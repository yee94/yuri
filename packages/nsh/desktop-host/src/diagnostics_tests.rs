use super::*;
use super::export::Driver;
use std::time::Duration;

fn scope() -> Scope {
    Scope::committed(&json!({"hostID":"fixture-host","lease":"00000000-0000-4000-8000-000000000001"}), "fixture-authorization", "fixture-window").unwrap()
}
fn row(at: usize) -> Value {
    json!({"at":at,"feat":"transcript","kind":"sse-event","sessionID":"session-1","source":"sse","sseType":"session.status","surfaceKind":"global"})
}
fn batch(events: Value) -> Value {
    json!({"hostID":"fixture-host","lease":"fixture-recording-lease","events":events,"dropped":0})
}
fn snapshot() -> Value {
    json!({"schemaVersion":1,"host":{"version":"1.2.3","status":"ready"},
        "opencode":{"version":"v2.0.0-beta.1+test","status":"ready","management":"bundled","canManage":false},
        "hostUpdate":{"status":"unknown","supported":null,"operation":null,"checkFailed":null}})
}
fn recording() -> Book {
    Book { enabled: true, scope: Some(scope()), lease: Some("fixture-recording-lease".into()), ..Book::default() }
}
#[test]
fn schema2_exact_whitelist_rejects_raw_ids_content_urls_credentials_and_unknown_events() {
    for kind in schema::TYPES {
        let mut event = row(0); event["sseType"] = json!(kind);
        assert!(schema::events(&batch(json!([event]))).is_ok(), "{kind}");
    }
    for field in ["body", "text", "parts", "raw", "directory", "url", "token", "password", "cookie", "authorization", "path"] {
        let mut event = row(0); event[field] = json!("synthetic-private");
        assert!(schema::events(&batch(json!([event]))).is_err(), "{field}");
        let mut input = batch(json!([row(0)])); input[field] = json!("synthetic-private");
        assert!(schema::events(&input).is_err(), "root {field}");
    }
    for (field, values) in [
        ("sessionID", vec![json!("ses_raw"), json!("session-01"), json!("session-1000"), json!("session--1"), json!("session-1/secret"), Value::Null]),
        ("at", vec![json!(-1), json!(true), Value::Null, json!(9_007_199_254_740_992u64)]),
        ("sseType", vec![json!("message.part.delta"), json!("unknown"), json!("https://example.invalid"), Value::Null]),
        ("surfaceKind", vec![json!("other"), json!("GLOBAL"), Value::Null]),
        ("source", vec![json!("raw")]), ("kind", vec![json!("text")]), ("feat", vec![json!("file")]),
    ] {
        for value in values { let mut event = row(0); event[field] = value; assert!(schema::events(&batch(json!([event]))).is_err(), "{field}"); }
    }
    for valid in ["session-0", "session-500", "session-999"] {
        // Swift schema accepts up to 999; TS only generates 0..500. Preserve wire parity.
        let mut event = row(0); event["sessionID"] = json!(valid); assert!(schema::events(&batch(json!([event]))).is_ok());
    }
    let mut fractional = row(0); fractional["at"] = json!(0.5);
    assert!(schema::events(&batch(json!([fractional]))).is_ok());
    for dropped in [json!(-1), json!(1_000_001), json!(0.5), json!(true), Value::Null] {
        let mut input = batch(json!([row(0)])); input["dropped"] = dropped;
        assert!(schema::events(&input).is_err());
    }
}
#[test]
fn batch_is_atomic_bounded_and_ingress_accounting_cannot_mutate_prior_on_failure() {
    let mut book = recording(); book.append(&batch(json!([row(0)]))).unwrap();
    for events in [json!([]), json!(vec![row(1);33]), json!([row(1),{"body":"synthetic-private"}])] {
        let mut input = batch(events); input["dropped"] = json!(99);
        assert!(book.append(&input).is_err()); assert_eq!(book.ring.len(),1); assert_eq!(book.dropped,0);
    }
    let mut input = batch(json!(vec![row(2);32])); input["dropped"] = json!(1_000_000);
    book.append(&input).unwrap(); assert_eq!(book.ring.len(),33); assert_eq!(book.dropped,1_000_000);
    for field in ["lease", "hostID"] { let mut input = batch(json!([row(3)])); input[field] = json!("wrong"); assert!(book.append(&input).is_err()); }
    book.enabled = false; assert!(book.append(&batch(json!([row(4)]))).is_err());
}
#[test]
fn native_memory_ring_is_fifo_bounded_report_is_anonymous_and_disable_clears_every_byte() {
    let mut book = recording();
    for i in 0..1_100 { book.append(&batch(json!([row(i)]))).unwrap(); }
    assert_eq!(book.ring.len(),500); assert_eq!(book.dropped,600);
    assert!(book.bytes <= schema::MAX_BYTES);
    assert_eq!(serde_json::from_str::<Value>(book.ring.front().unwrap()).unwrap()["at"],600);
    let client = schema::client(&json!("0.4.0"), &json!("42"));
    let report = book.report(&snapshot(), &client).unwrap(); assert!(report.len() <= schema::MAX_EXPORT_BYTES);
    let text = String::from_utf8(report).unwrap();
    for private in ["fixture-host", "fixture-recording-lease", "fixture-authorization", "fixture-window", "00000000-"] { assert!(!text.contains(private)); }
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["eventCount"],500); assert_eq!(report["dropped"],600);
    assert_eq!(report["events"][499]["at"],1099);
    assert_eq!(report["context"]["client"]["version"],"0.4.0");
    book.clear(); assert!(book.ring.is_empty()); assert_eq!(book.bytes,0); assert_eq!(book.dropped,0); assert!(book.lease.is_none());
}
#[test]
fn context_never_serializes_arbitrary_snapshot_fields_or_invalid_versions() {
    let client = schema::client(&json!("/private/fake"), &json!("fake-token"));
    assert!(client["version"].is_null()); assert!(client["build"].is_null());
    for input in [json!({"schemaVersion":1,"token":"synthetic"}), json!(true), Value::Null] { assert!(schema::context(&input,&client).is_err()); }
    let mut input = snapshot(); input["host"]["body"] = json!("synthetic-private"); assert!(schema::context(&input,&client).is_err());
    let mut input = snapshot(); input["host"]["version"] = json!("https://example.invalid"); input["hostUpdate"]["operation"] = json!("synthetic-private");
    let context = schema::context(&input,&client).unwrap();
    assert!(context["host"]["version"].is_null()); assert!(context["hostUpdate"]["operation"].is_null());
    assert!(!context.to_string().contains("synthetic-private"));
    input["host"]["version"] = json!("界".repeat(33)); assert!(schema::context(&input,&client).is_err());
    for valid in ["1.2.3", "v1.2.3-a.b+build.1", " 1.2.3 "] { assert!(!schema::version(&json!(valid)).is_null()); }
    for invalid in ["1.2", "1.2.3/secret", "1.2.3+", "1.2.3-a+foo+bar", "1.2.3\nsecret"] { assert!(schema::version(&json!(invalid)).is_null()); }
}

