use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::sync::{Mutex, atomic::AtomicUsize};
#[path = "diagnostics_owner_tests.rs"]
mod diagnostics_contract;
#[path = "file_download_owner_tests.rs"]
mod download_owner_contract;
#[path = "connection_editor_tests.rs"]
mod editor_contract;
#[path = "file_journal_owner_tests.rs"]
mod file_journal_contract;
#[path = "http_jobs_tests.rs"]
mod http_job_contract;
#[path = "connection_actor_owner_tests.rs"]
mod native_actor_contract;
#[path = "connection_actor_http_tests.rs"]
mod native_http_contract;
#[path = "native_ssh_bridge_tests.rs"]
mod native_ssh_contract;
#[path = "notification_owner_tests.rs"]
mod notification_contract;
#[path = "runtime_stream_owner_tests.rs"]
mod runtime_stream_contract;
#[path = "terminal_ws_host_tests.rs"]
mod terminal_ws_contract;
#[path = "window_restore_tests.rs"]
mod window_restore_contract;

#[derive(Clone, Default)]
struct MemoryVault {
    bytes: Arc<Mutex<Option<Vec<u8>>>>,
    fail: Arc<AtomicBool>,
}
impl Vault for MemoryVault {
    fn read(&self) -> Result<Option<Vec<u8>>> {
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn write(&self, bytes: &[u8]) -> Result<()> {
        if self.fail.load(Ordering::Relaxed) {
            return Err("synthetic_secure_store_failure".into());
        }
        *self.bytes.lock().unwrap() = Some(bytes.to_vec());
        Ok(())
    }
}
#[derive(Default)]
struct FakeNetwork {
    requests: Mutex<Vec<HttpRequest>>,
    cancelled: Arc<AtomicUsize>,
}
struct FakeTask(Arc<AtomicUsize>);
impl FetchTask for FakeTask {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}
impl Network for FakeNetwork {
    fn fetch(&self, request: HttpRequest, _: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
        self.requests.lock().unwrap().push(request);
        Box::new(FakeTask(self.cancelled.clone()))
    }
}
fn connection() -> Connection {
    Connection {
        id: "synthetic-host".into(),
        label: "Synthetic".into(),
        url: "https://host.invalid".into(),
        token: "synthetic-test-token".into(),
        used: 1.0,
        authorization: "synthetic-authorization".into(),
        editor_version: None,
    }
}
fn state() -> State {
    let mut value = State {
        connections: vec![connection()],
        selected: Some("synthetic-host".into()),
        scope: None,
        notification_retirements: Vec::new(),
        notification_error: None,
        native: Default::default(),
        extra: Default::default(),
    };
    value.rotate().unwrap();
    value
}
fn actor() -> (Actor, MemoryVault, Arc<FakeNetwork>) {
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let network = Arc::new(FakeNetwork::default());
    let (tx, _rx) = mpsc::sync_channel(QUEUE);
    let mut actor = Actor::new(
        HostChannel::default(),
        tx,
        Box::new(store.clone()),
        network.clone(),
    );
    actor.load().unwrap();
    (actor, store, network)
}

#[test]
fn authorization_cache_cleanup_preserves_retirements_until_exact_claim_and_ack() {
    let (mut actor, vault, _) = actor();
    let ready = actor.immediate("authorization.cache.ready", &json!({})).unwrap();
    let owner = ready["owner"].as_str().unwrap();
    assert_eq!(ready["tickets"], json!([]));
    actor.immediate("connection.remove", &json!({"id":"synthetic-host"})).unwrap();
    assert_eq!(history_retirement::pending(&State::load(&vault, false).unwrap()).unwrap(), vec![("synthetic-host".into(), "synthetic-authorization".into())]);
    let tickets = actor.immediate("authorization.cache.list", &json!({"owner":owner})).unwrap();
    let ticket = tickets[0].as_str().unwrap();
    assert!(actor.immediate("authorization.cache.ack", &json!({"owner":owner,"ticket":ticket})).is_err());
    assert!(actor.immediate("authorization.cache.claim", &json!({"owner":"forged","ticket":ticket})).is_err());
    assert_eq!(actor.immediate("authorization.cache.claim", &json!({"owner":owner,"ticket":ticket})).unwrap(), json!({"connectionID":"synthetic-host","authorizationID":"synthetic-authorization"}));
    vault.fail.store(true, Ordering::Relaxed);
    assert!(actor.immediate("authorization.cache.ack", &json!({"owner":owner,"ticket":ticket})).is_err());
    assert_eq!(history_retirement::pending(&State::load(&vault, false).unwrap()).unwrap().len(), 1);
    vault.fail.store(false, Ordering::Relaxed);
    assert_eq!(actor.immediate("authorization.cache.ack", &json!({"owner":owner,"ticket":ticket})).unwrap(), json!(true));
    assert_eq!(actor.immediate("authorization.cache.list", &json!({"owner":owner})).unwrap(), json!([]));
    let restored = State::load(&vault, false).unwrap();
    assert!(restored.extra.get("historyRetirements").is_none());
}

#[test]
fn authorization_cache_cleanup_recovers_after_restart_and_rejects_old_tickets() {
    let (mut actor, vault, network) = actor();
    let first = actor.immediate("authorization.cache.ready", &json!({})).unwrap();
    let mut next = actor.state().clone();
    next.connections[0].authorization = "new-authorization".into();
    actor.commit(next, true).unwrap();
    let old_owner = first["owner"].as_str().unwrap();
    let old_tickets = actor.immediate("authorization.cache.list", &json!({"owner":old_owner})).unwrap();
    let old_ticket = old_tickets[0].as_str().unwrap();
    let (tx, _) = mpsc::sync_channel(QUEUE);
    let mut restarted = Actor::new(HostChannel::default(), tx, Box::new(vault), network);
    restarted.load().unwrap();
    let ready = restarted.immediate("authorization.cache.ready", &json!({})).unwrap();
    assert_eq!(ready["tickets"].as_array().unwrap().len(), 1);
    assert!(restarted.immediate("authorization.cache.claim", &json!({"owner":old_owner,"ticket":old_ticket})).is_err());
    let owner = ready["owner"].as_str().unwrap();
    let ticket = ready["tickets"][0].as_str().unwrap();
    assert_eq!(restarted.immediate("authorization.cache.claim", &json!({"owner":owner,"ticket":ticket})).unwrap(), json!({"connectionID":"synthetic-host","authorizationID":"synthetic-authorization"}));
}

#[test]
fn installed_tabs_follow_committed_publication_preserve_metadata_and_cannot_revive_after_shutdown()
{
    let (mut actor, vault, _) = actor();
    let tabs = crate::desktop_tab::Registration::default();
    assert_eq!(tabs.current_scope(), None);
    actor.services.install_tabs(tabs.clone()).unwrap();
    let original = actor.state().scope.clone().unwrap();
    assert_eq!(tabs.current_scope(), Some(original.clone()));
    actor.immediate("connection.list", &json!({})).unwrap();
    let mut metadata = actor.state().clone();
    metadata.connections[0].label = "Synthetic metadata rename".into();
    actor.commit(metadata, false).unwrap();
    assert_eq!(tabs.current_scope(), Some(original.clone()));
    vault.fail.store(true, Ordering::Relaxed);
    assert!(
        actor
            .immediate("connection.remove", &json!({"id":"synthetic-host"}))
            .is_err()
    );
    assert_eq!(tabs.current_scope(), Some(original.clone()));
    vault.fail.store(false, Ordering::Relaxed);
    let next = actor.state().clone();
    actor.commit(next, true).unwrap();
    let current = actor.state().scope.clone().unwrap();
    assert_ne!(current, original);
    assert_eq!(tabs.current_scope(), Some(current.clone()));
    actor.services.invalidate();
    assert_eq!(tabs.current_scope(), None);
    actor.authorize_services();
    assert_eq!(tabs.current_scope(), Some(current));
    actor.services.shutdown();
    assert_eq!(tabs.current_scope(), None);
    actor.authorize_services();
    assert_eq!(
        tabs.current_scope(),
        None,
        "late committed publication cannot revive a shut down window"
    );
    assert!(actor.services.install_tabs(tabs).is_err());
}
#[test]
fn secure_roundtrip_keeps_credentials_out_of_snapshot_and_rotates_cold_lease() {
    let store = MemoryVault::default();
    let original = state();
    original.persist(&store).unwrap();
    let restored = State::load(&store, false).unwrap();
    assert_eq!(restored.current().unwrap().token, "synthetic-test-token");
    assert_eq!(original.selected, restored.selected);
    assert_ne!(original.scope, restored.scope);
    let public = restored.snapshot().to_string();
    assert!(!public.contains("synthetic-test-token"));
    assert!(!public.contains("Bearer"));
}
#[test]
fn failed_secure_write_preserves_authority_and_streams() {
    let (mut actor, store, network) = actor();
    let snapshot = actor.state().snapshot();
    let scope = snapshot["runtimeScope"].clone();
    let browser = actor.browser.capture(&scope).unwrap();
    actor
        .immediate(
            "runtime.stream",
            &json!({"key":"global","path":"/api/yuri/events","expectedHost":scope}),
        )
        .unwrap();
    store.fail.store(true, Ordering::Relaxed);
    assert!(
        actor
            .immediate("connection.remove", &json!({"id":"synthetic-host"}))
            .is_err()
    );
    assert_eq!(actor.state().snapshot(), snapshot);
    assert_eq!(actor.streams.len(), 1);
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 0);
    assert!(browser.current());
}

