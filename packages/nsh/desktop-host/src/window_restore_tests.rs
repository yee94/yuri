//! Native target is set before the first Vault load/publication; no UI or real credentials.
use super::*;

#[test]
fn restoration_never_publishes_prior_default_or_writes_global_selected_target() {
    let vault = MemoryVault::default();
    let mut saved = state();
    let mut second = connection();
    second.id = "other-host".into();
    second.url = "https://other.invalid".into();
    saved.connections.push(second);
    saved.persist(&vault).unwrap();
    let before = vault.read().unwrap();
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let mut owner = install_target(
        &host,
        &json!({"host":["connection.list"]}),
        Box::new(vault.clone()),
        network.clone(),
        false,
        appearance::metadata(&Value::Null),
        appearance::Port::unavailable(),
        Some("other-host".into()),
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';host.call('connection.list',{}).then(value=>host.post('test.result',value));"#.into());
    let result = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result["selected"], "other-host");
    let geometry = crate::window_persistence::tests::record("primary").geometry;
    let record = owner
        .services()
        .reader()
        .window_record("primary", geometry)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(record.connection_id, "other-host");
    assert_eq!(record.runtime_key, "nsh:other-host");
    assert_eq!(
        vault.read().unwrap(),
        before,
        "restoring a window is not a global selection mutation"
    );
    assert!(network.requests.lock().unwrap().is_empty());
    owner.begin_shutdown();
    crate::window_persistence::tests::wait(|| owner.stopped());
}

#[test]
fn missing_restored_target_stays_explicitly_failed_without_default_host_or_disk_deletion() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let before = vault.read().unwrap();
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let mut owner = install_target(
        &host,
        &json!({"host":["connection.list"]}),
        Box::new(vault.clone()),
        network.clone(),
        false,
        appearance::metadata(&Value::Null),
        appearance::Port::unavailable(),
        Some("missing-host".into()),
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{let errors=[];for(let n=0;n<2;n++){try{await host.call('connection.list',{});}catch(error){errors.push(String(error));}}host.post('test.result',{errors});})();"#.into());
    let result = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    assert!(result["errors"].as_array().unwrap().iter().all(|s| {
        s.as_str()
            .unwrap()
            .contains("window_restore_target_unavailable")
    }));
    let captured = owner
        .services()
        .reader()
        .window_record(
            "primary",
            crate::window_persistence::tests::record("primary").geometry,
        )
        .unwrap();
    assert!(captured.record.is_none());
    assert_eq!(vault.read().unwrap(), before);
    assert!(network.requests.lock().unwrap().is_empty());
    owner.begin_shutdown();
    crate::window_persistence::tests::wait(|| owner.stopped());
}

#[test]
fn services_shutdown_fences_original_mailbox_before_reply_but_owner_still_performs_real_teardown() {
    let vault = MemoryVault::default();
    state().persist(&vault).unwrap();
    let before = vault.read().unwrap();
    let host = HostChannel::default();
    let network = Arc::new(FakeNetwork::default());
    let mut owner = install_with(
        &host,
        &json!({"host":["connection.list","connection.remove","runtime.request"]}),
        Box::new(vault.clone()),
        network.clone(),
        false,
    )
    .unwrap();
    let services = owner.services();
    host.handle("test.fence", move |call| {
        services.shutdown();
        call.resolve(json!(true));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(host, r#"import {host} from 'nsh';(async()=>{
      const saved=await host.call('connection.list',{});await host.call('test.fence',{});
      let denied=0;for(const [name,value] of [['connection.remove',{id:saved.selected}],['runtime.request',{path:'/api/config/settings',expectedHost:saved.runtimeScope}]]){
        try{await host.call(name,value);}catch(error){if(String(error).includes('native_host_unavailable'))denied++;}
      }host.post('test.result',{denied});})();"#.into());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"denied":2})
    );
    assert!(owner.stop.load(Ordering::Acquire));
    assert!(!owner.stopped());
    assert_eq!(vault.read().unwrap(), before);
    assert!(network.requests.lock().unwrap().is_empty());
    owner.begin_shutdown();
    owner.begin_shutdown();
    crate::window_persistence::tests::wait(|| owner.stopped());
}

#[test]
fn stopped_is_not_published_until_original_vault_destructor_and_thread_join_complete() {
    struct HeldVault {
        inner: MemoryVault,
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
    }
    impl Vault for HeldVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            self.inner.read()
        }
        fn write(&self, bytes: &[u8]) -> Result<()> {
            self.inner.write(bytes)
        }
    }
    impl Drop for HeldVault {
        fn drop(&mut self) {
            self.entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    }
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, held) = mpsc::sync_channel(1);
    let mut owner = install_with(
        &HostChannel::default(),
        &json!({"host":[]}),
        Box::new(HeldVault {
            inner: MemoryVault::default(),
            entered,
            release: held,
        }),
        Arc::new(FakeNetwork::default()),
        false,
    )
    .unwrap();
    owner.begin_shutdown();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        !owner.stopped(),
        "teardown work reaching zero is not a released Vault/actual thread exit"
    );
    release.send(()).unwrap();
    crate::window_persistence::tests::wait(|| owner.stopped());
}
