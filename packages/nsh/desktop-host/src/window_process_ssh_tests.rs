//! Actual Process/secure lane/typed Port and real Engine selection consumers.
use super::*;
use crate::connection_actor_port::{self as native, Target};

fn target(id: &str) -> Target {
    Target { id: id.into(), label: "Synthetic Process SSH".into(), host: "ssh.example.invalid".into(),
        user: "fixture".into(), port: 22, remote_port: 3210, local_port: 0, managed: true }
}
fn prepare(port: &native::Port, target: &Target, local: u16) -> native::Committed {
    port.authorize(target.clone(), local, port.password(target.clone()).unwrap(), Arc::new(|| true)).unwrap()
}
fn record(snapshot: &Value, id: &str) -> Value {
    snapshot["connections"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone()
}
fn saved_record(disk: &Disk, id: &str) -> Value {
    let value: Value = serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    record(&value, id)
}
fn selected(view: &View, id: &str) -> Value {
    let result = view.call("connection.select", json!({"id":id}));
    assert!(result.get("error").is_none(), "explicit native select failed");
    result["value"].clone()
}
fn release(view: &View, grant: &Value) {
    let mut input = writer_input(&grant["expectedHost"], "session", "ssh-session");
    input["grantID"] = grant["grantID"].clone();
    assert_eq!(view.call("desktop.writer.release", input)["value"]["released"], true);
}
fn prompt(view: &View, scope: &Value, grant: &Value) -> Value {
    view.call("runtime.request", json!({"path":"/api/session/ssh-session/prompt", "method":"POST",
        "expectedHost":scope, "writerGrant":grant["grantID"]}))
}

#[test]
fn two_real_windows_protect_each_selected_version_and_only_explicit_select_changes_authority() {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-b");
    let aa = a.snapshot();
    let bb = b.snapshot();
    let original_writer = a.call("desktop.writer.acquire", writer_input(&aa["runtimeScope"], "session", "ssh-session"))["value"].clone();
    let port = process.connection_actor_port();
    let row = target("two-selected");
    port.save(0, vec![row.clone()]).unwrap();
    let first = prepare(&port, &row, 45101);
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], bb["runtimeScope"]);
    assert!(prompt(&a, &aa["runtimeScope"], &original_writer).get("error").is_none(), "background ready must not release the old writer");
    let calls = wire.calls.lock().unwrap().len();
    assert!(prompt(&b, &bb["runtimeScope"], &original_writer).get("error").is_some());
    assert_eq!(wire.calls.lock().unwrap().len(), calls, "peer cannot borrow the original writer");
    release(&a, &original_writer);
    let first_a = selected(&a, &first.connection_id);
    assert_ne!(first_a["runtimeScope"], aa["runtimeScope"]);
    let first_record = record(&first_a, &first.connection_id);
    let first_private = saved_record(&disk, &first.connection_id);
    let first_writer = a.call("desktop.writer.acquire", writer_input(&first_a["runtimeScope"], "session", "ssh-session"))["value"].clone();
    let restored = port.restore(row.clone(), Arc::new(|| true)).unwrap().unwrap();
    assert_ne!(restored.connection_id, first.connection_id, "same target restore is a new immutable version");
    assert_eq!(a.snapshot()["runtimeScope"], first_a["runtimeScope"]);
    assert_eq!(record(&a.snapshot(), &first.connection_id), first_record);
    let second_b = selected(&b, &restored.connection_id);
    let second_record = record(&second_b, &restored.connection_id);
    let second_private = saved_record(&disk, &restored.connection_id);
    let third = prepare(&port, &row, 45102);
    let after_a = a.snapshot();
    let after_b = b.snapshot();
    assert_eq!(after_a["runtimeScope"], first_a["runtimeScope"]);
    assert_eq!(after_b["runtimeScope"], second_b["runtimeScope"]);
    assert_eq!(record(&after_a, &first.connection_id), first_record);
    assert_eq!(record(&after_b, &restored.connection_id), second_record);
    assert_eq!(saved_record(&disk, &first.connection_id), first_private);
    assert_eq!(saved_record(&disk, &restored.connection_id), second_private);
    assert!(prompt(&a, &first_a["runtimeScope"], &first_writer).get("error").is_none());
    release(&a, &first_writer);
    let direct = selected(&a, "host-a");
    let fourth = prepare(&port, &row, 45103);
    let current = a.snapshot();
    assert_eq!(current["runtimeScope"], direct["runtimeScope"]);
    assert!(!current["connections"].as_array().unwrap().iter().any(|c| c["id"] == first.connection_id || c["id"] == third.connection_id));
    assert_eq!(record(&b.snapshot(), &restored.connection_id), second_record, "secondary selection must survive anchor GC");
    assert_eq!(b.snapshot()["runtimeScope"], second_b["runtimeScope"]);
    port.retire(first).unwrap();
    assert_eq!(b.snapshot()["runtimeScope"], second_b["runtimeScope"]);
    let fourth_a = selected(&a, &fourth.connection_id);
    assert_ne!(fourth_a["runtimeScope"]["lease"], direct["runtimeScope"]["lease"]);
    assert_eq!(b.snapshot()["runtimeScope"], second_b["runtimeScope"]);
    assert!(prompt(&a, &fourth_a["runtimeScope"], &first_writer).get("error").is_some(), "selection never renews a stale native writer");
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn unloaded_context_is_unknown_not_empty_and_retirement_releases_its_gc_protection() {
    let (vault, _) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let a = open(&process, "primary", "host-a");
    a.snapshot();
    let port = process.connection_actor_port();
    let row = target("unknown-selection");
    port.save(0, vec![row.clone()]).unwrap();
    let first = prepare(&port, &row, 45201);
    let caps = serde_json::from_str::<Value>(include_str!("../../nsh.json")).unwrap()["capabilities"].clone();
    let mut unloaded = factory::open(&process, "unknown-peer".into(), caps,
        appearance::metadata(&Value::Null), appearance::Port::unavailable(), Some("host-b".into())).unwrap();
    let second = prepare(&port, &row, 45202);
    let snapshot = a.snapshot();
    assert!(snapshot["connections"].as_array().unwrap().iter().any(|c| c["id"] == first.connection_id), "an uninitialized peer must protect unknown selection, not guess its restore target");
    assert!(port.healthy(first.clone()).unwrap());
    unloaded.owner.begin_shutdown();
    wait(|| unloaded.owner.stopped());
    let third = prepare(&port, &row, 45203);
    let snapshot = a.snapshot();
    assert!(!snapshot["connections"].as_array().unwrap().iter().any(|c| c["id"] == first.connection_id || c["id"] == second.connection_id));
    assert!(snapshot["connections"].as_array().unwrap().iter().any(|c| c["id"] == third.connection_id));
    assert_eq!(snapshot["selected"], "host-a");
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn shared_reload_retains_exact_cancel_fence_before_select_and_before_new_window_restore_publication() {
    let (vault, disk) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-b");
    let aa = a.snapshot();
    let bb = b.snapshot();
    let port = process.connection_actor_port();
    let row = target("reload-cancel");
    port.save(0, vec![row.clone()]).unwrap();
    let current = Arc::new(AtomicBool::new(true));
    let checking = current.clone();
    let candidate = port.authorize(row.clone(), 45301, port.password(row.clone()).unwrap(), Arc::new(move || checking.load(Ordering::Acquire))).unwrap();
    a.snapshot(); b.snapshot();
    let editor = b.call("connection.editor", json!({"id":"host-b"}))["value"].clone();
    assert!(b.call("connection.rename", json!({"id":"host-b","version":editor["version"],"label":"Trigger shared reload"})).get("error").is_none());
    port.load().unwrap();
    current.store(false, Ordering::Release);
    for view in [&a, &b] {
        let rejected = view.call("connection.select", json!({"id":candidate.connection_id}));
        assert!(rejected["error"].as_str().unwrap().contains("ssh_authorization_required"));
    }
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], bb["runtimeScope"]);
    let blocked = open(&process, "cancelled-restore", &candidate.connection_id);
    assert!(blocked.call("connection.list", json!({}))["error"].as_str().unwrap().contains("window_restore_target_unavailable"));
    assert!(blocked.owner.services.reader().capture_diagnostics().is_none(), "cancelled restore must not transiently publish an authority before Current import");
    let fresh = prepare(&port, &row, 45302);
    assert_ne!(fresh.connection_id, candidate.connection_id);
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert!(blocked.owner.services.reader().capture_diagnostics().is_none());
    let stored: Value = serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    let mut old = connection_actor_storage::Native::read(&stored).unwrap();
    let cancelled = old.bindings.iter_mut().find(|b| b.receipt == candidate.receipt).unwrap();
    cancelled.current = Some(Arc::new(|| false));
    let mut conflicting = old.clone();
    conflicting.bindings.iter_mut().find(|b| b.receipt == candidate.receipt).unwrap().current = Some(Arc::new(|| true));
    old.inherit_live(&conflicting);
    assert!(!old.bindings.iter().find(|b| b.receipt == candidate.receipt).unwrap().current.as_ref().unwrap()(), "fresh true cannot wash the exact receipt's prior cancellation");
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn selection_projection_has_bounded_sources_unknown_poison_and_no_vault_io_on_repeated_refresh() {
    let (vault, disk) = store();
    let lane = secure::Lane::new(vault);
    let selected = SelectedConnections::default();
    let mut windows = BTreeMap::new();
    for _ in 0..100 { selected.refresh(&lane, &windows, false); assert!(selected.protects("not-a-known-host")); }
    assert_eq!(disk.reads.load(Ordering::Acquire), 0, "snapshot cannot trigger startup credential discovery");
    lane.view(false).read().unwrap();
    let reads = disk.reads.load(Ordering::Acquire);
    selected.refresh(&lane, &windows, false);
    assert!(selected.protects("host-a"), "preserve the authoritative primary cold default's referential integrity");
    assert!(!selected.protects("host-b"));
    let Built { actor, rx, owner } = assemble_target(&HostChannel::default(), &json!({"host":[]}), lane.view(false), Arc::new(Wire::default()), false,
        appearance::metadata(&Value::Null), appearance::Port::unavailable(), Some("host-b".into())).unwrap();
    windows.insert("native-peer".into(), Context::new(actor, rx, &owner));
    selected.refresh(&lane, &windows, false);
    assert!(selected.protects("unresolved"));
    windows.get_mut("native-peer").unwrap().actor.load().unwrap();
    for _ in 0..100 {
        selected.refresh(&lane, &windows, false);
        assert!(selected.protects("host-a") && selected.protects("host-b"));
        assert!(!selected.protects("unselected"));
    }
    assert_eq!(disk.reads.load(Ordering::Acquire), reads, "bounded idle refresh must not read/parse the Vault again");
    selected.refresh(&lane, &windows, true);
    assert!(selected.protects("during-process-exit"));
    lane.poison(vault::COMMIT_UNKNOWN);
    selected.refresh(&lane, &windows, false);
    assert!(selected.protects("unknown-is-not-empty"));
    for (_, context) in windows { context.retire(); }
}