#[test]
fn browser_authority_restores_once_and_changes_only_after_durable_commit_before_job_retirement() {
    struct ProbeVault {
        store: MemoryVault,
        browser: crate::browser_view::Capture,
    }
    impl Vault for ProbeVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            assert!(
                self.browser.current(),
                "old authority survives until durable write succeeds"
            );
            self.store.write(bytes)
        }
    }
    struct Retirement(crate::browser_view::Capture, MemoryVault, Arc<AtomicBool>);
    impl FetchTask for Retirement {
        fn send(&mut self, _: Vec<u8>) {}
        fn finish(&mut self) {}
        fn pause(&mut self, _: bool) {}
        fn cancel(self: Box<Self>) {
            assert!(
                !self.0.current(),
                "browser must be fenced before HTTP/lease retirement"
            );
            let durable: Value = serde_json::from_slice(&self.1.read().unwrap().unwrap()).unwrap();
            assert_eq!(durable["connections"][0]["token"], "synthetic-new-token");
            self.2.store(true, Ordering::Release);
        }
    }
    struct RetirementNetwork(crate::browser_view::Capture, MemoryVault, Arc<AtomicBool>);
    impl Network for RetirementNetwork {
        fn fetch(&self, _: HttpRequest, _: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
            Box::new(Retirement(self.0.clone(), self.1.clone(), self.2.clone()))
        }
    }
    let (mut actor, store, network) = actor();
    let old_scope = actor.state().scope.clone().unwrap();
    let old = actor.browser.capture(&old_scope).unwrap();
    actor.load().unwrap();
    actor.immediate("connection.list", &json!({})).unwrap();
    assert!(
        old.current(),
        "list/load must not repeatedly rotate browser authority"
    );
    actor.vault = Box::new(ProbeVault {
        store: store.clone(),
        browser: old.clone(),
    });
    let retired = Arc::new(AtomicBool::new(false));
    actor.network = Arc::new(RetirementNetwork(old.clone(), store, retired.clone()));
    actor.request(
        json!({"path":"/api/config/settings","expectedHost":old_scope}),
        HostReply::default(),
    );
    let mut next = actor.state().clone();
    next.connections[0].token = "synthetic-new-token".into();
    next.connections[0].url = "https://new-host.invalid".into();
    let snapshot = actor.commit(next, true).unwrap();
    assert!(retired.load(Ordering::Acquire));
    assert!(!old.current());
    assert!(actor.browser.capture(&old_scope).is_err());
    let capture = actor.browser.capture(&snapshot["runtimeScope"]).unwrap();
    let pending = crate::browser_view::Preparing::begin(
        capture,
        "synthetic-owner".into(),
        crate::browser_view::Intent::Html {
            directory: "/work".into(),
            path: "/work/index.html".into(),
        },
    )
    .unwrap();
    assert!(pending.is_ok());
    let requests = network.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url,
        "https://new-host.invalid/api/fs/stat?path=%2Fwork%2Findex.html"
    );
    assert!(
        requests[0]
            .headers
            .contains(&("Authorization".into(), "Bearer synthetic-new-token".into()))
    );
    assert!(!snapshot.to_string().contains("synthetic-new-token"));
}

#[test]
fn browser_unavailable_does_not_rollback_connection_and_unrelated_commit_preserves_capture() {
    let (mut actor, store, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    let old = actor.browser.capture(&scope).unwrap();
    let mut next = actor.state().clone();
    let mut other = connection();
    other.id = "other".into();
    other.url = "https://other.invalid".into();
    next.connections.push(other);
    actor.commit(next, false).unwrap();
    actor
        .immediate("connection.remove", &json!({"id":"other"}))
        .unwrap();
    assert!(old.current());
    let mut next = actor.state().clone();
    next.connections[0].token.clear();
    let committed = actor.commit(next, true).unwrap();
    assert_eq!(committed["selected"], "synthetic-host");
    assert!(!old.current());
    assert!(actor.browser.capture(&committed["runtimeScope"]).is_err());
    let durable: Value = serde_json::from_slice(&store.read().unwrap().unwrap()).unwrap();
    assert_eq!(durable["connections"][0]["token"], "");
    actor.request(
        json!({"path":"/api/config/settings","expectedHost":committed["runtimeScope"]}),
        HostReply::default(),
    );
    let requests = network.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(
        !requests[0]
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("authorization"))
    );
}

