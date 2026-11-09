//! The main-thread AppView is the sole native appearance owner. No JS event fallback.
use crate::appearance::{Inbox, Port};
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;
use std::process::ExitCode;

/// Fully assembled, distinct per-window native owners. The caller retains bridge Owners.
pub(crate) struct Window {
    pub window_key: String,
    pub source: platform::AppSource,
    pub options: platform::AppOptions,
    pub inbox: Option<Inbox>,
    pub services: crate::host_services::Port,
    pub dialogs: Dialogs,
    pub lifetime: Option<crate::bridge::Owner>,
    pub persistence: Option<crate::window_persistence::Port>,
    pub restored: Option<crate::window_state::MainWindow>,
}
pub(crate) type WindowFactory = Box<dyn FnMut() -> crate::policy::Result<Window>>;

fn validate_windows(windows: &[Window]) -> crate::policy::Result<()> {
    use std::collections::HashSet;
    if windows.is_empty() || windows.len() > crate::window_state::MAX_WINDOWS {
        return Err("window_capacity".into());
    }
    let mut keys = HashSet::new();
    let mut owners = HashSet::new();
    if let Some(port) = &windows[0].persistence {
        if windows.iter().any(|w| {
            w.persistence
                .as_ref()
                .is_none_or(|other| !port.same_lane(other))
        }) {
            return Err("window_state_lane_shared_required".into());
        }
    } else if windows.iter().any(|w| w.persistence.is_some()) {
        return Err("window_state_lane_shared_required".into());
    }
    for window in windows {
        if window.window_key.is_empty()
            || window.window_key.len() > 128
            || !window
                .window_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
            || !keys.insert(&window.window_key)
            || !owners.insert(window.services.window_id()?)
        {
            return Err("window_identity_invalid".into());
        }
        if windows.len() > 1 && window.options.storage.is_none() {
            return Err("window_metadata_namespace_required".into());
        }
        let mut params = window.options.host.params();
        params.insert("windowKey".into(), serde_json::json!(window.window_key));
        params.insert("windowKind".into(), serde_json::json!("main"));
        params.insert(
            "windowCoordination".into(),
            serde_json::json!(if windows.len() > 1 {
                "multi-engine"
            } else {
                window
                    .lifetime
                    .as_ref()
                    .map_or("single-engine", |owner| owner.window_coordination())
            }),
        );
        window.options.host.set_params(params);
    }
    for (index, window) in windows.iter().enumerate() {
        if window
            .options
            .host
            .params()
            .get("windowKey")
            .and_then(serde_json::Value::as_str)
            != Some(&window.window_key)
            || window
                .options
                .host
                .params()
                .get("windowKind")
                .and_then(serde_json::Value::as_str)
                != Some("main")
        {
            return Err("window_channel_shared".into());
        }
        if let Some(storage) = &window.options.storage
            && windows[..index].iter().any(|other| {
                other
                    .options
                    .storage
                    .as_ref()
                    .is_some_and(|other| std::sync::Arc::ptr_eq(storage, other))
            })
        {
            return Err("window_metadata_namespace_shared".into());
        }
    }
    Ok(())
}

pub(crate) fn run_factory(
    process: std::rc::Rc<std::cell::RefCell<crate::bridge::process::Process>>,
    mut factory: WindowFactory,
) -> crate::policy::Result<ExitCode> {
    let window = factory()?;
    #[cfg(target_os = "macos")]
    {
        Ok(macos::run_windows(
            vec![window],
            |_, _, _| None,
            Some(factory),
            Some(crate::bridge::process::ExitBarrier::new(process)),
        ))
    }
    #[cfg(target_os = "windows")]
    {
        windows::run_process_windows(
            vec![window],
            Some(crate::bridge::process::ExitBarrier::new(process)),
        )
        .map(|()| ExitCode::SUCCESS)
    }
}

#[derive(Default)]
pub struct Dialogs {
    pub picks: Option<crate::attachments::Inbox>,
    pub saves: Option<crate::documents::Inbox>,
    pub diagnostics: Option<crate::diagnostics::Inbox>,
    pub notifications: Option<crate::notifications::UiInbox>,
    pub downloads: Option<crate::file_download::Inbox>,
}