#[derive(Default)]
struct MemoryDriver {
    mode: &'static str,
    prior: Vec<u8>, staged: Vec<u8>, selects: usize, stages: usize, commits: usize, verifies: usize,
    hook: Option<Box<dyn FnOnce()>>,
    staged_hook: Option<Box<dyn FnOnce()>>,
}
impl Driver for MemoryDriver {
    fn choose(&mut self) -> Result<bool> {
        self.selects += 1;
        if let Some(hook) = self.hook.take() { hook(); }
        if self.mode == "cancelled" { Ok(false) } else if self.mode == "panel-error" { Err("never-send-private-error".into()) } else { Ok(true) }
    }
    fn stage(&mut self, bytes: &[u8], current: &dyn Fn()->bool) -> Result<()> {
        self.stages += 1;
        assert!(current());
        if self.mode == "stage-error" { return Err("never-send-private-error".into()); }
        self.staged = bytes.to_vec();
        if let Some(hook) = self.staged_hook.take() { hook(); }
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        self.commits += 1;
        match self.mode {
            "unknown" | "verify-error" => Err("documents_write_unknown".into()),
            "write-error" => Err("never-send-private-error".into()),
            "committed-unknown" => { self.prior = self.staged.clone(); Err("documents_write_unknown".into()) },
            _ => { self.prior = self.staged.clone(); Ok(()) },
        }
    }
    fn verify(&mut self, bytes: &[u8]) -> Result<bool> {
        self.verifies += 1;
        if self.mode == "verify-error" { Err("never-send-private-error".into()) } else { Ok(self.prior == bytes) }
    }
}
struct Sink;
impl nsh_engine::MountSink for Sink { fn submit(&self, _: nsh_core::MountBatch) {} }
fn engine(host: HostChannel, script: String) -> nsh_engine::Engine {
    let mut bundle = nsh_engine::Bundle::source(script);
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = nsh_engine::EngineConfig::new(bundle); config.host = host;
    nsh_engine::Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap()
}
#[test]
fn real_quickjs_hostchannel_schema2_default_closed_recording_lease_atomic_append_and_stop() {
    let host = HostChannel::default(); let (port,inbox) = channel();
    let _owner = install(&host,Arc::new(||Some(scope())),port,json!("0.4.0"),json!("1"));
    let (tx,rx) = mpsc::channel(); host.handle("fixture.done",move |mut c| { tx.send(c.take_data()).unwrap(); });
    let script = format!(r#"import {{host}} from 'nsh'; (async()=>{{
        const call=(n,b)=>host.call('native.diagnostics.'+n,b);
        const before=await call('status');
        let disabled=false; try{{await call('append',{batch})}}catch{{disabled=true}}
        const on=await call('setEnabled',{{enabled:true}});
        const same=await call('setEnabled',{{enabled:true}});
        const input={{...{batch},lease:on.recordingLease}};
        const accepted=await call('append',input);
        let extra=false,raw=false,lease=false,hostFence=false,bool=false;
        try{{await call('append',{{...input,events:[input.events[0],{{...input.events[0],body:'private'}}]}})}}catch{{extra=true}}
        try{{await call('append',{{...input,events:[{{...input.events[0],sessionID:'ses_private'}}]}})}}catch{{raw=true}}
        try{{await call('append',{{...input,lease:'wrong'}})}}catch{{lease=true}}
        try{{await call('append',{{...input,hostID:'other'}})}}catch{{hostFence=true}}
        try{{await call('setEnabled',{{enabled:1}})}}catch{{bool=true}}
        const recorded=await call('status'); const off=await call('setEnabled',{{enabled:false}});
        const restart=await call('setEnabled',{{enabled:true}});
        host.post('fixture.done',{{before,disabled,accepted,extra,raw,lease,hostFence,bool,recorded,off,
            stableLease:on.recordingLease===same.recordingLease,freshLease:on.recordingLease!==restart.recordingLease}});
    }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#, batch=batch(json!([row(1)])));
    let engine = engine(host,script); let value=rx.recv_timeout(Duration::from_secs(10)).unwrap(); drop(engine);
    assert!(value.get("error").is_none(),"{value}");
    assert_eq!(value["before"]["schemaVersion"],2); assert_eq!(value["before"]["enabled"],false); assert!(value["before"]["recordingLease"].is_null());
    for key in ["disabled","extra","raw","lease","hostFence","bool","stableLease","freshLease"] { assert_eq!(value[key],true,"{key}"); }
    assert_eq!(value["recorded"]["eventCount"],1); assert_eq!(value["off"]["eventCount"],0);
    assert!(value["off"]["recordingLease"].is_null()); assert!(inbox.try_recv().is_none());
}
#[test]
fn real_bridge_export_driver_explicit_confirmation_failure_unknown_no_retry_no_user_files() {
    for mode in ["saved","cancelled","panel-error","stage-error","write-error","unknown","verify-error","committed-unknown","retired","retired-in-panel","retired-after-stage","wrong-window","dropped-job","shutdown"] {
        let host=HostChannel::default(); let (port,inbox)=channel();
        let current=Arc::new(Mutex::new(Some(scope()))); let capture=current.clone();
        let owner=Arc::new(install(&host,Arc::new(move||capture.lock().unwrap().clone()),port,json!("0.4.0"),json!("1")));
        let (tx,rx)=mpsc::channel(); host.handle("fixture.done",move|mut c|{tx.send(c.take_data()).unwrap();});
        let (tx,drive)=mpsc::channel(); host.handle("fixture.drive",move|_|{tx.send(()).unwrap();});
        let script=format!(r#"import {{host}} from 'nsh'; (async()=>{{
            const call=(n,b)=>host.call('native.diagnostics.'+n,b);
            const on=await call('setEnabled',{{enabled:true}}); await call('append',{{...{batch},lease:on.recordingLease}});
            const input={{hostID:'fixture-host',snapshot:{snapshot}}};
            const exporting=call('export',input);
            let busy=false;try{{await call('setEnabled',{{enabled:true}})}}catch{{busy=true}}
            const duplicate=await call('export',input);
            host.post('fixture.drive',{{}});const result=await exporting;
            const status=await call('status').catch(()=>({{retired:true}}));
            const retry=('{mode}'==='unknown'||'{mode}'==='verify-error')?await call('export',input):null;
            host.post('fixture.done',{{busy,duplicate,result,status,retry}});
        }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#,batch=batch(json!([row(3)])),snapshot=snapshot());
        let engine=engine(host,script);drive.recv_timeout(Duration::from_secs(10)).unwrap();
        let job=inbox.try_recv().expect("one bounded export job");
        let mut driver=MemoryDriver{mode,prior:b"prior synthetic bytes".to_vec(),..MemoryDriver::default()};
        match mode {
            "retired"=>{owner.invalidate();*current.lock().unwrap()=None;job.drive(&mut driver);}
            "shutdown"=>{drop(owner);*current.lock().unwrap()=None;job.drive(&mut driver);}
            "retired-in-panel"=>{let owner=owner.clone();let current=current.clone();driver.hook=Some(Box::new(move||{owner.invalidate();*current.lock().unwrap()=None;}));job.drive(&mut driver);}
            "retired-after-stage"=>{let owner=owner.clone();let current=current.clone();driver.staged_hook=Some(Box::new(move||{owner.invalidate();*current.lock().unwrap()=None;}));job.drive(&mut driver);}
            "wrong-window"=>unsafe{job.show(std::ptr::null_mut(),"different-window");},
            "dropped-job"=>drop(job),
            _=>job.drive(&mut driver),
        }
        let value=rx.recv_timeout(Duration::from_secs(10)).unwrap();drop(engine);
        assert!(value.get("error").is_none(),"{mode}: {value}");assert_eq!(value["busy"],true);
        assert_eq!(value["duplicate"]["error"],"diagnostics_export_busy");
        let expected=match mode {"saved"|"committed-unknown"=>"shared","cancelled"|"retired"|"retired-in-panel"|"retired-after-stage"|"wrong-window"|"shutdown"=>"cancelled",_=>"failed"};
        assert_eq!(value["result"]["outcome"],expected,"{mode}: {value}");
        if matches!(mode,"unknown"|"verify-error") {
            assert_eq!(value["retry"]["error"],"diagnostics_write_unknown");assert_eq!(driver.commits,1);assert_eq!(driver.verifies,1);
        }
        if matches!(mode,"saved"|"committed-unknown") {
            let report:Value=serde_json::from_slice(&driver.prior).unwrap();assert_eq!(report["eventCount"],1);
            assert_eq!(report["events"][0]["at"],3);assert_eq!(report["schema"],"yuri.client-diagnostics.v1");
        } else {assert_eq!(driver.prior,b"prior synthetic bytes");}
        if matches!(mode,"retired"|"wrong-window"|"dropped-job"|"shutdown") {assert_eq!(driver.selects,0);}
        if matches!(mode,"retired"|"retired-in-panel"|"retired-after-stage") {assert_eq!(value["status"]["eventCount"],0);assert!(value["status"]["recordingLease"].is_null());}
        if mode=="retired-after-stage" {assert_eq!(driver.commits,0);}
        if mode=="shutdown" {assert_eq!(value["status"]["retired"],true);}
        assert!(!value.to_string().contains("private-error"));assert!(value["result"].get("path").is_none());
        assert!(inbox.try_recv().is_none());
    }
}
#[test]
fn exact_native_host_runtime_authorization_window_changes_rotate_even_when_hostid_is_same() {
    for field in ["host","runtime","authorization","window"] {
        let host=HostChannel::default(); let (port,inbox)=channel();
        let current=Arc::new(Mutex::new(Some(scope()))); let capture=current.clone();
        let owner=install(&host,Arc::new(move||capture.lock().unwrap().clone()),port,Value::Null,Value::Null);
        let (tx,rx)=mpsc::channel();host.handle("fixture.rotate",move|c|{
            owner.invalidate();let mut next=scope();match field {"host"=>next.host_id="new-host".into(),"runtime"=>next.runtime_lease="new-runtime".into(),"authorization"=>next.authorization_id="new-authorization".into(),_=>next.window_id="new-window".into()};
            *current.lock().unwrap()=Some(next);c.into_reply().unwrap().resolve(json!(true));
        });
        host.handle("fixture.done",move|mut c|{tx.send(c.take_data()).unwrap();});
        let script=format!(r#"import {{host}} from 'nsh';(async()=>{{
            const a=await host.call('native.diagnostics.setEnabled',{{enabled:true}});
            await host.call('native.diagnostics.append',{{...{batch},lease:a.recordingLease}});
            await host.call('fixture.rotate');const b=await host.call('native.diagnostics.status');
            let stale=false;try{{await host.call('native.diagnostics.append',{{...{batch},lease:a.recordingLease}})}}catch{{stale=true}}
            host.post('fixture.done',{{fresh:a.recordingLease!==b.recordingLease,b,stale}});
        }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#,batch=batch(json!([row(1)])));
        let engine=engine(host,script);let value=rx.recv_timeout(Duration::from_secs(10)).unwrap();drop(engine);
        assert_eq!(value["fresh"],true,"{field}");assert_eq!(value["stale"],true);assert_eq!(value["b"]["eventCount"],0);
        assert!(inbox.try_recv().is_none());
    }
}

