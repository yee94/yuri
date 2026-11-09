//! Production install/publication lifecycle only. No chooser, user files, Vault or network.
use super::*;

#[test]
fn production_diagnostics_persist_only_opt_in_and_cold_start_never_restores_event_rows_or_authority()
 {
    #[derive(Clone, Default)]
    struct PreferenceStore(Arc<Mutex<Option<Value>>>);
    impl crate::notifications::store::Store for PreferenceStore {
        fn load(&mut self) -> Result<Option<Value>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn commit(&mut self, next: &Value) -> Result<()> {
            *self.0.lock().unwrap() = Some(next.clone());
            Ok(())
        }
    }
    let metadata = PreferenceStore::default();
    let mut old_lease = None;
    for phase in 0..2 {
        let vault = MemoryVault::default();
        state().persist(&vault).unwrap();
        let host = HostChannel::default();
        let caps = json!({"host":["connection.list","native.diagnostics.status","native.diagnostics.setEnabled","native.diagnostics.append"]});
        let owner = install_with(
            &host,
            &caps,
            Box::new(vault),
            Arc::new(FakeNetwork::default()),
            false,
        )
        .unwrap();
        let (port, _jobs) = crate::diagnostics::channel();
        owner
            .services()
            .install_diagnostics_with_preference(
                &host,
                port,
                json!("0.4.0"),
                json!("42"),
                Some(Box::new(crate::native_preferences::Consent::with_store(
                    Box::new(metadata.clone()),
                ))),
            )
            .unwrap();
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            let _ = tx.send(call.take_data());
        });
        let source = format!(
            r#"import {{host}} from 'nsh';(async()=>{{
          const check=(v,m)=>{{if(!v)throw Error(m);}};const call=(n,v={{}})=>host.call('native.diagnostics.'+n,v);const cold=await call('status');
          check(cold.enabled==={enabled}&&cold.eventCount===0&&cold.recordingLease===null&&cold.preferenceState==='ready','only persisted consent before native authority');
          const saved=await host.call('connection.list',{{}});const on=await call('setEnabled',{{enabled:true}});check(!!on.recordingLease,'current native lease');
          await call('append',{{hostID:saved.selected,lease:on.recordingLease,events:[{{at:1,feat:'transcript',kind:'sse-event',sessionID:'session-1',source:'sse',sseType:'session.status',surfaceKind:'global'}}],dropped:0}});
          host.post('test.result',{{lease:on.recordingLease,count:(await call('status')).eventCount}});
        }})().catch(error=>host.post('test.result',{{error:String(error)}}));"#,
            enabled = phase == 1
        );
        let engine = engine(host, source);
        let result = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(result.get("error").is_none(), "{result}");
        assert_eq!(result["count"], 1);
        if let Some(lease) = old_lease {
            assert_ne!(result["lease"], lease);
        }
        old_lease = Some(result["lease"].clone());
        drop(engine);
        drop(owner);
        assert_eq!(
            *metadata.0.lock().unwrap(),
            Some(json!({"v":1,"diagnosticsEnabled":true}))
        );
    }
}

