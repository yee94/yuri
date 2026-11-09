//! Independent synthetic-only AppKit executable. Never calls bridge::install or NativeVault.
// Modules are shared with the production binary, whose unused entrypoints are intentional here.
#![allow(dead_code)]

#[cfg(target_os = "macos")]
#[path = "../src/appearance.rs"]
mod appearance;
#[cfg(target_os = "macos")]
#[path = "../src/attachments.rs"]
mod attachments;
#[cfg(target_os = "macos")]
#[path = "../src/bridge.rs"]
mod bridge;
#[cfg(target_os = "macos")]
#[path = "../src/browser_view.rs"]
mod browser_view;
#[cfg(target_os = "macos")]
#[path = "../src/close.rs"]
mod close;
#[path = "../src/connection_actor_http_port.rs"]
mod connection_actor_http_port;
#[path = "../src/connection_actor_port.rs"]
mod connection_actor_port;
#[path = "../src/desktop_tab.rs"]
mod desktop_tab;
#[cfg(target_os = "macos")]
#[path = "../src/diagnostics.rs"]
mod diagnostics;
#[cfg(target_os = "macos")]
#[path = "../src/documents.rs"]
mod documents;
#[path = "../src/file_download.rs"]
mod file_download;
#[path = "../src/file_download_attachment_validation.rs"]
mod file_download_attachment_validation;
#[cfg(target_os = "macos")]
#[path = "../src/file_journal.rs"]
mod file_journal;
#[cfg(target_os = "macos")]
#[path = "../src/host_services.rs"]
mod host_services;
#[cfg(target_os = "macos")]
#[path = "../src/native_preferences.rs"]
mod native_preferences;
#[path = "../src/native_ssh_bridge.rs"]
mod native_ssh_bridge;
#[cfg(target_os = "macos")]
#[path = "../src/native_ui.rs"]
mod native_ui;
#[cfg(target_os = "macos")]
#[path = "../src/notification_store_grant.rs"]
mod notification_store_grant;
#[cfg(target_os = "macos")]
#[path = "../src/notifications.rs"]
mod notifications;
#[cfg(target_os = "macos")]
#[path = "../src/open_in_apps.rs"]
mod open_in_apps;
#[cfg(target_os = "macos")]
#[path = "../src/policy.rs"]
mod policy;
#[cfg(target_os = "macos")]
#[path = "../src/resources.rs"]
mod resources;
#[path = "../src/ssh.rs"]
mod ssh;
#[cfg(target_os = "macos")]
#[path = "../src/terminal_host.rs"]
mod terminal_host;
#[cfg(target_os = "macos")]
#[path = "../src/terminal_transport.rs"]
mod terminal_transport;
#[cfg(target_os = "macos")]
#[path = "../src/terminal_viewport.rs"]
mod terminal_viewport;
#[cfg(target_os = "macos")]
#[path = "../src/vault.rs"]
mod vault;
#[path = "../src/window_geometry.rs"]
mod window_geometry;
#[path = "../src/window_kernel.rs"]
mod window_kernel;
#[path = "../src/window_persistence.rs"]
mod window_persistence;
#[path = "../src/window_sampling.rs"]
mod window_sampling;
#[path = "../src/window_state.rs"]
mod window_state;