#[test]
fn capture_racing_retirement_cannot_rebind_an_old_native_scope_or_keep_anonymous_rows() {
    use std::sync::atomic::AtomicUsize;
    let host = HostChannel::default(); let (port,inbox) = channel();
    let current = Arc::new(Mutex::new(Some(scope()))); let native = current.clone();
    let calls = AtomicUsize::new(0);
    let (started, began) = mpsc::channel(); let (release, released) = mpsc::channel();
    let released = Mutex::new(released);
    let owner = install(&host, Arc::new(move || {
        let snapshot = native.lock().unwrap().clone();
        if calls.fetch_add(1, Ordering::Relaxed) == 2 {
            started.send(()).unwrap(); released.lock().unwrap().recv_timeout(Duration::from_secs(10)).unwrap();
        }
        snapshot
    }), port, Value::Null, Value::Null);
    let (tx,rx) = mpsc::channel(); host.handle("fixture.done", move|mut c|{tx.send(c.take_data()).unwrap();});
    let script = format!(r#"import {{host}} from 'nsh'; (async()=>{{
        const call=(n,b)=>host.call('native.diagnostics.'+n,b);
        const first=await call('setEnabled',{{enabled:true}});
        await call('append',{{...{batch},lease:first.recordingLease}});
        let retired=false;try{{await call('status')}}catch{{retired=true}}
        const next=await call('status');
        let stale=false;try{{await call('append',{{...{batch},lease:first.recordingLease}})}}catch{{stale=true}}
        host.post('fixture.done',{{retired,stale,fresh:first.recordingLease!==next.recordingLease,next}});
    }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#,batch=batch(json!([row(1)])));
    let engine=engine(host,script); began.recv_timeout(Duration::from_secs(10)).unwrap();
    owner.invalidate(); let mut next=scope(); next.authorization_id="new-authorization".into(); *current.lock().unwrap()=Some(next);
    release.send(()).unwrap(); let value=rx.recv_timeout(Duration::from_secs(10)).unwrap();drop(engine);
    assert_eq!(value["retired"],true);assert_eq!(value["stale"],true);assert_eq!(value["fresh"],true);
    assert_eq!(value["next"]["eventCount"],0);assert!(inbox.try_recv().is_none());
}

