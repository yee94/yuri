//! Production HostChannel -> owning service worker -> adapter -> original actor.
use super::*;
use crate::{native_ssh_bridge, ssh};

#[derive(Default)]
struct Driver {
    closed: Arc<AtomicUsize>,
}
struct Tunnel(Arc<AtomicUsize>);
impl ssh::Tunnel for Tunnel {
    fn alive(&mut self) -> bool {
        true
    }
    fn close(&mut self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}
impl ssh::Driver for Driver {
    fn inspect(
        &self,
        _: &ssh::Instance,
        cancel: &ssh::Cancellation,
    ) -> ssh::Result<ssh::Inspection> {
        assert_eq!(std::thread::current().name(), Some("yuri-ssh-operation"));
        cancel.check()?;
        Ok(ssh::Inspection {
            node_major: 24,
            version: Some("1.2.3".into()),
        })
    }
    fn initialize(
        &self,
        _: &ssh::Instance,
        version: &str,
        password: &ssh::Secret,
        cancel: &ssh::Cancellation,
    ) -> ssh::Result<()> {
        assert_eq!(version, "1.2.3");
        assert!(password.expose().len() >= 24);
        cancel.check()
    }
    fn forward(&self, _: &ssh::Instance, cancel: &ssh::Cancellation) -> ssh::Result<ssh::Forward> {
        cancel.check()?;
        Ok(ssh::Forward {
            port: 43123,
            tunnel: Box::new(Tunnel(self.closed.clone())),
        })
    }
}
#[derive(Default)]
struct Auth {
    requests: Mutex<Vec<HttpRequest>>,
}
impl Network for Auth {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn FetchTask> {
        let body = if request.url == "http://127.0.0.1:43123/auth/session" {
            assert!(
                !request
                    .headers
                    .iter()
                    .any(|(key, _)| key.eq_ignore_ascii_case("authorization"))
            );
            json!({"clientToken":"synthetic-ssh-bridge-bearer"})
        } else {
            assert_eq!(request.url, "http://127.0.0.1:43123/api/config/settings");
            assert!(request.headers.contains(&(
                "Authorization".into(),
                "Bearer synthetic-ssh-bridge-bearer".into()
            )));
            json!({"ok":true})
        };
        assert!(!request.follow_redirects);
        let url = request.url.clone();
        self.requests.lock().unwrap().push(request);
        events(FetchEvent::Head(HttpHead {
            status: 200,
            url,
            headers: vec![("Content-Type".into(), "application/json".into())],
            ..Default::default()
        }));
        events(FetchEvent::Data(serde_json::to_vec(&body).unwrap()));
        events(FetchEvent::End);
        Box::new(FakeTask(Arc::new(AtomicUsize::new(0))))
    }
}
fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "synthetic service completion timed out"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn caps() -> Value {
    json!({"host":native_ssh_bridge::METHODS})
}

#[test]
fn product_manifest_policy_reaches_all_six_real_connection_only_handlers_without_sync_grants() {
    let product: Value = serde_json::from_str(include_str!("../../nsh.json")).unwrap();
    let capabilities = &product["capabilities"];
    let names = capabilities["host"].as_array().unwrap();
    let ssh_names: Vec<_> = names
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| s.starts_with("desktop.ssh."))
        .collect();
    assert_eq!(ssh_names.len(), 6);
    for method in native_ssh_bridge::METHODS {
        assert_eq!(ssh_names.iter().filter(|name| **name == *method).count(), 1);
    }
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(Auth::default());
    let mut owner =
        install_with(&host, capabilities, Box::new(vault), network.clone(), false).unwrap();
    owner
        .install_ssh(Ok(Arc::new(Driver::default())), "1.2.3".into())
        .unwrap();
    wait(|| owner.ssh.as_ref().unwrap().phase() == Some(ssh::service::Phase::Ready));
    let (tx, rx) = mpsc::channel();
    host.handle("runtime.pickAttachment", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let mut bundle = Bundle::source(r#"import {host} from 'nsh';(async()=>{
      const check=v=>{if(!v)throw Error('product SSH policy');};
      const cap=await host.call('desktop.ssh.capabilities',{});check(cap.version===1&&cap.connections.supported&&cap.sync.supported===false);
      let read=await host.call('desktop.ssh.read',{});check(read.revision===0);
      const row={id:'product-ssh',label:'Fixture',host:'ssh.example.invalid',user:'fixture',port:22,remotePort:3210,localPort:0,managed:true};
      await host.call('desktop.ssh.save',{requestID:'policy-save',revision:0,instance:row});
      await host.call('desktop.ssh.remove',{requestID:'policy-remove',revision:1,id:row.id});
      await host.call('desktop.ssh.save',{requestID:'policy-save-again',revision:2,instance:row});
      await host.call('desktop.ssh.start',{requestID:'policy-start',id:row.id,intent:'connect'});
      for(let n=0;n<4096;n++){read=await host.call('desktop.ssh.read',{});if(read.statuses[0]?.phase==='ready'&&!read.statuses[0].running)break;}
      check(read.statuses[0]?.phase==='ready');
      try { await host.call('desktop.ssh.cancel',{id:row.id,attempt:read.statuses[0].attempt}); }
      catch(error) { check(String(error).includes('ssh_')); }
      let denied=false;try{await host.call('desktop.ssh.sync.preview',{});}catch{denied=true;}check(denied);
      host.post('runtime.pickAttachment',{ok:true});
    })().catch(error=>host.post('runtime.pickAttachment',{error:String(error)}));"#.into());
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(capabilities).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let _engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    owner.begin_shutdown();
    wait(|| owner.stopped());
    assert_eq!(network.requests.lock().unwrap().len(), 2);
}

