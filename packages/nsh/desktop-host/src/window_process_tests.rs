//! Two real Engines, one original synthetic Vault object and the actual shared process dispatcher.
use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, MountSink};
use std::sync::{Mutex, atomic::AtomicUsize};
#[path = "window_process_ssh_tests.rs"]
mod ssh_contract;

#[derive(Default)]
struct Disk {
    reads: AtomicUsize,
    bytes: Mutex<Option<Vec<u8>>>,
    writes: AtomicUsize,
    drops: AtomicUsize,
    unknown: AtomicBool,
    deny: AtomicBool,
}
#[test]
fn peer_registry_removal_fences_only_the_removed_host_and_known_write_failure_keeps_both_prior_scopes()
 {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-b");
    let aa = a.snapshot();
    let bb = b.snapshot();
    let prior = disk.bytes.lock().unwrap().clone();
    disk.deny.store(true, Ordering::Release);
    assert!(
        a.call("connection.remove", json!({"id":"host-b"}))
            .get("error")
            .is_some()
    );
    assert_eq!(disk.bytes.lock().unwrap().clone(), prior);
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(b.snapshot()["runtimeScope"], bb["runtimeScope"]);
    disk.deny.store(false, Ordering::Release);
    assert!(
        a.call("connection.remove", json!({"id":"host-b"}))
            .get("error")
            .is_none()
    );
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    let now = b.snapshot();
    assert!(now["selected"].is_null() && now["runtimeScope"].is_null());
    assert!(
        b.call(
            "runtime.request",
            json!({"path":"/api/config/settings","expectedHost":bb["runtimeScope"]})
        )
        .get("error")
        .is_some()
    );
    assert!(
        wire.calls.lock().unwrap().is_empty(),
        "no default Host fallback or stale request"
    );
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn external_secure_baseline_change_is_conflict_not_a_stale_merge_or_automatic_retry() {
    let (vault, disk) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-b");
    a.snapshot();
    b.snapshot();
    let external = {
        let mut bytes = disk.bytes.lock().unwrap();
        let mut value: Value = serde_json::from_slice(bytes.as_ref().unwrap()).unwrap();
        value["fixtureExternal"] = json!(true);
        let external = serde_json::to_vec(&value).unwrap();
        *bytes = Some(external.clone());
        external
    };
    let writes = disk.writes.load(Ordering::Acquire);
    assert!(
        a.call("connection.remove", json!({"id":"host-b"}))
            .get("error")
            .is_some()
    );
    wait(|| !a.owner.services.live() && !b.owner.services.live());
    assert_eq!(disk.bytes.lock().unwrap().as_ref(), Some(&external));
    assert_eq!(disk.writes.load(Ordering::Acquire), writes);
    process.shutdown();
    wait(|| process.stopped());
}

struct OnlyVault(Arc<Disk>);
impl Vault for OnlyVault {
    fn read(&self) -> Result<Option<Vec<u8>>> {
        self.0.reads.fetch_add(1, Ordering::AcqRel);
        Ok(self.0.bytes.lock().unwrap().clone())
    }
    fn write(&self, bytes: &[u8]) -> Result<()> {
        self.0.writes.fetch_add(1, Ordering::AcqRel);
        if self.0.deny.load(Ordering::Acquire) {
            return Err("fixture_secure_write_denied".into());
        }
        *self.0.bytes.lock().unwrap() = Some(bytes.to_vec());
        if self.0.unknown.load(Ordering::Acquire) {
            Err(vault::COMMIT_UNKNOWN.into())
        } else {
            Ok(())
        }
    }
}
impl Drop for OnlyVault {
    fn drop(&mut self) {
        self.0.drops.fetch_add(1, Ordering::AcqRel);
    }
}
fn store() -> (Box<dyn Vault>, Arc<Disk>) {
    let data = Arc::new(Disk::default());
    let store: Box<dyn Vault> = Box::new(OnlyVault(data.clone()));
    let connection = |id: &str| Connection {
        id: id.into(),
        label: id.into(),
        url: format!("https://{id}.invalid"),
        token: format!("fixture-{id}-token"),
        authorization: format!("fixture-{id}-auth"),
        used: 1.,
        editor_version: None,
    };
    let mut state = State {
        connections: vec![connection("host-a"), connection("host-b")],
        selected: Some("host-a".into()),
        scope: None,
        notification_retirements: Vec::new(),
        notification_error: None,
        native: Default::default(),
        extra: Default::default(),
    };
    state.rotate().unwrap();
    state.persist(&*store).unwrap();
    (store, data)
}
struct Task(Arc<AtomicUsize>);
impl FetchTask for Task {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}
#[derive(Default)]
struct Wire {
    mints: AtomicUsize,
    hold_session: AtomicBool,
    calls: Mutex<Vec<HttpRequest>>,
    held: Mutex<Vec<(String, nsh_engine::FetchEvents)>>,
    cancels: Arc<AtomicUsize>,
}
impl Network for Wire {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn FetchTask> {
        let url = request.url.clone();
        self.calls.lock().unwrap().push(request);
        if url.ends_with("/api/wait")
            || self.hold_session.load(Ordering::Acquire) && url.contains("/api/session/")
        {
            self.held.lock().unwrap().push((url, events));
        } else {
            let body = if url.ends_with("/auth/session") {
                json!({"clientToken":format!("fixture-ssh-bearer-{}", self.mints.fetch_add(1, Ordering::AcqRel))})
            } else {
                json!({"url":url})
            };
            complete(&mut events, &url, body);
        }
        Box::new(Task(self.cancels.clone()))
    }
}
fn complete(events: &mut nsh_engine::FetchEvents, url: &str, body: Value) {
    events(FetchEvent::Head(HttpHead {
        status: 200,
        url: url.into(),
        headers: vec![("Content-Type".into(), "application/json".into())],
        ..Default::default()
    }));
    events(FetchEvent::Data(serde_json::to_vec(&body).unwrap()));
    events(FetchEvent::End);
}
struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
struct View {
    host: HostChannel,
    owner: Owner,
    output: mpsc::Receiver<Value>,
    engine: Engine,
}
fn open(process: &Process, key: &str, target: &str) -> View {
    let manifest: Value = serde_json::from_str(include_str!("../../nsh.json")).unwrap();
    let capabilities = manifest["capabilities"].clone();
    let installed = factory::open(
        process,
        key.into(),
        capabilities.clone(),
        appearance::metadata(&Value::Null),
        appearance::Port::unavailable(),
        Some(target.into()),
    )
    .unwrap();
    launch(installed, capabilities, key)
}
fn launch(installed: factory::Installed, capabilities: Value, key: &str) -> View {
    let factory::Installed { host, owner, .. } = installed;
    let (tx, output) = mpsc::channel();
    host.handle("test.output", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let mut bundle = Bundle::source(r#"import {host} from 'nsh';host.on('test.call',async({name,value,tag})=>{
      try{host.post('test.output',{tag,value:await host.call(name,value)});}catch(error){host.post('test.output',{tag,error:String(error)});}
    });host.post('test.output',{ready:true,key:host.params.windowKey,coordination:host.params.windowCoordination});"#.into());
    let mut policy = capabilities;
    policy["host"]
        .as_array_mut()
        .unwrap()
        .push(json!("test.output"));
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(&policy).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host.clone();
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        output.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ready":true,"key":key,"coordination":"multi-engine"})
    );
    View {
        host,
        owner,
        output,
        engine,
    }
}
impl View {
    fn send(&self, name: &str, value: Value, tag: &str) {
        self.host
            .send("test.call", json!({"name":name,"value":value,"tag":tag}))
            .unwrap();
    }
    fn receive(&self) -> Value {
        self.output.recv_timeout(Duration::from_secs(5)).unwrap()
    }
    fn call(&self, name: &str, value: Value) -> Value {
        self.send(name, value, "call");
        self.receive()
    }
    fn snapshot(&self) -> Value {
        self.call("connection.list", json!({}))["value"].clone()
    }
}
fn wait(ready: impl FnMut() -> bool) {
    crate::window_persistence::tests::wait(ready);
}
fn process(store: Box<dyn Vault>, network: Arc<Wire>) -> Process {
    Process::install(store, network, false, appearance::metadata(&Value::Null)).unwrap()
}