#[test]
fn production_diagnostics_share_committed_actor_window_keep_metadata_and_cancel_before_retirement()
{
    struct Observed {
        store: MemoryVault,
        reads: Arc<AtomicUsize>,
    }
    impl Vault for Observed {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.reads.fetch_add(1, Ordering::AcqRel);
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            self.store.write(bytes)
        }
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let network = Arc::new(FakeNetwork::default());
    let host = HostChannel::default();
    let caps = json!({"host":["connection.list","connection.editor","connection.rename","connection.select","native.diagnostics.status","native.diagnostics.setEnabled","native.diagnostics.append","native.diagnostics.export"]});
    let owner = install_with(
        &host,
        &caps,
        Box::new(Observed {
            store: store.clone(),
            reads: reads.clone(),
        }),
        network.clone(),
        false,
    )
    .unwrap();
    let services = owner.services();
    let window = services.window_id().unwrap();
    assert_eq!(services.window_id().unwrap(), window);
    assert!(services.reader().capture_diagnostics().is_none());
    let (port, inbox) = crate::diagnostics::channel();
    services
        .install_diagnostics(&host, port.clone(), json!("0.4.0"), json!("42"))
        .unwrap();
    assert_eq!(
        services
            .install_diagnostics(&host, port, json!("0.4.0"), json!("42"))
            .unwrap_err(),
        "diagnostics_install_not_available"
    );
    let reader = services.reader();
    let expected_window = window.clone();
    host.handle("test.scope", move |mut call| {
        let value = call.take_data();
        let expected = crate::diagnostics::Scope::committed(
            &value,
            "synthetic-authorization",
            &expected_window,
        )
        .unwrap();
        call.resolve(json!(
            reader
                .capture_diagnostics()
                .is_some_and(|scope| scope == expected)
        ));
    });
    let reading = reads.clone();
    host.handle("test.reads", move |call| {
        call.resolve(json!(reading.load(Ordering::Acquire)))
    });
    let failing = store.fail.clone();
    host.handle("test.failVault", move |mut call| {
        failing.store(
            call.take_data()["fail"].as_bool().unwrap(),
            Ordering::Release,
        );
        call.resolve(json!(true));
    });
    let suspended = services.clone();
    host.handle("test.suspend", move |mut call| {
        suspended.set_runtime_suspended(call.take_data()["suspended"].as_bool().unwrap());
        call.resolve(json!(true));
    });
    let queued = Arc::new(Mutex::new(None));
    let slot = queued.clone();
    let inbox = Mutex::new(inbox);
    host.handle("test.takeExport", move |call| {
        let mut slot = slot.lock().unwrap();
        assert!(slot.is_none());
        *slot = inbox.lock().unwrap().try_recv();
        assert!(slot.is_some());
        call.resolve(json!(true));
    });
    let dropped = queued.clone();
    host.handle("test.dropExport", move |call| {
        drop(dropped.lock().unwrap().take());
        call.resolve(json!(true));
    });
    let shutdown = services.clone();
    host.handle("test.shutdown", move |call| {
        shutdown.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const call=(name,value)=>host.call('native.diagnostics.'+name,value);const status=()=>call('status',{});
      const before=await status();check(!before.enabled&&before.recordingLease===null&&before.schemaVersion===2,'default closed');check(await host.call('test.reads',{})===0,'status must not restore Vault');
      const saved=await host.call('connection.list',{});const expectedHost=saved.runtimeScope;check(await host.call('test.scope',expectedHost),'exact committed native scope/window/auth');
      const on=await call('setEnabled',{enabled:true});const input={hostID:saved.selected,lease:on.recordingLease,events:[{at:1,feat:'transcript',kind:'sse-event',sessionID:'session-1',source:'sse',sseType:'session.status',surfaceKind:'global'}],dropped:0};await call('append',input);
      const editor=await host.call('connection.editor',{id:saved.selected});await host.call('connection.rename',{id:saved.selected,version:editor.version,label:'Metadata only'});const renamed=await status();check(renamed.eventCount===1&&renamed.recordingLease===on.recordingLease,'metadata must not retire recording');
      await host.call('test.failVault',{fail:true});const current=await host.call('connection.editor',{id:saved.selected});let failed=false;try{await host.call('connection.rename',{id:saved.selected,version:current.version,label:'Must not commit'});}catch{failed=true;}await host.call('test.failVault',{fail:false});check(failed&&(await status()).recordingLease===on.recordingLease,'failed write preserves prior');
      const exporting=call('export',{hostID:saved.selected,snapshot:{schemaVersion:1,host:{version:'1.2.3',status:'ready'},opencode:{version:'2.0.0',status:'ready',management:'bundled',canManage:false},hostUpdate:{status:'unknown',supported:null,operation:null,checkFailed:null}}});await host.call('test.takeExport',{});
      await host.call('test.suspend',{suspended:true});check((await exporting).outcome==='cancelled','retire settles pending before returning');const paused=await status();check(paused.enabled&&paused.recordingLease===null&&paused.eventCount===0,'suspension clears without opting out');
      let stale=false;try{await call('append',input);}catch{stale=true;}check(stale,'old recording lease');await host.call('test.suspend',{suspended:false});const resumed=await status();check(resumed.enabled&&resumed.recordingLease&&resumed.recordingLease!==on.recordingLease,'resume fresh recording lease');
      await host.call('test.dropExport',{});await call('append',{...input,lease:resumed.recordingLease});await host.call('connection.select',{id:saved.selected});const selected=await status();check(selected.eventCount===0&&selected.recordingLease!==resumed.recordingLease,'actor lease replacement');
      await host.call('test.shutdown',{});let stopped=false;try{await status();}catch{stopped=true;}check(stopped,'Owner dropped at shutdown');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(reads.load(Ordering::Acquire), 1);
    assert!(network.requests.lock().unwrap().is_empty());
    assert!(services.reader().capture_diagnostics().is_none());
    assert!(services.window_id().is_err());
    assert!(!crate::diagnostics::is_presenting());
    drop(engine);
    drop(owner);
}

#[test]
fn uncertain_or_conflicting_actor_commit_retires_installed_recording_before_quarantine() {
    struct Fault {
        store: MemoryVault,
        fail: Arc<AtomicBool>,
        error: &'static str,
    }
    impl Vault for Fault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.store.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            if self.fail.load(Ordering::Acquire) {
                Err(self.error.into())
            } else {
                self.store.write(bytes)
            }
        }
    }
    for error in [vault::COMMIT_UNKNOWN, vault::CONFLICT] {
        let store = MemoryVault::default();
        state().persist(&store).unwrap();
        let failing = Arc::new(AtomicBool::new(false));
        let host = HostChannel::default();
        let caps = json!({"host":["connection.list","connection.editor","connection.rename","native.diagnostics.status","native.diagnostics.setEnabled","native.diagnostics.append"]});
        let owner = install_with(
            &host,
            &caps,
            Box::new(Fault {
                store,
                fail: failing.clone(),
                error,
            }),
            Arc::new(FakeNetwork::default()),
            false,
        )
        .unwrap();
        let (port, _inbox) = crate::diagnostics::channel();
        owner
            .services()
            .install_diagnostics(&host, port, json!("0.4.0"), json!("42"))
            .unwrap();
        host.handle("test.fail", move |call| {
            failing.store(true, Ordering::Release);
            call.resolve(json!(true));
        });
        let (tx, rx) = mpsc::channel();
        host.handle("test.result", move |mut call| {
            let _ = tx.send(call.take_data());
        });
        let source = format!(
            r#"import {{host}} from 'nsh';(async()=>{{
          const check=(v,m)=>{{if(!v)throw Error(m);}};const saved=await host.call('connection.list',{{}});const call=(n,v)=>host.call('native.diagnostics.'+n,v);
          const on=await call('setEnabled',{{enabled:true}});const input={{hostID:saved.selected,lease:on.recordingLease,events:[{{at:1,feat:'transcript',kind:'sse-event',sessionID:'session-1',source:'sse',sseType:'session.status',surfaceKind:'global'}}],dropped:0}};await call('append',input);
          const editor=await host.call('connection.editor',{{id:saved.selected}});await host.call('test.fail',{{}});let rejected=false;
          try{{await host.call('connection.rename',{{id:saved.selected,version:editor.version,label:'Uncertain'}});}}catch(error){{rejected=String(error).includes('{error}');}}check(rejected,'must preserve quarantine error');
          const status=await call('status',{{}});check(status.enabled&&status.recordingLease===null&&status.eventCount===0,'quarantine clears recording authority');let stale=false;try{{await call('append',input);}}catch{{stale=true;}}check(stale,'old lease cannot append');host.post('test.result',{{ok:true}});
        }})().catch(error=>host.post('test.result',{{error:String(error)}}));"#
        );
        let engine = engine(host, source);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            json!({"ok":true})
        );
        assert!(owner.services().reader().capture_diagnostics().is_none());
        drop(engine);
        drop(owner);
    }
}
