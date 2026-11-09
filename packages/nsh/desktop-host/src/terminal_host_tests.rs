use super::*;

#[test]
fn granted_catalog_unknown_never_replays_or_returns_authoritative_empty() {
    use std::sync::atomic::AtomicUsize;
    struct Unknown {
        writes: Arc<AtomicUsize>,
    }
    impl crate::notifications::store::Store for Unknown {
        fn load(&mut self) -> Result<Option<Value>> {
            Ok(None)
        }
        fn commit(&mut self, _: &Value) -> Result<()> {
            self.writes.fetch_add(1, Ordering::AcqRel);
            Err("notification_store_unknown".into())
        }
    }
    let writes = Arc::new(AtomicUsize::new(0));
    let mut catalog = Catalog {
        source: CatalogSource::Granted(Box::new(Unknown {
            writes: writes.clone(),
        })),
        unknown: false,
    };
    let value = json!({"schema":1,"hostID":"fixture","directories":[]});
    assert_eq!(
        catalog.write("fixture", value.clone()).unwrap_err(),
        "terminal_catalog_unknown"
    );
    assert!(catalog.read("fixture").is_err());
    assert!(catalog.write("fixture", value).is_err());
    assert_eq!(writes.load(Ordering::Acquire), 1);
}
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};
struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}

