//! Only injected memory metadata. No real preferences, Vault, network or user files.
use super::*;
use std::time::Duration;

#[derive(Default)]
struct Disk {
    enabled: bool,
    load_failed: bool,
    save_failed: bool,
    loads: usize,
    saves: Vec<bool>,
    cancelled_before_save: Option<Arc<AtomicBool>>,
}
struct MemoryPreference(Arc<Mutex<Disk>>);
impl Preference for MemoryPreference {
    fn load(&mut self) -> Result<bool> {
        let mut disk = self.0.lock().unwrap();
        disk.loads += 1;
        if disk.load_failed { Err("synthetic-private-load-path".into()) } else { Ok(disk.enabled) }
    }
    fn save(&mut self, enabled: bool) -> Result<()> {
        let mut disk = self.0.lock().unwrap();
        disk.saves.push(enabled);
        if let Some(cancelled) = &disk.cancelled_before_save {
            assert!(!enabled);
            assert!(cancelled.load(Ordering::Acquire), "cancel export before metadata I/O");
        }
        if disk.save_failed { Err("synthetic-private-save-path".into()) }
        else { disk.enabled = enabled; Ok(()) }
    }
}
fn scope() -> Scope {
    Scope::committed(&json!({"hostID":"fixture-host","lease":"00000000-0000-4000-8000-000000000001"}), "fixture-auth", "fixture-window").unwrap()
}
fn install(disk: Arc<Mutex<Disk>>) -> (HostChannel, Owner, Inbox) {
    let host = HostChannel::default();
    let (port, inbox) = channel();
    let owner = install_with_preference(&host, Arc::new(||Some(scope())), port, json!("0.4.0"), Value::Null, Some(Box::new(MemoryPreference(disk))));
    (host, owner, inbox)
}
struct Sink;
impl nsh_engine::MountSink for Sink { fn submit(&self, _: nsh_core::MountBatch) {} }
fn run(host: HostChannel, script: &str) -> Value {
    let (tx, rx) = mpsc::channel();
    host.handle("fixture.done", move |mut call| { tx.send(call.take_data()).unwrap(); });
    let mut bundle = nsh_engine::Bundle::source(format!(r#"import {{host}} from 'nsh'; (async()=>{{
        const call=(n,b)=>host.call('native.diagnostics.'+n,b);
        {script}
    }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#));
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = nsh_engine::EngineConfig::new(bundle); config.host = host;
    let engine = nsh_engine::Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    let value = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    drop(engine);
    assert!(value.get("error").is_none(), "{value}");
    value
}

#[test]
fn injected_preference_restores_only_consent_with_fresh_lease_no_events_and_no_load_write() {
    let disk = Arc::new(Mutex::new(Disk::default()));
    let (host, owner, inbox) = install(disk.clone());
    assert_eq!(disk.lock().unwrap().loads, 1);
    assert!(disk.lock().unwrap().saves.is_empty());
    let first = run(host, r#"
        const initial=await call('status');const on=await call('setEnabled',{enabled:true});
        const same=await call('setEnabled',{enabled:true});
        await call('append',{hostID:'fixture-host',lease:on.recordingLease,dropped:0,events:[{at:1,feat:'transcript',kind:'sse-event',sessionID:'session-1',source:'sse',sseType:'session.status',surfaceKind:'global'}]});
        host.post('fixture.done',{initial,on,same,recorded:await call('status')});
    "#);
    assert_eq!(first["initial"]["enabled"], false);
    assert_eq!(first["initial"]["preferenceState"], "ready");
    assert_eq!(first["on"]["recordingLease"], first["same"]["recordingLease"]);
    assert_eq!(first["recorded"]["eventCount"], 1);
    assert_eq!(disk.lock().unwrap().saves, vec![true]);
    assert!(inbox.try_recv().is_none()); drop(owner);
    let (host, owner, _) = install(disk.clone());
    let restored = run(host, "host.post('fixture.done',{status:await call('status')});");
    assert_eq!(restored["status"]["enabled"], true);
    assert_eq!(restored["status"]["eventCount"], 0);
    assert_ne!(restored["status"]["recordingLease"], first["on"]["recordingLease"]);
    assert_eq!(disk.lock().unwrap().loads, 2);
    assert_eq!(disk.lock().unwrap().saves, vec![true]); drop(owner);
    // Restored consent must also acquire a lease when setEnabled(true) is the first call.
    let (host, _owner, _) = install(disk.clone());
    let value = run(host, "host.post('fixture.done',{status:await call('setEnabled',{enabled:true})});");
    assert!(value["status"]["recordingLease"].is_string());
    assert_eq!(disk.lock().unwrap().saves, vec![true]);
}

#[test]
fn confirmed_disable_persists_false_and_send_only_preference_does_not_need_sync() {
    let disk = Arc::new(Mutex::new(Disk { enabled:true, ..Disk::default() }));
    let (host, owner, _) = install(disk.clone());
    let value = run(host, "host.post('fixture.done',{status:await call('setEnabled',{enabled:false})});");
    assert_eq!(value["status"]["enabled"], false); drop(owner);
    let (host, _owner, _) = install(disk.clone());
    let value = run(host, "host.post('fixture.done',{status:await call('status')});");
    assert_eq!(value["status"]["enabled"], false);
    assert!(value["status"]["recordingLease"].is_null());
    assert_eq!(disk.lock().unwrap().saves, vec![false]);
    // Cell is Send but !Sync: the native driver is uniquely owned behind the gate.
    struct SendOnly(std::cell::Cell<bool>);
    impl Preference for SendOnly {
        fn load(&mut self) -> Result<bool> { Ok(self.0.get()) }
        fn save(&mut self, enabled: bool) -> Result<()> { self.0.set(enabled); Ok(()) }
    }
    let host = HostChannel::default(); let (port, _) = channel();
    let _owner = install_with_preference(&host, Arc::new(||Some(scope())), port, Value::Null, Value::Null, Some(Box::new(SendOnly(std::cell::Cell::new(false)))));
    let value = run(host, "host.post('fixture.done',{status:await call('setEnabled',{enabled:true})});");
    assert_eq!(value["status"]["enabled"], true);
}

#[test]
fn load_failure_is_explicit_closed_and_enable_cannot_overwrite_unreadable_prior() {
    let disk = Arc::new(Mutex::new(Disk { enabled:true, load_failed:true, ..Disk::default() }));
    let (host, _owner, inbox) = install(disk.clone());
    let value = run(host, r#"
        const before=await call('status');let rejected='';
        try{await call('setEnabled',{enabled:true})}catch(e){rejected=String(e)}
        const after=await call('status');
        const off=await call('setEnabled',{enabled:false});
        host.post('fixture.done',{before,after,rejected,off});
    "#);
    for key in ["before", "after"] {
        assert_eq!(value[key]["enabled"], false);
        assert_eq!(value[key]["preferenceState"], "load-failed");
        assert!(value[key]["recordingLease"].is_null());
    }
    assert!(value["rejected"].as_str().unwrap().contains("diagnostics_preference_load_failed"));
    assert_eq!(value["off"]["preferenceState"], "ready");
    assert_eq!(disk.lock().unwrap().saves, vec![false]);
    assert_eq!(disk.lock().unwrap().loads, 1);
    assert!(!disk.lock().unwrap().enabled);
    assert!(!value.to_string().contains("synthetic-private"));
    assert!(inbox.try_recv().is_none());
}

#[test]
fn enable_save_failure_cannot_issue_lease_or_events_and_only_explicit_success_recovers() {
    let disk = Arc::new(Mutex::new(Disk { save_failed:true, ..Disk::default() }));
    let (host, owner, inbox) = install(disk.clone());
    let value = run(host, r#"
        let rejected='';try{await call('setEnabled',{enabled:true})}catch(e){rejected=String(e)}
        host.post('fixture.done',{rejected,status:await call('status')});
    "#);
    assert!(value["rejected"].as_str().unwrap().contains("diagnostics_preference_save_failed"));
    assert_eq!(value["status"]["preferenceState"], "save-failed");
    assert_eq!(value["status"]["enabled"], false);
    assert!(value["status"]["recordingLease"].is_null());
    assert_eq!(value["status"]["eventCount"], 0);
    assert!(!disk.lock().unwrap().enabled);
    disk.lock().unwrap().save_failed = false;
    let result = owner.book.lock().unwrap().set_enabled(true).unwrap();
    assert_eq!(result["preferenceState"], "ready");
    assert_eq!(result["enabled"], true);
    assert!(result["recordingLease"].is_string());
    assert_eq!(disk.lock().unwrap().saves, vec![true,true]);
    assert!(inbox.try_recv().is_none());
}

#[test]
fn disable_save_failure_first_clears_ring_cancels_export_and_status_never_reloads_old_true() {
    let disk = Arc::new(Mutex::new(Disk { enabled:true, save_failed:true, ..Disk::default() }));
    let (host, owner, inbox) = install(disk.clone());
    let native_disk = disk.clone(); let native_book = owner.book.clone();
    host.handle("fixture.arm", move |call| {
        let book = native_book.lock().unwrap();
        native_disk.lock().unwrap().cancelled_before_save = book.cancelled.clone();
        call.resolve(json!(true));
    });
    let value = run(host, r#"
        const on=await call('status');const input={hostID:'fixture-host',lease:on.recordingLease,dropped:0,events:[{at:1,feat:'transcript',kind:'sse-event',sessionID:'session-1',source:'sse',sseType:'session.status',surfaceKind:'global'}]};
        await call('append',input);
        const exporting=call('export',{hostID:'fixture-host',snapshot:{schemaVersion:1,host:{version:null,status:'unknown'},opencode:{version:null,status:'unknown',management:null,canManage:null},hostUpdate:{status:'unknown',supported:null,operation:null,checkFailed:null}}});
        await host.call('fixture.arm');
        let rejected='';try{await call('setEnabled',{enabled:false})}catch(e){rejected=String(e)}
        let appendDenied=false;try{await call('append',input)}catch{appendDenied=true}
        const result=await exporting;const after=await call('status');const again=await call('status');
        const exportDenied=await call('export',{hostID:'fixture-host',snapshot:{}});
        host.post('fixture.done',{rejected,appendDenied,result,after,again,exportDenied});
    "#);
    assert!(value["rejected"].as_str().unwrap().contains("diagnostics_preference_save_failed"));
    assert_eq!(value["appendDenied"], true);
    assert_eq!(value["result"]["outcome"], "cancelled");
    for key in ["after", "again"] {
        assert_eq!(value[key]["preferenceState"], "save-failed");
        assert_eq!(value[key]["enabled"], false);
        assert_eq!(value[key]["eventCount"], 0);
        assert!(value[key]["recordingLease"].is_null());
    }
    assert_eq!(value["exportDenied"]["error"], "diagnostics_disabled");
    assert_eq!(disk.lock().unwrap().loads, 1);
    assert_eq!(disk.lock().unwrap().saves, vec![false]);
    assert!(disk.lock().unwrap().enabled, "failed store retains synthetic prior, never resumes this owner");
    assert!(!value.to_string().contains("synthetic-private"));
    drop(inbox.try_recv().expect("cancelled job retained until UI drains/drop"));
    assert!(owner.book.lock().unwrap().export.is_none());
    disk.lock().unwrap().save_failed = false;
    let status = owner.book.lock().unwrap().set_enabled(false).unwrap();
    assert_eq!(status["preferenceState"], "ready");
    assert!(!disk.lock().unwrap().enabled);
}
