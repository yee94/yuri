//! Real committed actor/HostChannel/QuickJS; injected Store/Driver only. No OS notification.
use super::*;
use crate::notifications::{self, Activation, Driver};
#[derive(Clone, Default)]
struct Receipts {
    data: Arc<Mutex<Option<Value>>>,
    fail: Arc<AtomicBool>,
    unknown: Arc<AtomicBool>,
}
impl notifications::store::Store for Receipts {
    fn load(&mut self) -> Result<Option<Value>> {
        Ok(self.data.lock().unwrap().clone())
    }
    fn commit(&mut self, next: &Value) -> Result<()> {
        if self.unknown.load(Ordering::Acquire) {
            return Err("notification_store_unknown".into());
        }
        if self.fail.load(Ordering::Acquire) {
            return Err("notification_unavailable".into());
        }
        *self.data.lock().unwrap() = Some(next.clone());
        Ok(())
    }
}
#[derive(Default)]
struct Counts {
    requests: usize,
    adds: Vec<String>,
    removes: Vec<String>,
    remove_fail: bool,
}
struct Synthetic(Arc<Mutex<Counts>>);
impl Driver for Synthetic {
    fn status(&mut self) -> Result<Value> {
        Ok(
            json!({"authorization":"authorized","alert":true,"sound":true,"badge":false,"backgroundPush":false}),
        )
    }
    fn request(&mut self, current: &dyn Fn() -> bool) -> Result<Value> {
        assert!(current());
        self.0.lock().unwrap().requests += 1;
        self.status()
    }
    fn add(&mut self, receipt: &str, _: &str, _: &str) -> Result<()> {
        self.0.lock().unwrap().adds.push(receipt.into());
        Ok(())
    }
    fn remove(&mut self, receipts: &[String]) -> Result<()> {
        let mut c = self.0.lock().unwrap();
        c.removes.extend_from_slice(receipts);
        if c.remove_fail {
            Err("notification_cleanup_failed".into())
        } else {
            Ok(())
        }
    }
}
fn capabilities() -> Value {
    let mut methods = notifications::METHODS.to_vec();
    methods.extend([
        "connection.list",
        "connection.select",
        "connection.remove",
        "connection.editor",
        "connection.rename",
    ]);
    json!({"host":methods})
}
fn installed(
    host: &HostChannel,
    owner: &Owner,
    receipts: &Receipts,
    counts: &Arc<Mutex<Counts>>,
) -> notifications::UiInbox {
    let c = counts.clone();
    let ingress = Arc::new(Mutex::new(None::<Activation>));
    let saved = ingress.clone();
    let jobs = owner
        .install_notifications(
            host,
            Box::new(receipts.clone()),
            Box::new(move |activation| {
                *saved.lock().unwrap() = Some(activation);
                Ok(Box::new(Synthetic(c)))
            }),
        )
        .unwrap();
    let clicks = counts.clone();
    host.handle("test.click", move |call| {
        let receipt = clicks.lock().unwrap().adds.last().unwrap().clone();
        let result = ingress
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .receive(&receipt)
            .unwrap();
        call.resolve(json!(result));
    });
    let services = owner.services();
    host.handle("test.activity", move |mut call| {
        services.set_foreground(call.take_data()["active"].as_bool().unwrap());
        call.resolve(json!(true));
    });
    jobs
}