#[test]
fn browser_selected_removal_and_shutdown_fence_pending_commit_publication() {
    let (mut actor, _, _) = actor();
    let scope = actor.state().scope.clone().unwrap();
    let prior = actor.browser.capture(&scope).unwrap();
    actor
        .immediate("connection.remove", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert!(!prior.current());
    assert!(actor.browser.capture(&scope).is_err());

    struct BlockedVault {
        store: MemoryVault,
        entered: SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl Vault for BlockedVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            self.store.write(bytes)
        }
    }
    let (mut actor, store, _) = self::actor();
    let browser = actor.browser.clone();
    let prior = browser
        .capture(actor.state().scope.as_ref().unwrap())
        .unwrap();
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, blocked) = mpsc::sync_channel(1);
    actor.vault = Box::new(BlockedVault {
        store,
        entered,
        release: Mutex::new(blocked),
    });
    let owner = Owner {
        shutting_down: false,
        shared_lane: false,
        tx: actor.tx.clone(),
        stop: Arc::new(AtomicBool::new(false)),
        actor_stop: Arc::new(AtomicBool::new(false)),
        actor_done: Arc::new(AtomicBool::new(false)),
        services: actor.services.clone(),
        attachments: None,
        ssh: None,
        native_port: crate::connection_actor_port::Port::new(Arc::new(|_| {
            Err(crate::connection_actor_port::Error::Busy)
        })),
        native_http_port: crate::connection_actor_http_port::Port::new(Arc::new(|_| {
            Err(crate::connection_actor_http_port::Error::Busy)
        })),
    };
    let worker = std::thread::spawn(move || {
        let next = actor.state().clone();
        actor.commit(next, true).unwrap()
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(owner);
    assert!(
        !prior.current(),
        "owner shutdown is a synchronous authority fence"
    );
    release.send(()).unwrap();
    let committed = worker.join().unwrap();
    assert_eq!(committed["selected"], "synthetic-host");
    assert!(
        browser.capture(&committed["runtimeScope"]).is_err(),
        "late durable commit cannot resurrect browser authority"
    );
}

#[test]
fn uncertain_commit_or_external_store_conflict_revokes_all_runtime_authority() {
    struct Uncertain(&'static str);
    impl Vault for Uncertain {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("quarantined actor must not silently reload or reuse authority")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            Err(self.0.into())
        }
    }
    for error in [vault::COMMIT_UNKNOWN, vault::CONFLICT] {
        let (mut actor, _, network) = actor();
        let scope = actor.state().scope.clone().unwrap();
        let browser = actor.browser.capture(&scope).unwrap();
        actor
            .immediate(
                "runtime.stream",
                &json!({"key":"global","path":"/api/yuri/events","expectedHost":scope}),
            )
            .unwrap();
        actor.vault = Box::new(Uncertain(error));
        assert_eq!(
            actor
                .immediate("connection.remove", &json!({"id":"synthetic-host"}))
                .unwrap_err(),
            error
        );
        assert!(actor.quarantined);
        assert!(actor.state.is_none());
        assert!(actor.streams.is_empty());
        assert!(!browser.current());
        assert!(actor.browser.capture(&scope).is_err());
        let before = network.requests.lock().unwrap().len();
        actor.call(
            "runtime.request",
            json!({"path":"/api/config/settings","expectedHost":scope}),
            HostReply::default(),
        );
        actor.call("connection.list", json!({}), HostReply::default());
        assert_eq!(network.requests.lock().unwrap().len(), before);
        assert_eq!(actor.load().unwrap_err(), vault::COMMIT_UNKNOWN);
    }
}
#[test]
fn mutation_admission_requires_exact_current_scope_before_dispatch() {
    let (mut actor, _, network) = actor();
    let old = actor.state().scope.clone().unwrap();
    actor.request(
        json!({"path":"/api/write","method":"POST","body":{"value":1}}),
        HostReply::default(),
    );
    assert!(network.requests.lock().unwrap().is_empty());
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    actor.request(
        json!({"path":"/api/write","method":"POST","expectedHost":old}),
        HostReply::default(),
    );
    assert!(network.requests.lock().unwrap().is_empty());
    let scope = actor.state().scope.clone().unwrap();
    actor.request(json!({"path":"/api/write?opaque=a%2Bb","method":"PATCH","body":{"value":1},"expectedHost":scope}),HostReply::default());
    let requests = network.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "PATCH");
    assert_eq!(
        requests[0].url,
        "https://host.invalid/api/write?opaque=a%2Bb"
    );
    assert!(!requests[0].follow_redirects);
    assert!(
        requests[0]
            .headers
            .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
    );
}
#[test]
fn old_stream_cleanup_cannot_cancel_new_lease_same_key() {
    let (mut actor, _, network) = actor();
    let old = actor.state().scope.clone().unwrap();
    actor
        .immediate(
            "runtime.stream",
            &json!({"key":"chat","path":"/api/event?directory=%2Fsynthetic","expectedHost":old}),
        )
        .unwrap();
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    let current = actor.state().scope.clone().unwrap();
    actor.immediate("runtime.stream",&json!({"key":"chat","path":"/api/event?directory=%2Fsynthetic","expectedHost":current})).unwrap();
    actor
        .immediate("runtime.stop", &json!({"key":"chat","expectedHost":old}))
        .unwrap();
    assert_eq!(actor.streams.len(), 1);
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
    actor
        .immediate(
            "runtime.stop",
            &json!({"key":"chat","expectedHost":current}),
        )
        .unwrap();
    assert!(actor.streams.is_empty());
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 2);
}
#[test]
fn invalid_replacement_stream_does_not_cancel_existing_stream() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    actor
        .immediate(
            "runtime.stream",
            &json!({"key":"global","path":"/api/yuri/events","expectedHost":scope}),
        )
        .unwrap();
    assert!(
        actor
            .immediate(
                "runtime.stream",
                &json!({"key":"global","path":"/api/other","expectedHost":scope})
            )
            .is_err()
    );
    assert_eq!(actor.streams.len(), 1);
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 0);
}
#[test]
fn selecting_cancels_inflight_http_and_rejects_stale_completion() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    actor.request(
        json!({"path":"/api/read","expectedHost":scope}),
        HostReply::default(),
    );
    let id = *actor.jobs.keys().next().unwrap();
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert!(actor.jobs.is_empty());
    actor.event(id, FetchEvent::End);
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
    assert_ne!(actor.state().scope.as_ref(), Some(&scope));
}
#[test]
fn remove_has_no_implicit_fallback_selection() {
    let (mut actor, _, _) = actor();
    let snapshot = actor
        .immediate("connection.remove", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert!(snapshot["selected"].is_null());
    assert!(snapshot["runtimeScope"].is_null());
    assert!(actor.state().admit(None, false).is_err());
}
#[test]
fn pairing_reauthorization_and_custom_headers_never_dispatch() {
    let (mut actor, _, network) = actor();
    for value in [
        json!({"pairingLink":"yuri://connect?v=2&p=synthetic"}),
        json!({"url":"https://host.invalid","id":"existing","version":"v1"}),
        json!({"url":"https://host.invalid","token":"bad\r\nheader"}),
    ] {
        actor.connect(value, HostReply::default());
    }
    actor.request(
        json!({"path":"/api/x","headers":{"Authorization":"attacker"}}),
        HostReply::default(),
    );
    assert!(network.requests.lock().unwrap().is_empty());
}
#[test]
fn limits_and_content_type_fail_closed() {
    let (mut actor, _, _) = actor();
    actor.request(json!({"path":"/api/x"}), HostReply::default());
    let id = *actor.jobs.keys().next().unwrap();
    actor.event(
        id,
        FetchEvent::Head(HttpHead {
            status: 200,
            url: "https://host.invalid/api/x".into(),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("content-length".into(), (BODY_LIMIT + 1).to_string()),
            ],
            ..Default::default()
        }),
    );
    assert!(actor.jobs.is_empty());
    let head = HttpHead {
        status: 200,
        headers: vec![("Content-Type".into(), "text/html".into())],
        ..Default::default()
    };
    assert!(response_head(&head, "/api/x", false).is_err());
    let head = HttpHead {
        status: 302,
        headers: vec![("content-type".into(), "application/json".into())],
        ..Default::default()
    };
    assert!(response_head(&head, "/api/x", false).is_err());
    let head = HttpHead {
        status: 200,
        headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        ..Default::default()
    };
    assert_eq!(
        decode(Some(&head), "/api/fs/read?path=x", b"synthetic").unwrap(),
        (200, json!("synthetic"))
    );
    assert!(decode(Some(&head), "/api/fs/read", &[255]).is_err());
}
#[test]
fn sse_parser_preserves_split_utf8_crlf_multiline_and_bounds() {
    let mut parser = Sse::default();
    let text = "data: 合成\r\ndata: second\r\n\r\n";
    let mut events = Vec::new();
    for byte in text.as_bytes() {
        events.extend(parser.consume(&[*byte]).unwrap());
    }
    assert_eq!(events, vec!["合成\nsecond"]);
    let mut parser = Sse::default();
    assert!(parser.consume(&vec![b'x'; 2_000_001]).is_err());
    assert!(Sse::default().consume(&[255, 10]).is_err());
}
#[test]
fn corrupt_secure_state_is_failure_not_empty_success() {
    let store = MemoryVault::default();
    *store.bytes.lock().unwrap() = Some(b"not-json".to_vec());
    assert!(State::load(&store, false).is_err());
    let mut value = state();
    value.connections.push(connection());
    value.persist(&store).unwrap();
    assert!(State::load(&store, false).is_err());
}