fn writer_input(scope: &Value, kind: &str, id: &str) -> Value {
    json!({"ownerID":"chat-owner","expectedHost":scope,"target":{"kind":kind,"id":id}})
}

#[test]
fn legacy_held_record_without_native_authority_is_preserved_and_never_reconstructed_from_current_connection()
 {
    let (vault, disk) = store();
    let mut value: Value =
        serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    value["nativeWindowWriters"] = json!({"schemaVersion":1,"held":[{"hostID":"host-a","target":{"kind":"session","id":"s1"},"windowKey":"primary","grantID":"legacy-grant"}]});
    *disk.bytes.lock().unwrap() = Some(serde_json::to_vec(&value).unwrap());
    let prior = disk.bytes.lock().unwrap().clone();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-a");
    for view in [&a, &b] {
        let scope = view.snapshot()["runtimeScope"].clone();
        let mut input = writer_input(&scope, "session", "s1");
        assert!(
            view.call("desktop.writer.acquire", input.clone())["error"]
                .as_str()
                .unwrap()
                .contains("writer_recovery_required")
        );
        input["grantID"] = json!("legacy-grant");
        assert!(
            view.call("desktop.writer.renew", input)
                .get("error")
                .is_some()
        );
    }
    assert_eq!(disk.bytes.lock().unwrap().clone(), prior);
    assert!(wire.calls.lock().unwrap().is_empty());
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn unknown_writer_renew_commit_fences_the_original_process_without_replaying_or_replacing_its_vault()
 {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-a");
    let old = a.snapshot()["runtimeScope"].clone();
    let first = a.call(
        "desktop.writer.acquire",
        writer_input(&old, "session", "s1"),
    )["value"]
        .clone();
    let scope =
        a.call("connection.select", json!({"id":"host-a"}))["value"]["runtimeScope"].clone();
    let mut input = writer_input(&scope, "session", "s1");
    input["grantID"] = first["grantID"].clone();
    disk.unknown.store(true, Ordering::Release);
    let writes = disk.writes.load(Ordering::Acquire);
    assert!(
        a.call("desktop.writer.renew", input.clone())
            .get("error")
            .is_some()
    );
    wait(|| !a.owner.services.live() && !b.owner.services.live());
    assert!(a.call("desktop.writer.renew", input).get("error").is_some());
    assert_eq!(disk.writes.load(Ordering::Acquire), writes + 1);
    assert!(wire.calls.lock().unwrap().is_empty());
    process.shutdown();
    wait(|| process.stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
}

#[test]
fn writer_renew_rotates_only_same_native_owner_and_committed_authority_and_fences_old_http_grant() {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-a");
    let old = a.snapshot()["runtimeScope"].clone();
    let peer = b.snapshot()["runtimeScope"].clone();
    let first = a.call(
        "desktop.writer.acquire",
        writer_input(&old, "session", "s1"),
    )["value"]
        .clone();
    let selected =
        a.call("connection.select", json!({"id":"host-a"}))["value"]["runtimeScope"].clone();
    assert_ne!(old, selected);
    let mut renew = writer_input(&selected, "session", "s1");
    renew["grantID"] = first["grantID"].clone();
    let mut stolen = renew.clone();
    stolen["expectedHost"] = peer;
    assert!(
        b.call("desktop.writer.renew", stolen)
            .get("error")
            .is_some()
    );
    let before = disk.bytes.lock().unwrap().clone();
    for (field, value) in [
        ("ownerID", json!("other-owner")),
        ("target", json!({"kind":"assistant","id":"s1"})),
        ("grantID", json!("not-the-native-grant")),
        ("expectedHost", old.clone()),
        ("sameAuthority", json!(true)),
    ] {
        let mut invalid = renew.clone();
        invalid[field] = value;
        assert!(
            a.call("desktop.writer.renew", invalid)
                .get("error")
                .is_some()
        );
    }
    let mut old_release = renew.clone();
    old_release["expectedHost"] = old;
    assert!(
        a.call("desktop.writer.release", old_release)
            .get("error")
            .is_some()
    );
    assert!(
        a.call("desktop.writer.release", renew.clone())
            .get("error")
            .is_some()
    );
    assert_eq!(disk.bytes.lock().unwrap().clone(), before);
    disk.deny.store(true, Ordering::Release);
    assert!(
        a.call("desktop.writer.renew", renew.clone())
            .get("error")
            .is_some()
    );
    assert_eq!(disk.bytes.lock().unwrap().clone(), before);
    assert!(a.owner.services.live() && a.owner.services.writer_close_ready());
    disk.deny.store(false, Ordering::Release);
    let next = a.call("desktop.writer.renew", renew.clone())["value"].clone();
    assert!(next["grantID"].is_string());
    assert_ne!(next["grantID"], first["grantID"]);
    assert_eq!(next["expectedHost"], selected);
    assert_eq!(next["ownerID"], first["ownerID"]);
    let held: Value = serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(
        held["nativeWindowWriters"]["held"][0]["authority"],
        json!({"origin":"https://host-a.invalid","authorizationID":"fixture-host-a-auth"})
    );
    assert_eq!(
        held["nativeWindowWriters"]["held"][0]["grantID"],
        next["grantID"]
    );
    assert!(next.get("authority").is_none());
    assert!(a.call("runtime.request", json!({"path":"/api/session/s1/prompt","method":"POST","expectedHost":selected,"writerGrant":first["grantID"]})).get("error").is_some());
    let window = a.call("runtime.http.capabilities", json!({}))["value"]["windowID"].clone();
    assert!(a.call("runtime.http.request", json!({"ownerID":"http","requestID":"renew-old","windowID":window,"expectedHost":selected,"path":"/api/session/s1/prompt","method":"POST","writerGrant":first["grantID"]})).get("error").is_some());
    assert!(wire.calls.lock().unwrap().is_empty());
    assert!(a.call("runtime.request", json!({"path":"/api/session/s1/prompt","method":"POST","expectedHost":selected,"writerGrant":next["grantID"]})).get("error").is_none());
    assert!(a.call("runtime.http.request", json!({"ownerID":"http","requestID":"renew-new","windowID":window,"expectedHost":selected,"path":"/api/session/s1/prompt","method":"POST","writerGrant":next["grantID"]})).get("error").is_none());
    let auth = a.call(
        "connection.connect",
        json!({"url":"https://host-a.invalid","token":"synthetic-re-authorized"}),
    );
    assert!(auth.get("error").is_none());
    let scope = a.snapshot()["runtimeScope"].clone();
    renew["expectedHost"] = scope;
    renew["grantID"] = next["grantID"].clone();
    assert!(
        a.call("desktop.writer.renew", renew)["error"]
            .as_str()
            .unwrap()
            .contains("writer_authority_changed")
    );
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn writer_renew_cannot_transfer_a_held_draft_to_a_reauthorized_replacement_origin() {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let scope = a.snapshot()["runtimeScope"].clone();
    let first = a.call(
        "desktop.writer.acquire",
        writer_input(&scope, "session", "s1"),
    )["value"]
        .clone();
    assert!(a.call("connection.connect", json!({"id":"host-a","version":"legacy","url":"https://replacement.invalid","token":"synthetic-new-origin"})).get("error").is_none());
    let current = a.snapshot()["runtimeScope"].clone();
    assert_eq!(current["hostID"], scope["hostID"]);
    let mut input = writer_input(&current, "session", "s1");
    input["grantID"] = first["grantID"].clone();
    let before = disk.bytes.lock().unwrap().clone();
    let calls = wire.calls.lock().unwrap().len();
    assert!(
        a.call("desktop.writer.renew", input)["error"]
            .as_str()
            .unwrap()
            .contains("writer_authority_changed")
    );
    assert_eq!(disk.bytes.lock().unwrap().clone(), before);
    assert!(a.call("runtime.request", json!({"path":"/api/session/s1/prompt","method":"POST","expectedHost":current,"writerGrant":first["grantID"]})).get("error").is_some());
    assert_eq!(wire.calls.lock().unwrap().len(), calls);
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn new_session_create_requires_the_native_exact_host_directory_draft_grant_without_guessing_a_session_id()
 {
    let (vault, _) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-a");
    let aa = a.snapshot()["runtimeScope"].clone();
    let bb = b.snapshot()["runtimeScope"].clone();
    let grant = a.call(
        "desktop.writer.acquire",
        writer_input(&aa, "new-session", "/workspace"),
    )["value"]
        .clone();
    assert!(grant["grantID"].is_string());
    assert!(
        b.call(
            "desktop.writer.acquire",
            writer_input(&bb, "new-session", "/workspace")
        )
        .get("error")
        .is_some()
    );
    for (scope, view, directory) in [(&bb, &b, "/workspace"), (&aa, &a, "/other")] {
        assert!(view.call("runtime.request", json!({"path":"/api/session","method":"POST","expectedHost":scope,"writerGrant":grant["grantID"],"body":{"location":{"directory":directory}}})).get("error").is_some());
    }
    assert!(wire.calls.lock().unwrap().is_empty());
    assert!(a.call("runtime.request", json!({"path":"/api/session","method":"POST","expectedHost":aa,"writerGrant":grant["grantID"],"body":{"location":{"directory":"/workspace"}}})).get("error").is_none());
    assert_eq!(wire.calls.lock().unwrap().len(), 1);
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn production_factory_manifest_writer_is_exclusive_at_both_http_entrypoints_and_release_transfers_it()
 {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "main:two.1", "host-a");
    let aa = a.snapshot()["runtimeScope"].clone();
    let bb = b.snapshot()["runtimeScope"].clone();
    let input_a = writer_input(&aa, "session", "s/a");
    let input_b = writer_input(&bb, "session", "s/a");
    assert_eq!(
        a.call("desktop.writer.capabilities", json!({}))["value"]["supported"],
        true
    );
    let grant = a.call("desktop.writer.acquire", input_a.clone())["value"].clone();
    assert!(grant["grantID"].is_string());
    assert_eq!(
        a.call("desktop.writer.acquire", input_a.clone())["value"],
        grant,
        "same owner retries reuse exact native receipt"
    );
    assert!(
        b.call("desktop.writer.acquire", input_b.clone())["error"]
            .as_str()
            .unwrap()
            .contains("writer_conflict")
    );
    assert!(
        b.call(
            "runtime.request",
            json!({"path":"/api/session/s%2Fa/message","expectedHost":bb})
        )["value"]
            .is_object(),
        "read-only panel does not acquire a writer"
    );
    let before = wire.calls.lock().unwrap().len();
    assert!(b.call("runtime.request", json!({"path":"/api/session/s%2Fa/prompt","method":"POST","expectedHost":bb,"writerGrant":grant["grantID"]})).get("error").is_some(), "a peer cannot borrow the correct native grant");
    for path in [
        "/api/session/s%2Fa/prompt",
        "/api/%73ession/s%2Fa/interrupt",
        "/api/session/s%2Fa/inbox/x",
        "/api/session/s%2Fa/form/f/submit",
        "/api/session/s%2Fa/permission/p/reply",
    ] {
        assert!(
            b.call(
                "runtime.request",
                json!({"path":path,"method":"POST","expectedHost":bb})
            )
            .get("error")
            .is_some()
        );
    }
    let window = b.call("runtime.http.capabilities", json!({}))["value"]["windowID"].clone();
    assert!(b.call("runtime.http.request", json!({"ownerID":"panel","requestID":"blocked-writer","windowID":window,"expectedHost":bb,"path":"/api/session/s%2Fa/shell","method":"POST"})).get("error").is_some());
    assert_eq!(
        wire.calls.lock().unwrap().len(),
        before,
        "no non-owner native execution"
    );
    assert!(a.call("runtime.request", json!({"path":"/api/session/s%2Fa/prompt","method":"POST","body":{},"expectedHost":aa,"writerGrant":grant["grantID"]})).get("error").is_none());
    let mut release = input_a;
    release["grantID"] = grant["grantID"].clone();
    assert_eq!(
        a.call("desktop.writer.release", release)["value"]["released"],
        true
    );
    let next = b.call("desktop.writer.acquire", input_b)["value"].clone();
    assert!(next["grantID"].is_string());
    assert_ne!(next["grantID"], grant["grantID"]);
    assert!(b.call("runtime.request", json!({"path":"/api/session/s%2Fa/prompt","method":"POST","expectedHost":bb,"writerGrant":grant["grantID"]})).get("error").is_some(), "an old native writer epoch cannot execute after transfer");
    assert!(b.call("runtime.http.request", json!({"ownerID":"chat","requestID":"owner-writer","windowID":window,"expectedHost":bb,"path":"/api/session/s%2Fa/prompt","method":"POST","writerGrant":next["grantID"]})).get("error").is_none());
    let disk_value: Value =
        serde_json::from_slice(disk.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(
        disk_value["nativeWindowWriters"]["held"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn assistant_writer_uses_exact_encoded_identity_and_approved_final_close_releases_only_its_grants()
{
    let (vault, _) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let mut a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-a");
    let aa = a.snapshot()["runtimeScope"].clone();
    let bb = b.snapshot()["runtimeScope"].clone();
    let grant = a.call(
        "desktop.writer.acquire",
        writer_input(&aa, "assistant", "bot/a"),
    )["value"]
        .clone();
    assert!(grant["grantID"].is_string());
    assert!(b.call("runtime.request", json!({"path":"/api/yuri/assistants/bot%2Fa/messages","method":"POST","expectedHost":bb})).get("error").is_some());
    assert!(a.call("runtime.request", json!({"path":"/api/yuri/assistants/bot%2Fa/messages","method":"POST","expectedHost":aa,"writerGrant":grant["grantID"]})).get("error").is_none());
    a.owner.services.approve_final_close();
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert!(
        b.call(
            "desktop.writer.acquire",
            writer_input(&bb, "assistant", "bot/a")
        )["value"]["grantID"]
            .is_string()
    );
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn pending_then_unknown_writer_cannot_release_or_replay_and_cold_start_retains_recovery_block() {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    wire.hold_session.store(true, Ordering::Release);
    let mut first = process(vault, wire.clone());
    let mut a = open(&first, "primary", "host-a");
    let scope = a.snapshot()["runtimeScope"].clone();
    let mut input = writer_input(&scope, "session", "s1");
    input["grantID"] = a.call("desktop.writer.acquire", input.clone())["value"]["grantID"].clone();
    a.send("runtime.request", json!({"path":"/api/session/s1/prompt","method":"POST","expectedHost":scope,"writerGrant":input["grantID"]}), "pending");
    wait(|| !wire.held.lock().unwrap().is_empty());
    assert!(!a.owner.services.writer_close_ready());
    assert!(
        a.call("desktop.writer.renew", input.clone())["error"]
            .as_str()
            .unwrap()
            .contains("writer_pending")
    );
    assert!(
        a.call("desktop.writer.release", input.clone())["error"]
            .as_str()
            .unwrap()
            .contains("writer_pending")
    );
    wire.held.lock().unwrap()[0].1(FetchEvent::Failed("synthetic dropped ACK".into()));
    assert_eq!(a.receive()["tag"], "pending");
    assert!(
        a.call("desktop.writer.renew", input.clone())["error"]
            .as_str()
            .unwrap()
            .contains("writer_unknown")
    );
    assert!(
        a.call("desktop.writer.release", input)["error"]
            .as_str()
            .unwrap()
            .contains("writer_unknown")
    );
    assert!(!a.owner.services.writer_close_ready());
    assert!(a.owner.services.live());
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    first.shutdown();
    wait(|| first.stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
    drop(first);
    drop(a);
    let mut cold = process(Box::new(OnlyVault(disk.clone())), wire.clone());
    let b = open(&cold, "primary", "host-a");
    let scope = b.snapshot()["runtimeScope"].clone();
    assert!(
        b.call(
            "desktop.writer.acquire",
            writer_input(&scope, "session", "s1")
        )["error"]
            .as_str()
            .unwrap()
            .contains("writer_recovery_required")
    );
    assert!(
        b.call(
            "runtime.request",
            json!({"path":"/api/session/s1/prompt","method":"POST","expectedHost":scope})
        )
        .get("error")
        .is_some()
    );
    assert_eq!(
        wire.calls.lock().unwrap().len(),
        1,
        "no automatic unlock or replay after crash/reopen"
    );
    cold.shutdown();
    wait(|| cold.stopped());
}

#[test]
fn product_process_exit_barrier_retains_original_vault_until_real_join_after_last_view() {
    use std::{cell::RefCell, rc::Rc};
    let (vault, disk) = store();
    let process = Rc::new(RefCell::new(process(vault, Arc::new(Wire::default()))));
    let mut a = open(&process.borrow(), "primary", "host-a");
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert_eq!(
        disk.drops.load(Ordering::Acquire),
        0,
        "Dock reopen retains original Process without a view"
    );
    let mut b = open(&process.borrow(), "primary", "host-b");
    b.owner.begin_shutdown();
    wait(|| b.owner.stopped());
    let mut barrier = ExitBarrier::new(process.clone());
    wait(|| barrier.poll());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
    assert!(barrier.poll());
}

#[cfg(target_os = "macos")]
#[test]
fn production_factory_two_real_engines_use_native_granted_independent_journal_and_catalog_and_cold_restore()
 {
    use std::os::unix::fs::DirBuilderExt;
    let home = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("nsh-factory-disk-{}", crate::vault::id().unwrap()));
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&home)
        .unwrap();
    let _temp = Temp(home.clone());
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(home.join("Library"))
        .unwrap();
    let manifest: Value = serde_json::from_str(include_str!("../../nsh.json")).unwrap();
    let caps = manifest["capabilities"].clone();
    let (vault, _) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let install = |key: &str| {
        let installed = factory::open(
            &process,
            key.into(),
            caps.clone(),
            appearance::metadata(&Value::Null),
            appearance::Port::unavailable(),
            Some("host-a".into()),
        )
        .unwrap();
        let leaf = if key == "primary" {
            "terminal-catalog-primary".into()
        } else {
            format!("window-terminal-{}", installed.namespace)
        };
        let (_, catalog) =
            crate::notification_store_grant::granted_in_synthetic_home(&home, &leaf).unwrap();
        let app_dir = home.join("Library/Application Support/com.yee94.yuri.nsh");
        installed
            .install_stores(
                &app_dir,
                crate::terminal_viewport::Registration::default(),
                catalog,
            )
            .unwrap();
        launch(installed, caps.clone(), key)
    };
    let mut a = install("primary");
    let mut b = install("main:two.1");
    assert_eq!(
        a.call("desktop.files.journal.snapshot", json!({}))["value"]["version"],
        0
    );
    assert_eq!(
        a.call(
            "desktop.files.journal.commit",
            json!({"expectedVersion":0,"requestID":"journal-a","records":{}})
        )["value"]["version"],
        1
    );
    assert_eq!(
        b.call("desktop.files.journal.snapshot", json!({}))["value"]["version"],
        0
    );
    let aa = a.snapshot()["runtimeScope"].clone();
    let bb = b.snapshot()["runtimeScope"].clone();
    let catalog = json!({"schema":1,"hostID":"host-a","directories":[{"directory":"/workspace","activeId":"tab-one","tabs":[{"id":"tab-one","lifecycle":"idle"}]}]});
    assert_eq!(
        a.call(
            "terminal.catalog.write",
            json!({"expectedHost":aa,"catalog":catalog})
        )["value"],
        true
    );
    assert_eq!(
        b.call("terminal.catalog.read", json!({"expectedHost":bb}))["value"]["directories"],
        json!([])
    );
    a.owner.services.approve_final_close();
    b.owner.services.approve_final_close();
    a.owner.begin_shutdown();
    b.owner.begin_shutdown();
    wait(|| a.owner.stopped() && b.owner.stopped());
    let reopened_a = install("primary");
    let reopened_b = install("main:two.1");
    assert_eq!(
        reopened_a.call("desktop.files.journal.snapshot", json!({}))["value"]["version"],
        1
    );
    assert_eq!(
        reopened_b.call("desktop.files.journal.snapshot", json!({}))["value"]["version"],
        0
    );
    let scope = reopened_a.snapshot()["runtimeScope"].clone();
    assert_eq!(
        reopened_a.call("terminal.catalog.read", json!({"expectedHost":scope}))["value"],
        catalog
    );
    assert!(
        home.join("Library/Application Support/com.yee94.yuri.nsh/terminal-catalog.json")
            .is_file(),
        "primary keeps exact legacy file, without copying it to peers"
    );
    assert_eq!(
        crate::file_journal::window_namespace("primary").unwrap(),
        "primary"
    );
    assert_ne!(
        crate::file_journal::window_namespace("main:two.1").unwrap(),
        crate::file_journal::window_namespace("main_two_1").unwrap()
    );
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn two_engine_contexts_share_original_vault_transaction_lane_without_cross_window_selection_or_stale_overwrite()
 {
    let (vault, disk) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let mut a = open(&process, "primary", "host-a");
    let mut b = open(&process, "secondary", "host-b");
    assert_ne!(
        a.owner.services.window_id().unwrap(),
        b.owner.services.window_id().unwrap()
    );
    let aa = a.snapshot();
    let bb = b.snapshot();
    assert_eq!(aa["selected"], "host-a");
    assert_eq!(bb["selected"], "host-b");
    assert_ne!(aa["runtimeScope"], bb["runtimeScope"]);
    assert_eq!(
        disk.writes.load(Ordering::Acquire),
        1,
        "restoring views never rewrites global selected"
    );
    let editor = a.call("connection.editor", json!({"id":"host-a"}))["value"].clone();
    assert!(
        a.call(
            "connection.rename",
            json!({"id":"host-a","version":editor["version"],"label":"Renamed A"})
        )
        .get("error")
        .is_none()
    );
    let editor = b.call("connection.editor", json!({"id":"host-b"}))["value"].clone();
    assert!(
        b.call(
            "connection.rename",
            json!({"id":"host-b","version":editor["version"],"label":"Renamed B"})
        )
        .get("error")
        .is_none()
    );
    let a2 = a.snapshot();
    let b2 = b.snapshot();
    assert_eq!(a2["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(b2["runtimeScope"], bb["runtimeScope"]);
    for (view, scope) in [(&a, &aa["runtimeScope"]), (&b, &bb["runtimeScope"])] {
        assert!(view.call("runtime.request", json!({"path":"/api/config/settings","method":"POST","body":{"fixture":true},"expectedHost":scope})).get("error").is_none());
    }
    let calls = wire.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].url, "https://host-a.invalid/api/config/settings");
    assert_eq!(calls[1].url, "https://host-b.invalid/api/config/settings");
    assert!(
        calls[0]
            .headers
            .contains(&("Authorization".into(), "Bearer fixture-host-a-token".into()))
    );
    assert!(
        calls[1]
            .headers
            .contains(&("Authorization".into(), "Bearer fixture-host-b-token".into()))
    );
    drop(calls);
    let bytes = disk.bytes.lock().unwrap().clone().unwrap();
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        saved["connections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["label"] == "Renamed A")
    );
    assert!(
        saved["connections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["label"] == "Renamed B")
    );
    assert_eq!(
        saved["selected"], "host-a",
        "secondary metadata writes must not steal primary cold default"
    );
    assert!(
        a.call("connection.select", json!({"id":"host-b"}))
            .get("error")
            .is_none()
    );
    assert_eq!(
        b.snapshot()["runtimeScope"],
        bb["runtimeScope"],
        "Settings selection in A never rolls B's lease"
    );
    assert_eq!(wire.calls.lock().unwrap().len(), 2);
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert!(b.owner.services.live());
    assert_eq!(disk.drops.load(Ordering::Acquire), 0);
    assert_eq!(b.snapshot()["selected"], "host-b");
    b.owner.begin_shutdown();
    wait(|| b.owner.stopped());
    process.shutdown();
    wait(|| process.stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
    drop(a.engine);
    drop(b.engine);
}

#[test]
fn same_request_id_and_wrong_window_are_denied_and_late_http_after_one_close_never_reaches_other_engine()
 {
    let (vault, _) = store();
    let wire = Arc::new(Wire::default());
    let mut process = process(vault, wire.clone());
    let mut a = open(&process, "primary", "host-a");
    let mut b = open(&process, "secondary", "host-b");
    let aa = a.snapshot();
    let bb = b.snapshot();
    let input = |view: &View, scope: &Value, id: &str| json!({"ownerID":"fixture-owner","requestID":id,"windowID":view.owner.services.window_id().unwrap(),"expectedHost":scope,"path":"/api/wait"});
    a.send(
        "runtime.http.request",
        input(&a, &aa["runtimeScope"], "shared-id"),
        "a-wait",
    );
    wait(|| wire.held.lock().unwrap().len() == 1);
    assert!(
        b.call(
            "runtime.http.request",
            input(&b, &bb["runtimeScope"], "shared-id")
        )["error"]
            .as_str()
            .unwrap()
            .contains("http_receipt_stale")
    );
    let mut wrong = input(&a, &bb["runtimeScope"], "wrong-window");
    wrong["expectedHost"] = bb["runtimeScope"].clone();
    assert!(b.call("runtime.http.request", wrong).get("error").is_some());
    b.send(
        "runtime.http.request",
        input(&b, &bb["runtimeScope"], "b-id"),
        "b-wait",
    );
    wait(|| wire.held.lock().unwrap().len() == 2);
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert_eq!(a.receive()["tag"], "a-wait");
    let held = std::mem::take(&mut *wire.held.lock().unwrap());
    for (url, mut events) in held {
        complete(&mut events, &url, json!({"url":url}));
    }
    let received = b.receive();
    assert_eq!(received["tag"], "b-wait");
    assert_eq!(
        received["value"]["body"]["url"],
        "https://host-b.invalid/api/wait"
    );
    assert!(a.output.try_recv().is_err());
    assert!(b.owner.services.live());
    assert_eq!(wire.calls.lock().unwrap().len(), 2);
    b.owner.begin_shutdown();
    wait(|| b.owner.stopped());
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn original_unknown_write_poison_fences_all_contexts_and_never_creates_another_vault_or_replays() {
    let (vault, disk) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let a = open(&process, "primary", "host-a");
    let b = open(&process, "secondary", "host-b");
    a.snapshot();
    b.snapshot();
    disk.unknown.store(true, Ordering::Release);
    assert!(
        a.call("connection.remove", json!({"id":"host-b"}))
            .get("error")
            .is_some()
    );
    wait(|| !a.owner.services.live() && !b.owner.services.live());
    let writes = disk.writes.load(Ordering::Acquire);
    assert!(
        b.call("connection.select", json!({"id":"host-a"}))
            .get("error")
            .is_some()
    );
    assert_eq!(disk.writes.load(Ordering::Acquire), writes);
    process.shutdown();
    wait(|| process.stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
}

#[test]
fn ssh_has_one_process_dispatcher_and_original_actor_survives_view_close_until_service_stopped_ok()
{
    struct Driver(Arc<AtomicUsize>);
    struct Tunnel(Arc<AtomicUsize>);
    impl crate::ssh::Tunnel for Tunnel {
        fn alive(&mut self) -> bool {
            true
        }
        fn close(&mut self) {
            self.0.fetch_add(1, Ordering::AcqRel);
        }
    }
    impl crate::ssh::Driver for Driver {
        fn inspect(
            &self,
            _: &crate::ssh::Instance,
            cancel: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<crate::ssh::Inspection> {
            cancel.check()?;
            Ok(crate::ssh::Inspection {
                node_major: 24,
                version: Some("1.2.3".into()),
            })
        }
        fn initialize(
            &self,
            _: &crate::ssh::Instance,
            _: &str,
            _: &crate::ssh::Secret,
            cancel: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<()> {
            cancel.check()
        }
        fn forward(
            &self,
            _: &crate::ssh::Instance,
            cancel: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<crate::ssh::Forward> {
            cancel.check()?;
            Ok(crate::ssh::Forward {
                port: 43123,
                tunnel: Box::new(Tunnel(self.0.clone())),
            })
        }
    }
    let (vault, disk) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let closed = Arc::new(AtomicUsize::new(0));
    process
        .install_ssh(Ok(Arc::new(Driver(closed.clone()))), "1.2.3".into())
        .unwrap();
    assert!(
        process
            .install_ssh(Ok(Arc::new(Driver(closed.clone()))), "1.2.3".into())
            .is_err()
    );
    assert_eq!(process.connection_actor_port().load().unwrap().revision, 0);
    assert!(matches!(
        process.connection_actor_http_port().local_service(),
        Err(crate::connection_actor_http_port::Error::Unavailable)
    ));
    let mut a = open(&process, "primary", "host-a");
    let mut b = open(&process, "secondary", "host-b");
    assert!(
        a.owner
            .install_ssh(Ok(Arc::new(Driver(closed.clone()))), "1.2.3".into())
            .is_err()
    );
    let aa = a.snapshot();
    let bb = b.snapshot();
    wait(|| {
        b.call("desktop.ssh.capabilities", json!({}))["value"]["connections"]["supported"] == true
    });
    let row = json!({"id":"process-ssh","label":"Fixture","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true});
    assert!(
        a.call(
            "desktop.ssh.save",
            json!({"requestID":"process-save","revision":0,"instance":row})
        )
        .get("error")
        .is_none()
    );
    assert!(
        a.call(
            "desktop.ssh.start",
            json!({"requestID":"process-start","id":"process-ssh","intent":"connect"})
        )
        .get("error")
        .is_none()
    );
    wait(|| b.call("desktop.ssh.read", json!({}))["value"]["statuses"][0]["phase"] == "ready");
    assert_eq!(a.snapshot()["runtimeScope"], aa["runtimeScope"]);
    assert_eq!(
        b.snapshot()["runtimeScope"],
        bb["runtimeScope"],
        "process SSH commit must not steal either window's Host"
    );
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    assert_eq!(
        b.call("desktop.ssh.capabilities", json!({}))["value"]["connections"]["supported"],
        true
    );
    assert_eq!(
        closed.load(Ordering::Acquire),
        0,
        "closing one window is not process SSH shutdown"
    );
    b.owner.begin_shutdown();
    wait(|| b.owner.stopped());
    process.shutdown();
    wait(|| process.stopped());
    assert_eq!(closed.load(Ordering::Acquire), 1);
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
}

#[test]
fn pool_rejects_duplicate_key_or_channel_without_rebinding_existing_engine_and_drops_cancelled_open()
 {
    let (vault, _) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    let mut a = open(&process, "primary", "host-a");
    assert_eq!(
        a.host.params()["windowCoordination"],
        "multi-engine",
        "the first primary already knows its process coordination policy"
    );
    let request = |key: &str, host: HostChannel| WindowRequest {
        window_key: key.into(),
        host,
        capabilities: json!({"host":HANDLED}),
        metadata: appearance::metadata(&Value::Null),
        appearance: appearance::Port::unavailable(),
        restore_target: Some("host-b".into()),
    };
    let duplicate = process
        .open_window(request("primary", HostChannel::default()))
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert!(matches!(duplicate, Err(error) if error == "window_identity_invalid"));
    let duplicate = process
        .open_window(request("secondary", a.host.clone()))
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert!(matches!(duplicate, Err(error) if error == "window_channel_reused"));
    assert_eq!(a.snapshot()["selected"], "host-a");
    assert_eq!(a.host.params()["windowKey"], "primary");
    drop(
        process
            .open_window(request("cancelled-open", HostChannel::default()))
            .unwrap(),
    );
    wait(|| {
        !process
            .windows
            .lock()
            .unwrap()
            .contains_key("cancelled-open")
    });
    a.owner.begin_shutdown();
    wait(|| a.owner.stopped());
    let retired = process
        .open_window(request("primary", a.host.clone()))
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert!(matches!(retired, Err(error) if error == "window_channel_reused"));
    let mut reopened = open(&process, "primary", "host-b");
    assert_eq!(reopened.snapshot()["selected"], "host-b");
    assert!(
        a.call("connection.list", json!({})).get("error").is_some(),
        "late old Engine must not call the replacement context"
    );
    reopened.owner.begin_shutdown();
    wait(|| reopened.owner.stopped());
    process.shutdown();
    wait(|| process.stopped());
}

#[test]
fn failed_process_ssh_stop_keeps_original_actor_and_vault_lane_unresolved_without_production_unlock()
 {
    struct Inert;
    impl crate::ssh::Driver for Inert {
        fn inspect(
            &self,
            _: &crate::ssh::Instance,
            _: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<crate::ssh::Inspection> {
            panic!("save has no SSH I/O")
        }
        fn initialize(
            &self,
            _: &crate::ssh::Instance,
            _: &str,
            _: &crate::ssh::Secret,
            _: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<()> {
            panic!("save has no SSH I/O")
        }
        fn forward(
            &self,
            _: &crate::ssh::Instance,
            _: &crate::ssh::Cancellation,
        ) -> crate::ssh::Result<crate::ssh::Forward> {
            panic!("save has no SSH I/O")
        }
    }
    let (vault, disk) = store();
    let mut process = process(vault, Arc::new(Wire::default()));
    process
        .install_ssh(Ok(Arc::new(Inert)), "1.2.3".into())
        .unwrap();
    let a = open(&process, "primary", "host-a");
    wait(|| {
        a.call("desktop.ssh.capabilities", json!({}))["value"]["connections"]["supported"] == true
    });
    disk.unknown.store(true, Ordering::Release);
    let row = json!({"id":"unknown-ssh","label":"Fixture","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true});
    assert!(
        a.call(
            "desktop.ssh.save",
            json!({"requestID":"unknown-process-save","revision":0,"instance":row})
        )
        .get("error")
        .is_some()
    );
    let control = process.anchor.services.ssh().unwrap();
    wait(|| control.shutdown_failure() == Some(crate::ssh::Error::CommitUnknown));
    process.shutdown();
    assert!(!process.anchor.actor_stop.load(Ordering::Acquire));
    assert!(!process.stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 0);
    let writes = disk.writes.load(Ordering::Acquire);
    assert!(matches!(
        process.connection_actor_port().load(),
        Err(crate::connection_actor_port::Error::CommitUnknown)
    ));
    assert_eq!(disk.writes.load(Ordering::Acquire), writes);
    let process = std::rc::Rc::new(std::cell::RefCell::new(process));
    let mut exit = ExitBarrier::new(process.clone());
    assert!(
        !exit.poll(),
        "OS exit must retain failed SSH anchor even after all views stop"
    );
    // Test-private disposal of a synthetic unresolved worker, NOT a production recovery API.
    process
        .borrow()
        .anchor
        .actor_stop
        .store(true, Ordering::Release);
    wait(|| process.borrow().stopped());
    assert_eq!(disk.drops.load(Ordering::Acquire), 1);
}