#[test]
fn connection_bridge_commits_on_original_actor_and_shutdown_retires_before_actor_exit() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(Auth::default());
    let driver = Arc::new(Driver::default());
    let mut owner = install_with(
        &host,
        &caps(),
        Box::new(vault.clone()),
        network.clone(),
        false,
    )
    .unwrap();
    owner
        .install_ssh(Ok(driver.clone()), "1.2.3".into())
        .unwrap();
    let control = owner.ssh.as_ref().unwrap().clone();
    wait(|| control.phase() == Some(ssh::service::Phase::Ready));
    let shutdown = owner.services();
    host.handle("test.shutdown", move |call| {
        shutdown.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{
      const check=(v,m)=>{if(!v)throw Error(m);};const reject=async(name,value)=>{try{await host.call(name,value);return false;}catch{return true;}};
      const cap=await host.call('desktop.ssh.capabilities',{});check(cap.version===1&&cap.connections.supported&&!cap.sync.supported,'narrow real support');
      check(await reject('desktop.ssh.capabilities',{available:true}),'exact capability input');
      const row={id:'bridge-fixture',label:'Synthetic SSH',host:'ssh.example.invalid',user:'fixture',port:22,remotePort:3210,localPort:0,managed:true};
      let read=await host.call('desktop.ssh.read',{});check(read.revision===0&&read.instances.length===0,'real actor load');
      check(await reject('desktop.ssh.save',{requestID:'bad',revision:0,instance:{...row,password:'forbidden'}}),'no JS credentials');
      let saved=await host.call('desktop.ssh.save',{requestID:'save-1',revision:0,instance:row});check(saved.revision===1&&saved.receipts.includes('save-1'),'original transaction');
      check(await reject('desktop.ssh.save',{requestID:'stale',revision:0,instance:row}),'CAS retained');
      await host.call('desktop.ssh.start',{requestID:'connect-1',id:row.id,intent:'connect'});
      for(let n=0;n<4096;n++){read=await host.call('desktop.ssh.read',{});if(read.statuses[0]?.phase==='ready'&&!read.statuses[0].running)break;}
      check(read.statuses[0]?.phase==='ready'&&read.statuses[0].connectionID,'only committed Ready');
      const publicText=JSON.stringify(read);check(!publicText.includes('bearer')&&!publicText.includes('password')&&!publicText.includes('localPort":43123'),'no private material');
      await host.call('test.shutdown',{});check(!(await host.call('desktop.ssh.capabilities',{})).connections.supported,'stop fences capability');
      check(await reject('desktop.ssh.start',{requestID:'late',id:row.id,intent:'connect'}),'stop rejects late start');host.post('test.result',{ok:true});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    wait(|| owner.services().shutdown_complete());
    assert!(driver.closed.load(Ordering::Relaxed) > 0);
    assert_eq!(network.requests.lock().unwrap().len(), 2);
    let saved: Value = serde_json::from_slice(&vault.read().unwrap().unwrap()).unwrap();
    let binding = &saved["sshNative"]["bindings"][0];
    assert_eq!(
        owner
            .connection_actor_port()
            .healthy(crate::connection_actor_port::Committed {
                connection_id: binding["connectionID"].as_str().unwrap().into(),
                receipt: binding["receipt"].as_str().unwrap().into()
            }),
        Err(crate::connection_actor_port::Error::Unavailable),
        "services shutdown fences new health requests before the actor is torn down"
    );
    assert_eq!(
        saved["connections"].as_array().unwrap().len(),
        2,
        "retirement does not delete saved connection"
    );
    let stopped = owner.actor_stop.clone();
    drop(owner);
    wait(|| stopped.load(Ordering::Acquire));
}

#[test]
fn unsupported_driver_capability_is_inert_and_never_reads_vault_or_claims_sync() {
    struct NoVault;
    impl Vault for NoVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("unsupported native executable must not load credentials")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("unsupported native executable must not write credentials")
        }
    }
    let host = HostChannel::default();
    let mut owner = install_with(
        &host,
        &caps(),
        Box::new(NoVault),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    owner
        .install_ssh(Err(ssh::Error::Unavailable), "1.2.3".into())
        .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{const cap=await host.call('desktop.ssh.capabilities',{});let denied=false;try{await host.call('desktop.ssh.read',{});}catch{denied=true;}host.post('test.result',{ok:!cap.connections.supported&&!cap.sync.supported&&denied});})().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    owner.services().shutdown();
    assert!(owner.services().shutdown_complete());
}