#[test]
fn password_exchange_stays_native_and_commits_only_after_authorized_probe() {
    let (mut actor, store, network) = actor();
    let prior = actor.state().snapshot();
    actor.connect(json!({"url":"https://new.invalid","password":"synthetic-password","token":"unused-input-token"}), HostReply::default());
    {
        let requests = network.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url, "https://new.invalid/auth/session");
        assert!(
            !requests[0]
                .headers
                .iter()
                .any(|(key, _)| key == "Authorization")
        );
        let nsh_core::platform::HttpBody::Bytes(bytes) = &requests[0].body else {
            panic!("JSON body missing")
        };
        let body: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(body["password"], "synthetic-password");
        assert_eq!(body["issueClientToken"], true);
    }
    fn finish(actor: &mut Actor, url: &str, body: &[u8]) {
        let id = *actor.jobs.keys().next().unwrap();
        actor.event(
            id,
            FetchEvent::Head(HttpHead {
                status: 200,
                url: url.into(),
                headers: vec![("Content-Type".into(), "application/json".into())],
                ..Default::default()
            }),
        );
        actor.event(id, FetchEvent::Data(body.to_vec()));
        actor.event(id, FetchEvent::End);
    }
    finish(
        &mut actor,
        "https://new.invalid/auth/session",
        br#"{"clientToken":"synthetic-exchanged-token"}"#,
    );
    assert_eq!(actor.state().snapshot(), prior);
    {
        let requests = network.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].headers.contains(&(
            "Authorization".into(),
            "Bearer synthetic-exchanged-token".into()
        )));
    }
    // Even an authorized Host cannot switch the app if the atomic credential write fails.
    store.fail.store(true, Ordering::Relaxed);
    finish(
        &mut actor,
        "https://new.invalid/api/config/settings",
        br#"{"ok":true}"#,
    );
    assert_eq!(actor.state().snapshot(), prior);
    assert!(
        !actor
            .state()
            .snapshot()
            .to_string()
            .contains("synthetic-exchanged-token")
    );
}

#[test]
fn response_without_content_length_still_obeys_incremental_limit() {
    let (mut actor, _, network) = actor();
    actor.request(json!({"path":"/api/x"}), HostReply::default());
    let id = *actor.jobs.keys().next().unwrap();
    actor.event(
        id,
        FetchEvent::Head(HttpHead {
            status: 200,
            url: "https://host.invalid/api/x".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }),
    );
    actor
        .jobs
        .get_mut(&id)
        .unwrap()
        .bytes
        .resize(BODY_LIMIT, b' ');
    actor.event(id, FetchEvent::Data(vec![b'x']));
    assert!(actor.jobs.is_empty());
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
}

#[test]
fn synchronous_network_burst_never_blocks_or_reports_incomplete_success() {
    struct BurstNetwork(Arc<AtomicUsize>);
    impl Network for BurstNetwork {
        fn fetch(&self, _: HttpRequest, mut sink: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
            for _ in 0..QUEUE + 1 {
                sink(FetchEvent::Data(vec![0]));
            }
            sink(FetchEvent::End);
            Box::new(FakeTask(self.0.clone()))
        }
    }
    let (tx, _rx) = mpsc::sync_channel(QUEUE);
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let cancelled = Arc::new(AtomicUsize::new(0));
    let mut actor = Actor::new(
        HostChannel::default(),
        tx,
        Box::new(store),
        Arc::new(BurstNetwork(cancelled.clone())),
    );
    actor.load().unwrap();
    actor.request(json!({"path":"/api/x"}), HostReply::default());
    assert!(
        actor
            .jobs
            .values()
            .next()
            .unwrap()
            .overflow
            .load(Ordering::Acquire)
    );
    actor.tick();
    assert!(actor.jobs.is_empty());
    assert_eq!(cancelled.load(Ordering::Relaxed), 1);
}

