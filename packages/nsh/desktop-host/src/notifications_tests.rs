use super::*;
#[derive(Clone, Default)]
struct Memory {
    bytes: Arc<Mutex<Option<Value>>>,
    fail: Arc<AtomicBool>,
    unknown: Arc<AtomicBool>,
}
impl store::Store for Memory {
    fn load(&mut self) -> Result<Option<Value>> {
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn commit(&mut self, value: &Value) -> Result<()> {
        if self.unknown.load(Ordering::Acquire) {
            return Err("notification_store_unknown".into());
        }
        if self.fail.load(Ordering::Acquire) {
            return Err(UNAVAILABLE.into());
        }
        *self.bytes.lock().unwrap() = Some(value.clone());
        Ok(())
    }
}
#[derive(Default)]
struct Counts {
    requests: usize,
    adds: Vec<String>,
    removes: Vec<String>,
    unknown: bool,
    remove_fail: bool,
}
struct Synthetic {
    counts: Arc<Mutex<Counts>>,
    status: Value,
    on_add: Option<Box<dyn FnOnce()>>,
}
impl Driver for Synthetic {
    fn status(&mut self) -> Result<Value> {
        Ok(self.status.clone())
    }
    fn request(&mut self, current: &dyn Fn() -> bool) -> Result<Value> {
        if !current() {
            return Err(STALE.into());
        }
        self.counts.lock().unwrap().requests += 1;
        self.status()
    }
    fn add(&mut self, id: &str, title: &str, body: &str) -> Result<()> {
        assert!(!title.contains("secret"));
        assert!(!body.contains("secret"));
        self.counts.lock().unwrap().adds.push(id.into());
        if let Some(f) = self.on_add.take() {
            f();
        }
        if self.counts.lock().unwrap().unknown {
            Err(UNAVAILABLE.into())
        } else {
            Ok(())
        }
    }
    fn remove(&mut self, ids: &[String]) -> Result<()> {
        let mut counts = self.counts.lock().unwrap();
        counts.removes.extend_from_slice(ids);
        if counts.remove_fail {
            Err(UNAVAILABLE.into())
        } else {
            Ok(())
        }
    }
}
fn identity() -> Identity {
    Identity {
        host_id: "host_A".into(),
        authorization_id: "auth_A".into(),
        runtime_lease: "runtime_A".into(),
    }
}
fn proof(kind: &str) -> Value {
    match kind {
        "assistant" => {
            json!({"v":1,"kind":"assistant","eventID":"admitted_assistant_3_bot_4_turn","target":{"kind":"assistant","id":"bot"},"source":{"type":"assistant","assistantID":"bot","turnID":"turn","status":"complete","publication":"published"}})
        }
        "schedule" => {
            json!({"v":1,"kind":"schedule","eventID":"admitted_schedule_1_p_1_t_1_r","target":{"kind":"schedule","id":"t"},"source":{"type":"schedule","projectID":"p","taskID":"t","runID":"r","trigger":"scheduled","resultOwner":"unowned","status":"success"}})
        }
        _ => {
            json!({"v":1,"kind":kind,"eventID":format!("admitted_{kind}_1_s_1_b"),"target":{"kind":"session","id":"s"},"source":{"type":"session","sessionID":"s","directory":"/synthetic/worktree","parentID":if kind=="subtask"{json!("parent")}else{Value::Null},"boundaryID":"b"}})
        }
    }
}
struct Fixture {
    engine: Engine,
    driver: Result<Box<dyn Driver>>,
    counts: Arc<Mutex<Counts>>,
    memory: Memory,
}
impl Fixture {
    fn new() -> Self {
        let memory = Memory::default();
        let counts = Arc::new(Mutex::new(Counts::default()));
        let shared = Arc::new(Shared {
            stopped: Arc::new(AtomicBool::new(false)),
            foreground: Arc::new(AtomicBool::new(true)),
            generation: Arc::new(AtomicU64::new(1)),
            identity: Mutex::new(Some(identity())),
            inbox: Mutex::new(Inbox::load(Box::new(memory.clone())).unwrap()),
            host: HostChannel::new(),
            ui: mpsc::sync_channel(4).0,
        });
        Self {
            engine: Engine {
                shared,
                configuration: None,
                lease: String::new(),
                generation: 0,
                seen: VecDeque::new(),
                claims: HashMap::new(),
            },
            driver: Ok(Box::new(Synthetic {
                counts: counts.clone(),
                status: policy::status("authorized", "enabled", "enabled", "unsupported"),
                on_add: None,
            })),
            counts,
            memory,
        }
    }
    fn call(&mut self, name: &str, body: Value) -> Result<Value> {
        let generation = self.engine.shared.generation.load(Ordering::Acquire);
        self.engine.call(name, body, generation, &mut self.driver)
    }
    fn configure(&mut self, enabled: bool, mode: &str) {
        self.call("notification.configure",json!({"hostID":"host_A","enabled":enabled,"mode":mode,"events":policy::KINDS,"language":"zh-CN"})).unwrap();
    }
    fn live(&mut self, kind: &str) -> Result<Value> {
        let p = proof(kind);
        self.call("notification.live",json!({"lease":self.engine.lease,"eventID":p["eventID"],"kind":p["kind"],"target":p["target"],"admission":p}))
    }
}
#[test]
fn configure_status_peek_never_request_or_send() {
    let mut f = Fixture::new();
    f.configure(false, "hidden-only");
    f.call("notification.status", json!({})).unwrap();
    assert_eq!(
        f.call("notification.launch.peek", json!({})).unwrap(),
        json!({"record":null})
    );
    assert_eq!(f.live("completion").unwrap()["result"], "suppressed");
    let c = f.counts.lock().unwrap();
    assert_eq!(c.requests, 0);
    assert!(c.adds.is_empty());
}
#[test]
fn desktop_always_and_hidden_only_use_real_foreground() {
    let mut f = Fixture::new();
    f.configure(true, "hidden-only");
    assert_eq!(f.live("completion").unwrap()["result"], "suppressed");
    f.configure(true, "always");
    assert_eq!(f.live("completion").unwrap()["result"], "scheduled");
    assert_eq!(f.live("completion").unwrap()["result"], "duplicate");
    assert_eq!(f.counts.lock().unwrap().adds.len(), 1);
}
#[test]
fn denied_and_background_request_fail_without_send() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.driver = Ok(Box::new(Synthetic {
        counts: f.counts.clone(),
        status: policy::status("denied", "disabled", "unknown", "unsupported"),
        on_add: None,
    }));
    assert_eq!(f.live("error").unwrap_err(), "notification_denied");
    f.engine.shared.foreground.store(false, Ordering::Release);
    assert!(f.call("notification.request", json!({})).is_err());
    assert!(
        f.call(
            "notification.test",
            json!({"hostID":"host_A","language":"en"})
        )
        .is_err()
    );
    assert_eq!(f.counts.lock().unwrap().requests, 0);
}
#[test]
fn complete_proofs_reject_cross_target_directory_and_extra_content() {
    for kind in policy::KINDS {
        let p = proof(kind);
        policy::admission(&p).unwrap();
        let mut wrong = p.clone();
        wrong["target"]["id"] = json!("other");
        assert!(policy::admission(&wrong).is_err());
        let mut wrong = p.clone();
        wrong["source"]["body"] = json!("secret");
        assert!(policy::admission(&wrong).is_err());
    }
    let mut p = proof("completion");
    p["source"]["directory"] = json!("");
    assert!(policy::admission(&p).is_err());
}
#[test]
fn exact_claim_ack_and_two_clicks_survive_restart_failed_ack_and_lease() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("completion").unwrap();
    f.live("assistant").unwrap();
    let ids = f.counts.lock().unwrap().adds.clone();
    let activation = Activation(f.engine.shared.clone());
    for id in &ids {
        assert!(activation.receive(id).unwrap());
        assert!(activation.receive(id).unwrap());
    }
    let mut restored = Inbox::load(Box::new(f.memory.clone())).unwrap();
    assert_eq!(restored.peek().unwrap()["receipt"], ids[0]);
    assert!(
        restored
            .claim(
                &ids[0],
                &Identity {
                    authorization_id: "different".into(),
                    ..identity()
                }
            )
            .is_err()
    );
    let claim = f
        .call(
            "notification.launch.claim",
            json!({"receipt":ids[0],"connectionID":"host_A"}),
        )
        .unwrap();
    assert_eq!(
        claim["record"]["admission"]["source"]["directory"],
        "/synthetic/worktree"
    );
    let ack = json!({"receipt":ids[0],"connectionID":"host_A","lease":f.engine.lease,"expectedRevision":1});
    f.memory.fail.store(true, Ordering::Release);
    assert!(f.call("notification.launch.ack", ack.clone()).is_err());
    assert_eq!(
        f.call("notification.launch.peek", json!({})).unwrap()["record"]["receipt"],
        ids[0]
    );
    f.memory.fail.store(false, Ordering::Release);
    f.engine.shared.generation.fetch_add(1, Ordering::AcqRel);
    f.configure(true, "always");
    assert!(f.call("notification.launch.ack", ack).is_err());
    f.call(
        "notification.launch.claim",
        json!({"receipt":ids[0],"connectionID":"host_A"}),
    )
    .unwrap();
    f.call("notification.launch.ack",json!({"receipt":ids[0],"connectionID":"host_A","lease":f.engine.lease,"expectedRevision":1})).unwrap();
    assert_eq!(
        f.call("notification.launch.peek", json!({})).unwrap()["record"]["receipt"],
        ids[1]
    );
}
#[test]
fn unknown_add_is_not_replayed_and_late_switch_removes_os_notification() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.counts.lock().unwrap().unknown = true;
    assert!(f.live("completion").is_err());
    assert_eq!(f.live("completion").unwrap()["result"], "duplicate");
    f.counts.lock().unwrap().unknown = false;
    let shared = f.engine.shared.clone();
    f.driver = Ok(Box::new(Synthetic {
        counts: f.counts.clone(),
        status: policy::status("authorized", "enabled", "enabled", "unsupported"),
        on_add: Some(Box::new(move || {
            shared.generation.fetch_add(1, Ordering::AcqRel);
            *shared.identity.lock().unwrap() = None;
        })),
    }));
    assert_eq!(f.live("error").unwrap_err(), STALE);
    assert_eq!(f.counts.lock().unwrap().removes.len(), 1);
}
#[test]
fn retirement_is_durable_route_denial_and_never_revived_by_same_identity() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("assistant").unwrap();
    let receipt = f.counts.lock().unwrap().adds[0].clone();
    let mut inbox = f.engine.shared.inbox.lock().unwrap();
    inbox.retire("host_A", "auth_A").unwrap();
    assert!(!inbox.receive(&receipt).unwrap());
    assert!(
        inbox
            .reserve(
                &crate::vault::id().unwrap(),
                &identity(),
                proof("error"),
                2,
                false,
                "always"
            )
            .is_err()
    );
    drop(inbox);
    let d = f.driver.as_mut().unwrap();
    f.engine.cleanup(d.as_mut(), "host_A", "auth_A").unwrap();
    assert_eq!(f.counts.lock().unwrap().removes, vec![receipt]);
    let mut restored = Inbox::load(Box::new(f.memory)).unwrap();
    assert!(
        restored
            .reserve(
                &crate::vault::id().unwrap(),
                &identity(),
                proof("error"),
                2,
                false,
                "always"
            )
            .is_err()
    );
}
#[test]
fn failed_tap_commit_is_retained_in_memory_and_retried_by_peek() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("schedule").unwrap();
    let id = f.counts.lock().unwrap().adds[0].clone();
    f.memory.fail.store(true, Ordering::Release);
    assert!(Activation(f.engine.shared.clone()).receive(&id).is_err());
    f.memory.fail.store(false, Ordering::Release);
    assert_eq!(
        f.call("notification.launch.peek", json!({})).unwrap()["record"]["receipt"],
        id
    );
}
#[test]
fn receipt_capacity_never_evicts_unacknowledged_taps() {
    let mut inbox = Inbox::load(Box::new(Memory::default())).unwrap();
    let mut first = String::new();
    for n in 0..256 {
        let id = format!("00000000-0000-4000-8000-{n:012x}");
        if n == 0 {
            first = id.clone();
        }
        inbox
            .reserve(&id, &identity(), proof("completion"), 1, false, "always")
            .unwrap();
        inbox.receive(&id).unwrap();
    }
    assert!(
        inbox
            .reserve(
                "ffffffff-0000-4000-8000-000000000000",
                &identity(),
                proof("error"),
                1,
                false,
                "always"
            )
            .is_err()
    );
    assert_eq!(inbox.peek().unwrap()["receipt"], first);
}
#[test]
fn shutdown_activation_keeps_durable_click_but_forbids_presentation() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("completion").unwrap();
    let id = f.counts.lock().unwrap().adds[0].clone();
    let sink = Activation(f.engine.shared.clone());
    assert!(sink.may_present(&id));
    f.engine.shared.stopped.store(true, Ordering::Release);
    assert!(!sink.may_present(&id));
    assert!(sink.receive(&id).unwrap());
    assert_eq!(
        f.call("notification.launch.peek", json!({})).unwrap()["record"]["receipt"],
        id
    );
}
#[test]
fn install_publish_and_shutdown_are_inert_and_cannot_revive_retired_owner() {
    let memory = Memory::default();
    let counts = Arc::new(Mutex::new(Counts::default()));
    let driver_counts = counts.clone();
    let (mut owner, ui) = install(
        &HostChannel::new(),
        Box::new(memory.clone()),
        Box::new(move |_| {
            Ok(Box::new(Synthetic {
                counts: driver_counts,
                status: policy::status("authorized", "enabled", "unknown", "unsupported"),
                on_add: None,
            }))
        }),
    )
    .unwrap();
    assert!(memory.bytes.lock().unwrap().is_none());
    assert!(ui.try_recv().is_none());
    owner.publish(Some(identity())).unwrap();
    owner.set_foreground(true);
    assert!(
        !owner
            .activation()
            .receive("00000000-0000-4000-8000-000000000000")
            .unwrap()
    );
    owner.shutdown();
    assert_eq!(owner.publish(Some(identity())).unwrap_err(), STALE);
    let counts = counts.lock().unwrap();
    assert_eq!(counts.requests, 0);
    assert!(counts.adds.is_empty());
}
#[test]
fn production_web_admission_validator_agrees_on_all_eight_proof_domains() {
    // Pure, import-free owning Web source, not a second JS implementation or a real Host.
    let javascript = include_str!("../../../web/server/lib/notifications/admission-event.js");
    let mut cases = Vec::new();
    for kind in policy::KINDS {
        let original = proof(kind);
        cases.push(original.clone());
        let mut wrong = original.clone();
        wrong["source"]["extra"] = json!(true);
        cases.push(wrong);
        let mut wrong = original.clone();
        wrong["target"]["id"] = json!("wrong");
        cases.push(wrong);
        let mut wrong = original.clone();
        wrong["eventID"] = json!("wrong");
        cases.push(wrong);
    }
    let script = format!(
        "{javascript}\nprocess.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(v=>!!notificationAdmission(v))));"
    );
    let output = std::process::Command::new("node")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .args([
            "--input-type=module",
            "-e",
            &script,
            &serde_json::to_string(&cases).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let web: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        web,
        cases
            .iter()
            .map(|c| policy::admission(c).is_ok())
            .collect::<Vec<_>>()
    );
}
#[test]
fn all_fixed_native_copy_matches_the_existing_ios_privacy_contract() {
    let ios = include_str!("../../ios/NotificationBridge.swift");
    for language in policy::LANGUAGES {
        let (title, body) = policy::copy(language, true);
        let (_, live) = policy::copy(language, false);
        for value in [title, body, live] {
            assert!(
                ios.contains(value),
                "native fixed copy diverged for {language}"
            );
        }
    }
}
#[test]
fn failed_os_absence_readback_never_acknowledges_retirement_and_can_retry() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("completion").unwrap();
    let id = f.counts.lock().unwrap().adds[0].clone();
    f.engine
        .shared
        .inbox
        .lock()
        .unwrap()
        .retire("host_A", "auth_A")
        .unwrap();
    f.counts.lock().unwrap().remove_fail = true;
    assert!(
        f.engine
            .cleanup(f.driver.as_mut().unwrap().as_mut(), "host_A", "auth_A")
            .is_err()
    );
    assert_eq!(
        Inbox::load(Box::new(f.memory.clone()))
            .unwrap()
            .retired("host_A", "auth_A"),
        vec![id.clone()]
    );
    assert!(!Activation(f.engine.shared.clone()).receive(&id).unwrap());
    f.counts.lock().unwrap().remove_fail = false;
    f.engine
        .cleanup(f.driver.as_mut().unwrap().as_mut(), "host_A", "auth_A")
        .unwrap();
    assert!(
        Inbox::load(Box::new(f.memory))
            .unwrap()
            .retired("host_A", "auth_A")
            .is_empty()
    );
}
#[test]
fn unknown_ack_commit_quarantines_instead_of_turning_failure_into_empty_success() {
    let mut f = Fixture::new();
    f.configure(true, "always");
    f.live("assistant").unwrap();
    let id = f.counts.lock().unwrap().adds[0].clone();
    Activation(f.engine.shared.clone()).receive(&id).unwrap();
    f.call(
        "notification.launch.claim",
        json!({"receipt":id,"connectionID":"host_A"}),
    )
    .unwrap();
    f.memory.unknown.store(true, Ordering::Release);
    assert_eq!(f.call("notification.launch.ack",json!({"receipt":id,"connectionID":"host_A","lease":f.engine.lease,"expectedRevision":1})).unwrap_err(),"notification_store_unknown");
    assert!(f.call("notification.launch.peek", json!({})).is_err());
    f.memory.unknown.store(false, Ordering::Release);
    assert_eq!(
        Inbox::load(Box::new(f.memory)).unwrap().peek().unwrap()["receipt"],
        id
    );
}
fn unsupported_owner(memory: &Memory) -> (Owner, UiInbox) {
    install(
        &HostChannel::new(),
        Box::new(memory.clone()),
        Box::new(|_| Err("notification_unsupported_identity".into())),
    )
    .unwrap()
}
#[test]
fn durable_retirement_and_empty_cleanup_do_not_depend_on_an_os_driver() {
    let memory = Memory::default();
    let (owner, _ui) = unsupported_owner(&memory);
    assert_eq!(
        owner
            .retry_retirement_cleanup("host_A", "auth_A")
            .unwrap_err(),
        STALE
    );
    owner.commit_retirement("host_A", "auth_A").unwrap();
    assert!(
        Inbox::load(Box::new(memory.clone()))
            .unwrap()
            .cleanup_empty("host_A", "auth_A")
            .unwrap()
    );
    // A proven marker replay does not rewrite the Store or consult the unsupported driver.
    memory.fail.store(true, Ordering::Release);
    owner.commit_retirement("host_A", "auth_A").unwrap();
    owner
        .retry_retirement_cleanup("host_A", "auth_A")
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    owner
        .retire_authorization("host_A", "auth_A")
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert!(owner.pending_retirement_cleanups().unwrap().is_empty());
}
#[test]
fn durable_marker_is_success_independent_of_nonempty_unsupported_os_cleanup() {
    let memory = Memory::default();
    let receipt = "00000000-0000-4000-8000-000000000001";
    let mut inbox = Inbox::load(Box::new(memory.clone())).unwrap();
    inbox
        .reserve(receipt, &identity(), proof("assistant"), 1, false, "always")
        .unwrap();
    inbox.receive(receipt).unwrap();
    drop(inbox);
    let (owner, _ui) = unsupported_owner(&memory);
    owner.commit_retirement("host_A", "auth_A").unwrap();
    assert_eq!(
        owner.pending_retirement_cleanups().unwrap(),
        vec![("host_A".into(), "auth_A".into())]
    );
    assert_eq!(
        owner
            .retry_retirement_cleanup("host_A", "auth_A")
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err(),
        "notification_unsupported_identity"
    );
    assert!(!owner.activation().receive(receipt).unwrap());
    let restored = Inbox::load(Box::new(memory)).unwrap();
    assert_eq!(restored.retired("host_A", "auth_A"), vec![receipt]);
    assert!(!restored.cleanup_empty("host_A", "auth_A").unwrap());
}
#[test]
fn failed_marker_commit_cannot_be_mistaken_for_a_completed_retirement() {
    let memory = Memory::default();
    let (owner, _ui) = unsupported_owner(&memory);
    owner.publish(Some(identity())).unwrap();
    memory.fail.store(true, Ordering::Release);
    assert_eq!(
        owner.commit_retirement("host_A", "auth_A").unwrap_err(),
        UNAVAILABLE
    );
    assert!(owner.shared.identity.lock().unwrap().is_none());
    assert_eq!(
        owner
            .retry_retirement_cleanup("host_A", "auth_A")
            .unwrap_err(),
        STALE
    );
    assert!(memory.bytes.lock().unwrap().is_none());
    memory.fail.store(false, Ordering::Release);
    owner.commit_retirement("host_A", "auth_A").unwrap();
    assert!(
        Inbox::load(Box::new(memory))
            .unwrap()
            .cleanup_empty("host_A", "auth_A")
            .unwrap()
    );
}
#[test]
fn unknown_marker_commit_blocks_even_previously_empty_cleanup_until_recovery() {
    let memory = Memory::default();
    let (owner, _ui) = unsupported_owner(&memory);
    owner.commit_retirement("host_A", "auth_A").unwrap();
    memory.unknown.store(true, Ordering::Release);
    assert_eq!(
        owner.commit_retirement("host_B", "auth_B").unwrap_err(),
        "notification_store_unknown"
    );
    assert_eq!(
        owner.commit_retirement("host_A", "auth_A").unwrap_err(),
        UNAVAILABLE
    );
    assert_eq!(
        owner
            .retry_retirement_cleanup("host_A", "auth_A")
            .unwrap_err(),
        UNAVAILABLE
    );
    assert!(owner.pending_retirement_cleanups().is_err());
}
#[test]
fn worker_empty_cleanup_checks_store_before_extracting_an_unsupported_driver() {
    let mut f = Fixture::new();
    f.driver = Err("notification_unsupported_identity".into());
    assert_eq!(
        f.engine
            .cleanup_available(&mut f.driver, "host_A", "auth_A")
            .unwrap_err(),
        STALE
    );
    f.engine
        .shared
        .inbox
        .lock()
        .unwrap()
        .retire("host_A", "auth_A")
        .unwrap();
    f.engine
        .cleanup_available(&mut f.driver, "host_A", "auth_A")
        .unwrap();
}
#[test]
fn recovered_tombstone_cannot_hide_an_active_row_or_an_untracked_retired_row() {
    let memory = Memory::default();
    let mut inbox = Inbox::load(Box::new(memory.clone())).unwrap();
    inbox
        .reserve(
            "00000000-0000-4000-8000-000000000001",
            &identity(),
            proof("assistant"),
            1,
            false,
            "always",
        )
        .unwrap();
    let mut invalid = inbox.root.clone();
    invalid["retirements"] = json!([{"host":"host_A","authorization":"auth_A"}]);
    *memory.bytes.lock().unwrap() = Some(invalid);
    assert!(Inbox::load(Box::new(memory.clone())).is_err());
    let mut invalid = inbox.root.clone();
    invalid["rows"][0]["retired"] = json!(true);
    *memory.bytes.lock().unwrap() = Some(invalid);
    assert!(Inbox::load(Box::new(memory)).is_err());
}
#[test]
fn ui_control_and_owner_drop_complete_while_identity_and_store_are_locked() {
    fn ui_traits<T: Clone + Send + Sync>() {}
    ui_traits::<Control>();
    let (mut owner, _ui) = unsupported_owner(&Memory::default());
    owner.publish(Some(identity())).unwrap();
    let shared = owner.shared.clone();
    let control = owner.control();
    let identity_lock = shared.identity.lock().unwrap();
    let store_lock = shared.inbox.lock().unwrap();
    let (done, completed) = mpsc::sync_channel(1);
    let ui_thread = std::thread::spawn(move || {
        control.set_foreground(true);
        control.shutdown();
        control.set_foreground(true);
        owner.shutdown();
        drop(owner);
        let _ = done.try_send(());
    });
    let result = completed.recv_timeout(Duration::from_secs(2));
    drop(store_lock);
    drop(identity_lock);
    ui_thread.join().unwrap();
    assert!(
        result.is_ok(),
        "UI lifecycle waited for the identity/Store lock"
    );
    assert!(shared.stopped.load(Ordering::Acquire));
    assert!(!shared.foreground.load(Ordering::Acquire));
}
#[test]
fn control_stop_is_terminal_idempotent_and_preserves_a_queued_launch_receipt() {
    let memory = Memory::default();
    let receipt = "00000000-0000-4000-8000-000000000002";
    let mut inbox = Inbox::load(Box::new(memory.clone())).unwrap();
    inbox
        .reserve(receipt, &identity(), proof("assistant"), 1, false, "always")
        .unwrap();
    inbox.receive(receipt).unwrap();
    drop(inbox);
    let (owner, _ui) = unsupported_owner(&memory);
    owner.publish(Some(identity())).unwrap();
    let control = owner.control();
    let clone = control.clone();
    let generation = owner.shared.generation.load(Ordering::Acquire);
    control.shutdown();
    let retired = owner.shared.generation.load(Ordering::Acquire);
    assert_eq!(retired, generation + 1);
    for _ in 0..1024 {
        clone.set_foreground(true);
        clone.shutdown();
    }
    assert_eq!(owner.shared.generation.load(Ordering::Acquire), retired);
    assert!(!owner.shared.foreground.load(Ordering::Acquire));
    assert_eq!(owner.publish(Some(identity())).unwrap_err(), STALE);
    assert_eq!(
        owner.shared.inbox.lock().unwrap().peek().unwrap()["receipt"],
        receipt
    );
}
#[test]
fn an_actor_waiting_to_publish_cannot_reactivate_after_the_ui_stop_fence() {
    let (owner, _ui) = unsupported_owner(&Memory::default());
    let control = owner.control();
    let shared = owner.shared.clone();
    let guard = shared.identity.lock().unwrap();
    let (done, completed) = mpsc::sync_channel(1);
    let actor = std::thread::spawn(move || {
        let _ = done.try_send(owner.publish(Some(identity())));
    });
    control.shutdown();
    drop(guard);
    assert_eq!(
        completed
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap_err(),
        STALE
    );
    actor.join().unwrap();
}
struct StalledAckStore {
    memory: Memory,
    entered: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
}
impl store::Store for StalledAckStore {
    fn load(&mut self) -> Result<Option<Value>> {
        store::Store::load(&mut self.memory)
    }
    fn commit(&mut self, value: &Value) -> Result<()> {
        self.entered.try_send(()).map_err(|_| UNAVAILABLE)?;
        self.release
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| UNAVAILABLE)?;
        store::Store::commit(&mut self.memory, value)
    }
}
#[test]
fn ui_shutdown_does_not_wait_for_an_already_admitted_durable_ack() {
    let (configured, ready) = mpsc::sync_channel(1);
    let (entered, writing) = mpsc::sync_channel(1);
    let (release, resume) = mpsc::sync_channel(1);
    let actor = std::thread::spawn(move || {
        let mut f = Fixture::new();
        f.configure(true, "always");
        f.live("assistant").unwrap();
        let receipt = f.counts.lock().unwrap().adds[0].clone();
        Activation(f.engine.shared.clone())
            .receive(&receipt)
            .unwrap();
        f.call(
            "notification.launch.claim",
            json!({"receipt":receipt,"connectionID":"host_A"}),
        )
        .unwrap();
        f.engine.shared.inbox.lock().unwrap().storage = Box::new(StalledAckStore {
            memory: f.memory.clone(),
            entered,
            release: resume,
        });
        let control = Control {
            stopped: f.engine.shared.stopped.clone(),
            foreground: f.engine.shared.foreground.clone(),
            generation: f.engine.shared.generation.clone(),
        };
        configured.try_send(control).unwrap();
        let result = f.call("notification.launch.ack",json!({"receipt":receipt,"connectionID":"host_A","lease":f.engine.lease,"expectedRevision":1}));
        (
            result,
            Inbox::load(Box::new(f.memory)).unwrap().peek().unwrap(),
        )
    });
    let control = ready.recv_timeout(Duration::from_secs(2)).unwrap();
    writing.recv_timeout(Duration::from_secs(2)).unwrap();
    let (done, stopped) = mpsc::sync_channel(1);
    let ui_thread = std::thread::spawn(move || {
        control.set_foreground(false);
        control.shutdown();
        let _ = done.try_send(());
    });
    let result = stopped.recv_timeout(Duration::from_secs(2));
    let _ = release.try_send(());
    ui_thread.join().unwrap();
    let (ack, pending) = actor.join().unwrap();
    assert!(result.is_ok(), "shutdown waited for durable ACK completion");
    assert_eq!(ack.unwrap(), json!({"ok":true}));
    assert!(pending.is_null()); // admitted ACK completed, not fake-rolled-back.
}
#[test]
fn native_ui_focus_defers_instead_of_waiting_for_the_private_store() {
    let memory = Memory::default();
    let receipt = "00000000-0000-4000-8000-000000000003";
    let mut inbox = Inbox::load(Box::new(memory.clone())).unwrap();
    inbox
        .reserve(receipt, &identity(), proof("assistant"), 1, false, "always")
        .unwrap();
    drop(inbox);
    let (owner, ui) = unsupported_owner(&memory);
    owner.publish(Some(identity())).unwrap();
    owner.activation().receive(receipt).unwrap();
    let job = ui.try_recv().unwrap();
    let guard = owner.shared.inbox.lock().unwrap();
    // A null window is never inspected: the busy Store branch must requeue before any OS call.
    let (done, finished) = mpsc::sync_channel(1);
    let ui_thread = std::thread::spawn(move || {
        unsafe {
            job.run(std::ptr::null_mut());
        }
        let _ = done.try_send(());
    });
    let result = finished.recv_timeout(Duration::from_secs(2));
    let deferred = ui.try_recv();
    assert!(guard.active(receipt));
    drop(guard);
    ui_thread.join().unwrap();
    assert!(result.is_ok(), "UI focus waited for durable Store I/O");
    assert!(deferred.is_some());
    owner.control().shutdown();
    drop(deferred);
}