#[test]
#[ignore = "Requires NSH-built production core fixture; invoked by desktop-terminal-host.test.ts"]
fn production_core_host_registry_catalog_and_real_network_without_shell_or_vault() {
    let bundle_path = std::env::var("NSH_TERMINAL_CORE_BUNDLE")
        .expect("build the isolated NSH terminal core fixture first");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (seen_tx, seen_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut connections = Vec::new();
        let closes = Arc::new(AtomicUsize::new(0));
        for _ in 0..7 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let seen = seen_tx.clone();
            let closes = closes.clone();
            connections.push(std::thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                let mut auth = false;
                let mut plain = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" { break; }
                    let (k, v) = line.split_once(':').unwrap();
                    if k.eq_ignore_ascii_case("authorization") {
                        auth = v.trim() == "Bearer synthetic-terminal-token";
                    } else if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse::<usize>().unwrap();
                    } else if k.eq_ignore_ascii_case("content-type") {
                        plain = v.trim().starts_with("text/plain");
                    }
                }
                assert!(auth, "native bearer header");
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                if first.contains("/input ") { assert!(plain); assert_eq!(body, "中\0\r\n".as_bytes()); }
                if first.contains("/create ") { let value: Value = serde_json::from_slice(&body).unwrap(); assert_eq!(value["cwd"], "C:/Synthetic/项目"); }
                seen.send(first.clone()).unwrap();
                let (mime, body) = if first.contains("/stream ") {
                    ("text/event-stream", "data: {\"type\":\"connected\"}\r\n\r\ndata: {\"type\":\"data\",\"data\":\"SYNTHETIC_中文\"}\r\n\r\n".to_owned())
                } else if first.contains("/create ") {
                    ("application/json", "{\"sessionId\":\"synthetic-session\",\"capabilities\":{\"stream\":{\"preferred\":\"sse\",\"transports\":[\"sse\"]},\"input\":{\"preferred\":\"http\",\"transports\":[\"http\"]}}}".into())
                } else if first.starts_with("DELETE ") && closes.fetch_add(1, Ordering::AcqRel) == 0 {
                    ("application/json", "{\"success\":false}".into())
                } else {
                    ("application/json", "{\"success\":true}".into())
                };
                if first.contains("/stream ") {
                    // The stream stays open while independent real HTTP input,
                    // resize and close requests execute, as a real Host would.
                    write!(reader.get_mut(), "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n", body.len()).unwrap();
                    reader.get_mut().flush().unwrap();
                    std::thread::sleep(Duration::from_millis(800));
                } else {
                    write!(reader.get_mut(), "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            }));
        }
        let _ = stop_rx.recv_timeout(Duration::from_secs(10));
        for worker in connections {
            worker.join().unwrap();
        }
    });
    let scope = json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000007"});
    let expected = scope.clone();
    let capture: Capture = Arc::new(move |requested| {
        if requested != &expected {
            return Err("terminal_scope_stale".into());
        }
        Captured::direct(
            expected.clone(),
            &origin,
            "synthetic-terminal-token",
            true,
            Arc::new(|| true),
        )
    });
    let temporary = std::env::temp_dir().join(format!(
        "nsh-terminal-catalog-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let host = HostChannel::default();
    let owner = install(
        &host,
        nsh_engine::net::network(),
        capture,
        temporary.clone(),
    );
    let (tx, rx) = mpsc::channel();
    host.handle("terminal.fixture.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let mut bundle = Bundle::read(std::path::Path::new(&bundle_path)).unwrap();
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    let result = rx.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(
        result,
        json!({"ok":true,"directory":"C:/Synthetic/项目","creates":1})
    );
    drop(engine);
    drop(owner);
    let _ = stop_tx.send(());
    server.join().unwrap();
    let seen: Vec<_> = seen_rx.try_iter().collect();
    assert_eq!(seen.len(), 7);
    assert_eq!(
        seen.iter().filter(|line| line.contains("/create ")).count(),
        1
    );
    assert_eq!(
        seen.iter().filter(|line| line.contains("/input ")).count(),
        1
    );
    let persisted: Value = serde_json::from_slice(&std::fs::read(&temporary).unwrap()).unwrap();
    assert!(!persisted.to_string().contains("synthetic-terminal-token"));
    assert!(!persisted.to_string().contains("SYNTHETIC_中文"));
    let _ = std::fs::remove_file(temporary);
}

#[test]
#[ignore = "Requires NSH-built production core fixture; invoked by desktop-terminal-host.test.ts"]
fn uncertain_real_http_create_is_journaled_and_never_replayed_or_falsely_closed() {
    let bundle_path =
        std::env::var("NSH_TERMINAL_CORE_BUNDLE").expect("build isolated core fixture");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        assert!(first.starts_with("POST /api/terminal/create "));
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            let (k, v) = line.split_once(':').unwrap();
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse::<usize>().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        // Backend observed the POST, then the response is lost. No shell exists.
        drop(reader);
        listener.set_nonblocking(true).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert!(listener.accept().is_err(), "uncertain create was replayed");
    });
    let scope = json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000007"});
    let capture: Capture = Arc::new(move |expected| {
        if expected != &scope {
            return Err("terminal_scope_stale".into());
        }
        Captured::direct(
            scope.clone(),
            &origin,
            "synthetic-terminal-token",
            true,
            Arc::new(|| true),
        )
    });
    let temporary = std::env::temp_dir().join(format!(
        "nsh-terminal-unknown-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let host = HostChannel::default();
    host.set_params(serde_json::from_value(json!({"scenario":"create-unknown"})).unwrap());
    let owner = install(
        &host,
        nsh_engine::net::network(),
        capture,
        temporary.clone(),
    );
    let (tx, rx) = mpsc::channel();
    host.handle("terminal.fixture.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let mut bundle = Bundle::read(std::path::Path::new(&bundle_path)).unwrap();
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(15)).unwrap(),
        json!({"ok":true,"unknown":true})
    );
    drop(engine);
    drop(owner);
    server.join().unwrap();
    let persisted: Value = serde_json::from_slice(&std::fs::read(&temporary).unwrap()).unwrap();
    assert_eq!(
        persisted["synthetic-host"]["directories"][0]["tabs"][0]["createUnknown"],
        true
    );
    let _ = std::fs::remove_file(temporary);
}

#[test]
fn catalog_schema_and_corruption_cannot_masquerade_as_empty_or_persist_extra_sensitive_fields() {
    let path =
        std::env::temp_dir().join(format!("nsh-terminal-schema-{}.json", std::process::id()));
    let mut storage = Catalog {
        source: CatalogSource::SyntheticPath(path.clone()),
        unknown: false,
    };
    let value = json!({"schema":1,"hostID":"synthetic","directories":[{"directory":"//server/share","activeId":"tab","tabs":[{"id":"tab","lifecycle":"idle"}]}]});
    storage.write("synthetic", value.clone()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut invalid = value;
    invalid["directories"][0]["tabs"][0]["token"] = json!("must-not-be-persisted");
    assert!(storage.write("synthetic", invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, b"false").unwrap();
    assert!(storage.read("synthetic").is_err());
    let _ = std::fs::remove_file(path);
}

struct ExitNetwork;
struct ExitTask;
impl nsh_engine::FetchTask for ExitTask {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}
impl Network for ExitNetwork {
    fn fetch(
        &self,
        request: nsh_core::platform::HttpRequest,
        mut emit: nsh_engine::FetchEvents,
    ) -> Box<dyn nsh_engine::FetchTask> {
        use nsh_core::platform::{FetchEvent, HttpHead};
        emit(FetchEvent::Head(HttpHead {
            status: 200,
            status_text: "OK".into(),
            url: request.url,
            redirected: false,
            headers: vec![("Content-Type".into(), "text/event-stream".into())],
        }));
        emit(FetchEvent::Data(
            b"data: {\"type\":\"connected\"}\n\ndata: {\"type\":\"exit\",\"exitCode\":0}\n\n"
                .to_vec(),
        ));
        Box::new(ExitTask)
    }
}

#[test]
fn authoritative_exit_cannot_be_resurrected_by_native_catalog_merge() {
    let scope = json!({"hostID":"synthetic-exit","lease":"00000000-0000-4000-8000-000000000007"});
    let capture: Capture = Arc::new(move |expected| {
        Captured::direct(
            expected.clone(),
            "https://example.invalid",
            "synthetic-token",
            false,
            Arc::new(|| true),
        )
    });
    let path = std::env::temp_dir().join(format!("nsh-terminal-exit-{}.json", std::process::id()));
    let host = HostChannel::default();
    let owner = install(&host, Arc::new(ExitNetwork), capture, path.clone());
    let prior = json!({"schema":1,"hostID":"synthetic-exit","directories":[{"directory":"/synthetic","activeId":"tab","tabs":[{"id":"tab","sessionId":"session","lifecycle":"running"}]}]});
    owner
        .state
        .catalog
        .lock()
        .unwrap()
        .write("synthetic-exit", prior.clone())
        .unwrap();
    let session = Arc::new(Session::new(
        scope.clone(),
        "tab".into(),
        "/synthetic".into(),
        Some("session".into()),
    ));
    session.attachment.store(1, Ordering::Release);
    session.prefer_sse.store(true, Ordering::Release);
    owner
        .state
        .sessions
        .lock()
        .unwrap()
        .insert(key(&scope, "tab"), session.clone());
    let captured = (owner.state.capture)(&scope).unwrap();
    owner
        .state
        .receive(captured, session, Arc::new(AtomicBool::new(false)), 1, 0);
    let ended = json!({"schema":1,"hostID":"synthetic-exit","directories":[{"directory":"/synthetic","activeId":"tab","tabs":[{"id":"tab","lifecycle":"exited"}]}]});
    owner
        .state
        .call(
            "terminal.catalog.write",
            &json!({"expectedHost":scope,"catalog":ended}),
        )
        .unwrap();
    assert_eq!(
        owner
            .state
            .catalog
            .lock()
            .unwrap()
            .read("synthetic-exit")
            .unwrap(),
        ended
    );
    let _ = std::fs::remove_file(path);
}