#[cfg(target_os = "macos")]
mod smoke {
    use crate::{appearance, bridge, native_ui, policy::Result, vault};
    use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
    use nsh_engine::{Bundle, CacheOptions, FetchTask, HostChannel, Network};
    use nsh_platform_macos::{
        self as platform, objc2, objc2_app_kit as kit, objc2_foundation as foundation,
    };
    use serde_json::{Value, json};
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        process::ExitCode,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    const ORIGIN: &str = "https://synthetic.invalid";
    // Check the production registration signature without constructing a renderer in unit tests.
    const _: fn(&platform::Components) -> Result<crate::terminal_viewport::Registration> =
        crate::terminal_viewport::register;
    const APP_ID: &str = "com.yee94.yuri.nsh.synthetic-smoke";
    struct SyntheticVault;
    impl vault::Vault for SyntheticVault {
        fn read(&self) -> Result<Option<Vec<u8>>> {
            Ok(Some(json!({"version":1,"selected":"synthetic-host","connections":[{
                "id":"synthetic-host","label":"Synthetic Host — no real credentials","url":ORIGIN,
                "token":"synthetic-smoke-only","transport":"direct","lastUsedAt":1,
                "authorizationID":"synthetic-authorization"
            }]}).to_string().into_bytes()))
        }
        fn write(&self, _: &[u8]) -> Result<()> {
            Err("synthetic_vault_is_read_only".into())
        }
    }
    struct Task;
    impl FetchTask for Task {
        fn send(&mut self, _: Vec<u8>) {}
        fn finish(&mut self) {}
        fn pause(&mut self, _: bool) {}
        fn cancel(self: Box<Self>) {}
    }
    #[derive(Default)]
    struct Fixtures {
        known: AtomicUsize,
        unknown: AtomicUsize,
    }
    fn fixture(path: &str) -> Option<(&'static str, Vec<u8>)> {
        let body = match path {
            "/api/config/settings" => {
                json!({"projects":[{"id":"synthetic-project","name":"Synthetic workspace","path":"/synthetic/workspace"}],"themeMode":"dark","themeId":"jetbrains-dark","lightThemeId":"jetbrains-light","darkThemeId":"jetbrains-dark"})
            }
            "/api/config/themes" => json!({"themes":[]}),
            "/api/yuri/session-index" => {
                json!({"available":true,"directories":[{"directory":"/synthetic/workspace","sessions":[{"id":"ses_synthetic","title":"Synthetic native conversation","time":{"updated":2}}]}]})
            }
            "/api/yuri/assistants/snapshot" => json!({"assistants":[]}),
            "/api/yuri/scheduled-tasks" => json!({"tasks":[],"failedProjectIds":[]}),
            "/api/session/active" => json!({"data":{}}),
            "/api/permission/request" | "/api/experimental/form" => json!({"data":[]}),
            "/api/fs/stat?path=%2Fsynthetic%2Fsource.md" => {
                json!({"isFile":true,"isBinary":false,"size":15})
            }
            "/api/fs/read?path=%2Fsynthetic%2Fsource.md" => {
                return Some(("text/plain", b"Synthetic text\n".to_vec()));
            }
            _ => return None,
        };
        Some(("application/json", body.to_string().into_bytes()))
    }
    impl Network for Fixtures {
        fn fetch(
            &self,
            request: HttpRequest,
            mut events: nsh_engine::FetchEvents,
        ) -> Box<dyn FetchTask> {
            // There is deliberately no real Network, DNS, socket or fallback in this executable.
            let admitted = request.method == "GET"
                && !request.follow_redirects
                && request.headers.iter().any(|(k, v)| {
                    k.eq_ignore_ascii_case("authorization") && v == "Bearer synthetic-smoke-only"
                });
            let path = request
                .url
                .strip_prefix(ORIGIN)
                .filter(|path| path.starts_with('/'));
            let response = if admitted {
                path.and_then(fixture)
            } else {
                None
            };
            let (status, mime, body) = match response {
                Some((mime, body)) => {
                    self.known.fetch_add(1, Ordering::Relaxed);
                    (200, mime, body)
                }
                None if admitted && path == Some("/api/yuri/events") => {
                    self.known.fetch_add(1, Ordering::Relaxed);
                    events(FetchEvent::Head(HttpHead {
                        status: 200,
                        url: request.url,
                        headers: vec![("Content-Type".into(), "text/event-stream".into())],
                        ..Default::default()
                    }));
                    return Box::new(Task);
                }
                None => {
                    self.unknown.fetch_add(1, Ordering::Relaxed);
                    (
                        501,
                        "application/json",
                        br#"{"error":"synthetic_fixture_unsupported"}"#.to_vec(),
                    )
                }
            };
            events(FetchEvent::Head(HttpHead {
                status,
                url: request.url,
                headers: vec![("Content-Type".into(), mime.into())],
                ..Default::default()
            }));
            events(FetchEvent::Data(body));
            events(FetchEvent::End);
            Box::new(Task)
        }
    }
    fn capture(view: &platform::AppView, path: &Path) -> Result<()> {
        use foundation::NSDictionary;
        use kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
        let view = view.view();
        view.displayIfNeeded();
        let bounds = view.bounds();
        let bitmap = view
            .bitmapImageRepForCachingDisplayInRect(bounds)
            .ok_or("smoke_bitmap_failed")?;
        view.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
        let properties =
            NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new();
        // SAFETY: PNG encoding accepts an empty property dictionary. All work is on AppKit's main thread.
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or("smoke_png_failed")?
        .to_vec();
        if png.len() > 32 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("smoke_png_invalid".into());
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "smoke_output_exists_or_unwritable")?
            .write_all(&png)
            .map_err(|_| "smoke_output_failed")?;
        Ok(())
    }
    fn close_smoke(state_dir: PathBuf) -> Result<ExitCode> {
        let host = HostChannel::default();
        let stage = Arc::new(AtomicUsize::new(0));
        let progress = stage.clone();
        let caps = json!({"network":{"hosts":[],"http":[]},"fs":{"read":[],"write":[]},"process":{"execute":[],"exit":false,"env":[]},"host":["smoke.progress","desktop.window.closeDecision","connection.list","appearance.reset","appearance.apply","resources.read","resources.close","resources.cancel","resources.release"]});
        let (port, inbox) = native_ui::channel();
        let _owner = bridge::install_configured(
            &host,
            &caps,
            Box::new(SyntheticVault),
            Arc::new(Fixtures::default()),
            false,
            appearance::metadata(&Value::Null),
            port,
        )?;
        host.handle("smoke.progress", move |mut call| {
            let value = call.take_data();
            progress.store(
                value["stage"].as_u64().unwrap_or(100) as usize,
                Ordering::Release,
            );
        });
        let source = r#"import {host} from 'nsh';
          let first=null, count=0;
          const check=(value)=>{if(!value)throw Error('synthetic close assertion');};
          host.on('desktop.window.closeRequested',event=>{
            (async()=>{
              count++;
              check(typeof event.windowID==='string'&&event.windowID.length>0);
              if(count===1){
                first=event;check(event.reason==='close');
                let invalid=false;try{await host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:'true'});}catch{invalid=true;}check(invalid);
                check(await host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:false})===true);
                let duplicate=false;try{await host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:true});}catch{duplicate=true;}check(duplicate);
                host.post('smoke.progress',{stage:2});
              }else if(count===2){
                check(event.reason==='quit'&&event.windowID===first.windowID&&event.generation>first.generation&&event.ticket!==first.ticket);
                let stale=false;try{await host.call('desktop.window.closeDecision',{ticket:first.ticket,approved:true});}catch{stale=true;}check(stale);
                host.post('smoke.progress',{stage:3});
                await host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:true});
              }else throw Error('unexpected close request');
            })().catch(()=>host.post('smoke.progress',{stage:100}));
          });
          (async()=>{
            const saved=await host.call('connection.list',{});
            const reset=await host.call('appearance.reset',{hostID:saved.selected});
            const appearance=__APPEARANCE_FIXTURE__;appearance.revision=reset.revision;
            const applied=await host.call('appearance.apply',appearance);
            check(typeof applied.uiFontFamily==='string'&&typeof applied.monoFontFamily==='string');
            const read=await host.call('resources.read',{path:'/synthetic/source.md',requestId:'close-smoke-resource',expectedHost:saved.runtimeScope});
            check(read.kind==='text'&&read.text==='Synthetic text\n'&&read.size===15&&typeof read.lease==='string');
            await host.call('resources.close',{lease:read.lease});
            await host.call('resources.cancel',{requestId:'close-smoke-resource'});
            await host.call('resources.release',{lease:read.lease});
            host.post('smoke.progress',{stage:1});
          })().catch(()=>host.post('smoke.progress',{stage:100}));"#;
        let source = source.replace(
            "__APPEARANCE_FIXTURE__",
            include_str!("../fixtures/appearance.json"),
        );
        let bundle = Bundle::source(source)
            .with_app_id(Some("com.yee94.yuri.nsh.synthetic-close"))
            .with_capabilities_json(Some(&caps.to_string()))?;
        fs::create_dir(&state_dir).map_err(|_| "smoke_state_create_failed")?;
        let started = Instant::now();
        let mut requested = 0;
        let observed = stage.clone();
        let components = platform::Components::default();
        _owner
            .services()
            .install_tabs(crate::desktop_tab::register(&components)?)?;
        let code = native_ui::run_observed(
            platform::AppSource::Bundle(bundle),
            platform::AppOptions {
                app_id: "com.yee94.yuri.nsh.synthetic-close".into(),
                title: "Synthetic native close admission".into(),
                size: (480, 320),
                data_dir: Some(state_dir),
                cache: CacheOptions::off(),
                host,
                components,
                ..Default::default()
            },
            inbox,
            _owner.services(),
            native_ui::Dialogs::default(),
            move |view, _| {
                let stage = observed.load(Ordering::Acquire);
                if stage == 100 || started.elapsed() > Duration::from_secs(10) {
                    return Some(ExitCode::FAILURE);
                }
                if stage == 1 && requested == 0 {
                    requested = 1;
                    if let Some(window) = view.view().window() {
                        window.performClose(None);
                    }
                } else if stage == 2 && requested == 1 {
                    requested = 2;
                    let mtm = objc2::MainThreadMarker::new().expect("native observer main thread");
                    kit::NSApplication::sharedApplication(mtm).terminate(None);
                }
                None
            },
        );
        if code != ExitCode::SUCCESS || stage.load(Ordering::Acquire) != 3 {
            return Err("smoke_close_admission_failed".into());
        }
        println!(
            "synthetic_close: native appearance reset/apply and authenticated text resource passed; real performClose rejected, invalid/duplicate/stale rejected, retry terminate approved and native loop exited"
        );
        Ok(code)
    }
    /// Opt-in physical-window harness. Never run by cargo test or while the UI gate is locked.
    fn two_windows(state_dir: PathBuf) -> Result<ExitCode> {
        use nsh_core::storage::StorageChange;
        use std::{collections::BTreeMap, sync::Mutex};
        #[derive(Default)]
        struct Memory(Mutex<BTreeMap<String, String>>);
        impl nsh_engine::StorageBackend for Memory {
            fn load(&self) -> Result<BTreeMap<String, String>> {
                Ok(self.0.lock().unwrap().clone())
            }
            fn write(&self, change: StorageChange) {
                let mut values = self.0.lock().unwrap();
                match change {
                    StorageChange::Set(k, v) => {
                        values.insert(k, v);
                    }
                    StorageChange::Remove(k) => {
                        values.remove(&k);
                    }
                    StorageChange::Clear => values.clear(),
                }
            }
        }
        fs::create_dir(&state_dir).map_err(|_| "smoke_state_create_failed")?;
        let mut windows = Vec::new();
        let mut progress = Vec::new();
        let mut service_ports = Vec::new();
        let mut hosts = Vec::new();
        let caps = json!({"network":{"hosts":[],"http":[]},"fs":{"read":[],"write":[]},"process":{"execute":[],"exit":false,"env":[]},"host":["connection.list","desktop.window.closeDecision","smoke.progress"]});
        for index in 0..2 {
            let key = format!("synthetic-main-{index}");
            let host = HostChannel::default();
            let (port, inbox) = native_ui::channel();
            let owner = bridge::install_configured(
                &host,
                &caps,
                Box::new(SyntheticVault),
                Arc::new(Fixtures::default()),
                false,
                appearance::metadata(&Value::Null),
                port,
            )?;
            let stage = Arc::new(AtomicUsize::new(0));
            let publishing = stage.clone();
            let expected_key = key.clone();
            host.handle("smoke.progress", move |mut call| {
                let value = call.take_data();
                let valid = value["key"] == expected_key;
                publishing.store(
                    if valid {
                        value["stage"].as_u64().unwrap_or(100) as usize
                    } else {
                        100
                    },
                    Ordering::Release,
                );
            });
            let bundle = Bundle::source(r#"import {host} from 'nsh';
              let count=0;
              const progress=stage=>host.post('smoke.progress',{stage,key:host.params.windowKey});
              host.on('smoke.ping',()=>{count++;progress(count===1?2:100);});
              host.on('desktop.window.closeRequested',event=>{void host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:true});});
              (async()=>{const state=await host.call('connection.list',{});progress(state.selected==='synthetic-host'?1:100);})().catch(()=>progress(100));"#.into())
                .with_app_id(Some("com.yee94.yuri.nsh.synthetic-two-windows"))
                .with_capabilities_json(Some(&caps.to_string()))?;
            service_ports.push(owner.services());
            progress.push(stage);
            hosts.push(host.clone());
            windows.push(native_ui::Window {
                window_key: key.clone(),
                source: platform::AppSource::Bundle(bundle),
                options: platform::AppOptions {
                    app_id: "com.yee94.yuri.nsh.synthetic-two-windows".into(),
                    title: format!("Synthetic main window {index}"),
                    size: (480, 320),
                    host,
                    storage: Some(Arc::new(Memory::default())),
                    data_dir: Some(state_dir.join(&key)),
                    cache: CacheOptions::off(),
                    ..Default::default()
                },
                inbox,
                services: owner.services(),
                dialogs: native_ui::Dialogs::default(),
                lifetime: Some(owner),
                persistence: None,
                restored: None,
            });
        }
        let result_progress = progress.clone();
        let started = Instant::now();
        let mut step = 0;
        let code = native_ui::run_windows_observed(windows, move |index, view, _| {
            if started.elapsed() > Duration::from_secs(15)
                || progress.iter().any(|p| p.load(Ordering::Acquire) == 100)
            {
                return Some(ExitCode::FAILURE);
            }
            if step == 0 && index == 0 && progress.iter().all(|p| p.load(Ordering::Acquire) == 1) {
                step = 1;
                if let Some(window) = view.view().window() {
                    window.performClose(None);
                }
            } else if step == 1 && index == 1 && !service_ports[0].live() && service_ports[1].live()
            {
                step = 2;
                let _ = hosts[1].send("smoke.ping", json!({}));
            } else if step == 2 && index == 1 && progress[1].load(Ordering::Acquire) == 2 {
                step = 3;
                let mtm = objc2::MainThreadMarker::new().expect("native observer main thread");
                kit::NSApplication::sharedApplication(mtm).terminate(None);
            }
            None
        });
        if code != ExitCode::SUCCESS || result_progress[1].load(Ordering::Acquire) != 2 {
            return Err("smoke_two_windows_failed".into());
        }
        println!(
            "synthetic_two_windows: separate AppView/Engine/HostChannel; close first, second receives exact ping, then approved Quit; read-only synthetic runtime only, not independent production authority"
        );
        Ok(code)
    }
    pub fn run() -> Result<ExitCode> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.len() == 2 && args[0] == "--two-windows" {
            return two_windows(PathBuf::from(&args[1]));
        }
        if args.len() == 2 && args[0] == "--close-admission" {
            return close_smoke(PathBuf::from(&args[1]));
        }
        if args.len() != 4 || args[0] != "--bundle" || args[2] != "--screenshot" {
            return Err(
                "usage: synthetic_smoke --bundle path/bundle.js --screenshot new/path.png".into(),
            );
        }
        let path = PathBuf::from(&args[1])
            .canonicalize()
            .map_err(|_| "smoke_bundle_missing")?;
        let root = path.parent().ok_or("smoke_bundle_missing")?;
        let screenshot = PathBuf::from(&args[3]);
        if screenshot.exists() {
            return Err("smoke_output_exists_or_unwritable".into());
        }
        let mut caps: Value = serde_json::from_slice(
            &fs::read(root.join("capabilities.json")).map_err(|_| "smoke_capabilities_missing")?,
        )
        .map_err(|_| "smoke_capabilities_invalid")?;
        // AppView's internal JS network cannot be injected in NSH 0.4. Deny it (and all native
        // file/process/external-app paths); only the production Rust bridge receives our Fixtures.
        caps["network"] = json!({"hosts":[],"http":[]});
        caps["fs"] = json!({"read":[],"write":[]});
        caps["process"] = json!({"execute":[],"exit":false,"env":[]});
        caps["openUrl"] = json!({"schemes":[]});
        for name in ["clipboard", "picker", "speech", "statusBar"] {
            caps[name] = json!(false);
        }
        let bundle = Bundle::read(&path)
            .map_err(|_| "smoke_bundle_invalid")?
            .with_app_id(Some(APP_ID))
            .with_capabilities_json(Some(&caps.to_string()))?;
        let host = HostChannel::default();
        let (port, inbox) = native_ui::channel();
        let fixtures = Arc::new(Fixtures::default());
        let _owner = bridge::install_configured(
            &host,
            &caps,
            Box::new(SyntheticVault),
            fixtures.clone(),
            false,
            appearance::metadata(&Value::Null),
            port,
        )?;
        // A new data root, not just AppOptions.app_id: Bundle.app_id owns NSH Storage's namespace.
        let state_dir = screenshot
            .parent()
            .ok_or("smoke_output_invalid")?
            .join(format!("synthetic-state-{}", vault::id()?));
        fs::create_dir(&state_dir).map_err(|_| "smoke_state_create_failed")?;
        let started = Instant::now();
        let mut activated = false;
        let mut ready_since = None;
        let captured = std::rc::Rc::new(std::cell::Cell::new(false));
        let capture_flag = captured.clone();
        let components = platform::Components::default();
        _owner
            .services()
            .install_tabs(crate::desktop_tab::register(&components)?)?;
        let code = native_ui::run_observed(
            platform::AppSource::Bundle(bundle),
            platform::AppOptions {
                app_id: APP_ID.into(),
                title: "Yuri Native — synthetic-only smoke".into(),
                size: (1280, 860),
                asset_base: Some(platform::AssetBase::Directory(root.join("assets"))),
                data_dir: Some(state_dir),
                cache: CacheOptions::off(),
                host,
                components,
                ..Default::default()
            },
            inbox,
            _owner.services(),
            native_ui::Dialogs::default(),
            move |view, applied| {
                if !activated {
                    activated = true;
                    let mtm = objc2::MainThreadMarker::new().expect("native observer main thread");
                    // Same OS activation request as NSH's native test agent; no synthetic JS lifecycle.
                    #[allow(deprecated)]
                    kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
                }
                if !applied {
                    ready_since = None;
                }
                if applied
                    && ready_since.get_or_insert_with(Instant::now).elapsed()
                        >= Duration::from_secs(1)
                {
                    match capture(view, &screenshot) {
                        Ok(()) => {
                            capture_flag.set(true);
                            println!(
                                "synthetic_smoke: captured; native appearance applied; fixture responses={}; unsupported responses={}",
                                fixtures.known.load(Ordering::Relaxed),
                                fixtures.unknown.load(Ordering::Relaxed)
                            );
                            return Some(ExitCode::SUCCESS);
                        }
                        Err(error) => {
                            eprintln!("synthetic_smoke: {error}");
                            return Some(ExitCode::FAILURE);
                        }
                    }
                }
                if started.elapsed() >= Duration::from_secs(15) {
                    eprintln!(
                        "synthetic_smoke: timed out waiting for real native appearance apply; fixture responses={}; unsupported responses={}",
                        fixtures.known.load(Ordering::Relaxed),
                        fixtures.unknown.load(Ordering::Relaxed)
                    );
                    let mtm = objc2::MainThreadMarker::new().expect("native observer main thread");
                    let app = kit::NSApplication::sharedApplication(mtm);
                    eprintln!(
                        "synthetic_smoke: native active={} running={} visible={}",
                        app.isActive(),
                        app.isRunning(),
                        app.occlusionState()
                            .contains(kit::NSApplicationOcclusionState::Visible)
                    );
                    let _ = capture(view, &screenshot.with_extension("timeout.png"));
                    return Some(ExitCode::FAILURE);
                }
                None
            },
        );
        if !captured.get() {
            return Err("smoke_no_capture".into());
        }
        Ok(code)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn fixed_resources_and_unknown_routes_never_become_empty_success() {
            assert_eq!(
                fixture("/api/fs/read?path=%2Fsynthetic%2Fsource.md")
                    .unwrap()
                    .1,
                b"Synthetic text\n"
            );
            assert!(fixture("/api/fs/read?path=%2Fetc%2Fpasswd").is_none());
            assert!(fixture("/api/unknown").is_none());
        }
    }
}

fn main() -> std::process::ExitCode {
    #[cfg(target_os = "macos")]
    match smoke::run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("synthetic_smoke: {error}");
            std::process::ExitCode::FAILURE
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("synthetic_smoke requires macOS AppKit");
        std::process::ExitCode::FAILURE
    }
}