#[test]
fn dropping_host_fences_admission_but_keeps_original_actor_until_ssh_worker_stops() {
    struct PausedDriver {
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl ssh::Driver for PausedDriver {
        fn inspect(
            &self,
            _: &ssh::Instance,
            cancel: &ssh::Cancellation,
        ) -> ssh::Result<ssh::Inspection> {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            cancel.check()?;
            panic!("shutdown must cancel the operation before it can continue")
        }
        fn initialize(
            &self,
            _: &ssh::Instance,
            _: &str,
            _: &ssh::Secret,
            _: &ssh::Cancellation,
        ) -> ssh::Result<()> {
            panic!("no initialize after shutdown")
        }
        fn forward(&self, _: &ssh::Instance, _: &ssh::Cancellation) -> ssh::Result<ssh::Forward> {
            panic!("no forward after shutdown")
        }
    }
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, paused) = mpsc::sync_channel(1);
    let mut owner = install_with(&host, &caps(), Box::new(vault), network.clone(), false).unwrap();
    owner
        .install_ssh(
            Ok(Arc::new(PausedDriver {
                entered,
                release: Mutex::new(paused),
            })),
            "1.2.3".into(),
        )
        .unwrap();
    let control = owner.ssh.as_ref().unwrap().clone();
    wait(|| control.phase() == Some(ssh::service::Phase::Ready));
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{const instance={id:'paused',label:'Synthetic paused',host:'ssh.example.invalid',user:'fixture',port:22,remotePort:3210,localPort:0,managed:true};await host.call('desktop.ssh.save',{requestID:'save',revision:0,instance});await host.call('desktop.ssh.start',{requestID:'start',id:instance.id,intent:'connect'});host.post('test.result',{ok:true});})().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let actor_stop = owner.actor_stop.clone();
    let port = owner.connection_actor_port();
    let services = owner.services();
    drop(owner);
    assert!(
        !actor_stop.load(Ordering::Acquire),
        "Host actor must remain available for exact retirement"
    );
    assert!(!services.shutdown_complete());
    assert!(services.window_id().is_err());
    assert!(
        matches!(
            port.load(),
            Err(crate::connection_actor_port::Error::Unavailable)
        ),
        "ordinary native admission is fenced"
    );
    release.send(()).unwrap();
    wait(|| control.stopped() && actor_stop.load(Ordering::Acquire));
    assert!(services.shutdown_complete());
    assert!(network.requests.lock().unwrap().is_empty());
}

