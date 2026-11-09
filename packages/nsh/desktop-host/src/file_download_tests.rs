use super::*;
use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    sync::atomic::AtomicUsize,
    time::{Duration, Instant},
};

pub(super) struct Temp(pub(super) PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "download-stream-test-{}",
            crate::vault::id().unwrap()
        ));
        fs::create_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
pub(super) struct Task;
impl nsh_engine::FetchTask for Task {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}
struct Net {
    requests: Arc<Mutex<Vec<HttpRequest>>>,
    fail_first: bool,
}
impl Network for Net {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn nsh_engine::FetchTask> {
        let call = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        let resume = call > 1 && self.fail_first;
        let mut headers = vec![
            ("ETag".into(), "\"exact-content\"".into()),
            (
                "Content-Length".into(),
                if resume { "3" } else { "6" }.into(),
            ),
        ];
        if resume {
            headers.push(("Content-Range".into(), "bytes 3-5/6".into()));
        }
        events(FetchEvent::Head(HttpHead {
            status: if resume { 206 } else { 200 },
            url: request.url,
            headers,
            ..Default::default()
        }));
        if self.fail_first && call == 1 {
            events(FetchEvent::Data(vec![0, 255, 13]));
            events(FetchEvent::Failed("synthetic disconnected".into()));
        } else {
            events(FetchEvent::Data(if resume {
                vec![10, 128, 0]
            } else {
                vec![0, 255, 13, 10, 128, 0]
            }));
            events(FetchEvent::End);
        }
        Box::new(Task)
    }
}
pub(super) fn scope() -> Value {
    json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"})
}
pub(super) fn capture(current: Arc<AtomicBool>) -> Capture {
    Arc::new(move |scope, window| {
        let current = current.clone();
        Captured::direct(
            scope,
            window,
            "https://synthetic.invalid",
            "synthetic-token",
            false,
            Arc::new(move || current.load(Ordering::Acquire)),
        )
    })
}
// This is a synthetic file-grant driver ONLY, not a substitute for documents'
// nofollow/pinned-parent system destination adapter. Its root is private Temp.
struct SyntheticTarget {
    file: File,
    partial: PathBuf,
    dest: PathBuf,
    commits: Arc<AtomicUsize>,
    unknown: bool,
}
impl Drop for SyntheticTarget {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.partial);
    }
}
impl Target for SyntheticTarget {
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.file
            .write_all(bytes)
            .map_err(|_| "synthetic_write".into())
    }
    fn rewind(&mut self, received: u64) -> Result<()> {
        self.file
            .set_len(received)
            .map_err(|_| "synthetic_truncate")?;
        self.file
            .seek(SeekFrom::Start(received))
            .map_err(|_| "synthetic_seek")?;
        self.file.sync_all().map_err(|_| "synthetic_sync".into())
    }
    fn seal(&mut self) -> Result<()> {
        self.file.sync_all().map_err(|_| "synthetic_sync".into())
    }
    fn commit(&mut self) -> Commit {
        self.commits.fetch_add(1, Ordering::AcqRel);
        if fs::rename(&self.partial, &self.dest).is_err() {
            return Commit::Unknown;
        }
        if self.unknown {
            Commit::Unknown
        } else {
            Commit::Saved
        }
    }
}
fn targets(root: &Path, commits: Arc<AtomicUsize>, unknown: bool) -> Targets {
    let root = root.to_path_buf();
    Arc::new(move |dest| {
        assert_eq!(dest.parent(), Some(root.as_path()));
        let partial = root.join(format!("partial-{}", crate::vault::id()?));
        let mut options = OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&partial).map_err(|_| "synthetic_open")?;
        Ok(Box::new(SyntheticTarget {
            file,
            partial,
            dest: dest.into(),
            commits: commits.clone(),
            unknown,
        }))
    })
}
pub(super) type JobFixture = (
    Job,
    Arc<Mutex<Book>>,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<HttpRequest>>>,
);
pub(super) fn job(root: &Path, fail_first: bool, unknown: bool) -> JobFixture {
    let current = Arc::new(AtomicBool::new(true));
    let commits = Arc::new(AtomicUsize::new(0));
    let cancel = Arc::new(AtomicBool::new(false));
    let book = Arc::new(Mutex::new(Book::default()));
    book.lock().unwrap().rows.insert(
        "request".into(),
        Receipt {
            owner: "owner".into(),
            scope: scope(),
            cancel: cancel.clone(),
            state: "pending",
            error: None,
            checkpoint: Checkpoint::default(),
            transfer: None,
            running: true,
            attachment: None,
        },
    );
    let requests = Arc::new(Mutex::new(Vec::new()));
    (
        Job {
            id: "request".into(),
            window: "window".into(),
            filename: "binary.bin".into(),
            file: Source::File(HostFile {
                directory: "/workspace".into(),
                path: "/workspace/binary.bin".into(),
            }),
            captured: Some(capture(current)(&scope(), "window").unwrap()),
            targets: targets(root, commits.clone(), unknown),
            network: Arc::new(Net {
                requests: requests.clone(),
                fail_first,
            }),
            book: book.clone(),
            cancel,
            stop: Arc::new(AtomicBool::new(false)),
            finished: false,
        },
        book,
        commits,
        requests,
    )
}
#[test]
fn native_job_keeps_prior_and_private_prefix_then_explicit_resume_commits_exact_bytes_once() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (job, book, commits, requests) = job(&temp.0, true, false);
    let network = job.network.clone();
    let stop = job.stop.clone();
    let cancel = job.cancel.clone();
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(commits.load(Ordering::Acquire), 0);
    let transfer = {
        let mut b = book.lock().unwrap();
        let row = b.rows.get_mut("request").unwrap();
        assert_eq!(row.state, "error");
        assert_eq!(row.checkpoint.received, 3);
        assert!(row.checkpoint.resumable());
        assert_eq!(snapshot("request", "window", row)["resumable"], true);
        row.transfer.take().unwrap()
    };
    run("request", transfer, network, book.clone(), cancel, stop);
    assert_eq!(fs::read(&dest).unwrap(), [0, 255, 13, 10, 128, 0]);
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .headers
            .contains(&("Range".into(), "bytes=3-".into()))
    );
}
#[test]
fn unknown_final_commit_is_not_saved_and_retirement_drops_partial_without_another_get() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    let (job, book, commits, requests) = job(&temp.0, false, true);
    let stop = job.stop.clone();
    job.write(&dest);
    let owner = Owner {
        book: book.clone(),
        stop,
    };
    let before = snapshot("request", "window", &book.lock().unwrap().rows["request"]);
    assert_eq!(before["state"], "unknown");
    assert_eq!(before["resumable"], false);
    assert_eq!(fs::read(&dest).unwrap(), [0, 255, 13, 10, 128, 0]);
    owner.invalidate();
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(book.lock().unwrap().rows["request"].state, "unknown");
}
#[test]
fn cancelled_or_retired_job_does_not_open_grant_or_network_and_cannot_replace_prior() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (job, book, commits, requests) = job(&temp.0, false, false);
    let owner = Owner {
        book,
        stop: job.stop.clone(),
    };
    owner.invalidate();
    job.write(&dest);
    assert_eq!(fs::read(dest).unwrap(), b"prior");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(commits.load(Ordering::Acquire), 0);
}
#[test]
fn cancellation_during_append_fences_queued_end_and_never_enters_final_commit() {
    struct Cancelling {
        target: Box<dyn Target>,
        cancel: Arc<AtomicBool>,
    }
    impl Target for Cancelling {
        fn append(&mut self, bytes: &[u8]) -> Result<()> {
            self.target.append(bytes)?;
            self.cancel.store(true, Ordering::Release);
            Ok(())
        }
        fn rewind(&mut self, received: u64) -> Result<()> {
            self.target.rewind(received)
        }
        fn seal(&mut self) -> Result<()> {
            panic!("cancelled stream must not seal")
        }
        fn commit(&mut self) -> Commit {
            panic!("cancelled stream must not commit")
        }
    }
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) = job(&temp.0, false, false);
    let target = job.targets.clone();
    let cancel = job.cancel.clone();
    job.targets = Arc::new(move |path| {
        Ok(Box::new(Cancelling {
            target: target(path)?,
            cancel: cancel.clone(),
        }))
    });
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(book.lock().unwrap().rows["request"].state, "cancelled");
    assert_eq!(commits.load(Ordering::Acquire), 0);
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
struct CountedDestination {
    inner: Box<dyn Target>,
    commits: Arc<AtomicUsize>,
    lose_ack: bool,
    fail_seal: bool,
    delay_inspect: bool,
}
impl Target for CountedDestination {
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.inner.append(bytes)
    }
    fn rewind(&mut self, received: u64) -> Result<()> {
        self.inner.rewind(received)
    }
    fn seal(&mut self) -> Result<()> {
        if self.fail_seal {
            self.fail_seal = false;
            return Err("injected_sync_failure".into());
        }
        self.inner.seal()
    }
    fn commit(&mut self) -> Commit {
        self.commits.fetch_add(1, Ordering::AcqRel);
        let committed = self.inner.commit();
        if self.lose_ack && matches!(committed, Commit::Saved) {
            Commit::Unknown
        } else {
            committed
        }
    }
    fn inspect(&mut self, current: &dyn Fn() -> bool) -> Verification {
        if self.delay_inspect {
            std::thread::sleep(Duration::from_millis(60));
        }
        self.inner.inspect(current)
    }
}
pub(super) fn real_targets(commits: Arc<AtomicUsize>, lose_ack: bool, fail_seal: bool) -> Targets {
    let factory = target::factory();
    Arc::new(move |path| {
        Ok(Box::new(CountedDestination {
            inner: factory(path)?,
            commits: commits.clone(),
            lose_ack,
            fail_seal,
            delay_inspect: false,
        }))
    })
}
#[test]
fn production_documents_stage_failure_retains_private_partial_and_retries_only_the_local_barrier() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) = job(&temp.0, false, false);
    job.targets = real_targets(commits.clone(), false, true);
    let network = job.network.clone();
    let stop = job.stop.clone();
    let cancel = job.cancel.clone();
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 2);
    let transfer = {
        let mut book = book.lock().unwrap();
        let row = book.rows.get_mut("request").unwrap();
        assert_eq!(row.state, "error");
        assert_eq!(row.checkpoint.received, 6);
        assert!(resumable(row));
        row.transfer.take().unwrap()
    };
    run("request", transfer, network, book.clone(), cancel, stop);
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(fs::read(&dest).unwrap(), [0, 255, 13, 10, 128, 0]);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
#[cfg(target_os = "macos")]
#[test]
fn production_unknown_receipt_needs_new_durable_barriers_and_never_replays_get_or_rename() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) = job(&temp.0, false, false);
    job.targets = real_targets(commits.clone(), true, false);
    let stop = job.stop.clone();
    let cancel = job.cancel.clone();
    job.write(&dest);
    let modified = dest.metadata().unwrap().modified().unwrap();
    let transfer = {
        let mut book = book.lock().unwrap();
        let row = book.rows.get_mut("request").unwrap();
        assert_eq!(row.state, "unknown");
        assert!(!resumable(row));
        row.transfer.take().unwrap()
    };
    inspect("request", transfer, book.clone(), cancel, stop);
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(dest.metadata().unwrap().modified().unwrap(), modified);
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn cancelled_unknown_verification_cannot_publish_even_an_original_real_destination() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    let (mut job, book, commits, requests) = job(&temp.0, false, false);
    job.targets = real_targets(commits.clone(), true, false);
    let stop = job.stop.clone();
    let cancel = job.cancel.clone();
    job.write(&dest);
    let transfer = book
        .lock()
        .unwrap()
        .rows
        .get_mut("request")
        .unwrap()
        .transfer
        .take()
        .unwrap();
    cancel.store(true, Ordering::Release);
    inspect("request", transfer, book.clone(), cancel, stop);
    assert_eq!(book.lock().unwrap().rows["request"].state, "unknown");
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn real_private_target_preserves_prior_on_failed_get_and_explicit_cancel_cleans_only_its_stage() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) = job(&temp.0, true, false);
    job.targets = real_targets(commits.clone(), false, false);
    let owner = Owner {
        book: book.clone(),
        stop: job.stop.clone(),
    };
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 2);
    owner.invalidate();
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(commits.load(Ordering::Acquire), 0);
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn actual_nsh_04_network_streams_to_real_stage_and_resumes_without_full_body_buffering() {
    use std::{
        io::{BufRead, BufReader, Read},
        net::TcpListener,
    };
    const TOTAL: usize = 16 * 1024 * 1024;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let mut offsets = Vec::new();
        for request in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(15);
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    other => panic!("synthetic server accept failed: {other:?}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim(),
                "GET /api/fs/raw?path=%2Fworkspace%2Fbinary.bin&directory=%2Fworkspace&download=true HTTP/1.1"
            );
            let mut headers = HashMap::new();
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                let (name, value) = line.trim_end().split_once(':').unwrap();
                headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
            }
            assert_eq!(
                headers.get("authorization").map(String::as_str),
                Some("Bearer synthetic-token")
            );
            assert_eq!(
                headers.get("accept-encoding").map(String::as_str),
                Some("identity")
            );
            assert!(!headers.contains_key("cookie"));
            let offset = if request == 0 {
                assert!(!headers.contains_key("range"));
                0
            } else {
                assert_eq!(
                    headers.get("if-range").map(String::as_str),
                    Some("\"large-exact\"")
                );
                headers["range"]
                    .strip_prefix("bytes=")
                    .unwrap()
                    .strip_suffix('-')
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
            };
            assert!(request == 0 || offset > 0 && offset < TOTAL);
            offsets.push(offset);
            let mut stream = reader.into_inner();
            let status = if request == 0 {
                "200 OK"
            } else {
                "206 Partial Content"
            };
            write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"large-exact\"\r\nConnection: close\r\n",TOTAL-offset).unwrap();
            if request > 0 {
                write!(
                    stream,
                    "Content-Range: bytes {}-{}/{}\r\n",
                    offset,
                    TOTAL - 1,
                    TOTAL
                )
                .unwrap();
            }
            write!(stream, "\r\n").unwrap();
            let end = if request == 0 {
                3 * transport::CHUNK
            } else {
                TOTAL
            };
            let mut buffer = [0u8; transport::CHUNK];
            for at in (offset..end).step_by(transport::CHUNK) {
                let size = (end - at).min(buffer.len());
                for (index, byte) in buffer[..size].iter_mut().enumerate() {
                    *byte = ((at + index) % 251) as u8;
                }
                stream.write_all(&buffer[..size]).unwrap();
            }
            // First response deliberately ends before Content-Length. Native
            // must retain its real prefix, not commit this truncated body.
        }
        offsets
    });
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, _) = job(&temp.0, false, false);
    job.targets = real_targets(commits.clone(), false, false);
    job.network = nsh_engine::net::network();
    job.captured = Some(
        Captured::direct(
            &scope(),
            "window",
            &origin,
            "synthetic-token",
            true,
            Arc::new(|| true),
        )
        .unwrap(),
    );
    let network = job.network.clone();
    let cancel = job.cancel.clone();
    let stop = job.stop.clone();
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(commits.load(Ordering::Acquire), 0);
    let (transfer, prefix) = {
        let mut book = book.lock().unwrap();
        let row = book.rows.get_mut("request").unwrap();
        assert_eq!(row.state, "error");
        assert!(resumable(row));
        (
            row.transfer.take().unwrap(),
            row.checkpoint.received as usize,
        )
    };
    run("request", transfer, network, book.clone(), cancel, stop);
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(server.join().unwrap(), [0, prefix]);
    let mut file = File::open(&dest).unwrap();
    let mut buffer = [0u8; transport::CHUNK];
    let mut offset = 0;
    loop {
        let length = file.read(&mut buffer).unwrap();
        if length == 0 {
            break;
        }
        for (index, byte) in buffer[..length].iter().enumerate() {
            assert_eq!(*byte, ((offset + index) % 251) as u8);
        }
        offset += length;
    }
    assert_eq!(offset, TOTAL);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