#[test]
fn production_notification_publication_metadata_native_activity_claim_and_shutdown_are_exact() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let counts = Arc::new(Mutex::new(Counts::default()));
    let receipts = Receipts::default();
    let owner = install_with(
        &host,
        &capabilities(),
        Box::new(vault),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let _jobs = installed(&host, &owner, &receipts, &counts);
    let shutdown = owner.services();
    host.handle("test.shutdown", move |call| {
        shutdown.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const call=(n,v={})=>host.call('notification.'+n,v);
      check((await call('status')).backgroundPush===false,'real injected status');let blocked=false;try{await call('request');}catch{blocked=true;}check(blocked,'native initial background');
      const saved=await host.call('connection.list',{});await host.call('test.activity',{active:true});await call('request');
      const config={hostID:saved.selected,enabled:true,mode:'hidden-only',events:['completion'],language:'en'};const first=await call('configure',config);
      const admission={v:1,kind:'completion',eventID:'admitted_completion_1_s_1_b',target:{kind:'session',id:'s'},source:{type:'session',sessionID:'s',directory:'/synthetic/worktree',parentID:null,boundaryID:'b'}};
      const event={lease:first.lease,eventID:admission.eventID,kind:'completion',target:admission.target,admission};
      check((await call('live',event)).result==='suppressed','native foreground hidden-only');
      await host.call('test.activity',{active:false});const background=await call('configure',{...config,mode:'always'});
      check((await call('live',{...event,lease:background.lease})).result==='scheduled','actual background admission');check(await host.call('test.click',{}),'native click');
      const peek=await call('launch.peek');await host.call('test.activity',{active:true});const claim=await call('launch.claim',{receipt:peek.record.receipt,connectionID:saved.selected});check(claim.route.hostID===saved.selected,'committed ID');
      const editor=await host.call('connection.editor',{id:saved.selected});await host.call('connection.rename',{id:saved.selected,version:editor.version,label:'Only metadata'});
      check((await call('configure',{...config,mode:'always'})).lease===background.lease,'metadata does not republish generation');
      await host.call('connection.select',{id:saved.selected});let stale=false;try{await call('launch.ack',{receipt:peek.record.receipt,connectionID:saved.selected,lease:claim.route.lease,expectedRevision:peek.record.revision});}catch{stale=true;}check(stale,'lease fence old claim');
      const next=await call('configure',{...config,mode:'always'});check(next.lease!==background.lease,'fresh runtime');check((await call('launch.claim',{receipt:peek.record.receipt,connectionID:saved.selected})).record.authorizationID===peek.record.authorizationID,'lease-only keeps durable authorization');
      await host.call('test.shutdown',{});let stopped=false;try{await call('status');}catch{stopped=true;}check(stopped,'UI shutdown fences without OS join');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    drop(engine);
    drop(owner);
    assert_eq!(counts.lock().unwrap().requests, 1);
    assert_eq!(counts.lock().unwrap().adds.len(), 1);
    let persisted = receipts.data.lock().unwrap();
    let data = persisted.as_ref().unwrap();
    assert_eq!(data["retirements"], json!([]));
    assert_eq!(data["rows"][0]["queued"], true);
}

#[test]
fn production_authorization_retirement_journal_preserves_confirmed_vault_commit_and_retries_only_handoff()
 {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let counts = Arc::new(Mutex::new(Counts::default()));
    let receipts = Receipts::default();
    let owner = install_with(
        &host,
        &capabilities(),
        Box::new(vault.clone()),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let _jobs = installed(&host, &owner, &receipts, &counts);
    let fail_vault = vault.fail.clone();
    host.handle("test.vaultFailure", move |mut call| {
        fail_vault.store(
            call.take_data()["fail"].as_bool().unwrap(),
            Ordering::Release,
        );
        call.resolve(json!(true));
    });
    let fail_receipts = receipts.fail.clone();
    host.handle("test.receiptFailure", move |mut call| {
        fail_receipts.store(
            call.take_data()["fail"].as_bool().unwrap(),
            Ordering::Release,
        );
        call.resolve(json!(true));
    });
    let observed = vault.clone();
    host.handle("test.savedIntent",move|call|{let value:Value=serde_json::from_slice(&observed.read().unwrap().unwrap()).unwrap();call.resolve(json!({"connections":value["connections"].as_array().unwrap().len(),"pending":value["notificationRetirements"].as_array().map_or(0,Vec::len)}));});
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let source = r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});
      await host.call('test.vaultFailure',{fail:true});let failed=false;try{await host.call('connection.remove',{id:saved.selected});}catch{failed=true;}check(failed,'confirmed Vault failure');
      await host.call('test.vaultFailure',{fail:false});check((await host.call('test.savedIntent',{})).pending===0,'no tombstone intent before confirmed Vault write');
      await host.call('test.receiptFailure',{fail:true});const committed=await host.call('connection.remove',{id:saved.selected});check(committed.selected===null&&committed.notificationRetirement.pending===1,'commit not fake rollback');
      const pending=await host.call('test.savedIntent',{});check(pending.connections===0&&pending.pending===1,'intent durable with exact removal');
      await host.call('test.receiptFailure',{fail:false});const recovered=await host.call('connection.list',{});check(recovered.connections.length===0&&!recovered.notificationRetirement,'read-only retry never recreates connection');
      check((await host.call('test.savedIntent',{})).pending===0,'exact marker handed off before intent clear');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#;
    let engine = engine(host, source.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert_eq!(
        receipts.data.lock().unwrap().as_ref().unwrap()["retirements"],
        json!([{"host":"synthetic-host","authorization":"synthetic-authorization"}])
    );
    assert!(counts.lock().unwrap().adds.is_empty());
    drop(engine);
    drop(owner);
}

#[test]
fn production_restore_hands_off_durable_old_authorization_before_publishing_new_identity() {
    let vault = MemoryVault::default();
    let mut saved = state();
    saved.connections[0].authorization = "fresh-authorization".into();
    saved.notification_retirements =
        vec![("synthetic-host".into(), "synthetic-authorization".into())];
    saved.persist(&vault).unwrap();
    let host = HostChannel::default();
    let counts = Arc::new(Mutex::new(Counts::default()));
    let receipts = Receipts::default();
    let owner = install_with(
        &host,
        &capabilities(),
        Box::new(vault.clone()),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let _jobs = installed(&host, &owner, &receipts, &counts);
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let engine=engine(host,r#"import {host} from 'nsh';(async()=>{const saved=await host.call('connection.list',{});const result=await host.call('notification.configure',{hostID:saved.selected,enabled:false,mode:'hidden-only',events:[],language:'en'});host.post('test.result',{ok:!!result.lease&&saved.connections[0].authorizationID==='fresh-authorization'});})().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    let record: Value = serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap();
    assert!(record.get("notificationRetirements").is_none());
    assert_eq!(
        receipts.data.lock().unwrap().as_ref().unwrap()["retirements"][0]["authorization"],
        "synthetic-authorization"
    );
    assert!(counts.lock().unwrap().adds.is_empty());
    drop(engine);
    drop(owner);
}

#[test]
fn production_marker_unknown_keeps_vault_intent_and_cold_recovery_never_replays_reauthorization() {
    let (mut actor, vault, network) = actor();
    let receipts = Receipts::default();
    let counts = Arc::new(Mutex::new(Counts::default()));
    let c = counts.clone();
    let _jobs = actor
        .services
        .install_notifications(
            &actor.host,
            Box::new(receipts.clone()),
            Box::new(move |_| Ok(Box::new(Synthetic(c)))),
        )
        .unwrap();
    actor.authorize_services();
    let old_scope = actor.state().scope.clone();
    let mut next = actor.state().clone();
    next.connections[0].authorization = "fresh-durable-authorization".into();
    next.connections[0].token = "fresh-synthetic-bearer".into();
    receipts.unknown.store(true, Ordering::Release);
    let committed = actor.commit(next, true).unwrap();
    assert_eq!(committed["notificationRetirement"]["pending"], 1);
    assert_eq!(
        committed["notificationRetirement"]["error"],
        "notification_store_unknown"
    );
    assert!(!actor.services.reader().current(old_scope.as_ref().unwrap()));
    let saved: Value = serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap();
    assert_eq!(
        saved["connections"][0]["authorizationID"],
        "fresh-durable-authorization"
    );
    assert_eq!(
        saved["notificationRetirements"][0]["authorizationID"],
        "synthetic-authorization"
    );
    actor.services.shutdown();
    drop(actor);
    receipts.unknown.store(false, Ordering::Release);
    let host = HostChannel::default();
    let (tx, _) = mpsc::sync_channel(QUEUE);
    let mut restored = Actor::new(host.clone(), tx, Box::new(vault.clone()), network.clone());
    let c = counts.clone();
    let _jobs = restored
        .services
        .install_notifications(
            &host,
            Box::new(receipts.clone()),
            Box::new(move |_| Ok(Box::new(Synthetic(c)))),
        )
        .unwrap();
    restored.load().unwrap();
    assert!(restored.state().notification_retirements.is_empty());
    assert_eq!(
        restored.state().current().unwrap().authorization,
        "fresh-durable-authorization"
    );
    assert!(network.requests.lock().unwrap().is_empty());
    assert!(counts.lock().unwrap().adds.is_empty());
    restored.services.shutdown();
}

#[test]
fn production_unavailable_notification_store_still_journals_retirement_without_disabling_other_services()
 {
    let (mut actor, vault, _) = actor();
    actor.authorize_services();
    let mut next = actor.state().clone();
    next.connections[0].authorization = "fresh-durable-authorization".into();
    next.connections[0].token = "fresh-synthetic-bearer".into();
    let committed = actor.commit(next, true).unwrap();
    assert_eq!(committed["notificationRetirement"]["pending"], 1);
    assert!(
        actor
            .services
            .reader()
            .current(actor.state().scope.as_ref().unwrap())
    );
    let saved: Value = serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap();
    assert_eq!(
        saved["notificationRetirements"],
        json!([{"hostID":"synthetic-host","authorizationID":"synthetic-authorization"}])
    );
    actor.services.shutdown();
}

#[test]
fn production_os_cleanup_failure_keeps_store_retry_without_retaining_a_completed_vault_intent() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let counts = Arc::new(Mutex::new(Counts {
        remove_fail: true,
        ..Default::default()
    }));
    let receipts = Receipts::default();
    let owner = install_with(
        &host,
        &capabilities(),
        Box::new(vault.clone()),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let _jobs = installed(&host, &owner, &receipts, &counts);
    let retry = counts.clone();
    host.handle("test.allowCleanup", move |call| {
        retry.lock().unwrap().remove_fail = false;
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let engine=engine(host,r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const saved=await host.call('connection.list',{});await host.call('test.activity',{active:true});await host.call('notification.test',{hostID:saved.selected,language:'en'});
      const committed=await host.call('connection.remove',{id:saved.selected});check(committed.selected===null&&committed.notificationRetirement.pending===0&&committed.notificationRetirement.error==='notification_cleanup_failed','OS failure distinct from durable marker');
      await host.call('test.allowCleanup',{});const retried=await host.call('connection.list',{});check(retried.connections.length===0&&!retried.notificationRetirement,'explicit retry only cleans OS remnants');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    let saved: Value = serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap();
    assert!(saved.get("notificationRetirements").is_none());
    assert_eq!(counts.lock().unwrap().adds.len(), 1);
    assert_eq!(
        receipts.data.lock().unwrap().as_ref().unwrap()["rows"],
        json!([])
    );
    drop(engine);
    drop(owner);
}

#[test]
fn production_unregistered_driver_returns_stable_unsupported_without_loading_credentials() {
    struct NoCredentials;
    impl Vault for NoCredentials {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("status cannot read Vault")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("status cannot write Vault")
        }
    }
    let host = HostChannel::default();
    let owner = install_with(
        &host,
        &capabilities(),
        Box::new(NoCredentials),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    let _jobs = owner
        .install_notifications(
            &host,
            Box::new(Receipts::default()),
            Box::new(|_| Err("notification_unsupported_identity".into())),
        )
        .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let engine=engine(host,r#"import {host} from 'nsh';host.call('notification.status',{}).then(()=>host.post('test.result',{error:'fake success'})).catch(error=>host.post('test.result',{ok:String(error).includes('notification_unsupported_identity')}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    drop(engine);
    drop(owner);
}