#[derive(Default)]
struct SshDriver {
    initialized: AtomicUsize,
    tunnels: Mutex<Vec<Arc<TunnelState>>>,
}
struct TunnelState { alive: AtomicBool, closed: AtomicBool }
struct SshTunnel(Arc<TunnelState>);
impl crate::ssh::Tunnel for SshTunnel {
    fn alive(&mut self) -> bool { self.0.alive.load(Ordering::Acquire) }
    fn close(&mut self) { self.0.closed.store(true, Ordering::Release); }
}
impl crate::ssh::Driver for SshDriver {
    fn inspect(&self, _: &crate::ssh::Instance, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<crate::ssh::Inspection> {
        cancel.check()?;
        Ok(crate::ssh::Inspection { node_major: 24, version: Some("1.2.3".into()) })
    }
    fn initialize(&self, _: &crate::ssh::Instance, _: &str, _: &crate::ssh::Secret, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<()> {
        cancel.check()?;
        self.initialized.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    fn forward(&self, _: &crate::ssh::Instance, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<crate::ssh::Forward> {
        cancel.check()?;
        let state = Arc::new(TunnelState { alive: AtomicBool::new(true), closed: AtomicBool::new(false) });
        let mut tunnels = self.tunnels.lock().unwrap();
        tunnels.push(state.clone());
        Ok(crate::ssh::Forward { port: 46000 + tunnels.len() as u16, tunnel: Box::new(SshTunnel(state)) })
    }
}
fn status(view: &View) -> Value { view.call("desktop.ssh.read", json!({}))["value"]["statuses"][0].clone() }
fn ready(view: &View, request: &str) -> Value {
    let mut result = Value::Null;
    wait(|| { result = status(view); result["requestID"] == request && result["phase"] == "ready" && result["running"] == false });
    result
}
fn start(view: &View, request: &str, intent: &str) {
    assert!(view.call("desktop.ssh.start", json!({"requestID":request,"id":"service-process","intent":intent})).get("error").is_none());
}

#[test]
fn real_service_restore_cancel_and_health_recovery_keep_both_authorities_and_retire_only_unselected_own_receipts() {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let driver = Arc::new(SshDriver::default());
    process.install_ssh(Ok(driver.clone()), "1.2.3".into()).unwrap();
    let mut a = open(&process, "primary", "host-a");
    let mut b = open(&process, "secondary", "host-b");
    let aa = a.snapshot();
    let bb = b.snapshot();
    wait(|| a.call("desktop.ssh.capabilities", json!({}))["value"]["connections"]["supported"] == true);
    assert!(a.call("desktop.ssh.save", json!({"requestID":"service-save","revision":0,"instance":{
        "id":"service-process","label":"Fixture","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true
    }})).get("error").is_none());
    start(&a, "first", "connect");
    let first = ready(&b, "first");
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], bb["runtimeScope"]);
    let first_id = first["connectionID"].as_str().unwrap();
    let selected_a = selected(&a, first_id);
    let selected_b = selected(&b, first_id);
    let first_private = saved_record(&disk, first_id);
    let first_tunnel = driver.tunnels.lock().unwrap()[0].clone();
    start(&b, "live-restore", "restore");
    let restore = ready(&a, "live-restore");
    assert_ne!(restore["connectionID"], first["connectionID"]);
    assert_eq!(driver.initialized.load(Ordering::Acquire), 2);
    assert_eq!(a.snapshot()["runtimeScope"], selected_a["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], selected_b["runtimeScope"]);
    assert_eq!(saved_record(&disk, first_id), first_private);
    assert!(!first_tunnel.closed.load(Ordering::Acquire));
    assert!(b.call("desktop.ssh.cancel", json!({"id":"service-process","attempt":restore["attempt"]})).get("error").is_none());
    assert!(driver.tunnels.lock().unwrap()[1].closed.load(Ordering::Acquire));
    assert!(!first_tunnel.closed.load(Ordering::Acquire));
    assert_eq!(a.snapshot()["runtimeScope"], selected_a["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], selected_b["runtimeScope"]);
    start(&a, "recover-me", "connect");
    let recover_me = ready(&b, "recover-me");
    let stored: Value = serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    let old = stored["sshNative"]["bindings"].as_array().unwrap().iter().find(|binding| binding["connectionID"] == recover_me["connectionID"]).unwrap();
    let stale = native::Committed { connection_id: recover_me["connectionID"].as_str().unwrap().into(), receipt: old["receipt"].as_str().unwrap().into() };
    driver.tunnels.lock().unwrap()[2].alive.store(false, Ordering::Release);
    let mut recovered = Value::Null;
    wait(|| { recovered = status(&b); recovered["phase"] == "ready" && recovered["running"] == false
        && recovered["attempt"].as_u64().is_some_and(|attempt| attempt > recover_me["attempt"].as_u64().unwrap()) });
    assert!(recovered["requestID"].as_str().unwrap().starts_with("recovery-"));
    assert_ne!(recovered["connectionID"], recover_me["connectionID"]);
    assert_eq!(a.snapshot()["runtimeScope"], selected_a["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], selected_b["runtimeScope"]);
    assert_eq!(saved_record(&disk, first_id), first_private);
    let recovered_a = selected(&a, recovered["connectionID"].as_str().unwrap());
    process.connection_actor_port().retire(stale).unwrap();
    assert_eq!(a.snapshot()["runtimeScope"], recovered_a["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], selected_b["runtimeScope"]);
    let health_calls = || wire.calls.lock().unwrap().iter().filter(|r| r.url == "http://127.0.0.1:46001/api/config/settings").count();
    let before = health_calls();
    wait(|| health_calls() > before);
    status(&b);
    assert!(!first_tunnel.closed.load(Ordering::Acquire), "a remaining secondary reader protects its actual selected transport");
    assert!(a.call("desktop.ssh.cancel", json!({"id":"service-process","attempt":restore["attempt"]})).get("error").is_some());
    b.owner.begin_shutdown();
    wait(|| b.owner.stopped());
    wait(|| first_tunnel.closed.load(Ordering::Acquire));
    assert_eq!(a.snapshot()["runtimeScope"], recovered_a["runtimeScope"], "retiring the last old reader cannot revoke the new selection");
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert!(!driver.tunnels.lock().unwrap()[3].closed.load(Ordering::Acquire), "last window close is not process SSH shutdown");
    process.shutdown();
    wait(|| process.stopped());
    assert!(driver.tunnels.lock().unwrap().iter().all(|t| t.closed.load(Ordering::Acquire)));
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
}
