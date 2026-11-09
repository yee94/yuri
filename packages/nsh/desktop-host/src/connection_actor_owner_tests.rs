//! Actual bounded connection actor/typed port; synthetic Vault and Network only.
use super::*;
use crate::connection_actor_port::{self as port, Error, Target};
#[derive(Default)]
struct AuthNetwork {
    requests: Mutex<Vec<HttpRequest>>,
    counter: AtomicUsize,
    mint_status: AtomicUsize,
    probe_status: AtomicUsize,
}
impl Network for AuthNetwork {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn FetchTask> {
        assert!(!request.follow_redirects);
        let mint = request.url.ends_with("/auth/session");
        let body = if mint {
            assert!(
                !request
                    .headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            );
            let nsh_engine::HttpBody::Bytes(bytes) = &request.body else {
                panic!("auth body must be native bytes")
            };
            let b: Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(b["clientKind"], "desktop-local");
            let candidate = b["dedupeKey"].as_str().unwrap().strip_prefix("desktop-local:ssh:").unwrap();
            assert!(super::super::connection_actor_storage::identifier(candidate));
            assert_eq!(b["clientLabel"], format!("Yuri SSH {candidate}"));
            assert_eq!(b["trustDevice"], true);
            assert_eq!(b["issueClientToken"], true);
            json!({"clientToken":format!("synthetic-native-token-{}",self.counter.fetch_add(1,Ordering::Relaxed))})
        } else {
            assert!(request.url.ends_with("/api/config/settings"));
            assert!(
                request.headers.iter().any(|(k, v)| k == "Authorization"
                    && v.starts_with("Bearer synthetic-native-token-"))
            );
            json!({"ok":true})
        };
        let url = request.url.clone();
        self.requests.lock().unwrap().push(request);
        let status = if mint { &self.mint_status } else { &self.probe_status }.load(Ordering::Acquire);
        events(FetchEvent::Head(HttpHead {
            status: if status == 0 { 200 } else { status as u16 },
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        events(FetchEvent::Data(serde_json::to_vec(&body).unwrap()));
        events(FetchEvent::End);
        Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
    }
}
fn target(id: &str) -> Target {
    Target {
        id: id.into(),
        label: format!("Synthetic {id}"),
        host: "synthetic.invalid".into(),
        user: "synthetic".into(),
        port: 22,
        remote_port: 4000,
        local_port: 0,
        managed: true,
    }
}
fn installed(vault: MemoryVault, network: Arc<dyn Network>) -> Owner {
    let selection = vault.clone();
    let mut owner = install_with(
        &HostChannel::default(),
        &json!({"host":[]}),
        Box::new(vault),
        network,
        false,
    )
    .unwrap();
    owner.native_port = owner.native_port.with_selection_protection(Arc::new(move |id| {
        // Synthetic durable primary selection, not a boolean mock of a commit.
        saved(&selection)["selected"].as_str() == Some(id)
    }));
    owner
}
fn saved(vault: &MemoryVault) -> Value {
    serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap()
}
fn authorize(port: &port::Port, t: &Target, local: u16) -> port::Committed {
    let secret = port.password(t.clone()).unwrap();
    port.authorize(t.clone(), local, secret, Arc::new(|| true))
        .unwrap()
}
fn select(owner: &Owner, id: &str) {
    owner.tx.try_send(Message::Call("connection.select".into(), json!({"id":id}), HostReply::default())).ok().unwrap();
    owner.connection_actor_port().load().unwrap();
}
fn tabs(owner: &Owner) -> crate::desktop_tab::Registration {
    let tabs = crate::desktop_tab::Registration::default();
    owner.services().install_tabs(tabs.clone()).unwrap();
    tabs
}
fn saved_connection(vault: &MemoryVault, id: &str) -> Value {
    saved(vault)["connections"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone()
}

#[test]
fn ready_versions_never_replace_selected_authority_and_only_original_select_rotates_lease() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("ready-version");
    p.save(0, vec![t.clone()]).unwrap();
    let tabs = tabs(&owner);
    let direct = tabs.current_scope().unwrap();
    let first = authorize(&p, &t, 41201);
    assert_eq!(saved(&vault)["selected"], "synthetic-host");
    assert_eq!(tabs.current_scope(), Some(direct));
    select(&owner, &first.connection_id);
    let selected = tabs.current_scope().unwrap();
    assert_eq!(selected["hostID"], first.connection_id);
    let prior = saved_connection(&vault, &first.connection_id);
    let renewed = authorize(&p, &t, 41202);
    assert_ne!(first.connection_id, renewed.connection_id);
    assert_eq!(saved(&vault)["selected"], first.connection_id);
    assert_eq!(saved_connection(&vault, &first.connection_id), prior);
    assert_eq!(tabs.current_scope(), Some(selected.clone()));
    let restored = p.restore(t, Arc::new(|| true)).unwrap().unwrap();
    assert_ne!(restored.connection_id, renewed.connection_id);
    assert_ne!(restored.connection_id, first.connection_id);
    assert_eq!(saved_connection(&vault, &first.connection_id), prior);
    assert_eq!(tabs.current_scope(), Some(selected.clone()));
    assert!(!p.healthy(renewed.clone()).unwrap());
    p.retire(renewed).unwrap();
    assert_eq!(tabs.current_scope(), Some(selected.clone()));
    select(&owner, &restored.connection_id);
    let chosen = tabs.current_scope().unwrap();
    assert_eq!(chosen["hostID"], restored.connection_id);
    assert_ne!(chosen["lease"], selected["lease"]);
    p.retire(first).unwrap();
    assert_eq!(tabs.current_scope(), Some(chosen.clone()), "late receipt cannot retire a newer selection");
    p.retire(restored).unwrap();
    assert_eq!(tabs.current_scope(), None, "exact owned health retirement still revokes its own runtime");
}

#[test]
fn cancelled_and_cold_candidates_cannot_be_selected_or_reuse_an_immutable_ready_version() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("cancelled-candidate");
    p.save(0, vec![t.clone()]).unwrap();
    let tabs = tabs(&owner);
    let prior = tabs.current_scope();
    let cancel = Arc::new(AtomicBool::new(false));
    let current = cancel.clone();
    let candidate = p.authorize(t.clone(), 41203, p.password(t.clone()).unwrap(), Arc::new(move || !current.load(Ordering::Acquire))).unwrap();
    cancel.store(true, Ordering::Release);
    select(&owner, &candidate.connection_id);
    assert_eq!(saved(&vault)["selected"], "synthetic-host");
    assert_eq!(tabs.current_scope(), prior);
    p.retire(candidate.clone()).unwrap();
    select(&owner, &candidate.connection_id);
    assert_eq!(tabs.current_scope(), prior);
    drop(owner);
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    p.load().unwrap();
    select(&owner, &candidate.connection_id);
    assert_eq!(saved(&vault)["selected"], "synthetic-host");
    let restored = p.restore(t, Arc::new(|| true)).unwrap().unwrap();
    assert_ne!(restored.connection_id, candidate.connection_id);
    select(&owner, &restored.connection_id);
    assert_eq!(saved(&vault)["selected"], restored.connection_id);
    assert!(!saved(&vault).to_string().contains("current"), "native cancellation is never persisted");
}

#[test]
fn mint_probe_credential_and_persist_failures_leave_selected_version_and_lease_untouched() {
    for failure in ["mint", "probe", "credential", "persist", "select-persist"] {
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let network = Arc::new(AuthNetwork::default());
        let owner = installed(vault.clone(), network.clone());
        let p = owner.connection_actor_port();
        let t = target("failure-prior");
        p.save(0, vec![t.clone()]).unwrap();
        let first = authorize(&p, &t, 41204);
        select(&owner, &first.connection_id);
        let tabs = tabs(&owner);
        let prior_scope = tabs.current_scope();
        let prior_connection = saved_connection(&vault, &first.connection_id);
        let prior_record = saved(&vault);
        match failure {
            "mint" => network.mint_status.store(401, Ordering::Release),
            "probe" => network.probe_status.store(401, Ordering::Release),
            "credential" => {
                let secret = port::Secret::new("wrong-native-secret".into()).unwrap();
                assert!(matches!(p.authorize(t.clone(), 41205, secret, Arc::new(|| true)), Err(Error::Authentication)));
            }
            "persist" => vault.fail.store(true, Ordering::Release),
            "select-persist" => {
                let candidate = authorize(&p, &t, 41205);
                vault.fail.store(true, Ordering::Release);
                select(&owner, &candidate.connection_id);
            }
            _ => unreachable!(),
        }
        if matches!(failure, "mint" | "probe" | "persist") {
            assert!(matches!(p.authorize(t, 41205, p.password(target("failure-prior")).unwrap(), Arc::new(|| true)), Err(Error::Authentication | Error::Storage)));
        }
        assert_eq!(saved_connection(&vault, &first.connection_id), prior_connection, "{failure}");
        assert_eq!(tabs.current_scope(), prior_scope, "{failure}");
        assert_eq!(saved(&vault)["selected"], first.connection_id, "{failure}");
        if failure != "select-persist" { assert_eq!(saved(&vault), prior_record, "{failure}"); }
    }
}

#[derive(Default)]
struct LifecycleDriver {
    fail_inspect: AtomicBool,
    initialized: AtomicUsize,
    tunnels: Mutex<Vec<Arc<AtomicBool>>>,
    closed: Arc<AtomicUsize>,
}
struct LifecycleTunnel { alive: Arc<AtomicBool>, closed: Arc<AtomicUsize> }
impl crate::ssh::Tunnel for LifecycleTunnel {
    fn alive(&mut self) -> bool { self.alive.load(Ordering::Acquire) }
    fn close(&mut self) { self.closed.fetch_add(1, Ordering::AcqRel); }
}
impl crate::ssh::Driver for LifecycleDriver {
    fn inspect(&self, _: &crate::ssh::Instance, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<crate::ssh::Inspection> {
        cancel.check()?;
        if self.fail_inspect.load(Ordering::Acquire) { return Err(crate::ssh::Error::Ssh); }
        Ok(crate::ssh::Inspection { version: Some("1.2.3".into()), node_major: 24 })
    }
    fn initialize(&self, _: &crate::ssh::Instance, _: &str, _: &crate::ssh::Secret, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<()> {
        self.initialized.fetch_add(1, Ordering::AcqRel);
        cancel.check()
    }
    fn forward(&self, _: &crate::ssh::Instance, cancel: &crate::ssh::Cancellation) -> crate::ssh::Result<crate::ssh::Forward> {
        cancel.check()?;
        let alive = Arc::new(AtomicBool::new(true));
        let mut tunnels = self.tunnels.lock().unwrap();
        tunnels.push(alive.clone());
        Ok(crate::ssh::Forward { port: 41300 + tunnels.len() as u16,
            tunnel: Box::new(LifecycleTunnel { alive, closed: self.closed.clone() }) })
    }
}
fn wait_ssh(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !predicate() {
        assert!(Instant::now() < deadline, "synthetic SSH lifecycle timeout");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn ssh_status(owner: &crate::ssh::Owner) -> Value { owner.snapshot().unwrap()["statuses"][0].clone() }

#[test]
fn real_adapter_owner_retains_prior_selected_tunnel_on_failed_cancelled_and_successful_reconnect() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("owner-lifecycle");
    p.save(0, vec![t.clone()]).unwrap();
    let driver = Arc::new(LifecycleDriver::default());
    let service = crate::ssh::actor::create(p.clone(), driver.clone(), "1.2.3".into()).unwrap();
    let ssh = service.owner;
    ssh.start(&t.id, "first", crate::ssh::Intent::Connect).unwrap();
    wait_ssh(|| ssh_status(&ssh)["running"] == false);
    let first = ssh_status(&ssh);
    assert_eq!(first["phase"], "ready");
    let first_id = first["connectionID"].as_str().unwrap();
    select(&owner, first_id);
    let tabs = tabs(&owner);
    let prior_scope = tabs.current_scope();
    let prior = saved_connection(&vault, first_id);
    driver.fail_inspect.store(true, Ordering::Release);
    ssh.start(&t.id, "failed", crate::ssh::Intent::Connect).unwrap();
    wait_ssh(|| ssh_status(&ssh)["running"] == false);
    assert_eq!(ssh_status(&ssh)["phase"], "error");
    let failed_attempt = ssh_status(&ssh)["attempt"].as_u64().unwrap();
    ssh.cancel(&t.id, failed_attempt).unwrap();
    ssh.tick();
    assert_eq!(tabs.current_scope(), prior_scope);
    assert_eq!(saved_connection(&vault, first_id), prior);
    assert_eq!(driver.closed.load(Ordering::Acquire), 0, "failed/cancelled new attempt cannot close prior selected tunnel");
    driver.fail_inspect.store(false, Ordering::Release);
    ssh.start(&t.id, "restore-live", crate::ssh::Intent::Restore).unwrap();
    wait_ssh(|| ssh_status(&ssh)["running"] == false);
    let ready = ssh_status(&ssh);
    assert_eq!(ready["phase"], "ready");
    assert_ne!(ready["connectionID"], first["connectionID"]);
    assert_eq!(driver.initialized.load(Ordering::Acquire), 2, "live restore uses a separate managed forward, cold restore remains probe-first");
    assert_eq!(driver.closed.load(Ordering::Acquire), 0);
    assert_eq!(tabs.current_scope(), prior_scope);
    assert_eq!(saved_connection(&vault, first_id), prior);
    assert_eq!(ssh.cancel(&t.id, failed_attempt).unwrap_err(), crate::ssh::Error::Stale);
    select(&owner, ready["connectionID"].as_str().unwrap());
    let chosen = tabs.current_scope();
    ssh.tick();
    assert_eq!(driver.closed.load(Ordering::Acquire), 1, "superseded retained transport is cleaned only after authority moves");
    assert_eq!(tabs.current_scope(), chosen, "late prior cleanup must not retire new selection");
    assert!(!ssh.snapshot().unwrap().to_string().contains("receipt-"));
    ssh.shutdown();
    assert_eq!(driver.closed.load(Ordering::Acquire), 2);
    assert_eq!(tabs.current_scope(), None);
}

fn service_request(handle: &crate::ssh::service::Handle, request: crate::ssh::service::Request) -> Value {
    let (tx, rx) = mpsc::channel();
    handle.submit(request, crate::ssh::Cancellation::default(), Box::new(move |outcome| { tx.send(outcome).unwrap(); })).unwrap();
    match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
        crate::ssh::service::Outcome::Complete(value) => value,
        _ => panic!("synthetic service request failed"),
    }
}

#[test]
fn actual_service_scheduler_health_recovery_prepares_new_version_without_selecting_host() {
    use crate::ssh::service::{self, Request};
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("scheduler-recovery");
    p.save(0, vec![t.clone()]).unwrap();
    let driver = Arc::new(LifecycleDriver::default());
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let handle = service::install(p.clone(), driver.clone(), "1.2.3".into(),
        Box::new(move |result| ready_tx.send(result).unwrap()),
        Box::new(move |result| stop_tx.send(result).unwrap())).unwrap();
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    service_request(&handle, Request::Start { id: t.id.clone(), request_id: "scheduler-first".into(), intent: crate::ssh::Intent::Connect });
    let mut ready = Value::Null;
    wait_ssh(|| { ready = service_request(&handle, Request::Snapshot)["statuses"][0].clone(); ready["phase"] == "ready" && ready["running"] == false });
    let first_id = ready["connectionID"].as_str().unwrap().to_owned();
    let first_attempt = ready["attempt"].as_u64().unwrap();
    select(&owner, &first_id);
    select(&owner, "synthetic-host");
    let tabs = tabs(&owner);
    let prior = tabs.current_scope();
    let original = saved_connection(&vault, "synthetic-host");
    driver.tunnels.lock().unwrap()[0].store(false, Ordering::Release);
    wait_ssh(|| {
        ready = service_request(&handle, Request::Snapshot)["statuses"][0].clone();
        ready["phase"] == "ready" && ready["running"] == false && ready["attempt"].as_u64().is_some_and(|a| a > first_attempt)
    });
    assert!(ready["requestID"].as_str().unwrap().starts_with("recovery-"));
    assert_ne!(ready["connectionID"], first_id);
    assert_eq!(saved(&vault)["selected"], "synthetic-host");
    assert_eq!(saved_connection(&vault, "synthetic-host"), original);
    assert_eq!(tabs.current_scope(), prior);
    let public = service_request(&handle, Request::Snapshot).to_string();
    assert!(!public.contains("synthetic-native-token") && !public.contains("password") && !public.contains("receipt\":"));
    select(&owner, ready["connectionID"].as_str().unwrap());
    let chosen = tabs.current_scope();
    p.retire(port::Committed { connection_id: first_id, receipt: "stale-receipt".into() }).unwrap();
    assert_eq!(tabs.current_scope(), chosen);
    handle.shutdown();
    stop_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    assert_eq!(handle.phase(), service::Phase::Stopped);
    assert_eq!(tabs.current_scope(), None);
}

#[test]
fn final_probe_exact_cancellation_target_cas_and_supersession_reject_late_ready_without_selecting() {
    struct ProbeGate {
        auth: AuthNetwork,
        hold: AtomicBool,
        entered: mpsc::SyncSender<()>,
        pending: Mutex<Option<(String, nsh_engine::FetchEvents)>>,
    }
    impl Network for ProbeGate {
        fn fetch(&self, request: HttpRequest, events: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
            if request.url.ends_with("/api/config/settings") && self.hold.swap(false, Ordering::AcqRel) {
                *self.pending.lock().unwrap() = Some((request.url, events));
                self.entered.send(()).unwrap();
                Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
            } else { self.auth.fetch(request, events) }
        }
    }
    for (action, restore) in ["cancel", "target", "supersede", "switch-host"].into_iter().flat_map(|action| [(action, false), (action, true)]) {
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let (entered, waiting) = mpsc::sync_channel(1);
        let network = Arc::new(ProbeGate { auth: AuthNetwork::default(), hold: AtomicBool::new(false), entered, pending: Mutex::new(None) });
        let owner = installed(vault.clone(), network.clone());
        let p = owner.connection_actor_port();
        let t = target("final-probe");
        p.save(0, vec![t.clone()]).unwrap();
        let first = authorize(&p, &t, 41401);
        select(&owner, &first.connection_id);
        let tabs = tabs(&owner);
        let prior = saved_connection(&vault, &first.connection_id);
        let scope = tabs.current_scope();
        let cancelled = Arc::new(AtomicBool::new(false));
        let current = cancelled.clone();
        let sending = p.clone();
        let row = t.clone();
        let secret = p.password(t.clone()).unwrap();
        network.hold.store(true, Ordering::Release);
        let worker = std::thread::spawn(move || {
            let current: port::Current = Arc::new(move || !current.load(Ordering::Acquire));
            if restore { sending.restore(row, current).map(Option::unwrap) }
            else { sending.authorize(row, 41402, secret, current) }
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut superseding = None;
        match action {
            "cancel" => cancelled.store(true, Ordering::Release),
            "target" => { let mut changed = t.clone(); changed.remote_port += 1; p.save(1, vec![changed]).unwrap(); }
            "supersede" => superseding = Some(authorize(&p, &t, 41403)),
            "switch-host" => select(&owner, "synthetic-host"),
            _ => unreachable!(),
        }
        let after_action = tabs.current_scope();
        let record = saved(&vault);
        let (url, mut events) = network.pending.lock().unwrap().take().unwrap();
        events(FetchEvent::Head(HttpHead { status: 200, url, headers: vec![("Content-Type".into(), "application/json".into())], ..Default::default() }));
        events(FetchEvent::Data(br#"{"ok":true}"#.to_vec()));
        events(FetchEvent::End);
        let result = worker.join().unwrap();
        if action == "switch-host" {
            let ready = result.unwrap();
            assert_ne!(ready.connection_id, first.connection_id);
            assert_eq!(saved(&vault)["selected"], "synthetic-host");
        } else {
            assert!(matches!(result, Err(Error::Cancelled | Error::Stale)), "{action}");
            assert_eq!(saved(&vault), record, "late completion must not mutate a replacement");
        }
        assert_eq!(tabs.current_scope(), after_action);
        if matches!(action, "cancel" | "supersede") {
            assert_eq!(tabs.current_scope(), scope);
            assert_eq!(saved_connection(&vault, &first.connection_id), prior);
        }
        if let Some(replacement) = superseding { assert!(p.healthy(replacement).unwrap()); }
    }
}

#[test]
fn optional_live_fences_roundtrip_only_in_memory_and_unknown_selection_protects_prior_candidates() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("live-fence");
    p.save(0, vec![t.clone()]).unwrap();
    let current = Arc::new(AtomicBool::new(true));
    let check = current.clone();
    let ready = p.authorize(t.clone(), 41404, p.password(t.clone()).unwrap(), Arc::new(move || check.load(Ordering::Acquire))).unwrap();
    let mut previous = State::load(&vault, false).unwrap();
    let binding = previous.native.bindings.iter_mut().find(|b| b.receipt == ready.receipt).unwrap();
    binding.current = Some({ let current = current.clone(); Arc::new(move || current.load(Ordering::Acquire)) });
    let mut reloaded = State::load(&vault, false).unwrap();
    assert!(reloaded.native.bindings.iter().all(|b| b.current.is_none()));
    reloaded.native.inherit_live(&previous.native);
    current.store(false, Ordering::Release);
    assert!(!reloaded.native.bindings.iter().find(|b| b.receipt == ready.receipt).unwrap().current.as_ref().unwrap()());
    reloaded.native.bindings[0].receipt = "not-the-same-receipt".into();
    reloaded.native.bindings[0].current = None;
    reloaded.native.inherit_live(&previous.native);
    assert!(reloaded.native.bindings[0].current.is_none(), "another receipt cannot borrow the cancellation fence");
    // Unconfigured native Port is conservative, not an empty all-window selection.
    let unknown = owner.native_port.clone().with_selection_protection(Arc::new(|_| true));
    let fresh = authorize(&unknown, &t, 41405);
    assert_ne!(fresh.connection_id, ready.connection_id);
    assert!(saved(&vault)["connections"].as_array().unwrap().iter().any(|c| c["id"] == ready.connection_id));
}

#[test]
fn actual_host_client_dedupe_cannot_revoke_selected_or_legacy_credentials_during_background_mint() {
    use std::{io::Write, process::{Command, Stdio}};
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let network = Arc::new(AuthNetwork::default());
    let owner = installed(vault, network.clone());
    let p = owner.connection_actor_port();
    let t = target("dedupe-isolation");
    p.save(0, vec![t.clone()]).unwrap();
    authorize(&p, &t, 41406);
    authorize(&p, &t, 41407);
    let fields: Vec<_> = network.requests.lock().unwrap().iter().filter(|r| r.url.ends_with("/auth/session")).map(|request| {
        let nsh_engine::HttpBody::Bytes(body) = &request.body else { panic!("native auth body") };
        let body: Value = serde_json::from_slice(body).unwrap();
        // Only public client metadata enters this synthetic server-policy test.
        json!({"label":body["clientLabel"],"clientKind":body["clientKind"],"dedupeKey":body["dedupeKey"]})
    }).collect();
    assert_eq!(fields.len(), 2);
    assert_ne!(fields[0]["dedupeKey"], fields[1]["dedupeKey"]);
    let program = r#"
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {createRemoteClientAuthRuntime} from './packages/web/server/lib/client-auth/remote-clients.js';
let store;
const fsPromises={
  readFile:async()=>{if(store===undefined)throw Object.assign(Error('synthetic missing'),{code:'ENOENT'});return store;},
  mkdir:async()=>{},chmod:async()=>{},writeFile:async(_path,value)=>{store=value;},
};
const runtime=createRemoteClientAuthRuntime({fsPromises,path,crypto,storePath:'/synthetic-memory-only/clients.json'});
let input='';for await(const bytes of process.stdin)input+=bytes;
const metadata=JSON.parse(input);
const desktop=await runtime.createClient({clientKind:'desktop-local',dedupeKey:'desktop-local'});
const legacy=await runtime.createClient({});
const receipts=[];
for(const row of metadata){
  receipts.push(await runtime.createClient(row));
  assert.equal((await runtime.authenticateBearerToken(desktop.token))?.ok,true,'selected desktop token was revoked');
  assert.equal((await runtime.authenticateBearerToken(legacy.token))?.ok,true,'legacy default-label token was revoked');
}
for(const receipt of receipts)assert.equal((await runtime.authenticateBearerToken(receipt.token))?.ok,true,'another candidate token was revoked');
process.stdout.write('ok');
"#;
    let node = std::env::var_os("NSH_SSH_IO_NODE").expect("provide an explicit Node executable for the synthetic Host policy fixture");
    let mut child = Command::new(node).args(["--input-type=module", "--eval", program])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&serde_json::to_vec(&fields).unwrap()).unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success(), "synthetic production Host policy failed: {}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(result.stdout, b"ok");
}

#[test]
fn registry_cas_preserves_other_fields_and_bad_native_records_never_become_empty() {
    let vault = MemoryVault::default();
    let mut original = state();
    original
        .extra
        .insert("otherNativeMetadata".into(), json!({"v":7,"opaque":[1,2]}));
    original.persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let port = owner.connection_actor_port();
    let missing = port.load().unwrap();
    assert_eq!(missing.revision, 0);
    assert!(missing.instances.is_empty());
    let prior = saved(&vault);
    assert!(prior.get("sshRegistry").is_none());
    let t = target("one");
    assert_eq!(port.save(0, vec![t.clone()]), Ok(1));
    let committed = saved(&vault);
    assert_eq!(committed["connections"], prior["connections"]);
    assert_eq!(
        committed["otherNativeMetadata"],
        prior["otherNativeMetadata"]
    );
    assert_eq!(port.save(0, Vec::new()), Err(Error::Stale));
    assert_eq!(saved(&vault), committed);
    assert_eq!(port.save(1, vec![t.clone(), t]), Err(Error::Invalid));
    drop(owner);
    for corrupt in [
        Value::Null,
        json!({"schema":1,"revision":0,"instances":null}),
        json!({"schema":2,"revision":0,"instances":[]}),
        json!({"schema":1,"revision":9007199254740991u64,"instances":[]}),
    ] {
        let mut bad = committed.clone();
        bad["sshRegistry"] = corrupt;
        vault.write(&serde_json::to_vec(&bad).unwrap()).unwrap();
        let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
        assert!(owner.connection_actor_port().load().is_err());
    }
}
#[test]
fn managed_mint_probe_binding_and_exact_retirement_use_one_original_transaction_lane() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let network = Arc::new(AuthNetwork::default());
    let owner = installed(vault.clone(), network.clone());
    let port = owner.connection_actor_port();
    let a = target("one");
    let b = target("two");
    port.save(0, vec![a.clone(), b.clone()]).unwrap();
    let first = authorize(&port, &a, 41001);
    let before = saved(&vault);
    let second = authorize(&port, &b, 41001);
    let committed = saved(&vault);
    assert_ne!(
        first.connection_id, second.connection_id,
        "same origin is NOT SSH identity"
    );
    assert_eq!(committed["connections"].as_array().unwrap().len(), 3);
    assert_eq!(
        committed["sshNative"]["bindings"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        committed["sshNative"]["bindings"][1]["connectionID"],
        second.connection_id
    );
    assert_eq!(
        committed["sshNative"]["bindings"][1]["receipt"],
        second.receipt
    );
    assert!(!committed["sshRegistry"].to_string().contains("password"));
    let restored = State::load(&vault, false).unwrap();
    assert_eq!(restored.selected.as_deref(), Some("synthetic-host"));
    assert!(restored.scope.is_some(), "background SSH never replaces the prior direct Host");
    let public = restored.snapshot().to_string();
    assert!(!public.contains("synthetic-native-token"));
    assert!(!public.contains(&second.receipt));
    let again = authorize(&port, &b, 41002);
    assert_ne!(again.connection_id, second.connection_id);
    assert_ne!(again.receipt, second.receipt);
    assert!(!port.healthy(second.clone()).unwrap());
    port.retire(second).unwrap();
    assert!(port.healthy(again.clone()).unwrap());
    port.retire(again.clone()).unwrap();
    assert!(!port.healthy(again).unwrap());
    assert_eq!(
        before["connections"][0], committed["connections"][0],
        "unrelated saved connection unchanged"
    );
    assert_eq!(network.counter.load(Ordering::Relaxed), 3);
}
#[test]
fn cold_restore_only_probes_saved_direct_endpoint_and_rotates_native_receipt() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let t = target("one");
    let first = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = first.connection_actor_port();
    p.save(0, vec![t.clone()]).unwrap();
    let old = authorize(&p, &t, 41003);
    drop(first);
    let network = Arc::new(AuthNetwork::default());
    let cold = installed(vault.clone(), network.clone());
    let p = cold.connection_actor_port();
    p.load().unwrap();
    assert!(network.requests.lock().unwrap().is_empty());
    let next = p.restore(t, Arc::new(|| true)).unwrap().unwrap();
    assert_ne!(next.connection_id, old.connection_id);
    assert_ne!(next.receipt, old.receipt);
    assert_eq!(network.requests.lock().unwrap().len(), 1);
    assert_eq!(network.counter.load(Ordering::Relaxed), 0);
    p.retire(old).unwrap();
    assert!(p.healthy(next).unwrap());
}
#[test]
fn confirmed_storage_failure_keeps_prior_receipt_and_authority() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let owner = installed(vault.clone(), Arc::new(AuthNetwork::default()));
    let p = owner.connection_actor_port();
    let t = target("one");
    p.save(0, vec![t.clone()]).unwrap();
    let prior = authorize(&p, &t, 41004);
    let record = saved(&vault);
    vault.fail.store(true, Ordering::Release);
    let secret = p.password(t.clone()).unwrap();
    assert!(matches!(
        p.authorize(t, 41005, secret, Arc::new(|| true)),
        Err(Error::Storage)
    ));
    assert_eq!(saved(&vault), record);
    assert!(p.healthy(prior).unwrap());
    vault.fail.store(false, Ordering::Release);
    let mut external = target("external");
    external.managed = false;
    p.save(1, vec![external.clone()]).unwrap();
    assert!(matches!(p.password(external), Err(Error::Authentication)));
}
#[test]
fn unknown_vault_commit_quarantines_the_original_actor() {
    struct Unknown(MemoryVault);
    impl Vault for Unknown {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.0.read()
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            Err(vault::COMMIT_UNKNOWN.into())
        }
    }
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let owner = install_with(
        &host,
        &json!({"host":[]}),
        Box::new(Unknown(vault)),
        Arc::new(AuthNetwork::default()),
        false,
    )
    .unwrap();
    let p = owner.connection_actor_port();
    p.load().unwrap();
    assert_eq!(p.save(0, vec![target("one")]), Err(Error::CommitUnknown));
    assert!(matches!(p.load(), Err(Error::CommitUnknown)));
    p.quarantine().unwrap();
    assert!(
        owner.services().window_id().is_err(),
        "native services remain terminally fenced"
    );
}

#[test]
fn full_original_queue_is_busy_and_dispatched_write_timeout_fences_before_return() {
    struct Paused {
        store: MemoryVault,
        entered: mpsc::SyncSender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
        write: bool,
    }
    impl Vault for Paused {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            if !self.write {
                self.entered.send(()).unwrap();
                self.resume
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            if self.write {
                self.entered.send(()).unwrap();
                self.resume
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            self.store.write(bytes)
        }
    }
    for write in [false, true] {
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, paused) = mpsc::sync_channel(1);
        let owner = install_with(
            &HostChannel::default(),
            &json!({"host":[]}),
            Box::new(Paused {
                store: vault.clone(),
                entered,
                resume: Mutex::new(paused),
                write,
            }),
            Arc::new(AuthNetwork::default()),
            false,
        )
        .unwrap();
        let port = owner.connection_actor_port();
        if write {
            port.load().unwrap();
            owner.services().window_id().unwrap();
            let timed = port.with_timeout(Duration::from_millis(30));
            let result = std::thread::spawn(move || timed.save(0, vec![target("one")]));
            waiting.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(result.join().unwrap(), Err(Error::CommitUnknown));
            assert!(
                owner.services().window_id().is_err(),
                "timeout fences services without waiting for Vault"
            );
            release.send(()).unwrap();
            assert!(matches!(port.load(), Err(Error::CommitUnknown)));
            assert_eq!(
                saved(&vault)["sshRegistry"]["revision"],
                1,
                "admitted durable write is not falsely rolled back"
            );
        } else {
            let loading = port.clone();
            let worker = std::thread::spawn(move || loading.load());
            waiting.recv_timeout(Duration::from_secs(5)).unwrap();
            for _ in 0..QUEUE {
                owner
                    .tx
                    .try_send(Message::RefreshNotifications)
                    .ok()
                    .unwrap();
            }
            assert_eq!(port.save(0, vec![target("one")]), Err(Error::Busy));
            release.send(()).unwrap();
            assert_eq!(worker.join().unwrap().unwrap().revision, 0);
            assert!(saved(&vault).get("sshRegistry").is_none());
        }
    }
}

#[test]
fn target_cas_during_authentication_and_native_cancel_block_late_commit() {
    struct PausedNetwork {
        ready: mpsc::SyncSender<()>,
        callback: Mutex<Option<nsh_engine::FetchEvents>>,
    }
    impl Network for PausedNetwork {
        fn fetch(
            &self,
            request: HttpRequest,
            events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            assert!(request.url.ends_with("/auth/session"));
            *self.callback.lock().unwrap() = Some(events);
            self.ready.send(()).unwrap();
            Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
        }
    }
    for replace in [false, true] {
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let (ready, waiting) = mpsc::sync_channel(1);
        let network = Arc::new(PausedNetwork {
            ready,
            callback: Mutex::new(None),
        });
        let owner = installed(vault.clone(), network.clone());
        let port = owner.connection_actor_port();
        let t = target("one");
        port.save(0, vec![t.clone()]).unwrap();
        let password = port.password(t.clone()).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let checking = cancelled.clone();
        let authorizing = port.clone();
        let original = t.clone();
        let worker = std::thread::spawn(move || {
            authorizing.authorize(
                original,
                41008,
                password,
                Arc::new(move || !checking.load(Ordering::Acquire)),
            )
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        if replace {
            let mut changed = t;
            changed.remote_port = 5000;
            port.save(1, vec![changed]).unwrap();
        } else {
            cancelled.store(true, Ordering::Release);
        }
        let mut callback = network.callback.lock().unwrap().take().unwrap();
        callback(FetchEvent::Head(HttpHead {
            status: 200,
            url: "http://127.0.0.1:41008/auth/session".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        callback(FetchEvent::Data(
            br#"{"clientToken":"synthetic-late-token"}"#.to_vec(),
        ));
        callback(FetchEvent::End);
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error::Cancelled) | Err(Error::Stale)
        ));
        let saved = saved(&vault);
        assert_eq!(saved["connections"].as_array().unwrap().len(), 1);
        assert!(
            saved
                .get("sshNative")
                .is_none_or(|v| v["bindings"].as_array().unwrap().is_empty())
        );
    }
}