#[test]
fn metadata_and_disabled_diagnostics_never_read_the_credential_vault() {
    struct NoRead;
    impl Vault for NoRead {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("local metadata must not read credentials")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("local metadata must not write credentials")
        }
    }
    let host = HostChannel::default();
    let caps = json!({"host":["native.clientMetadata","native.diagnostics.status","native.diagnostics.setEnabled"]});
    let _owner = install_configured(
        &host,
        &caps,
        Box::new(NoRead),
        Arc::new(FakeNetwork::default()),
        false,
        appearance::metadata(&json!({"version":"1.2.3-beta.1","build":42})),
        appearance::Port::unavailable(),
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut c| {
        tx.send(c.take_data()).unwrap();
    });
    let _engine=engine(host,r#"import {host} from 'nsh';
      (async()=>{const m=await host.call('native.clientMetadata',{});const s=await host.call('native.diagnostics.status',{});const d=await host.call('native.diagnostics.setEnabled',{enabled:false});let rejected=false;try{await host.call('native.diagnostics.setEnabled',{enabled:true});}catch{rejected=true;}host.post('test.result',{ok:m.version==='1.2.3-beta.1'&&m.build==='42'&&m.updates.status==='unsupported'&&!s.enabled&&s.recordingLease===null&&s.eventCount===0&&!d.enabled&&rejected});})().catch(e=>host.post('test.result',{error:String(e)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
}

#[test]
fn cancelling_one_resource_read_preserves_other_pending_owner_and_scope_fence() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    actor.resource_read(
        json!({"path":"/synthetic/a.md","requestId":"a","expectedHost":scope}),
        HostReply::default(),
    );
    actor.resource_read(
        json!({"path":"/synthetic/b.md","requestId":"b","expectedHost":scope}),
        HostReply::default(),
    );
    let a = *actor
        .jobs
        .iter()
        .find(|(_, j)| matches!(&j.completion,Completion::Resource {read,..} if read.request=="a"))
        .unwrap()
        .0;
    let b = *actor
        .jobs
        .iter()
        .find(|(_, j)| matches!(&j.completion,Completion::Resource {read,..} if read.request=="b"))
        .unwrap()
        .0;
    actor.call(
        "resources.cancel",
        json!({"requestId":"a","expectedHost":{"hostID":"other","lease":scope["lease"]}}),
        HostReply::default(),
    );
    assert_eq!(actor.jobs.len(), 2);
    actor.call(
        "resources.cancel",
        json!({"requestId":"a"}),
        HostReply::default(),
    );
    assert!(!actor.jobs.contains_key(&a));
    assert!(actor.jobs.contains_key(&b));
    assert_eq!(network.cancelled.load(Ordering::Relaxed), 1);
    actor.event(a, FetchEvent::End);
    assert!(actor.jobs.contains_key(&b));
    actor.resource_read(
        json!({"path":"/synthetic/a.md","requestId":"a","expectedHost":scope}),
        HostReply::default(),
    );
    assert_eq!(network.requests.lock().unwrap().len(), 2);
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert!(actor.jobs.is_empty());
    actor.resource_read(
        json!({"path":"/synthetic/a.md","requestId":"new","expectedHost":scope}),
        HostReply::default(),
    );
    assert_eq!(network.requests.lock().unwrap().len(), 2);
}

#[test]
fn resource_stat_and_text_each_enforce_their_streaming_body_limit() {
    let (mut actor, _, _) = actor();
    let scope = actor.state().scope.clone().unwrap();
    actor.resource_read(
        json!({"path":"/synthetic/a.md","requestId":"a","expectedHost":scope}),
        HostReply::default(),
    );
    let id = *actor.jobs.keys().next().unwrap();
    assert_eq!(actor.jobs[&id].limit, resources::STAT_LIMIT);
    let url = actor.jobs[&id].url.clone();
    actor.event(
        id,
        FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }),
    );
    actor.event(id, FetchEvent::Data(vec![b' '; resources::STAT_LIMIT + 1]));
    assert!(actor.jobs.is_empty());
    actor.resource_read(
        json!({"path":"/synthetic/b.md","requestId":"b","expectedHost":scope}),
        HostReply::default(),
    );
    let id = *actor.jobs.keys().next().unwrap();
    let url = actor.jobs[&id].url.clone();
    actor.event(
        id,
        FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }),
    );
    actor.event(
        id,
        FetchEvent::Data(br#"{"isFile":true,"isBinary":false,"size":2}"#.to_vec()),
    );
    actor.event(id, FetchEvent::End);
    let id = *actor.jobs.keys().next().unwrap();
    assert_eq!(actor.jobs[&id].limit, resources::TEXT_LIMIT);
    let url = actor.jobs[&id].url.clone();
    actor.event(
        id,
        FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "text/plain".into())],
            ..Default::default()
        }),
    );
    actor.event(id, FetchEvent::Data(vec![b'x'; resources::TEXT_LIMIT + 1]));
    assert!(actor.jobs.is_empty());
}

