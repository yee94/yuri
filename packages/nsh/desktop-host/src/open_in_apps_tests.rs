use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, HostChannel, MountSink};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
fn engine(host: HostChannel, source: &str, capabilities: &Value) -> Engine {
    let mut bundle = Bundle::source(source.to_owned());
    bundle.policy.declared = Some(nsh_core::access::Capabilities::from_json(capabilities).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap()
}

fn catalog() -> Catalog {
    Catalog::new(Arc::new(|| {
        panic!("tests must not discover real installed apps")
    }))
}

#[test]
fn cold_read_and_selection_do_not_scan_or_grant_host_paths() {
    let catalog = catalog();
    let cold = catalog.read(&json!({})).unwrap();
    assert_eq!(cold["apps"], json!([]));
    assert_eq!(cold["selectedID"], "finder");
    assert_eq!(cold["stale"], true);
    for _ in 0..50 {
        assert_eq!(catalog.read(&json!({})).unwrap(), cold);
    }
    assert!(catalog.select(&json!({"appID":"invented"})).is_err());
    assert!(
        catalog
            .select(&json!({"appID":"finder","path":"/synthetic"}))
            .is_err()
    );
    let caps = Catalog::capabilities(&json!({})).unwrap();
    assert_eq!(
        caps["open"],
        json!({"supported":false,"reason":"local_directory_mapping_unavailable"})
    );
    assert!(Catalog::capabilities(&json!({"open":true})).is_err());
}

#[test]
fn failed_scan_preserves_prior_and_successful_empty_clears_apps_not_preference() {
    let catalog = catalog();
    catalog
        .finish(Ok(vec![app("vscode", "VS Code", Some("1.0".into()))]))
        .unwrap();
    catalog.select(&json!({"appID":"vscode"})).unwrap();
    assert!(
        catalog
            .finish(Err("synthetic failure with unsafe details".into()))
            .is_err()
    );
    let failed = catalog.read(&json!({})).unwrap();
    assert_eq!(failed["apps"][0]["id"], "vscode");
    assert_eq!(failed["selectedID"], "vscode");
    assert_eq!(failed["error"], "discovery_failed");
    assert_eq!(failed["stale"], true);
    assert!(
        catalog
            .finish(Ok(vec![app("invented", "Invented", None)]))
            .is_err()
    );
    assert_eq!(catalog.read(&json!({})).unwrap()["apps"], failed["apps"]);
    let empty = catalog.finish(Ok(vec![])).unwrap();
    assert_eq!(empty["apps"], json!([]));
    assert_eq!(empty["selectedID"], "vscode");
    assert_eq!(empty["stale"], false);
    assert_eq!(empty["error"], Value::Null);
}

#[test]
fn all_open_paths_fail_closed_including_local_looking_host_and_matching_lease() {
    let catalog = catalog();
    catalog
        .finish(Ok(vec![app("finder", "Finder", None)]))
        .unwrap();
    let scope = json!({"hostID":"local","lease":"11111111-1111-4111-8111-111111111111"});
    let base = json!({"expectedHost":scope,"directory":"/synthetic/project","appID":"finder","intent":"open-current-directory"});
    assert_eq!(
        catalog.denied_open(&base, Some(&scope)).unwrap()["status"],
        "unsupported"
    );
    assert!(catalog.denied_open(&base, None).is_err());
    for field in ["hostID", "lease"] {
        let mut wrong = base.clone();
        wrong["expectedHost"][field] = json!(if field == "lease" {
            "22222222-2222-4222-8222-222222222222"
        } else {
            "remote"
        });
        assert!(catalog.denied_open(&wrong, Some(&scope)).is_err());
    }
    for path in [
        "relative",
        "/synthetic/../private",
        "/synthetic/./x",
        "file:///synthetic",
        "\\\\server\\share",
        "C:\\synthetic\\..\\private",
        "/x\u{0}y",
    ] {
        let mut wrong = base.clone();
        wrong["directory"] = json!(path);
        assert!(catalog.denied_open(&wrong, Some(&scope)).is_err());
    }
    let mut windows = base.clone();
    windows["directory"] = json!("C:\\synthetic\\project");
    assert_eq!(
        catalog.denied_open(&windows, Some(&scope)).unwrap()["status"],
        "unsupported"
    );
    let mut unknown = base.clone();
    unknown["appID"] = json!("unknown");
    assert!(catalog.denied_open(&unknown, Some(&scope)).is_err());
    let mut no_intent = base.clone();
    no_intent["intent"] = Value::Null;
    assert!(catalog.denied_open(&no_intent, Some(&scope)).is_err());
}

#[test]
fn real_host_reply_worker_singleflight_and_read_during_scan_without_os_discovery() {
    let (release, blocked) = mpsc::channel();
    let blocked = Mutex::new(blocked);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let catalog = Arc::new(Catalog::new(Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        blocked
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        Ok(vec![app("finder", "Synthetic Finder", None)])
    })));
    let host = HostChannel::default();
    let scanning = catalog.clone();
    host.handle("desktop.openInApps.scan", move |mut call| {
        let value = call.take_data();
        scanning.scan(&value, call.into_reply().unwrap());
    });
    let reading = catalog.clone();
    host.handle("desktop.openInApps.read", move |mut call| {
        let input = call.take_data();
        call.reply(reading.read(&input));
    });
    let (tx, rx) = mpsc::channel();
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(
        host,
        r#"import {host} from 'nsh';(async()=>{
      const first=host.call('desktop.openInApps.scan',{});
      let busy=false;try{await host.call('desktop.openInApps.scan',{});}catch{busy=true;}
      const during=await host.call('desktop.openInApps.read',{});
      host.post('test.result',{busy,scanning:during.scanning});
      const done=await first;for(let i=0;i<50;i++)await host.call('desktop.openInApps.read',{});
      host.post('test.result',{id:done.apps[0].id,scanning:done.scanning});
    })().catch(e=>host.post('test.result',{error:String(e)}));"#,
        &json!({"host":true}),
    );
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"busy":true,"scanning":true})
    );
    release.send(()).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"id":"finder","scanning":false})
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn product_manifest_and_installed_actor_expose_only_read_metadata_without_loading_credentials() {
    struct NoVault;
    impl crate::vault::Vault for NoVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            panic!("catalog must not read credentials")
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            panic!("catalog must not write credentials")
        }
    }
    struct NoNetwork;
    impl nsh_engine::Network for NoNetwork {
        fn fetch(
            &self,
            _: nsh_core::platform::HttpRequest,
            _: nsh_engine::FetchEvents,
        ) -> Box<dyn nsh_engine::FetchTask> {
            panic!("catalog must not access Host or network")
        }
    }
    let product: Value = serde_json::from_str(include_str!("../../nsh.json")).unwrap();
    for name in METHODS {
        assert_eq!(
            product["capabilities"]["host"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry.as_str() == Some(name))
                .count(),
            1
        );
    }
    let host = HostChannel::default();
    let _owner = crate::bridge::install_configured(
        &host,
        &product["capabilities"],
        Box::new(NoVault),
        Arc::new(NoNetwork),
        false,
        Value::Null,
        crate::appearance::Port::unavailable(),
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    host.handle("runtime.pickAttachment", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let _engine = engine(
        host,
        r#"import {host} from 'nsh';(async()=>{
      const caps=await host.call('desktop.openInApps.capabilities',{});
      const read=await host.call('desktop.openInApps.read',{});
      let rejected=false;try{await host.call('desktop.openInApps.open',{
        expectedHost:{hostID:'local',lease:'synthetic'},directory:'/synthetic/project',appID:'finder',intent:'open-current-directory'
      });}catch{rejected=true;}
      host.post('runtime.pickAttachment',{supported:caps.open.supported,reason:caps.open.reason,read:read.version,rejected});
    })().catch(e=>host.post('runtime.pickAttachment',{error:String(e)}));"#,
        &product["capabilities"],
    );
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"supported":false,"reason":"local_directory_mapping_unavailable","read":1,"rejected":true})
    );
}
