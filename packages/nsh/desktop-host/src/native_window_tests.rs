use super::*;
use nsh_engine::{Bundle, FetchTask, HttpRequest, Network, StorageBackend};
use std::{collections::BTreeMap, sync::Arc};
struct Offline;
impl Network for Offline {
    fn fetch(&self, _: HttpRequest, _: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
        panic!("window validation cannot perform network I/O")
    }
}
struct Memory;
impl StorageBackend for Memory {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        Ok(BTreeMap::new())
    }
    fn write(&self, _: nsh_core::storage::StorageChange) {
        panic!("window validation cannot write Storage")
    }
}
fn window(key: &str) -> Window {
    Window {
        window_key: key.into(),
        source: platform::AppSource::Bundle(Bundle::source(String::new())),
        options: platform::AppOptions {
            storage: Some(Arc::new(Memory)),
            ..Default::default()
        },
        inbox: channel().1,
        services: crate::host_services::Port::new(Arc::new(Offline)),
        dialogs: Dialogs::default(),
        lifetime: None,
        persistence: None,
        restored: None,
    }
}
#[test]
fn every_engine_requires_a_distinct_channel_owner_key_and_storage_before_creation() {
    let mut windows = vec![window("main-a"), window("main-b")];
    assert!(validate_windows(&windows).is_ok());
    assert_eq!(windows[0].options.host.params()["windowKey"], "main-a");
    assert_eq!(windows[0].options.host.params()["windowKind"], "main");
    assert_eq!(windows[1].options.host.params()["windowKey"], "main-b");
    windows[1].options.host = windows[0].options.host.clone();
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_channel_shared"
    );
    windows[1] = window("main-b");
    windows[1].options.storage = windows[0].options.storage.clone();
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_metadata_namespace_shared"
    );
    windows[1].options.storage = None;
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_metadata_namespace_required"
    );
    windows[1] = window("main-a");
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_identity_invalid"
    );
    windows[1] = window("main-b");
    windows[1].services = windows[0].services.clone();
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_identity_invalid"
    );
}
#[test]
fn main_window_budget_is_checked_before_any_engine_or_native_window_is_constructed() {
    assert!(validate_windows(&[]).is_err());
    let mut windows: Vec<_> = (0..crate::window_state::MAX_WINDOWS)
        .map(|index| window(&format!("main-{index}")))
        .collect();
    assert!(validate_windows(&windows).is_ok());
    windows.push(window("main-over-budget"));
    assert_eq!(validate_windows(&windows).unwrap_err(), "window_capacity");
    windows.truncate(1);
    windows[0].window_key = "../not-a-window-key".into();
    assert_eq!(
        validate_windows(&windows).unwrap_err(),
        "window_identity_invalid"
    );
}

#[test]
fn real_engines_read_the_native_launch_descriptor_without_inventing_a_receipt_identity() {
    use nsh_engine::{Engine, EngineConfig, MountSink};
    use serde_json::json;
    use std::{sync::mpsc, time::Duration};
    struct Sink;
    impl MountSink for Sink {
        fn submit(&self, _: nsh_core::MountBatch) {}
    }
    let windows = vec![window("primary"), window("main-native-key")];
    validate_windows(&windows).unwrap();
    let mut engines = Vec::new();
    for window in &windows {
        let (tx, rx) = mpsc::channel();
        window
            .options
            .host
            .handle("test.descriptor", move |mut call| {
                let _ = tx.send(call.take_data());
            });
        let mut bundle = Bundle::source(
            "import {host} from 'nsh';host.post('test.descriptor',host.params);".into(),
        );
        bundle.policy.declared = Some(
            nsh_core::access::Capabilities::from_json(&json!({"host":["test.descriptor"]}))
                .unwrap(),
        );
        let mut config = EngineConfig::new(bundle);
        config.host = window.options.host.clone();
        config.storage = window.options.storage.clone();
        engines.push(Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap());
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            json!({"windowKey":window.window_key,"windowKind":"main","windowCoordination":"multi-engine"})
        );
    }
    assert_eq!(engines.len(), 2);
}

#[test]
fn legacy_primary_descriptor_explicitly_declares_single_engine_without_key_heuristics() {
    let windows = vec![window("primary")];
    validate_windows(&windows).unwrap();
    assert_eq!(
        windows[0].options.host.params()["windowCoordination"],
        "single-engine"
    );
}