#[test]
fn hostchannel_resources_and_appearance_use_real_owners_and_native_reply_not_events() {
    struct Files {
        requests: Arc<Mutex<Vec<HttpRequest>>>,
    }
    impl Network for Files {
        fn fetch(&self, r: HttpRequest, mut events: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
            assert!(
                r.headers
                    .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
            );
            assert!(!r.follow_redirects);
            let is_stat = r.url.contains("/api/fs/stat?");
            let mime = if is_stat {
                "application/json"
            } else {
                "text/plain"
            };
            let body = if is_stat {
                br#"{"isFile":true,"isBinary":false,"size":14}"#.to_vec()
            } else {
                b"synthetic text".to_vec()
            };
            self.requests.lock().unwrap().push(r.clone());
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url: r.url,
                headers: vec![("Content-Type".into(), mime.into())],
                ..Default::default()
            }));
            events(FetchEvent::Data(body));
            events(FetchEvent::End);
            Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
        }
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let host = HostChannel::default();
    let (port, inbox) = appearance::Port::channel();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let caps = json!({"host":["connection.list","resources.read","resources.cancel","resources.release","resources.close","appearance.reset","appearance.apply"]});
    let owner = install_configured(
        &host,
        &caps,
        Box::new(store),
        Arc::new(Files {
            requests: requests.clone(),
        }),
        false,
        appearance::metadata(&Value::Null),
        port,
    )
    .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let applications = Arc::new(AtomicUsize::new(0));
    let applied = applications.clone();
    // Synthetic UI owner tests the native mailbox and ACK/fence boundary, not AppKit rendering.
    let ui = std::thread::spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            inbox.drain(|command|match command {appearance::Command::Reset {revision}=>Ok(json!({"revision":revision})),appearance::Command::Apply(_)=>{applied.fetch_add(1,Ordering::Relaxed);Ok(json!({"uiFontFamily":"system-ui","monoFontFamily":"monospace","assistantFontFamilies":{"light":"system-ui","dark":"monospace"},"unsupportedFonts":[]}))}});
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut c| {
        tx.send(c.take_data()).unwrap();
    });
    let fixture = appearance::fixture("synthetic-host", 0);
    let source = format!(
        r#"import {{host}} from 'nsh';
      (async()=>{{const check=(v,m)=>{{if(!v)throw Error(m);}};const a=await host.call('connection.list',{{}});const expectedHost=a.runtimeScope;const r=await host.call('resources.read',{{path:'/synthetic/source.md',requestId:'resource-owner',expectedHost}});check(r.kind==='text'&&r.text==='synthetic text'&&r.lease&&r.size===14,'text lease');await host.call('resources.close',{{lease:r.lease}});await host.call('resources.cancel',{{requestId:'resource-owner'}});await host.call('resources.release',{{lease:r.lease}});let reused=false;try{{await host.call('resources.read',{{path:'/synthetic/source.md',requestId:'resource-owner',expectedHost}});}}catch{{reused=true;}}check(reused,'id reuse');const reset=await host.call('appearance.reset',{{hostID:a.selected}});const payload={fixture};payload.revision=reset.revision;const applied=await host.call('appearance.apply',payload);check(applied.uiFontFamily==='system-ui','native ack');payload.cssVars.light.background='url(https://invalid.example)';let invalid=false;try{{await host.call('appearance.apply',payload);}}catch{{invalid=true;}}check(invalid,'invalid tokens');host.post('test.result',{{ok:true}});}})().catch(e=>host.post('test.result',{{error:String(e)}}));"#,
        fixture = fixture
    );
    let engine = engine(host, source);
    let result = rx.recv_timeout(Duration::from_secs(5));
    stop.store(true, Ordering::Release);
    ui.join().unwrap();
    drop(engine);
    drop(owner);
    assert_eq!(result.unwrap(), json!({"ok":true}));
    assert_eq!(applications.load(Ordering::Relaxed), 1);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .url
            .ends_with("/api/fs/stat?path=%2Fsynthetic%2Fsource.md")
    );
    assert!(
        requests[1]
            .url
            .ends_with("/api/fs/read?path=%2Fsynthetic%2Fsource.md")
    );
}

struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
fn engine(host: HostChannel, source: String) -> Engine {
    let mut bundle = Bundle::source(source);
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap()
}

#[test]
fn product_manifest_grants_exact_download_v2_methods_to_the_installed_host_without_a_chooser() {
    let product: Value = serde_json::from_str(include_str!("../../nsh.json")).unwrap();
    let capabilities = &product["capabilities"];
    let names = capabilities["host"].as_array().unwrap();
    for method in crate::file_download::METHODS {
        assert_eq!(
            names
                .iter()
                .filter(|name| name.as_str() == Some(method))
                .count(),
            1
        );
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let host = HostChannel::default();
    let mut owner = install_with(
        &host,
        capabilities,
        Box::new(store),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let (port, inbox) = crate::file_download::channel();
    owner.services().install_file_download(&host, port).unwrap();
    let (tx, rx) = mpsc::channel();
    // Use an already granted, otherwise unsupported method only as the test result sink.
    host.handle("runtime.pickAttachment", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let mut bundle = Bundle::source(r#"import {host} from 'nsh';(async()=>{
      const check=(value)=>{if(!value)throw Error('product download grant');};
      const capability=await host.call('desktop.files.download.capabilities',{});
      check(capability.version===2&&capability.save&&typeof capability.windowID==='string');
      const saved=await host.call('connection.list',{});
      const input={ownerID:'product-owner',requestID:'product-request',windowID:capability.windowID,expectedHost:saved.runtimeScope};
      check((await host.call('desktop.files.download.save',{...input,directory:'/synthetic',path:'/synthetic/file.bin'})).state==='selecting');
      check((await host.call('desktop.files.download.status',input)).state==='selecting');
      await host.call('desktop.files.download.cancel',input);
      check((await host.call('desktop.files.download.status',input)).state==='cancelled');
      let denied=false;try{await host.call('desktop.files.download.resume',input);}catch{denied=true;}check(denied);
      host.post('runtime.pickAttachment',{ok:true});
    })().catch(()=>host.post('runtime.pickAttachment',{ok:false}));"#.into());
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(capabilities).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    assert!(
        inbox.try_recv().is_some(),
        "native job only; no system dialog was run"
    );
    owner.begin_shutdown();
    owner.begin_shutdown();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !owner.stopped() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!owner.services().live());
    drop(engine);
}

fn native_upload() -> attachments::Upload {
    let bytes = vec![0, 255, 13, 10, 65];
    attachments::Upload {
        path: "/api/fs/prompt-attachments/00000000-0000-4000-8000-000000000001?storage=temporary"
            .into(),
        headers: vec![
            ("Content-Type".into(), "application/octet-stream".into()),
            ("X-Yuri-Content-Length".into(), bytes.len().to_string()),
            ("X-Yuri-Sha256".into(), "a".repeat(64)),
            ("X-Yuri-Mime".into(), "application/octet-stream".into()),
            ("X-Yuri-Filename".into(), "synthetic.bin".into()),
        ],
        bytes,
    }
}
fn queue_upload(
    actor: &mut Actor,
    scope: Value,
    cancelled: bool,
) -> mpsc::Receiver<attachments::UploadResult> {
    let (reply, result) = mpsc::sync_channel(1);
    actor.upload(attachment_transport::Pending {
        scope,
        upload: native_upload(),
        cancelled: Arc::new(AtomicBool::new(cancelled)),
        reply,
    });
    result
}
#[test]
fn native_attachment_upload_is_raw_actor_owned_and_late_receipt_survives_logical_cancellation() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    let (reply, result) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    actor.upload(attachment_transport::Pending {
        scope,
        upload: native_upload(),
        cancelled: cancelled.clone(),
        reply,
    });
    let requests = network.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method, "PUT");
    assert!(!request.follow_redirects);
    assert!(
        request
            .headers
            .contains(&("Authorization".into(), "Bearer synthetic-test-token".into()))
    );
    assert!(
        matches!(&request.body,nsh_engine::HttpBody::Bytes(bytes) if bytes==&vec![0,255,13,10,65])
    );
    let url = request.url.clone();
    drop(requests);
    cancelled.store(true, Ordering::Release);
    let ticket = *actor.jobs.keys().next().unwrap();
    assert_eq!(actor.jobs[&ticket].limit, attachments::WIRE_LIMIT);
    actor.event(
        ticket,
        FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }),
    );
    actor.event(
        ticket,
        FetchEvent::Data(br#"{"success":true,"synthetic":true}"#.to_vec()),
    );
    actor.event(ticket, FetchEvent::End);
    let attachments::UploadResult::Response { status, body } =
        result.recv_timeout(Duration::from_secs(1)).unwrap()
    else {
        panic!("known late receipt was lost")
    };
    assert_eq!(status, 200);
    assert_eq!(body, json!({"success":true,"synthetic":true}));
    assert!(!body.to_string().contains("synthetic-test-token"));
}
#[test]
fn native_attachment_preflight_denial_never_dispatches_and_retirement_or_timeout_never_replays() {
    let (mut actor, _, network) = actor();
    let scope = actor.state().scope.clone().unwrap();
    let mut stale = scope.clone();
    stale["lease"] = json!("00000000-0000-4000-8000-000000000099");
    for (scope, cancelled) in [(stale, false), (scope.clone(), true)] {
        assert!(matches!(
            queue_upload(&mut actor, scope, cancelled).recv().unwrap(),
            attachments::UploadResult::Denied
        ));
    }
    let mut upload = native_upload();
    upload.headers[0] = ("Authorization".into(), "forbidden-caller-header".into());
    assert!(attachment_transport::request(&connection(), upload).is_err());
    let mut upload = native_upload();
    upload.path = "/api/fs/read?path=%2Fetc%2Fpasswd".into();
    assert!(attachment_transport::request(&connection(), upload).is_err());
    assert!(network.requests.lock().unwrap().is_empty());
    let result = queue_upload(&mut actor, scope.clone(), false);
    actor
        .immediate("connection.select", &json!({"id":"synthetic-host"}))
        .unwrap();
    assert!(matches!(
        result.recv().unwrap(),
        attachments::UploadResult::Unknown
    ));
    assert!(matches!(
        queue_upload(&mut actor, scope, false).recv().unwrap(),
        attachments::UploadResult::Denied
    ));
    assert_eq!(network.requests.lock().unwrap().len(), 1);
    let scope = actor.state().scope.clone().unwrap();
    let result = queue_upload(&mut actor, scope, false);
    for job in actor.jobs.values_mut() {
        job.deadline = Instant::now() - Duration::from_secs(1);
    }
    actor.tick();
    assert!(matches!(
        result.recv().unwrap(),
        attachments::UploadResult::Unknown
    ));
    actor.tick();
    assert_eq!(network.requests.lock().unwrap().len(), 2);
}

