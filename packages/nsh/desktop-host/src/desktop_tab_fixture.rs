//! Real QuickJS + platform Components, but no NSWindow, Vault, network, user
//! storage, event monitor or physical mouse. Synthetic Rust inputs only.
use crate::desktop_tab::{self, NativeInput, Point};
use nsh_platform_macos::{
    self as platform,
    objc2::{self, MainThreadMarker, Message},
    objc2_app_kit::{NSApplication, NSView},
    objc2_foundation::{NSDate, NSRunLoop},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

struct SyntheticData(PathBuf);
impl Drop for SyntheticData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn pump(until: Instant) {
    while Instant::now() < until {
        objc2::rc::autoreleasepool(|_| {
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
        });
    }
}
fn zero_views(view: &NSView) -> usize {
    let mut count = 0;
    if view.class().name().to_string_lossy() == "YuriDesktopTabZeroView" {
        assert_eq!(view.frame().size.width, 0.);
        assert_eq!(view.frame().size.height, 0.);
        count += 1;
    }
    for child in view.subviews().iter() {
        count += zero_views(&child);
    }
    count
}
pub fn run() -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("fixture_main_thread_required")?;
    let _app = NSApplication::sharedApplication(mtm);
    let data_path =
        std::env::temp_dir().join(format!("yuri-desktop-tab-contract-{}", std::process::id()));
    std::fs::create_dir(&data_path).map_err(|e| e.to_string())?;
    let data = SyntheticData(data_path);
    let components = platform::Components::default();
    let registration = desktop_tab::register(&components)?;
    let scope = json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"});
    registration.set_scope(Some(&scope))?;
    let host = nsh_engine::HostChannel::default();
    let (tx, rx) = mpsc::channel();
    host.handle("desktop.tab.fixture.result", move |mut call| {
        let _ = tx.send(call.take_data());
        call.resolve(Value::Bool(true));
    });
    let script = r#"
      import {mount,nativeComponent,host,signal} from 'nsh';
      const Events=nativeComponent('yuri.desktop.tab-events',{props:['binding'],events:['middleClose','tabFocus','tabBlur']});
      const active=signal(true);
      const binding=()=>({owner:'fixture-owner',generation:1,revision:1,expectedHost:{hostID:'synthetic',lease:'00000000-0000-4000-8000-000000000001'},rect:{x:10,y:10,width:60,height:24},active:active()});
      host.on('desktop.tab.fixture.disable',()=>active.set(false));
      host.on('desktop.tab.fixture.enable',()=>active.set(true));
      const report=(kind,event)=>host.post('desktop.tab.fixture.result',{kind,event});
      mount(()=>Events({get binding(){return binding()},ref:node=>node.command('middleClose',{}),style:{width:0,height:0,pointerEvents:'none'},onMiddleClose:e=>report('middleClose',e),onTabFocus:e=>report('tabFocus',e),onTabBlur:e=>report('tabBlur',e)}));
    "#;
    let mut bundle = nsh_engine::Bundle::source(script.to_owned());
    bundle.policy.declared = Some(
        nsh_core::access::Capabilities::from_json(&json!({"host":true}))
            .map_err(|e| e.to_string())?,
    );
    let view = platform::AppView::new(
        mtm,
        platform::AppOptions {
            host: host.clone(),
            components,
            app_id: "example.synthetic-tabs".into(),
            data_dir: Some(data.0.clone()),
            cache: nsh_engine::CacheOptions::off(),
            ..Default::default()
        },
    );
    view.load(platform::App::Js(bundle));
    pump(Instant::now() + Duration::from_millis(500));
    assert_eq!(
        zero_views(&view.view()),
        1,
        "actual Components must create exactly one zero-area NSView"
    );
    registration.gate(true, false); // Deliberate synthetic window state, not an observer/foreground assertion.
    let point = Point { x: 20., y: 20. };
    registration.observe(NativeInput::MiddleDown(point), false);
    registration.observe(NativeInput::MiddleUp(point), false);
    registration.observe(NativeInput::MiddleUp(point), false);
    registration.observe(NativeInput::LeftDown(point), true);
    registration.observe(NativeInput::Blur, true);
    pump(Instant::now() + Duration::from_millis(300));
    let events: Vec<_> = rx.try_iter().collect();
    assert_eq!(
        events
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["middleClose", "tabFocus", "tabBlur"]
    );
    for event in &events {
        assert_eq!(event["event"]["owner"], "fixture-owner");
        assert_eq!(event["event"]["expectedHost"], scope);
        assert!(event["event"].get("id").is_none());
    }
    host.send("desktop.tab.fixture.disable", Value::Null)
        .map_err(|e| e.to_string())?;
    pump(Instant::now() + Duration::from_millis(100));
    registration.observe(NativeInput::MiddleDown(point), false);
    registration.observe(NativeInput::MiddleUp(point), false);
    pump(Instant::now() + Duration::from_millis(100));
    assert!(rx.try_recv().is_err());
    registration.set_scope(None)?;
    registration.set_scope(Some(&scope))?;
    host.send("desktop.tab.fixture.enable", Value::Null)
        .map_err(|e| e.to_string())?;
    pump(Instant::now() + Duration::from_millis(100));
    registration.observe(NativeInput::MiddleDown(point), false);
    registration.observe(NativeInput::MiddleUp(point), false);
    pump(Instant::now() + Duration::from_millis(100));
    assert!(rx.try_recv().is_err());
    view.stop();
    println!(
        "desktop tab fixture: real QuickJS/Components; 0x0 view, middle down/up once, focus/blur, inactive and retirement passed; no physical UI"
    );
    Ok(())
}