pub fn prepare_application() -> crate::policy::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use nsh_platform_macos::{objc2::MainThreadMarker, objc2_app_kit::NSApplication};
        let mtm = MainThreadMarker::new().ok_or("native_main_thread_required")?;
        let _ = NSApplication::sharedApplication(mtm);
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        crate::notification_identity_windows::prepare()
    }
}
pub fn notification_factory() -> crate::notifications::Factory {
    #[cfg(target_os = "macos")]
    {
        Box::new(|activation| {
            Ok(Box::new(crate::notifications::macos::Native::new(
                activation,
            )?))
        })
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(|activation| {
            Ok(Box::new(crate::notifications::windows::Native::new(
                crate::notification_identity_windows::installed()?,
                activation,
            )?))
        })
    }
}

pub fn channel() -> (Port, Option<Inbox>) {
    let (port, inbox) = Port::channel();
    (port, Some(inbox))
}

#[cfg(target_os = "windows")]
pub fn run(
    source: nsh_platform_windows::AppSource,
    options: nsh_platform_windows::AppOptions,
    inbox: Option<Inbox>,
    services: crate::host_services::Port,
    dialogs: Dialogs,
) -> ExitCode {
    let code = windows::run(source, options, inbox, services.clone(), dialogs);
    services.shutdown();
    code
}
#[cfg(target_os = "windows")]
#[path = "native_ui_windows.rs"]
mod windows;
#[cfg(target_os = "macos")]
#[allow(
    dead_code,
    reason = "Single-window synthetic UI harness entrypoint; production uses the owned factory"
)]
pub fn run(
    source: nsh_platform_macos::AppSource,
    options: nsh_platform_macos::AppOptions,
    inbox: Option<Inbox>,
    services: crate::host_services::Port,
    dialogs: Dialogs,
) -> ExitCode {
    run_observed(source, options, inbox, services, dialogs, |_, _| None)
}
#[cfg(target_os = "macos")]
#[allow(
    dead_code,
    reason = "Synthetic native observer harness; never called by the production factory"
)]
pub(crate) fn run_observed(
    source: nsh_platform_macos::AppSource,
    options: nsh_platform_macos::AppOptions,
    inbox: Option<Inbox>,
    services: crate::host_services::Port,
    dialogs: Dialogs,
    mut observe: impl FnMut(&nsh_platform_macos::AppView, bool) -> Option<ExitCode> + 'static,
) -> ExitCode {
    run_windows_observed(
        vec![Window {
            window_key: "synthetic-primary".into(),
            source,
            options,
            inbox,
            services,
            dialogs,
            lifetime: None,
            persistence: None,
            restored: None,
        }],
        move |_, view, applied| observe(view, applied),
    )
}
#[cfg(target_os = "macos")]
#[allow(
    dead_code,
    reason = "Opt-in physical two-window harness; gated off during locked validation"
)]
pub(crate) fn run_windows_observed(
    windows: Vec<Window>,
    observe: impl FnMut(usize, &nsh_platform_macos::AppView, bool) -> Option<ExitCode> + 'static,
) -> ExitCode {
    macos::run_windows(windows, observe, None, None)
}