#[test]
fn real_host_actor_authority_drives_terminal_http_sse_and_raw_attachment_without_ui_or_vault() {
    use crate::attachments::Transport;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (seen, received) = mpsc::channel();
    let hold = Arc::new(AtomicBool::new(true));
    let holding = hold.clone();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut workers = Vec::new();
        while workers.len() < 5 && started.elapsed() < Duration::from_secs(15) {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("synthetic accept failed: {error}"),
            };
            let seen = seen.clone();
            let holding = holding.clone();
            workers.push(std::thread::spawn(move || {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader=BufReader::new(stream);let mut first=String::new();reader.read_line(&mut first).unwrap();
                let mut length=0;let mut authorization=false;let mut content_type=String::new();
                loop {let mut line=String::new();reader.read_line(&mut line).unwrap();if line=="\r\n" {break;}
                    let (key,value)=line.split_once(':').unwrap();
                    if key.eq_ignore_ascii_case("authorization") {authorization=value.trim()=="Bearer synthetic-test-token";}
                    if key.eq_ignore_ascii_case("content-length") {length=value.trim().parse().unwrap();}
                    if key.eq_ignore_ascii_case("content-type") {content_type=value.trim().to_owned();}
                }
                assert!(authorization);let mut bytes=vec![0;length];reader.read_exact(&mut bytes).unwrap();
                let body=if first.contains("/create ") {assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap()["cwd"],"C:/Synthetic/项目");json!({"sessionId":"synthetic-terminal","capabilities":{"stream":{"preferred":"sse","transports":["sse"]},"input":{"preferred":"http","transports":["http"]}}}).to_string()}
                    else if first.contains("/input ") {assert!(content_type.starts_with("text/plain"));assert_eq!(bytes,"中\0\r\n".as_bytes());json!({"success":true}).to_string()}
                    else if first.contains("/resize ") {assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(),json!({"cols":140,"rows":40}));json!({"success":true}).to_string()}
                    else if first.starts_with("PUT /api/fs/prompt-attachments/") {assert_eq!(bytes,vec![0,255,13,10,65]);assert_eq!(content_type,"application/octet-stream");json!({"success":true,"nativeBytes":5}).to_string()}
                    else if first.contains("/stream ") {String::new()}
                    else {panic!("unexpected synthetic method or route");};
                seen.send(first.clone()).unwrap();
                if first.contains("/stream ") {
                    let body="data: {\"type\":\"connected\"}\n\ndata: {\"type\":\"data\",\"data\":\"native-terminal-output\"}\n\n";
                    write!(reader.get_mut(),"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n",body.len()).unwrap();reader.get_mut().flush().unwrap();
                    let started=Instant::now();while holding.load(Ordering::Acquire) && started.elapsed()<Duration::from_secs(10) {std::thread::sleep(Duration::from_millis(10));}
                } else {write!(reader.get_mut(),"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();}
            }));
        }
        assert_eq!(workers.len(), 5);
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let store = MemoryVault::default();
    let mut saved = state();
    saved.connections[0].url = origin;
    saved.persist(&store).unwrap();
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.select","terminal.capabilities","terminal.create","terminal.attach","terminal.input","terminal.resize","terminal.close","terminal.desktop.capabilities","desktop.attachments.status"]});
    let mut owner = install_with(
        &host,
        &caps,
        Box::new(store),
        nsh_engine::net::network(),
        true,
    )
    .unwrap();
    let catalog_dir =
        std::env::temp_dir().join(format!("synthetic-host-services-{}", vault::id().unwrap()));
    std::fs::create_dir(&catalog_dir).unwrap();
    let catalog = catalog_dir.join("terminal.json");
    owner
        .services()
        .install_terminal(
            &host,
            crate::terminal_viewport::Registration::default(),
            catalog.clone(),
        )
        .unwrap();
    let (picker, _picks) = attachments::channel();
    owner.install_attachments(&host, picker).unwrap();
    let (result, done) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = result.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';
      (async()=>{const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;
        const capability=await host.call('terminal.capabilities',{expectedHost});check(capability.httpInput&&capability.sseOutput&&capability.wsAvailable,'real capability');
        const base={expectedHost,owner:'synthetic-tab',directory:'C:/Synthetic/项目'};
        const created=await host.call('terminal.create',{...base,cols:120,rows:36});check(created.sessionId==='synthetic-terminal','create');
        const connected=new Promise(resolve=>host.on('terminal.event',value=>{if(value.type==='connected')resolve(value);}));
        const data=new Promise(resolve=>host.on('terminal.event',value=>{if(value.type==='data')resolve(value);}));
        await host.call('terminal.attach',{...base,sessionId:created.sessionId,attachment:1});
        const event=await connected;check(event.replayUnavailable===true&&event.expectedHost.lease===expectedHost.lease,'SSE authority');check((await data).data==='native-terminal-output','SSE output');
        check(await host.call('terminal.input',{...base,sessionId:created.sessionId,data:'中\0\r\n'})===true,'text input');
        check(await host.call('terminal.resize',{...base,sessionId:created.sessionId,cols:140,rows:40})===true,'resize');
        const next=await host.call('connection.select',{id:saved.selected});let stale=false;try{await host.call('terminal.close',{...base,sessionId:created.sessionId});}catch{stale=true;}check(stale,'retired close');
        host.post('test.result',{ok:true,scope:next.runtimeScope});
      })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    let result = done.recv_timeout(Duration::from_secs(15)).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    let transport = attachment_transport::NativeTransport {
        tx: owner.tx.clone(),
        authority: owner.services.reader(),
        stop: owner.stop.clone(),
    };
    let uploaded = transport.upload(&result["scope"], native_upload(), &AtomicBool::new(false));
    let attachments::UploadResult::Response { status, body } = uploaded else {
        panic!("native bytes upload not confirmed")
    };
    assert_eq!(status, 200);
    assert_eq!(body, json!({"success":true,"nativeBytes":5}));
    drop(engine);
    drop(owner);
    hold.store(false, Ordering::Release);
    server.join().unwrap();
    let seen: Vec<_> = received.try_iter().collect();
    assert_eq!(seen.len(), 5);
    assert!(
        !seen.iter().any(|line| line.starts_with("DELETE ")),
        "retiring a lease must detach, not kill a PTY"
    );
    let metadata = std::fs::read_to_string(&catalog).unwrap();
    assert!(!metadata.contains("synthetic-test-token"));
    assert!(!metadata.contains("native-terminal-output"));
    std::fs::remove_file(catalog).unwrap();
    std::fs::remove_dir(catalog_dir).unwrap();
}

