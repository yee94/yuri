use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Task;
impl FetchTask for Task {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}
struct Fixture {
    status: u16,
    headers: Vec<(String, String)>,
    events: Vec<FetchEvent>,
    requests: Arc<Mutex<Vec<HttpRequest>>>,
}
impl Network for Fixture {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn FetchTask> {
        self.requests.lock().unwrap().push(request.clone());
        events(FetchEvent::Head(HttpHead {
            status: self.status,
            url: request.url,
            headers: self.headers.clone(),
            ..Default::default()
        }));
        for event in &self.events {
            events(event.clone());
        }
        Box::new(Task)
    }
}
fn captured() -> Captured {
    Captured::direct(
        &serde_json::json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"}),
        "window",
        "https://synthetic.invalid",
        "synthetic-token",
        false,
        Arc::new(|| true),
    )
    .unwrap()
}
fn file() -> HostFile {
    HostFile {
        directory: "/workspace".into(),
        path: "/workspace/中文.bin".into(),
    }
}
#[derive(Default)]
struct Sink {
    bytes: Vec<u8>,
    begins: usize,
    progress: Vec<Checkpoint>,
}
impl Consumer for Sink {
    fn begin(&mut self, _: &Checkpoint) -> Result<()> {
        self.begins += 1;
        Ok(())
    }
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn progress(&mut self, c: &Checkpoint) {
        self.progress.push(c.clone());
    }
}
fn fixture(status: u16, headers: &[(&str, &str)], events: Vec<FetchEvent>) -> Arc<Fixture> {
    Arc::new(Fixture {
        status,
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        events,
        requests: Arc::new(Mutex::new(Vec::new())),
    })
}
#[test]
fn exact_authenticated_raw_route_utf8_binary_and_no_url_or_outside_workspace_power() {
    let bytes = "中文\r\n"
        .as_bytes()
        .iter()
        .copied()
        .chain([0, 255, 128])
        .collect::<Vec<_>>();
    let net = fixture(
        200,
        &[("ETag", "\"exact\"")],
        vec![FetchEvent::Data(bytes.clone()), FetchEvent::End],
    );
    let mut sink = Sink::default();
    let mut checkpoint = Checkpoint::default();
    receive(
        net.clone(),
        &captured(),
        &file(),
        &mut checkpoint,
        || true,
        &mut sink,
    )
    .unwrap();
    assert_eq!(sink.bytes, bytes);
    assert_eq!(checkpoint.total, None);
    let requests = net.requests.lock().unwrap();
    let request = &requests[0];
    assert_eq!(request.method, "GET");
    assert!(!request.follow_redirects);
    assert_eq!(
        request.url,
        "https://synthetic.invalid/api/fs/raw?path=%2Fworkspace%2F%E4%B8%AD%E6%96%87.bin&directory=%2Fworkspace&download=true"
    );
    assert!(
        request
            .headers
            .contains(&("Authorization".into(), "Bearer synthetic-token".into()))
    );
    for path in [
        "https://outside.invalid/file",
        "file:///local",
        "/workspace-other/file",
        "/workspace/../private",
        "/workspace//nested",
        "/workspace/",
    ] {
        assert!(
            HostFile {
                directory: "/workspace".into(),
                path: path.into()
            }
            .validate()
            .is_err()
        );
    }
    for (directory, path) in [
        ("/", "/file"),
        ("C:/", "C:/file"),
        ("C:/project", "C:/project/file"),
        ("//server/share/project", "//server/share/project/file"),
    ] {
        HostFile {
            directory: directory.into(),
            path: path.into(),
        }
        .validate()
        .unwrap();
    }
}
#[test]
fn failed_prefix_only_resumes_exact_strong_etag_range_and_size_never_200_or_weak() {
    let net = fixture(
        200,
        &[("Content-Length", "6"), ("ETag", "\"exact\"")],
        vec![
            FetchEvent::Data(vec![0, 255, 1]),
            FetchEvent::Failed("private URL must be redacted".into()),
        ],
    );
    let mut sink = Sink::default();
    let mut checkpoint = Checkpoint::default();
    assert_eq!(
        receive(
            net,
            &captured(),
            &file(),
            &mut checkpoint,
            || true,
            &mut sink
        )
        .unwrap_err(),
        "download_connection_failed"
    );
    assert_eq!(checkpoint.received, 3);
    assert!(checkpoint.resumable());
    for (status, headers) in [
        (200, vec![("Content-Length", "6"), ("ETag", "\"exact\"")]),
        (
            206,
            vec![("Content-Range", "bytes 3-5/6"), ("ETag", "W/\"exact\"")],
        ),
        (
            206,
            vec![("Content-Range", "bytes 2-5/6"), ("ETag", "\"exact\"")],
        ),
        (
            206,
            vec![("Content-Range", "bytes 3-5/6"), ("ETag", "\"changed\"")],
        ),
        (
            206,
            vec![
                ("Content-Range", "bytes 3-5/6"),
                ("ETag", "\"exact\""),
                ("Content-Length", "2"),
            ],
        ),
    ] {
        let bad = fixture(
            status,
            &headers,
            vec![FetchEvent::Data(vec![7, 7, 7]), FetchEvent::End],
        );
        let before = sink.bytes.clone();
        assert!(
            receive(
                bad,
                &captured(),
                &file(),
                &mut checkpoint,
                || true,
                &mut sink
            )
            .is_err()
        );
        assert_eq!(sink.bytes, before);
        assert_eq!(checkpoint.received, 3);
    }
    let good = fixture(
        206,
        &[
            ("Content-Range", "bytes 3-5/6"),
            ("ETag", "\"exact\""),
            ("Content-Length", "3"),
        ],
        vec![FetchEvent::Data(vec![2, 3, 4]), FetchEvent::End],
    );
    receive(
        good.clone(),
        &captured(),
        &file(),
        &mut checkpoint,
        || true,
        &mut sink,
    )
    .unwrap();
    assert_eq!(sink.bytes, [0, 255, 1, 2, 3, 4]);
    let requests = good.requests.lock().unwrap();
    assert!(
        requests[0]
            .headers
            .contains(&("Range".into(), "bytes=3-".into()))
    );
    assert!(
        requests[0]
            .headers
            .contains(&("If-Range".into(), "\"exact\"".into()))
    );
    let mut unsupported = Checkpoint {
        received: 3,
        total: Some(6),
        etag: Some("W/\"weak\"".into()),
    };
    assert_eq!(
        receive(
            good.clone(),
            &captured(),
            &file(),
            &mut unsupported,
            || true,
            &mut sink
        )
        .unwrap_err(),
        "download_resume_unsupported"
    );
    assert_eq!(requests.len(), 1);
}
#[test]
fn malformed_heads_lengths_event_order_and_stale_authority_never_append() {
    for (headers, events) in [
        (
            vec![("Content-Encoding", "gzip")],
            vec![FetchEvent::Data(vec![0]), FetchEvent::End],
        ),
        (
            vec![("Content-Length", "1"), ("content-length", "1")],
            vec![FetchEvent::End],
        ),
        (vec![("Content-Length", "NaN")], vec![FetchEvent::End]),
    ] {
        let mut sink = Sink::default();
        assert!(
            receive(
                fixture(200, &headers, events),
                &captured(),
                &file(),
                &mut Checkpoint::default(),
                || true,
                &mut sink
            )
            .is_err()
        );
        assert!(sink.bytes.is_empty());
    }
    let mut sink = Sink::default();
    let net = fixture(
        200,
        &[("Content-Length", "2")],
        vec![FetchEvent::Data(vec![0]), FetchEvent::End],
    );
    assert_eq!(
        receive(
            net,
            &captured(),
            &file(),
            &mut Checkpoint::default(),
            || true,
            &mut sink
        )
        .unwrap_err(),
        "download_size_mismatch"
    );
    let mut sink = Sink::default();
    assert_eq!(
        receive(
            fixture(302, &[], vec![FetchEvent::End]),
            &captured(),
            &file(),
            &mut Checkpoint::default(),
            || true,
            &mut sink
        )
        .unwrap_err(),
        "download_redirect_rejected"
    );
    assert!(sink.bytes.is_empty());
    let net = fixture(200, &[], vec![]);
    assert!(
        receive(
            net.clone(),
            &captured(),
            &file(),
            &mut Checkpoint::default(),
            || false,
            &mut sink
        )
        .is_err()
    );
    assert!(net.requests.lock().unwrap().is_empty());
}
#[test]
fn large_synchronous_producer_has_bounded_backpressure() {
    struct Large {
        produced: Arc<AtomicUsize>,
        written: Arc<AtomicUsize>,
        max: Arc<AtomicUsize>,
    }
    impl Network for Large {
        fn fetch(
            &self,
            request: HttpRequest,
            mut callback: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            callback(FetchEvent::Head(HttpHead {
                status: 200,
                url: request.url,
                ..Default::default()
            }));
            for _ in 0..4096 {
                let produced = self.produced.fetch_add(1, Ordering::AcqRel) + 1;
                self.max.fetch_max(
                    produced.saturating_sub(self.written.load(Ordering::Acquire)),
                    Ordering::AcqRel,
                );
                callback(FetchEvent::Data(vec![255; CHUNK]));
            }
            callback(FetchEvent::End);
            Box::new(Task)
        }
    }
    struct Count(Arc<AtomicUsize>);
    impl Consumer for Count {
        fn begin(&mut self, _: &Checkpoint) -> Result<()> {
            Ok(())
        }
        fn append(&mut self, bytes: &[u8]) -> Result<()> {
            assert_eq!(bytes.len(), CHUNK);
            self.0.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
        fn progress(&mut self, _: &Checkpoint) {}
    }
    let written = Arc::new(AtomicUsize::new(0));
    let produced = Arc::new(AtomicUsize::new(0));
    let max = Arc::new(AtomicUsize::new(0));
    let net = Arc::new(Large {
        produced: produced.clone(),
        written: written.clone(),
        max: max.clone(),
    });
    let mut checkpoint = Checkpoint::default();
    receive(
        net,
        &captured(),
        &file(),
        &mut checkpoint,
        || true,
        &mut Count(written),
    )
    .unwrap();
    assert_eq!(checkpoint.received, 4096 * CHUNK as u64);
    assert!(max.load(Ordering::Acquire) <= 4);
    // Test zero-byte oversize chunks are not accepted through an injected stack.
    let mut sink = Sink::default();
    assert_eq!(
        receive(
            fixture(200, &[], vec![FetchEvent::Data(vec![0; CHUNK + 1])]),
            &captured(),
            &file(),
            &mut Checkpoint::default(),
            || true,
            &mut sink
        )
        .unwrap_err(),
        "download_chunk_limit"
    );
}