#[cfg(test)]
#[path = "native_window_tests.rs"]
mod tests;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::{
        appearance::{Command, Contract},
        policy::Result,
        window_kernel::Catalog,
    };
    use foundation::{
        NSArray, NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRunLoop,
        NSRunLoopCommonModes, NSSize, NSString, NSTimer,
    };
    use kit::{
        NSAppearance, NSAppearanceCustomization, NSApplication, NSApplicationActivationPolicy,
        NSApplicationDelegate, NSApplicationTerminateReply, NSBackingStoreType, NSEvent,
        NSEventModifierFlags, NSEventType, NSFont, NSMenu, NSMenuItem, NSWindow, NSWindowDelegate,
        NSWindowStyleMask,
    };
    use nsh_platform_macos::{
        self as platform, objc2, objc2_app_kit as kit, objc2_foundation as foundation,
    };
    use objc2::{
        MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, ProtocolObject},
        sel,
    };
    use serde_json::{Value, json};
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        sync::{atomic::Ordering, mpsc},
        time::Instant,
    };
    thread_local! { static WINDOWS:RefCell<Catalog>=RefCell::new(Catalog::default()); }
    thread_local! { static REOPEN:Cell<bool>=const {Cell::new(false)}; }
    thread_local! {
        static DIRTY: RefCell<std::collections::HashSet<usize>> = RefCell::new(std::collections::HashSet::new());
        static TRANSITIONS: RefCell<std::collections::HashSet<usize>> = RefCell::new(std::collections::HashSet::new());
        static GEOMETRY_FAILED: RefCell<std::collections::HashSet<usize>> = RefCell::new(std::collections::HashSet::new());
    }
    thread_local! { static PUMP:RefCell<Option<Box<dyn FnMut()>>>=const {RefCell::new(None)}; }
    fn native_id(window: &NSWindow) -> usize {
        window as *const NSWindow as usize
    }
    fn changed(notification: &NSNotification, transition: Option<bool>) {
        if let Some(object) = notification.object() {
            let id = &*object as *const AnyObject as usize;
            DIRTY.with(|s| {
                s.borrow_mut().insert(id);
            });
            if let Some(active) = transition {
                if active {
                    GEOMETRY_FAILED.with(|s| {
                        s.borrow_mut().remove(&id);
                    });
                }
                TRANSITIONS.with(|s| {
                    if active {
                        s.borrow_mut().insert(id);
                    } else {
                        s.borrow_mut().remove(&id);
                    }
                });
            }
        }
    }
    fn capture_window(
        window: &NSWindow,
        geometry: &mut crate::window_geometry::Geometry,
        read_failed: &mut bool,
        key: &str,
        services: &crate::host_services::Port,
        installed: bool,
        force: bool,
    ) {
        if !installed {
            return;
        }
        let id = native_id(window);
        let captured = (|| {
            if TRANSITIONS.with(|s| s.borrow().contains(&id))
                || GEOMETRY_FAILED.with(|s| s.borrow().contains(&id))
            {
                return Err("window_geometry_transition_unresolved".into());
            }
            let dirty = DIRTY.with(|s| s.borrow_mut().remove(&id));
            crate::window_sampling::sample(geometry, read_failed, dirty, force, |prior| {
                crate::window_geometry::macos::capture(window, Some(prior))
            })?;
            services.reader().window_record(key, *geometry)
        })();
        WINDOWS.with(|cell| cell.borrow_mut().update_capture(id, captured));
    }
    fn retire_window(window: &NSWindow) {
        let services = WINDOWS.with(|cell| cell.borrow().services(native_id(window)));
        if let Some(services) = services {
            services.shutdown();
        }
    }
    fn runtime_suspended(suspended: bool) {
        let services = WINDOWS.with(|cell| cell.borrow().all_services());
        for services in services {
            services.set_runtime_suspended(suspended);
        }
    }
    fn foreground(active: bool) {
        let focused = MainThreadMarker::new().and_then(|mtm| {
            if active {
                NSApplication::sharedApplication(mtm)
                    .keyWindow()
                    .as_deref()
                    .map(native_id)
            } else {
                None
            }
        });
        WINDOWS.with(|cell| cell.borrow().activity(focused));
    }
    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind=MainThreadOnly]
        #[name = "YuriNshDesktopDelegate"]
        struct Delegate;
        unsafe impl NSObjectProtocol for Delegate {}
        impl Delegate {
            #[unsafe(method(runtimeWillSuspend:))]
            fn runtime_will_suspend(&self,_:&NSNotification) {runtime_suspended(true);}
            #[unsafe(method(runtimeDidResume:))]
            fn runtime_did_resume(&self,_:&NSNotification) {runtime_suspended(false);}
            #[unsafe(method(pump:))]
            fn pump(&self, _: &NSTimer) {
                let pump=PUMP.with(|cell|cell.borrow_mut().take());
                if let Some(mut pump)=pump {
                    pump();
                    PUMP.with(|cell| *cell.borrow_mut()=Some(pump));
                }
            }
        }
        unsafe impl NSApplicationDelegate for Delegate {
            #[unsafe(method(applicationDidBecomeActive:))]
            fn became_active(&self,_:&NSNotification) { foreground(true); }
            #[unsafe(method(applicationDidResignActive:))]
            fn resigned_active(&self,_:&NSNotification) { foreground(false); }
            #[unsafe(method(applicationShouldTerminate:))]
            fn should_terminate(&self, _: &NSApplication) -> NSApplicationTerminateReply {
                WINDOWS.with(|cell| cell.borrow_mut().request_quit(Instant::now()));
                NSApplicationTerminateReply::TerminateCancel
            }
            #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
            fn terminate_after_last_window(&self, _: &NSApplication) -> bool { false }
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn reopen(&self, _: &NSApplication, visible: bool) -> bool {
                if !visible { REOPEN.with(|flag| flag.set(true)); }
                true
            }
        }
        unsafe impl NSWindowDelegate for Delegate {
            #[unsafe(method(windowDidMove:))]
            fn moved(&self, n: &NSNotification) { changed(n, None); }
            #[unsafe(method(windowDidResize:))]
            fn resized(&self, n: &NSNotification) { changed(n, None); }
            #[unsafe(method(windowDidEndLiveResize:))]
            fn ended_resize(&self, n: &NSNotification) { changed(n, None); }
            #[unsafe(method(windowDidMiniaturize:))]
            fn minimized(&self, n: &NSNotification) { changed(n, None); }
            #[unsafe(method(windowDidDeminiaturize:))]
            fn restored(&self, n: &NSNotification) { changed(n, None); }
            #[unsafe(method(windowWillEnterFullScreen:))]
            fn will_enter_fullscreen(&self, n: &NSNotification) { changed(n, Some(true)); }
            #[unsafe(method(windowWillExitFullScreen:))]
            fn will_exit_fullscreen(&self, n: &NSNotification) { changed(n, Some(true)); }
            #[unsafe(method(windowDidEnterFullScreen:))]
            fn entered_fullscreen(&self, n: &NSNotification) { changed(n, Some(false)); }
            #[unsafe(method(windowDidExitFullScreen:))]
            fn exited_fullscreen(&self, n: &NSNotification) { changed(n, Some(false)); }
            #[unsafe(method(windowDidFailToEnterFullScreen:))]
            fn failed_enter_fullscreen(&self, window: &NSWindow) { GEOMETRY_FAILED.with(|s| { s.borrow_mut().insert(native_id(window)); }); }
            #[unsafe(method(windowDidFailToExitFullScreen:))]
            fn failed_exit_fullscreen(&self, window: &NSWindow) { GEOMETRY_FAILED.with(|s| { s.borrow_mut().insert(native_id(window)); }); }
            #[unsafe(method(windowDidBecomeKey:))]
            fn became_key(&self, _: &NSNotification) { foreground(NSApplication::sharedApplication(self.mtm()).isActive()); }
            #[unsafe(method(windowDidResignKey:))]
            fn resigned_key(&self, _: &NSNotification) { foreground(NSApplication::sharedApplication(self.mtm()).isActive()); }
            #[unsafe(method(windowShouldClose:))]
            fn should_close(&self, window: &NSWindow) -> bool {
                WINDOWS.with(|cell| cell.borrow_mut().request_close(native_id(window), Instant::now()));
                false
            }
            #[unsafe(method(windowWillClose:))]
            fn window_closed(&self, notification: &NSNotification) {
                if let Some(object) = notification.object() {
                    let id = &*object as *const AnyObject as usize;
                    WINDOWS.with(|cell| cell.borrow_mut().native_destroyed(id));
                    let services = WINDOWS.with(|cell| cell.borrow().services(id));
                    if let Some(services) = services { services.shutdown(); }
                }
            }
        }
    );
    fn runtime_notifications(delegate: &Delegate) -> Result<Retained<AnyObject>> {
        // Explicit system sleep/wake, not resign-active, occlusion, minimization or modal focus.
        unsafe extern "C" {
            static NSWorkspaceWillSleepNotification: *const NSString;
            static NSWorkspaceDidWakeNotification: *const NSString;
        }
        unsafe {
            let workspace =
                AnyClass::get(c"NSWorkspace").ok_or("native_runtime_observer_unavailable")?;
            let workspace: Retained<AnyObject> = msg_send![workspace, sharedWorkspace];
            let center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
            let sleep = NSWorkspaceWillSleepNotification
                .as_ref()
                .ok_or("native_runtime_observer_unavailable")?;
            let wake = NSWorkspaceDidWakeNotification
                .as_ref()
                .ok_or("native_runtime_observer_unavailable")?;
            let _: () = msg_send![&*center,addObserver:delegate,selector:sel!(runtimeWillSuspend:),name:sleep,object:std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*center,addObserver:delegate,selector:sel!(runtimeDidResume:),name:wake,object:std::ptr::null::<AnyObject>()];
            Ok(center)
        }
    }
    fn installed_fonts() -> Result<Vec<String>> {
        let class = AnyClass::get(c"NSFontManager").ok_or("appearance_font_catalog_unavailable")?;
        // NSFontManager is in AppKit but NSH's public objc2-app-kit feature set does not
        // generate its typed wrapper. These are the documented zero-argument selectors.
        let manager: Retained<AnyObject> = unsafe { msg_send![class, sharedFontManager] };
        let names: Retained<NSArray<NSString>> =
            unsafe { msg_send![&*manager, availableFontFamilies] };
        Ok(names.iter().map(|s| s.to_string()).collect())
    }
    fn apply(view: &platform::AppView, command: Command, mtm: MainThreadMarker) -> Result<Value> {
        if let Command::Reset { revision } = command {
            reset(view)?;
            return Ok(json!({"revision":revision}));
        }
        let Command::Apply(Contract {
            mode,
            colors,
            fonts,
        }) = command
        else {
            unreachable!()
        };
        let available = installed_fonts()?;
        let system = NSFont::systemFontOfSize(0.0)
            .familyName()
            .ok_or("appearance_system_font_unavailable")?
            .to_string();
        let mono = NSFont::monospacedSystemFontOfSize_weight(0.0, 0.0)
            .familyName()
            .ok_or("appearance_system_font_unavailable")?
            .to_string();
        let mut unsupported = Vec::new();
        let mut family = |name: &str, fallback: &str| {
            if ["system-ui", "monospace"].contains(&name) || available.iter().any(|v| v == name) {
                name.to_owned()
            } else {
                unsupported.push(name.to_owned());
                fallback.to_owned()
            }
        };
        let ui = family(fonts["ui"].as_str().expect("validated"), "system-ui");
        let code = family(fonts["mono"].as_str().expect("validated"), "monospace");
        let light = family(fonts["assistantLight"].as_str().expect("validated"), &ui);
        let dark = family(fonts["assistantDark"].as_str().expect("validated"), &ui);
        let physical = |name: &str| match name {
            "system-ui" => system.clone(),
            "monospace" => mono.clone(),
            _ => name.to_owned(),
        };
        let mut css = colors;
        css["theme"] = json!({"font-sans":physical(&ui),"font-mono":physical(&code)});
        let native_mode = match mode.as_str() {
            "light" => Some(
                NSAppearance::appearanceNamed(unsafe { kit::NSAppearanceNameAqua })
                    .ok_or("appearance_mode_unavailable")?,
            ),
            "dark" => Some(
                NSAppearance::appearanceNamed(unsafe { kit::NSAppearanceNameDarkAqua })
                    .ok_or("appearance_mode_unavailable")?,
            ),
            _ => None,
        };
        let encoded = json!({"cssVars":css}).to_string();
        // Parse and validate the entire override before mutating the view's other native settings.
        view.set_theme_overrides(Some(&encoded))
            .map_err(|_| "appearance_native_tokens_invalid")?;
        view.set_font_scale(Some(1.0));
        view.view().setAppearance(native_mode.as_deref());
        unsupported.sort();
        unsupported.dedup();
        let system = if NSApplication::sharedApplication(mtm)
            .effectiveAppearance()
            .name()
            .to_string()
            .contains("Dark")
        {
            "dark"
        } else {
            "light"
        };
        Ok(
            json!({"uiFontFamily":ui,"monoFontFamily":code,"assistantFontFamilies":{"light":light,"dark":dark},"unsupportedFonts":unsupported,"systemColorScheme":system}),
        )
    }
    fn reset(view: &platform::AppView) -> Result<()> {
        view.set_theme_overrides(None)
            .map_err(|_| "appearance_native_reset_failed")?;
        view.set_font_scale(None);
        view.view().setAppearance(None);
        Ok(())
    }
    struct OwnedWindow {
        window: Retained<NSWindow>,
        view: Rc<platform::AppView>,
        services: crate::host_services::Port,
        tabs: Option<Rc<crate::desktop_tab::Observer>>,
        lifetime: Option<crate::bridge::Owner>,
    }
    impl Drop for OwnedWindow {
        fn drop(&mut self) {
            retire_window(&self.window);
            self.services.shutdown();
            if let Some(observer) = &self.tabs {
                observer.retire();
            }
            self.view.stop();
            self.window.setDelegate(None);
            self.window.close();
            WINDOWS.with(|cell| cell.borrow_mut().remove(native_id(&self.window)));
            let id = native_id(&self.window);
            DIRTY.with(|s| {
                s.borrow_mut().remove(&id);
            });
            TRANSITIONS.with(|s| {
                s.borrow_mut().remove(&id);
            });
            GEOMETRY_FAILED.with(|s| {
                s.borrow_mut().remove(&id);
            });
            self.lifetime.take();
        }
    }
    pub(crate) fn run_windows(
        windows: Vec<super::Window>,
        observe: impl FnMut(usize, &platform::AppView, bool) -> Option<ExitCode> + 'static,
        mut reopen: Option<super::WindowFactory>,
        mut process_exit: Option<crate::bridge::process::ExitBarrier>,
    ) -> ExitCode {
        let Some(mtm) = MainThreadMarker::new() else {
            return ExitCode::FAILURE;
        };
        if super::validate_windows(&windows).is_err() {
            return ExitCode::FAILURE;
        }
        WINDOWS.with(|cell| *cell.borrow_mut() = Catalog::default());
        REOPEN.with(|flag| flag.set(false));
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(mtm), init] };
        let Ok(runtime_notifications) = runtime_notifications(&delegate) else {
            return ExitCode::FAILURE;
        };
        app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let menu = NSMenu::new(mtm);
        let entry = NSMenuItem::new(mtm);
        let submenu = NSMenu::new(mtm);
        let quit = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str("Quit"),
                Some(sel!(terminate:)),
                &NSString::from_str("q"),
            )
        };
        submenu.addItem(&quit);
        entry.setSubmenu(Some(&submenu));
        menu.addItem(&entry);
        app.setMainMenu(Some(&menu));
        if let Some(port) = &windows[0].persistence {
            WINDOWS.with(|cell| cell.borrow_mut().install_persistence(port.clone()));
        }
        let mut pumps: Vec<Box<dyn FnMut(bool) -> bool>> = Vec::new();
        let observe = Rc::new(RefCell::new(observe));
        let exit = Rc::new(Cell::new(ExitCode::SUCCESS));
        let forced = Rc::new(Cell::new(false));
        let result_for_window = exit.clone();
        let force_for_window = forced.clone();
        let window_app = app.clone();
        let window_delegate = delegate.clone();
        let create = move |index: usize,
                           spec: super::Window|
              -> Result<Box<dyn FnMut(bool) -> bool>> {
            let app = &window_app;
            let delegate = &window_delegate;
            let super::Window {
                source,
                options,
                inbox,
                services,
                dialogs,
                lifetime,
                window_key,
                persistence,
                restored,
            } = spec;
            let inbox = inbox.ok_or("appearance_native_owner_unavailable")?;
            let diagnostic_window_id = services.window_id()?;
            let Dialogs {
                picks,
                saves,
                diagnostics,
                notifications,
                downloads,
            } = dialogs;
            let (decisions, pending_decisions) =
                mpsc::sync_channel::<(Value, nsh_engine::HostReply)>(16);
            // Register before loading the engine. The TS capability must also be declared in its
            // manifest; an undeclared or missing JS consumer can never authorize native closure.
            options
                .host
                .handle("desktop.window.closeDecision", move |mut call| {
                    let value = call.take_data();
                    if let Some(reply) = call.into_reply()
                        && let Err(
                            mpsc::TrySendError::Full((_, reply))
                            | mpsc::TrySendError::Disconnected((_, reply)),
                        ) = decisions.try_send((value, reply))
                    {
                        reply.reject("close_owner_busy");
                    }
                });
            let window = unsafe {
                NSWindow::initWithContentRect_styleMask_backing_defer(
                    NSWindow::alloc(mtm),
                    NSRect::new(
                        NSPoint::new(0.0, 0.0),
                        NSSize::new(options.size.0 as f64, options.size.1 as f64),
                    ),
                    NSWindowStyleMask::Titled
                        | NSWindowStyleMask::Closable
                        | NSWindowStyleMask::Miniaturizable
                        | NSWindowStyleMask::Resizable,
                    NSBackingStoreType::Buffered,
                    false,
                )
            };
            unsafe {
                window.setReleasedWhenClosed(false);
            }
            window.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
            window.setTitle(&NSString::from_str(&options.title));
            if WINDOWS
                .with(|cell| {
                    cell.borrow_mut().insert(
                        native_id(&window),
                        options.host.clone(),
                        services.clone(),
                    )
                })
                .is_err()
            {
                window.setDelegate(None);
                window.close();
                return Err("window_owner_duplicate".into());
            }
            let view = platform::AppView::new(mtm, options);
            let mut owned = OwnedWindow {
                window: window.clone(),
                view: view.clone(),
                services: services.clone(),
                tabs: None,
                lifetime,
            };
            let mut browser_pump =
                crate::browser_view::macos::register(&view, services.browser(), mtm);
            window.setContentView(Some(&view.view()));
            let tab_observer: Option<Rc<crate::desktop_tab::Observer>> =
                if let Some(tabs) = services.tabs() {
                    match crate::desktop_tab::install_observer(&tabs, &window, &view.view(), mtm) {
                        Ok(observer) => Some(Rc::new(observer)),
                        Err(_) => return Err("window_tab_observer_failed".into()),
                    }
                } else {
                    None
                };
            owned.tabs = tab_observer.clone();
            let mut geometry = if let Some(saved) = &restored {
                crate::window_geometry::macos::restore_before_show(&window, saved.geometry)?
            } else {
                window.center();
                crate::window_geometry::macos::capture(&window, None)?
            };
            match source {
                platform::AppSource::Bundle(bundle) => view.load(platform::App::Js(bundle)),
                platform::AppSource::Rust(root) => view.load(platform::App::Rust(root)),
            }
            window.makeKeyAndOrderFront(None);
            if restored.as_ref().is_some_and(|s| s.geometry.fullscreen) {
                TRANSITIONS.with(|s| {
                    s.borrow_mut().insert(native_id(&window));
                });
                crate::window_geometry::macos::enter_fullscreen_after_show(&window, geometry)?;
            }
            app.activate();
            let mut generation = inbox.generation.load(Ordering::Acquire);
            let mut appearance_applied = false;
            let result = result_for_window.clone();
            let force = force_for_window.clone();
            let observing = observe.clone();
            let running_view = view.clone();
            let running_app = app.clone();
            let picking_window = window.clone();
            let polling_tabs = tab_observer.clone();
            let polling_services = services.clone();
            let mut geometry_read_failed = false;
            Ok(Box::new(move |capture_only| {
                objc2::rc::autoreleasepool(|_| {
                    if capture_only {
                        capture_window(
                            &picking_window,
                            &mut geometry,
                            &mut geometry_read_failed,
                            &window_key,
                            &polling_services,
                            persistence.is_some(),
                            true,
                        );
                        return false;
                    }
                    WINDOWS.with(|cell| {
                        let mut catalog = cell.borrow_mut();
                        catalog.expire(Instant::now());
                        for _ in 0..16 {
                            let Ok((value, reply)) = pending_decisions.try_recv() else {
                                break;
                            };
                            catalog.decide(
                                native_id(&picking_window),
                                &value,
                                reply,
                                Instant::now(),
                            );
                        }
                    });
                    let closing = force.get()
                        || WINDOWS.with(|cell| cell.borrow().closing(native_id(&picking_window)));
                    let destroyed =
                        WINDOWS.with(|cell| cell.borrow().destroyed(native_id(&picking_window)));
                    if !closing && !destroyed {
                        capture_window(
                            &picking_window,
                            &mut geometry,
                            &mut geometry_read_failed,
                            &window_key,
                            &polling_services,
                            persistence.is_some(),
                            false,
                        );
                    }
                    let current = inbox.generation.load(Ordering::Acquire);
                    if generation != current {
                        let _ = reset(&running_view);
                        generation = current;
                        appearance_applied = false;
                    }
                    inbox.drain(|command| {
                        let is_apply = matches!(&command, Command::Apply(_));
                        let result = apply(&running_view, command, mtm);
                        appearance_applied = is_apply && result.is_ok();
                        result
                    });
                    browser_pump.poll();
                    if let Some(observer) = &polling_tabs {
                        observer.poll(
                            running_app.isActive() && picking_window.isKeyWindow(),
                            crate::file_download::is_presenting()
                                || crate::diagnostics::is_presenting()
                                || crate::documents::is_presenting()
                                || crate::attachments::is_presenting(),
                        );
                    }
                    if !closing
                        && !destroyed
                        && polling_services.live()
                        && running_app.isActive()
                        && picking_window.isKeyWindow()
                        && picking_window.isVisible()
                        && !crate::file_download::is_presenting()
                        && !crate::diagnostics::is_presenting()
                        && !crate::documents::is_presenting()
                        && !crate::attachments::is_presenting()
                    {
                        // One system dialog per UI turn, including scheduled/native-modal lifetime.
                        if let Some(job) = diagnostics
                            .as_ref()
                            .and_then(|diagnostics| diagnostics.try_recv())
                        {
                            unsafe {
                                job.show(
                                    Retained::as_ptr(&picking_window).cast_mut().cast(),
                                    &diagnostic_window_id,
                                );
                            }
                        } else if let Some(job) = downloads
                            .as_ref()
                            .and_then(|downloads| downloads.try_recv())
                        {
                            unsafe {
                                job.show(
                                    &diagnostic_window_id,
                                    Retained::as_ptr(&picking_window).cast_mut().cast(),
                                );
                            }
                        } else if let Some(job) = saves.as_ref().and_then(|saves| saves.try_recv())
                        {
                            unsafe {
                                job.show(Retained::as_ptr(&picking_window).cast_mut().cast());
                            }
                        } else if let Some(job) = picks.as_ref().and_then(|picks| picks.try_recv())
                        {
                            unsafe {
                                job.show(Retained::as_ptr(&picking_window).cast_mut().cast());
                            }
                        } else if let Some(job) =
                            notifications.as_ref().and_then(|inbox| inbox.try_recv())
                        {
                            unsafe {
                                job.run(Retained::as_ptr(&picking_window).cast_mut().cast());
                            }
                        }
                    }
                    if let Some(code) =
                        observing.borrow_mut()(index, &running_view, appearance_applied)
                    {
                        result.set(code);
                        force.set(true);
                    }
                    if closing || destroyed || force.get() {
                        if destroyed && !closing {
                            result.set(ExitCode::FAILURE);
                        }
                        polling_services.shutdown();
                        if let Some(owner) = owned.lifetime.as_mut() {
                            owner.begin_shutdown();
                        }
                        if !polling_services.shutdown_complete() {
                            return false;
                        }
                        if owned
                            .lifetime
                            .as_ref()
                            .is_some_and(|owner| !owner.stopped())
                        {
                            return false;
                        }
                        // Keep the owning object captured until exact service retirement completes.
                        let _ = &owned;
                        return true;
                    }
                    false
                })
            }))
        };
        let mut next_index = windows.len();
        for (index, spec) in windows.into_iter().enumerate() {
            match create(index, spec) {
                Ok(pump) => pumps.push(pump),
                Err(_) => {
                    drop(pumps);
                    unsafe {
                        let _: () = msg_send![&*runtime_notifications,removeObserver:&*delegate];
                    }
                    app.setDelegate(None);
                    return ExitCode::FAILURE;
                }
            }
        }
        let running_app = app.clone();
        PUMP.with(|cell| *cell.borrow_mut() = Some(Box::new(move || {
            let mut index = 0;
            while index < pumps.len() {
                if pumps[index](false) { drop(pumps.remove(index)); } else { index += 1; }
            }
            if WINDOWS.with(|cell| cell.borrow().needs_final_capture()) { for pump in &mut pumps { pump(true); } }
            WINDOWS.with(|cell| cell.borrow_mut().drive_persistence());
            let quitting = WINDOWS.with(|cell| cell.borrow().quitting());
            if !pumps.is_empty() { REOPEN.with(|flag| flag.set(false)); }
            if pumps.is_empty() && !forced.get() && !quitting && REOPEN.with(|flag| flag.replace(false))
                && let Some(factory) = reopen.as_mut() {
                match factory().and_then(|window| { super::validate_windows(std::slice::from_ref(&window))?; create(next_index, window) }) {
                    Ok(pump) => { pumps.push(pump); next_index += 1; }
                    Err(_) => eprintln!("Yuri Native: window_reopen_failed"),
                }
            }
            if pumps.is_empty() && (forced.get() || quitting || reopen.is_none()) {
                if process_exit.as_mut().is_some_and(|barrier| !barrier.poll()) { return; }
                running_app.stop(None);
                // stop: takes effect after the next event; wake an otherwise idle AppKit loop.
                if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                    NSEventType::ApplicationDefined, NSPoint::new(0.0,0.0), NSEventModifierFlags::empty(),0.0,0,None,0,0,0
                ) { running_app.postEvent_atStart(&event,true); }
            }
        })));
        // Let AppKit own launch/activation/occlusion and native modal tracking. Merely polling
        // nextEvent never enters NSApplication's running lifecycle, so foreground TS work can stall.
        let timer = unsafe {
            NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
                0.05,
                &delegate,
                sel!(pump:),
                None,
                true,
            )
        };
        unsafe {
            NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
        }
        app.run();
        timer.invalidate();
        unsafe {
            let _: () = msg_send![&*runtime_notifications,removeObserver:&*delegate];
        }
        PUMP.with(|cell| *cell.borrow_mut() = None);
        app.setDelegate(None);
        WINDOWS.with(|cell| *cell.borrow_mut() = Catalog::default());
        exit.get()
    }
}