#[test]
fn real_hostchannel_and_nsh_network_synthetic_loopback_vertical_slice() {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let redirected = TcpListener::bind("127.0.0.1:0").unwrap();
    redirected.set_nonblocking(true).unwrap();
    let forbidden = format!(
        "http://127.0.0.1:{}/capture",
        redirected.local_addr().unwrap().port()
    );
    let (seen_tx, seen_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        for _ in 0..5 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let mut authorization = false;
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                let (key, value) = line.split_once(':').unwrap();
                if key.eq_ignore_ascii_case("authorization") {
                    authorization = value.trim() == "Bearer synthetic-test-token";
                }
                if key.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            assert!(authorization, "synthetic bearer header missing");
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            if first.starts_with("POST ") {
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap(),
                    json!({"synthetic":true})
                );
            }
            seen_tx.send(first.clone()).unwrap();
            let response = if first.contains("/api/redirect ") {
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {forbidden}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                )
            } else if first.contains("/api/yuri/events ") {
                let body = "data: {\"synthetic\":true}\r\n\r\n";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".to_owned()
            };
            reader.get_mut().write_all(response.as_bytes()).unwrap();
        }
    });
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.connect","connection.select","connection.remove","runtime.request","runtime.stream","runtime.stop","appearance.apply"]});
    let _owner = install_with(
        &host,
        &caps,
        Box::new(MemoryVault::default()),
        nsh_engine::net::network(),
        true,
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let source = format!(
        r#"
        import {{ host }} from 'nsh';
        const check = (value, message) => {{ if (!value) throw new Error(message); }};
        async function rejects(name, value) {{ let rejected=false; try {{ await host.call(name,value); }} catch {{ rejected=true; }} check(rejected, 'must reject '+name); }}
        async function run() {{
          check(host.available(),'real host unavailable');
          const empty=await host.call('connection.list',{{}}); check(empty.selected === null,'initial');
          const a=await host.call('connection.connect',{{url:{origin},token:'synthetic-test-token',label:'Synthetic'}});
          check(a.runtimeInvalidated && a.selected && a.runtimeScope,'connect');
          check(!JSON.stringify(a).includes('synthetic-test-token'),'credential leaked');
          const expectedHost=a.runtimeScope;
          await rejects('runtime.request',{{path:'/api/write',method:'POST'}});
          const read=await host.call('runtime.request',{{path:'/api/probe?opaque=a%2Bb',expectedHost}}); check(read.status===200 && read.body.ok,'read');
          const write=await host.call('runtime.request',{{path:'/api/write',method:'POST',body:{{synthetic:true}},expectedHost}}); check(write.body.ok,'write');
          await rejects('runtime.request',{{path:'/api/redirect',expectedHost}});
          await rejects('appearance.apply',{{}});
          const event=new Promise(resolve=>host.on('runtime.event',value=>{{if(value.data)resolve(value);}}));
          await host.call('runtime.stream',{{path:'/api/yuri/events',key:'global',expectedHost}});
          const received=await event; check(JSON.parse(received.data).synthetic && received.expectedHost.lease===expectedHost.lease,'stream');
          await host.call('runtime.stop',{{key:'global',expectedHost}});
          const b=await host.call('connection.select',{{id:a.selected}}); check(b.runtimeScope.lease!==expectedHost.lease,'rotate');
          await rejects('runtime.request',{{path:'/api/probe',expectedHost}});
          const removed=await host.call('connection.remove',{{id:a.selected}}); check(removed.selected===null && removed.runtimeScope===null,'remove');
          return {{ok:true}};
        }}
        run().then(value=>host.post('test.result',value),error=>host.post('test.result',{{error:String(error)}}));
    "#,
        origin = json!(origin)
    );
    let _engine = engine(host, source);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(20)).unwrap(),
        json!({"ok":true})
    );
    server.join().unwrap();
    assert_eq!(seen_rx.try_iter().count(), 5);
    assert!(
        redirected.accept().is_err(),
        "redirect followed with credentials"
    );
}
