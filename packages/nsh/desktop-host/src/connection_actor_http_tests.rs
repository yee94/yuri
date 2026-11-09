//! Original actor/typed raw port with synthetic sensitive bytes and Network only.
use super::*;
use crate::{connection_actor_http_port as raw, connection_actor_port as native};

struct NetworkFixture {
    calls: Mutex<Vec<HttpRequest>>,
    callbacks: Mutex<HashMap<String, nsh_engine::FetchEvents>>,
    ready: mpsc::Sender<String>,
    cancelled: Arc<AtomicUsize>,
}
impl Network for NetworkFixture {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn FetchTask> {
        assert!(!request.follow_redirects);
        let url = request.url.clone();
        let authentication = url.ends_with("/auth/session");
        let probe = url.ends_with("/api/config/settings");
        if authentication {
            assert!(
                !request
                    .headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            );
        } else {
            assert!(
                request
                    .headers
                    .contains(&("Authorization".into(), "Bearer synthetic-sync-token".into()))
            );
        }
        self.calls.lock().unwrap().push(request);
        if authentication || probe {
            let body = if authentication {
                br#"{"clientToken":"synthetic-sync-token"}"#.to_vec()
            } else {
                b"{}".to_vec()
            };
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url,
                headers: vec![("Content-Type".into(), "application/json".into())],
                ..Default::default()
            }));
            events(FetchEvent::Data(body));
            events(FetchEvent::End);
        } else {
            self.callbacks.lock().unwrap().insert(url.clone(), events);
            self.ready.send(url).unwrap();
        }
        Box::new(FakeTask(self.cancelled.clone()))
    }
}
impl NetworkFixture {
    fn complete(&self, url: &str, status: u16, mime: &str, bytes: &[u8]) {
        let mut callback = self.callbacks.lock().unwrap().remove(url).unwrap();
        callback(FetchEvent::Head(HttpHead {
            status,
            url: url.into(),
            headers: vec![
                ("Content-Type".into(), mime.into()),
                ("Content-Length".into(), bytes.len().to_string()),
            ],
            ..Default::default()
        }));
        callback(FetchEvent::Data(bytes.to_vec()));
        callback(FetchEvent::End);
    }
    fn raw_count(&self) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url.contains("/config-sync/"))
            .count()
    }
}
struct Fixture {
    owner: Owner,
    network: Arc<NetworkFixture>,
    ready: mpsc::Receiver<String>,
    native: native::Port,
    target: native::Target,
    committed: native::Committed,
}
fn fixture() -> Fixture {
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let selection = store.clone();
    let (tx, ready) = mpsc::channel();
    let network = Arc::new(NetworkFixture {
        calls: Mutex::new(Vec::new()),
        callbacks: Mutex::new(HashMap::new()),
        ready: tx,
        cancelled: Arc::new(AtomicUsize::new(0)),
    });
    let owner = install_with(
        &HostChannel::default(),
        &json!({"host":[]}),
        Box::new(store),
        network.clone(),
        false,
    )
    .unwrap();
    let native = owner.connection_actor_port().with_selection_protection(Arc::new(move |id| {
        let record: Value = serde_json::from_slice(&selection.read().unwrap().unwrap()).unwrap();
        record["selected"].as_str() == Some(id)
    }));
    let target = native::Target {
        id: "sync-fixture".into(),
        label: "Synthetic sync".into(),
        host: "ssh.example.invalid".into(),
        user: "fixture".into(),
        port: 22,
        remote_port: 3210,
        local_port: 0,
        managed: true,
    };
    native.save(0, vec![target.clone()]).unwrap();
    let password = native.password(target.clone()).unwrap();
    let committed = native
        .authorize(target.clone(), 43124, password, Arc::new(|| true))
        .unwrap();
    Fixture {
        owner,
        network,
        ready,
        native,
        target,
        committed,
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "synthetic raw job did not retire"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn six_fixed_routes_preserve_native_bytes_and_exact_remote_auth_independent_of_selected_host() {
    let f = fixture();
    let raw = f.owner.connection_actor_http_port();
    assert!(matches!(raw.local_service(), Err(raw::Error::Unavailable)));
    for (request, path, binary, imported) in [
        (
            raw::Request::CredentialsInventory,
            "/credentials/inventory",
            false,
            None,
        ),
        (
            raw::Request::CredentialsExport,
            "/download/credentials",
            true,
            None,
        ),
        (
            raw::Request::CredentialsImport(vec![0, 255, 13, 10, 42]),
            "/credentials",
            false,
            Some(vec![0, 255, 13, 10, 42]),
        ),
        (
            raw::Request::MagpieInventory,
            "/magpie/inventory",
            false,
            None,
        ),
        (raw::Request::MagpieExport, "/download/magpie", true, None),
        (
            raw::Request::MagpieImport(vec![1, 0, 254]),
            "/magpie",
            false,
            Some(vec![1, 0, 254]),
        ),
    ] {
        let sending = raw.clone();
        let committed = f.committed.clone();
        let worker = std::thread::spawn(move || {
            sending.request(
                raw::Authority::Remote(committed),
                request,
                Arc::new(|| true),
            )
        });
        let url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            url,
            format!("http://127.0.0.1:43124/api/yuri/config-sync{path}")
        );
        f.owner
            .tx
            .try_send(Message::Call(
                "connection.select".into(),
                json!({"id":"synthetic-host"}),
                HostReply::default(),
            ))
            .ok()
            .unwrap();
        f.native.load().unwrap();
        let calls = f.network.calls.lock().unwrap();
        let wire = calls.last().unwrap();
        assert!(
            wire.headers
                .contains(&("Cache-Control".into(), "no-store".into()))
        );
        if let Some(imported) = imported {
            assert_eq!(wire.method, "PUT");
            let nsh_engine::HttpBody::Bytes(bytes) = &wire.body else {
                panic!("raw body must not become JSON")
            };
            assert_eq!(*bytes, imported);
        } else {
            assert_eq!(wire.method, "GET");
        }
        drop(calls);
        let bytes = if binary {
            vec![0, 255, 13, 10, 228, 184, 173]
        } else {
            b"{\"ok\":true}".to_vec()
        };
        f.network.complete(
            &url,
            200,
            if binary {
                "application/octet-stream"
            } else {
                "application/json"
            },
            &bytes,
        );
        let response = worker.join().unwrap().unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, bytes);
    }
    assert_eq!(f.network.raw_count(), 6);
    let wrong = native::Committed {
        receipt: "wrong-receipt".into(),
        ..f.committed.clone()
    };
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(wrong),
            raw::Request::CredentialsExport,
            Arc::new(|| true)
        ),
        Err(raw::Error::Stale)
    ));
    assert_eq!(f.network.raw_count(), 6);
}