#[test]
fn original_actor_commit_unknown_remains_terminal_and_keeps_its_error() {
    struct UnknownVault;
    impl Vault for UnknownVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            Err(vault::COMMIT_UNKNOWN.into())
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("unknown load must not write")
        }
    }
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let mut owner = install_with(
        &host,
        &caps(),
        Box::new(UnknownVault),
        network.clone(),
        false,
    )
    .unwrap();
    owner
        .install_ssh(Ok(Arc::new(Driver::default())), "1.2.3".into())
        .unwrap();
    let control = owner.ssh.as_ref().unwrap().clone();
    wait(|| control.phase() == Some(ssh::service::Phase::Failed(ssh::Error::CommitUnknown)));
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{const cap=await host.call('desktop.ssh.capabilities',{});let unknown=false;try{await host.call('desktop.ssh.read',{});}catch(error){unknown=String(error).includes('ssh_commit_unknown');}host.post('test.result',{ok:cap.connections.phase==='failed'&&!cap.connections.supported&&unknown});})().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ok":true})
    );
    assert!(network.requests.lock().unwrap().is_empty());
    wait(|| control.shutdown_failure() == Some(ssh::Error::CommitUnknown));
    assert!(!control.stopped());
    assert!(!owner.services().shutdown_complete());
    let actor_stop = owner.actor_stop.clone();
    let actor_done = owner.actor_done.clone();
    owner.begin_shutdown();
    assert!(
        !actor_stop.load(Ordering::Acquire),
        "failed on_stopped must not release original actor teardown"
    );
    assert!(
        matches!(
            owner
                .connection_actor_port()
                .retire(crate::connection_actor_port::Committed {
                    connection_id: "synthetic-host".into(),
                    receipt: "unresolved-synthetic".into(),
                }),
            Err(crate::connection_actor_port::Error::CommitUnknown)
        ),
        "exact cleanup still reaches the quarantined original actor"
    );
    // Test-only disposal of this synthetic actor. Production must retain unresolved state;
    // there is deliberately no public force-success or automatic retry API.
    actor_stop.store(true, Ordering::Release);
    let _ = owner.tx.try_send(Message::Shutdown);
    wait(|| actor_done.load(Ordering::Acquire));
}

#[test]
fn dispatched_original_vault_unknown_preserves_failed_service_barrier_and_original_actor() {
    struct UnknownWrite(MemoryVault);
    impl Vault for UnknownWrite {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.0.read()
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            Err(vault::COMMIT_UNKNOWN.into())
        }
    }
    let store = MemoryVault::default();
    state().persist(&store).unwrap();
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let mut owner = install_with(
        &host,
        &caps(),
        Box::new(UnknownWrite(store)),
        network.clone(),
        false,
    )
    .unwrap();
    owner
        .install_ssh(Ok(Arc::new(Driver::default())), "1.2.3".into())
        .unwrap();
    let control = owner.ssh.as_ref().unwrap().clone();
    wait(|| control.phase() == Some(ssh::service::Phase::Ready));
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        let _ = tx.send(call.take_data());
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{
      const row={id:'unknown-save',label:'Synthetic',host:'ssh.example.invalid',user:'fixture',port:22,remotePort:3210,localPort:0,managed:true};
      let unknown=false;try{await host.call('desktop.ssh.save',{requestID:'unknown-write',revision:0,instance:row});}catch(error){unknown=String(error).includes('ssh_commit_unknown');}
      host.post('test.result',{unknown});
    })().catch(error=>host.post('test.result',{error:String(error)}));"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"unknown":true})
    );
    wait(|| control.shutdown_failure() == Some(ssh::Error::CommitUnknown));
    assert_eq!(
        control.phase(),
        Some(ssh::service::Phase::Failed(ssh::Error::CommitUnknown))
    );
    assert!(!control.stopped());
    assert!(!owner.services().shutdown_complete());
    let stopped = owner.actor_stop.clone();
    let done = owner.actor_done.clone();
    owner.begin_shutdown();
    owner.begin_shutdown();
    assert!(!stopped.load(Ordering::Acquire));
    assert!(
        network.requests.lock().unwrap().is_empty(),
        "no SSH or authentication fallback from unknown save"
    );
    // Only dispose the synthetic test worker, not a recovery path for a real unknown write.
    stopped.store(true, Ordering::Release);
    let _ = owner.tx.try_send(Message::Shutdown);
    wait(|| done.load(Ordering::Acquire));
}