#[test]
fn export_admission_and_unavailable_ui_never_write_or_requeue_and_unknown_survives_retirement() {
    let host=HostChannel::default(); let (port,inbox)=channel(); drop(inbox);
    let _owner=install(&host,Arc::new(||Some(scope())),port,Value::Null,Value::Null);
    let (tx,rx)=mpsc::channel();host.handle("fixture.done",move|mut c|{tx.send(c.take_data()).unwrap();});
    let script=format!(r#"import {{host}} from 'nsh';(async()=>{{
        const call=(n,b)=>host.call('native.diagnostics.'+n,b);const input={{hostID:'fixture-host',snapshot:{snapshot}}};
        const disabled=await call('export',input);await call('setEnabled',{{enabled:true}});
        const wrongHost=await call('export',{{...input,hostID:'other'}});
        const extra=await call('export',{{...input,path:'/synthetic/private'}});
        const unsafeSnapshot=await call('export',{{...input,snapshot:{{...input.snapshot,token:'synthetic-private'}}}});
        const unavailable=await call('export',input); const status=await call('status');
        host.post('fixture.done',{{disabled,wrongHost,extra,unsafeSnapshot,unavailable,status}});
    }})().catch(e=>host.post('fixture.done',{{error:String(e)}}));"#,snapshot=snapshot());
    let engine=engine(host,script);let value=rx.recv_timeout(Duration::from_secs(10)).unwrap();drop(engine);
    assert_eq!(value["disabled"]["error"],"diagnostics_disabled");
    assert_eq!(value["wrongHost"]["error"],"diagnostics_scope_retired");
    assert_eq!(value["extra"]["error"],"diagnostics_invalid_schema");
    assert_eq!(value["unsafeSnapshot"]["error"],"diagnostics_invalid_schema");
    assert_eq!(value["unavailable"]["error"],"diagnostics_ui_unavailable");
    assert_eq!(value["status"]["eventCount"],0);
    let mut book=recording(); book.unknown=true;book.clear();assert!(book.unknown);
    book.enabled=false;book.clear();assert!(book.unknown);
}