#[test]
fn shared_two_pending_budget_cancel_and_old_receipt_do_not_replay_or_poison_other_jobs() {
    let f = fixture();
    let raw = f.owner.connection_actor_http_port();
    let cancel = Arc::new(AtomicBool::new(false));
    let checking = cancel.clone();
    let sending = raw.clone();
    let committed = f.committed.clone();
    let write = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::CredentialsImport(b"synthetic-sensitive".to_vec()),
            Arc::new(move || !checking.load(Ordering::Acquire)),
        )
    });
    let write_url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let sending = raw.clone();
    let committed = f.committed.clone();
    let read = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::MagpieInventory,
            Arc::new(|| true),
        )
    });
    let read_url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(f.committed.clone()),
            raw::Request::CredentialsExport,
            Arc::new(|| true)
        ),
        Err(raw::Error::Busy)
    ));
    cancel.store(true, Ordering::Release);
    assert!(matches!(write.join().unwrap(), Err(raw::Error::Unknown)));
    wait(|| f.network.cancelled.load(Ordering::Relaxed) == 1);
    f.network
        .complete(&write_url, 200, "application/json", b"{}");
    f.network
        .complete(&read_url, 200, "application/json", br#"{"magpie":null}"#);
    assert_eq!(read.join().unwrap().unwrap().body, br#"{"magpie":null}"#);
    assert_eq!(f.network.raw_count(), 2);
    assert_eq!(f.native.load().unwrap().revision, 1);
    let sending = raw.clone();
    let committed = f.committed.clone();
    let write = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::MagpieImport(b"synthetic-magpie".to_vec()),
            Arc::new(|| true),
        )
    });
    let late = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    f.native.retire(f.committed.clone()).unwrap();
    assert!(matches!(write.join().unwrap(), Err(raw::Error::Unknown)));
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(f.committed.clone()),
            raw::Request::MagpieExport,
            Arc::new(|| true)
        ),
        Err(raw::Error::Stale)
    ));
    f.network.complete(&late, 200, "application/json", b"{}");
    assert_eq!(f.network.raw_count(), 3);
}