pub(super) struct Sink;
#[test]
fn ordinary_foreground_loss_after_selection_does_not_cancel_an_authenticated_transfer() {
    struct FocusSwitch {
        inner: Net,
        foreground: Arc<AtomicBool>,
    }
    impl Network for FocusSwitch {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn nsh_engine::FetchTask> {
            let foreground = self.foreground.clone();
            self.inner.fetch(
                request,
                Box::new(move |event| {
                    if matches!(event, FetchEvent::Data(_)) {
                        foreground.store(false, Ordering::Release);
                    }
                    events(event);
                }),
            )
        }
    }
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    let (mut job, book, commits, requests) = job(&temp.0, false, false);
    let foreground = Arc::new(AtomicBool::new(true));
    job.network = Arc::new(FocusSwitch {
        inner: Net {
            requests: requests.clone(),
            fail_first: false,
        },
        foreground: foreground.clone(),
    });
    job.targets = real_targets(commits.clone(), false, false);
    // The native system target has already been confirmed. Only the OS focus
    // changes during streamed Data; committed scope/window/runtime stay live.
    job.write(&dest);
    assert!(!foreground.load(Ordering::Acquire));
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(fs::read(dest).unwrap(), [0, 255, 13, 10, 128, 0]);
}
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
#[test]
#[ignore = "requires the built actual TS adapter fixture, passed explicitly"]
fn actual_ts_adapter_hostchannel_native_job_network_and_private_disk_resume_driver() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let source = fs::read_to_string(
        std::env::var_os("NSH_FILE_DOWNLOAD_FIXTURE")
            .expect("build desktop-files-download-fixture.ts first"),
    )
    .unwrap();
    let host = HostChannel::default();
    host.handle("test.scenario", |call| {
        if let Some(reply) = call.into_reply() {
            reply.resolve(json!("resume"));
        }
    });
    let (port, inbox) = channel();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let owner = install(
        &host,
        "window",
        Arc::new(Net {
            requests: requests.clone(),
            fail_first: true,
        }),
        capture(Arc::new(AtomicBool::new(true))),
        port,
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let mut bundle = Bundle::source(source);
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(job) = inbox.try_recv() {
            job.write(&dest);
            break;
        }
        assert!(Instant::now() < deadline, "no system-save job");
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(result["phase"], "saved", "{result}");
    assert_eq!(result["received"], 6);
    assert_eq!(result["resumed"], true);
    assert_eq!(result["leaked"], false);
    assert_eq!(result["forgedRejected"], 5);
    assert_eq!(fs::read(dest).unwrap(), [0, 255, 13, 10, 128, 0]);
    assert_eq!(requests.lock().unwrap().len(), 2);
    drop(engine);
    drop(owner);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the built actual TS adapter fixture, passed explicitly"]
fn actual_ts_native_status_verifies_unknown_without_replay_and_cancel_fences_late_verification() {
    let source = fs::read_to_string(
        std::env::var_os("NSH_FILE_DOWNLOAD_FIXTURE").expect("build TS fixture first"),
    )
    .unwrap();
    for scenario in ["unknown", "cancel-unknown"] {
        let temp = Temp::new();
        let dest = temp.0.join("chosen.bin");
        fs::write(&dest, b"prior").unwrap();
        let host = HostChannel::default();
        host.handle("test.scenario", move |call| {
            if let Some(reply) = call.into_reply() {
                reply.resolve(json!(scenario));
            }
        });
        let (port, inbox) = channel();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let commits = Arc::new(AtomicUsize::new(0));
        let factory = target::factory();
        let count = commits.clone();
        let targets: Targets = Arc::new(move |path| {
            Ok(Box::new(CountedDestination {
                inner: factory(path)?,
                commits: count.clone(),
                lose_ack: true,
                fail_seal: false,
                delay_inspect: true,
            }))
        });
        let owner = install_with_targets(
            &host,
            "window",
            Arc::new(Net {
                requests: requests.clone(),
                fail_first: false,
            }),
            capture(Arc::new(AtomicBool::new(true))),
            targets,
            port,
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            tx.send(call.take_data()).unwrap();
        });
        let mut bundle = Bundle::source(source.clone());
        bundle.policy.declared =
            Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
        let mut config = EngineConfig::new(bundle);
        config.host = host;
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(job) = inbox.try_recv() {
                job.write(&dest);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        let value = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            value["phase"],
            if scenario == "unknown" {
                "saved"
            } else {
                "unknown"
            },
            "{value}"
        );
        assert_eq!(value["received"], 6);
        assert_eq!(value["inspectedUnknown"], true);
        assert_eq!(value["resumed"], false);
        assert_eq!(value["forgedRejected"], 5);
        assert_eq!(value["leaked"], false);
        while owner
            .book
            .lock()
            .unwrap()
            .rows
            .values()
            .any(|row| row.running)
        {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(commits.load(Ordering::Acquire), 1);
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(fs::read(&dest).unwrap(), [0, 255, 13, 10, 128, 0]);
        drop(engine);
        drop(owner);
    }
}
