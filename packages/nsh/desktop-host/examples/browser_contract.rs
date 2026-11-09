//! Compile/test the independent browser without the concurrently edited runner entrypoints.
#![allow(dead_code)]
#[path = "../src/browser_view.rs"]
mod browser_view;
#[path = "../src/policy.rs"]
mod policy;
fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args().any(|a| a == "--native") {
        native::run();
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use nsh_engine::{
        Bundle, CacheOptions, FetchEvent, FetchEvents, FetchTask, HttpHead, HttpRequest, Network,
    };
    use nsh_platform_macos::{
        self as p,
        objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel},
        objc2_app_kit::*,
        objc2_foundation::*,
    };
    use serde_json::json;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };
    struct Task;
    thread_local! { static TICK: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) }; }
    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        struct Timer;
        unsafe impl NSObjectProtocol for Timer {}
        impl Timer { #[unsafe(method(tick:))] fn tick(&self, _: &NSTimer) { TICK.with(|f| { if let Some(f) = f.borrow_mut().as_mut() { f(); } }); } }
    );
    impl FetchTask for Task {
        fn send(&mut self, _: Vec<u8>) {}
        fn finish(&mut self) {}
        fn pause(&mut self, _: bool) {}
        fn cancel(self: Box<Self>) {}
    }
    struct Fixture(Arc<AtomicUsize>);
    impl Network for Fixture {
        fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
            assert!(request.url.starts_with("https://synthetic.invalid/api/fs/"));
            assert!(!request.follow_redirects);
            assert!(
                request
                    .headers
                    .iter()
                    .any(|(k, v)| k == "Authorization" && v == "Bearer synthetic-only")
            );
            self.0.fetch_add(1, Ordering::SeqCst);
            let (mime, body) = if request.url.contains("/stat?") {
                (
                    "application/json",
                    json!({"isFile":true,"size":200}).to_string(),
                )
            } else if request.url.ends_with(".css") {
                ("text/css", "body { font-size: 22px; }".into())
            } else {
                ("text/html","<!doctype html><link rel=stylesheet href=style.css><h1>Native WKWebView fixture</h1><a href=second.html>Second page</a><script>if(window.nsh||window.webkit?.messageHandlers?.runtime)throw Error('unexpected bridge');</script>".into())
            };
            events(FetchEvent::Head(HttpHead {
                status: 200,
                url: request.url,
                headers: vec![("Content-Type".into(), mime.into())],
                ..Default::default()
            }));
            events(FetchEvent::Data(body.into_bytes()));
            events(FetchEvent::End);
            Box::new(Task)
        }
    }
    pub fn run() {
        let mtm = MainThreadMarker::new().expect("main thread");
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        let reads = Arc::new(AtomicUsize::new(0));
        let port = browser_view::Port::new(Arc::new(Fixture(reads.clone())));
        let scope =
            json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000001"});
        port.authorize(&scope, "https://synthetic.invalid", "synthetic-only", false)
            .unwrap();
        let host = nsh_engine::HostChannel::default();
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = phases.clone();
        host.handle("fixture.event", move |mut call| {
            let value = call.take_data();
            sink.lock().unwrap().push(value);
        });
        let view = p::AppView::new(
            mtm,
            p::AppOptions {
                app_id: "example.yuri.native-browser-fixture".into(),
                size: (640, 360),
                cache: CacheOptions::off(),
                host,
                ..Default::default()
            },
        );
        let mut pump = browser_view::macos::register(&view, port.clone(), mtm);
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(640., 360.)),
                NSWindowStyleMask::Titled,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setContentView(Some(&view.view()));
        window.makeKeyAndOrderFront(None);
        let source = format!(
            r#"import {{mount,nativeComponent,host}} from 'nsh';
          const Browser=nativeComponent('yuri.desktop.browser',{{props:['binding'],events:['browser']}});
          mount(()=>Browser({{binding:{{owner:'synthetic-native-browser',expectedHost:{scope},generation:1,active:true,intent:{{kind:'html',directory:'/work',path:'/work/index.html'}}}},onBrowser:value=>host.post('fixture.event',value),style:{{flex:1}}}}));"#
        );
        let bundle = Bundle::source(source)
            .with_capabilities_json(Some(r#"{"host":["fixture.event"]}"#))
            .unwrap();
        view.load(p::App::Js(bundle));
        let started = Instant::now();
        let success = std::rc::Rc::new(std::cell::Cell::new(false));
        let succeeded = success.clone();
        let events = phases.clone();
        let running = app.clone();
        let authority = port.clone();
        TICK.with(|f| *f.borrow_mut()=Some(Box::new(move || {
            pump.poll();
            let events=events.lock().unwrap();
            let ready=events.iter().any(|v|v["phase"]=="ready")&&reads.load(Ordering::SeqCst)>=3;
            if ready || events.iter().any(|v|v["phase"]=="failed") || started.elapsed()>Duration::from_secs(15){
                succeeded.set(ready);authority.invalidate();drop(events);pump.poll();running.stop(None);
                if let Some(event)=NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(NSEventType::ApplicationDefined,NSPoint::new(0.,0.),NSEventModifierFlags::empty(),0.,0,None,0,0,0){running.postEvent_atStart(&event,true);}
            }
        })));
        let target: Retained<Timer> = unsafe { msg_send![Timer::alloc(mtm), init] };
        let timer = unsafe {
            NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
                0.016,
                &target,
                sel!(tick:),
                None,
                true,
            )
        };
        unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
        app.run();
        timer.invalidate();
        TICK.with(|f| *f.borrow_mut() = None);
        assert!(
            success.get(),
            "native load did not complete; synthetic phases: {:?}",
            phases.lock().unwrap()
        );
        assert!(
            phases
                .lock()
                .unwrap()
                .iter()
                .all(|v| !v.to_string().contains("synthetic-only"))
        );
        view.stop();
        window.close();
        println!(
            "browser_native: real WKWebView HTML + CSS via captured synthetic Host, ready event, invalidation; no Vault, real Host or app JS bridge"
        );
    }
}