#[test]
fn timeout_redirect_non_success_and_reauthorization_leave_dispatched_imports_unknown() {
    let f = fixture();
    let raw = f.owner.connection_actor_http_port();
    for status in [302, 500] {
        let sending = raw.clone();
        let committed = f.committed.clone();
        let worker = std::thread::spawn(move || {
            sending.request(
                raw::Authority::Remote(committed),
                raw::Request::CredentialsImport(b"synthetic".to_vec()),
                Arc::new(|| true),
            )
        });
        let url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
        f.network.complete(&url, status, "application/json", b"{}");
        assert!(matches!(worker.join().unwrap(), Err(raw::Error::Unknown)));
    }
    let sending = raw.with_timeout(Duration::from_millis(50));
    let committed = f.committed.clone();
    let worker = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::MagpieImport(b"synthetic".to_vec()),
            Arc::new(|| true),
        )
    });
    let timed_out = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(worker.join().unwrap(), Err(raw::Error::Unknown)));
    wait(|| f.network.cancelled.load(Ordering::Relaxed) == 2);
    f.network
        .complete(&timed_out, 200, "application/json", b"{}");
    let sending = raw.clone();
    let committed = f.committed.clone();
    let worker = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::CredentialsImport(b"synthetic".to_vec()),
            Arc::new(|| true),
        )
    });
    let old_url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let fresh = f
        .native
        .authorize(
            f.target.clone(),
            43124,
            f.native.password(f.target.clone()).unwrap(),
            Arc::new(|| true),
        )
        .unwrap();
    assert_ne!(fresh.receipt, f.committed.receipt);
    assert!(matches!(worker.join().unwrap(), Err(raw::Error::Unknown)));
    f.network.complete(&old_url, 200, "application/json", b"{}");
    assert_eq!(f.network.raw_count(), 4);
    assert!(f.native.healthy(fresh).unwrap());
}

#[test]
fn cancelled_empty_and_shutdown_requests_send_no_sensitive_fetch() {
    let f = fixture();
    let raw = f.owner.connection_actor_http_port();
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(f.committed.clone()),
            raw::Request::CredentialsImport(Vec::new()),
            Arc::new(|| true)
        ),
        Err(raw::Error::Invalid)
    ));
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(f.committed.clone()),
            raw::Request::MagpieExport,
            Arc::new(|| false)
        ),
        Err(raw::Error::Cancelled)
    ));
    f.owner.services().shutdown();
    assert!(matches!(
        raw.request(
            raw::Authority::Remote(f.committed.clone()),
            raw::Request::CredentialsInventory,
            Arc::new(|| true)
        ),
        Err(raw::Error::Unavailable)
    ));
    assert_eq!(f.network.raw_count(), 0);
}

