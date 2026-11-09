//! Explicit synthetic native renderer test carrier. It never installs runtime,
//! connection or credential handlers and can never create a real PTY.
#![cfg(target_os = "macos")]
use crate::terminal_viewport;
use foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRange, NSRect, NSSize};
use kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEventMask, NSView,
    NSWindow, NSWindowStyleMask,
};
use nsh_platform_macos::{
    self as platform, objc2, objc2_app_kit as kit, objc2_foundation as foundation,
};
use objc2::{MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::Bool};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};

fn find_web(view: &NSView) -> Option<Retained<NSView>> {
    if view.class().name().to_string_lossy().contains("WKWebView") {
        return Some(view.retain());
    }
    for child in view.subviews().iter() {
        if let Some(value) = find_web(&child) {
            return Some(value);
        }
    }
    None
}
fn tree(view: &NSView) -> String {
    format!(
        "{}[{}]",
        view.class().name().to_string_lossy(),
        view.subviews()
            .iter()
            .map(|v| tree(&v))
            .collect::<Vec<_>>()
            .join(",")
    )
}
pub fn run(path: &Path) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("fixture_main_thread_required")?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let components = platform::Components::default();
    let registration = terminal_viewport::register(&components)?;
    registration.set_scope(Some(
        &json!({"hostID":"synthetic-host","lease":"00000000-0000-4000-8000-000000000007"}),
    ))?;
    let host = nsh_engine::HostChannel::default();
    let (tx, rx) = mpsc::channel();
    host.handle("terminal.fixture.event", move |mut call| {
        let _ = tx.send(call.take_data());
        call.resolve(Value::Bool(true));
    });
    let test_host = host.clone();
    let options = platform::AppOptions {
        app_id: "example.yuri.synthetic-terminal".into(),
        host,
        components,
        ..Default::default()
    };
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(800.0, 400.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let view = platform::AppView::new(mtm, options);
    window.setContentView(Some(&view.view()));
    view.load(platform::App::Js(
        nsh_engine::Bundle::read(path).map_err(|_| "fixture_bundle_invalid")?,
    ));
    window.makeKeyAndOrderFront(None);
    app.finishLaunching();
    app.activate();
    let start = Instant::now();
    let mut ack = false;
    let mut typed = false;
    let mut input = false;
    let mut resize = false;
    let mut cols = 0;
    let mut focus_debug = String::new();
    let result = (|| {
        while start.elapsed() < Duration::from_secs(25) {
            objc2::rc::autoreleasepool(|_| {
                while let Ok(value) = rx.try_recv() {
                    if value["type"] == "error" {
                        return Err(format!("native renderer failed: {}", value["code"]));
                    }
                    if value["type"] == "ack" && value["cursor"] == 2 && value["serial"] == 1 {
                        ack = true;
                    }
                    if value["type"] == "resize" && value["key"] == "synthetic-tab" {
                        if cols == 0 {
                            cols = value["cols"].as_u64().unwrap_or(0);
                        } else if value["cols"].as_u64() != Some(cols) {
                            resize = true;
                        }
                    }
                    if value["type"] == "input"
                        && value["data"] == "SYNTHETIC_INPUT"
                        && value["receipt"].as_u64().is_some_and(|v| v > 0)
                    {
                        input = true;
                    }
                }
                if ack && !typed {
                    focus_debug = tree(&view.view());
                    if let Some(web) = find_web(&view.view()) {
                        focus_debug = format!(
                            "first={:?}, key={}, hidden={}, attached={}",
                            window.firstResponder().map(|v| v
                                .class()
                                .name()
                                .to_string_lossy()
                                .into_owned()),
                            window.isKeyWindow(),
                            web.isHidden(),
                            web.window().is_some()
                        );
                        if let Some(first) = window
                            .firstResponder()
                            .and_then(|v| v.downcast::<NSView>().ok())
                        {
                            let focused: Bool = unsafe { msg_send![&first,isDescendantOf:&*web] };
                            if focused.as_bool() {
                                let _: () = unsafe {
                                    msg_send![&first,insertText:&*foundation::NSString::from_str("SYNTHETIC_INPUT"),replacementRange:NSRange::new(usize::MAX,0)]
                                };
                                typed = true;
                                let _ =
                                    test_host.send("terminal.fixture.resize", Value::Bool(true));
                            }
                        }
                    }
                }
                let until = NSDate::dateWithTimeIntervalSinceNow(0.02);
                if let Some(event) = unsafe {
                    app.nextEventMatchingMask_untilDate_inMode_dequeue(
                        NSEventMask::Any,
                        Some(&until),
                        NSDefaultRunLoopMode,
                        true,
                    )
                } {
                    app.sendEvent(&event);
                }
                app.updateWindows();
                Ok::<(), String>(())
            })?;
            if ack && input && resize {
                return Ok(());
            }
        }
        Err(format!(
            "native renderer deadline: ack={ack}, nativeFocus={typed}, inputReceipt={input}, resize={resize}, cols={cols}, {focus_debug}"
        ))
    })();
    registration.set_scope(None)?;
    view.stop();
    window.close();
    result
}