#[test]
fn original_queue_full_is_definite_busy_and_never_fetches_or_keeps_sensitive_body() {
    struct Paused {
        store: MemoryVault,
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl Vault for Paused {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            self.store.write(bytes)
        }
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, paused) = mpsc::sync_channel(1);
    let network = Arc::new(FakeNetwork::default());
    let owner = install_with(
        &HostChannel::default(),
        &json!({"host":[]}),
        Box::new(Paused {
            store,
            entered,
            release: Mutex::new(paused),
        }),
        network.clone(),
        false,
    )
    .unwrap();
    let native = owner.connection_actor_port();
    let loading = std::thread::spawn(move || native.load());
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    for _ in 0..QUEUE {
        owner
            .tx
            .try_send(Message::RefreshNotifications)
            .ok()
            .unwrap();
    }
    let port = owner.connection_actor_http_port();
    let authority = || {
        raw::Authority::Remote(native::Committed {
            connection_id: "synthetic-host".into(),
            receipt: "synthetic".into(),
        })
    };
    let result = port.request(
        authority(),
        raw::Request::CredentialsImport(vec![0, 255]),
        Arc::new(|| true),
    );
    let second = port.request(
        authority(),
        raw::Request::CredentialsImport(vec![0, 255]),
        Arc::new(|| true),
    );
    release.send(()).unwrap();
    assert!(matches!(result, Err(raw::Error::Busy)));
    assert!(matches!(second, Err(raw::Error::Busy)));
    assert!(loading.join().unwrap().is_ok());
    wait(|| owner.connection_actor_port().load().is_ok());
    assert!(
        matches!(
            port.request(
                authority(),
                raw::Request::CredentialsImport(vec![0, 255]),
                Arc::new(|| true)
            ),
            Err(raw::Error::Stale)
        ),
        "full queue releases both pending permits"
    );
    assert!(network.requests.lock().unwrap().is_empty());
}

#[test]
fn invalid_heads_and_truncated_ack_are_unknown_but_failed_reads_never_become_empty_success() {
    let f = fixture();
    let raw = f.owner.connection_actor_http_port();
    for case in ["origin", "mime", "length", "duplicate", "truncated"] {
        let sending = raw.clone();
        let committed = f.committed.clone();
        let write = std::thread::spawn(move || {
            sending.request(
                raw::Authority::Remote(committed),
                raw::Request::CredentialsImport(b"synthetic".to_vec()),
                Arc::new(|| true),
            )
        });
        let url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut callback = f.network.callbacks.lock().unwrap().remove(&url).unwrap();
        let mut head = HttpHead {
            status: 200,
            url: url.clone(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        };
        match case {
            "origin" => head.url = "https://other.invalid/api/yuri/config-sync/credentials".into(),
            "mime" => head.headers[0].1 = "text/html".into(),
            "length" => head
                .headers
                .push(("Content-Length".into(), (1024 * 1024 + 1).to_string())),
            "duplicate" => head.headers.extend([
                ("Content-Length".into(), "2".into()),
                ("Content-Length".into(), "2".into()),
            ]),
            "truncated" => head.headers.push(("Content-Length".into(), "3".into())),
            _ => unreachable!(),
        }
        callback(FetchEvent::Head(head));
        callback(FetchEvent::Data(b"{}".to_vec()));
        callback(FetchEvent::End);
        assert!(
            matches!(write.join().unwrap(), Err(raw::Error::Unknown)),
            "{case}"
        );
    }
    let sending = raw.clone();
    let committed = f.committed.clone();
    let read = std::thread::spawn(move || {
        sending.request(
            raw::Authority::Remote(committed),
            raw::Request::CredentialsInventory,
            Arc::new(|| true),
        )
    });
    let url = f.ready.recv_timeout(Duration::from_secs(5)).unwrap();
    f.network.complete(
        &url,
        503,
        "application/json",
        br#"{"error":"synthetic-unavailable"}"#,
    );
    let response = read.join().unwrap().unwrap();
    assert_eq!(response.status, 503);
    assert!(!response.body.is_empty());
    assert_eq!(f.network.raw_count(), 6);
}
