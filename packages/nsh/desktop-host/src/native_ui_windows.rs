//! A UI-thread-owned NSH AppView, Win32 message loop, bounded mailboxes and close subclass.
//! All native calls use NSH's Windows reexports or system DLL ABI; no extra crate dependencies.
use super::*;
use crate::{
    appearance::{Command, Contract},
    policy::Result,
    window_kernel::Catalog,
};
use nsh_engine::HostReply;
use nsh_platform_windows::{
    self as platform,
    windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::LOGFONTW,
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, NONCLIENTMETRICSW, TranslateMessage,
        },
    },
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ffi::c_void,
    ptr,
    rc::Rc,
    sync::{atomic::Ordering, mpsc},
    time::Instant,
};

type RawWindow = *mut c_void;
type Subclass = unsafe extern "system" fn(RawWindow, u32, usize, isize, usize, usize) -> isize;
const SUBCLASS_ID: usize = 0x59555249;
const WM_CLOSE: u32 = 0x0010;
const WM_QUERYENDSESSION: u32 = 0x0011;
const WM_QUIT: u32 = 0x0012;
const WM_ENDSESSION: u32 = 0x0016;
const WM_NCDESTROY: u32 = 0x0082;
const WM_TIMER: u32 = 0x0113;
const WM_POWERBROADCAST: u32 = 0x0218;
#[link(name = "Comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(
        hwnd: RawWindow,
        callback: Option<Subclass>,
        id: usize,
        data: usize,
    ) -> i32;
    fn RemoveWindowSubclass(hwnd: RawWindow, callback: Option<Subclass>, id: usize) -> i32;
    fn DefSubclassProc(hwnd: RawWindow, message: u32, wparam: usize, lparam: isize) -> isize;
}
#[link(name = "User32")]
unsafe extern "system" {
    fn SetProcessDpiAwarenessContext(context: *mut c_void) -> i32;
    fn SetTimer(
        hwnd: RawWindow,
        id: usize,
        milliseconds: u32,
        callback: Option<unsafe extern "system" fn(RawWindow, u32, usize, u32)>,
    ) -> usize;
    fn KillTimer(hwnd: RawWindow, id: usize) -> i32;
    fn DestroyWindow(hwnd: RawWindow) -> i32;
    fn GetForegroundWindow() -> RawWindow;
    fn GetDC(hwnd: RawWindow) -> *mut c_void;
    fn ReleaseDC(hwnd: RawWindow, dc: *mut c_void) -> i32;
    fn SystemParametersInfoW(action: u32, size: u32, data: *mut c_void, flags: u32) -> i32;
}
#[link(name = "Ole32")]
unsafe extern "system" {
    fn OleInitialize(reserved: *const c_void) -> i32;
    fn OleUninitialize();
}
#[link(name = "Shell32")]
unsafe extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> i32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn Sleep(milliseconds: u32);
}
#[link(name = "Gdi32")]
unsafe extern "system" {
    fn EnumFontFamiliesExW(
        dc: *mut c_void,
        font: *const LOGFONTW,
        callback: Option<
            unsafe extern "system" fn(*const LOGFONTW, *const c_void, u32, isize) -> i32,
        >,
        data: isize,
        flags: u32,
    ) -> i32;
}
#[link(name = "Advapi32")]
unsafe extern "system" {
    fn RegGetValueW(
        key: *mut c_void,
        subkey: *const u16,
        value: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
}
#[link(name = "Dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: RawWindow,
        attribute: u32,
        value: *const c_void,
        size: u32,
    ) -> i32;
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        // SAFETY: this process main thread has not opened windows/COM yet. S_OK/S_FALSE both pair
        // with OleUninitialize; an incompatible apartment is a startup failure, not a fallback.
        if unsafe { OleInitialize(ptr::null()) } < 0 {
            return Err("windows_ole_initialize_failed".into());
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            OleUninitialize();
        }
    }
}
struct WindowState {
    services: crate::host_services::Port,
    destroyed: bool,
    tabs: Option<Rc<crate::desktop_tab::Observer>>,
    geometry_dirty: bool,
}
thread_local! {
    static WINDOWS: RefCell<BTreeMap<usize, WindowState>> = const { RefCell::new(BTreeMap::new()) };
    static CATALOG: RefCell<Catalog> = RefCell::new(Catalog::default());
    static SESSION_QUERY: Cell<Option<u64>> = const { Cell::new(None) };
}

fn retire_window(hwnd: RawWindow) {
    let services = WINDOWS.with(|cell| {
        cell.borrow()
            .get(&(hwnd as usize))
            .map(|state| (state.services.clone(), state.tabs.clone()))
    });
    if let Some((services, tabs)) = services {
        services.shutdown();
        if let Some(observer) = tabs {
            observer.retire();
        }
    }
}
fn runtime_suspended(hwnd: RawWindow, suspended: bool) {
    let services = WINDOWS.with(|cell| {
        cell.borrow()
            .get(&(hwnd as usize))
            .map(|state| state.services.clone())
    });
    if let Some(services) = services {
        services.set_runtime_suspended(suspended);
    }
}

fn request_quit(session: bool) {
    CATALOG.with(|cell| {
        let mut catalog = cell.borrow_mut();
        let pending = catalog.quit_pending();
        catalog.request_quit(Instant::now());
        if session && !pending && catalog.quit_pending() {
            SESSION_QUERY.with(|s| s.set(catalog.quit_id()));
        }
    });
}
fn capture_window(
    view: &platform::AppView,
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
    let hwnd = view.hwnd();
    let captured = (|| {
        let dirty = WINDOWS.with(|cell| {
            let mut windows = cell.borrow_mut();
            let state = windows
                .get_mut(&(hwnd.0 as usize))
                .ok_or("window_native_handle_invalid")?;
            if state.destroyed {
                return Err("window_native_handle_invalid");
            }
            Ok(std::mem::take(&mut state.geometry_dirty))
        })?;
        crate::window_sampling::sample(geometry, read_failed, dirty, force, |prior| {
            unsafe { crate::window_geometry::windows::Window::borrow(&hwnd) }
                .and_then(|window| window.capture(Some(prior)))
        })?;
        services.reader().window_record(key, *geometry)
    })();
    CATALOG.with(|cell| cell.borrow_mut().update_capture(hwnd.0 as usize, captured));
}
unsafe extern "system" fn window_proc(
    hwnd: RawWindow,
    message: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    crate::desktop_tab::observe_window_message(hwnd, message, wparam, lparam);
    if matches!(message, 0x0003 | 0x0005 | 0x0047 | 0x0232 | 0x02e0 | 0x007e) {
        WINDOWS.with(|cell| {
            if let Some(state) = cell.borrow_mut().get_mut(&(hwnd as usize)) {
                state.geometry_dirty = true;
            }
        });
    }
    match message {
        0x0006 => {
            let focused = unsafe { GetForegroundWindow() };
            CATALOG.with(|cell| cell.borrow().activity(Some(focused as usize)));
        }
        0x001c => {
            let focused = if wparam != 0 {
                Some(unsafe { GetForegroundWindow() } as usize)
            } else {
                None
            };
            CATALOG.with(|cell| cell.borrow().activity(focused));
        }
        WM_POWERBROADCAST if wparam == 4 => {
            runtime_suspended(hwnd, true);
            return 1;
        }
        WM_POWERBROADCAST if wparam == 7 || wparam == 18 => {
            runtime_suspended(hwnd, false);
            return 1;
        }
        WM_CLOSE => {
            CATALOG.with(|cell| {
                cell.borrow_mut()
                    .request_close(hwnd as usize, Instant::now())
            });
            return 0;
        }
        WM_QUERYENDSESSION => {
            // A synchronous OS query cannot wait for JS. Veto now, ask asynchronously. Approval
            // exits this app only; it does not restart a cancelled OS shutdown behind the user.
            request_quit(true);
            return 0;
        }
        WM_ENDSESSION => {
            if wparam == 0
                && let Some(query) = SESSION_QUERY.with(|s| s.replace(None))
            {
                CATALOG.with(|cell| {
                    let mut catalog = cell.borrow_mut();
                    if catalog.quit_id() == Some(query) {
                        catalog.cancel_quit();
                    }
                });
            }
            let forced = wparam != 0 && !CATALOG.with(|cell| cell.borrow().quitting());
            if forced {
                eprintln!("Yuri Native: windows_session_forced_without_close_approval");
            }
            if wparam != 0 {
                retire_window(hwnd);
            }
            // ENDSESSION(true) cannot be vetoed by an app. Never treat it as JS approval, save
            // unknown drafts, DestroyWindow, or voluntarily bypass the dirty guard here.
            return 0;
        }
        WM_NCDESTROY => {
            CATALOG.with(|cell| cell.borrow_mut().native_destroyed(hwnd as usize));
            retire_window(hwnd);
            unsafe {
                RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID);
            }
            WINDOWS.with(|cell| {
                if let Some(state) = cell.borrow_mut().get_mut(&(hwnd as usize)) {
                    state.destroyed = true;
                }
            });
        }
        _ => {}
    }
    // SAFETY: installed only on this UI thread's AppView HWND; Comctl32 owns the procedure chain.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn system_dark() -> Result<bool> {
    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let value = wide("AppsUseLightTheme");
    let mut light = 1u32;
    let mut size = 4;
    // HKEY_CURRENT_USER is the predefined sign-extended Win32 pseudo handle; read DWORD only.
    let status = unsafe {
        RegGetValueW(
            (-2147483647isize) as *mut c_void,
            subkey.as_ptr(),
            value.as_ptr(),
            0x10,
            ptr::null_mut(),
            (&mut light as *mut u32).cast(),
            &mut size,
        )
    };
    if status == 2 {
        return Ok(false);
    } // Absent personalization key is Windows' default light mode.
    if status != 0 || size != 4 || light > 1 {
        return Err("appearance_system_scheme_unavailable".into());
    }
    Ok(light == 0)
}
struct Families {
    names: Vec<String>,
    overflow: bool,
}
unsafe extern "system" fn font_family(
    font: *const LOGFONTW,
    _metrics: *const c_void,
    _kind: u32,
    data: isize,
) -> i32 {
    // SAFETY: EnumFontFamiliesExW supplies ENUMLOGFONTEXW, whose first member is LOGFONTW;
    // `data` points to our stack Families for this synchronous enumeration only.
    let font = unsafe { &*font };
    let families = unsafe { &mut *(data as *mut Families) };
    let length = font
        .lfFaceName
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(font.lfFaceName.len());
    let name = String::from_utf16_lossy(&font.lfFaceName[..length]);
    if !name.is_empty() && !name.starts_with('@') && !families.names.contains(&name) {
        if families.names.len() >= 4096 {
            families.overflow = true;
            return 0;
        }
        families.names.push(name);
    }
    1
}
fn fonts(hwnd: RawWindow) -> Result<(Vec<String>, String)> {
    let mut metrics = NONCLIENTMETRICSW::default();
    metrics.cbSize = std::mem::size_of_val(&metrics) as u32;
    if unsafe {
        SystemParametersInfoW(
            0x0029,
            metrics.cbSize,
            (&mut metrics as *mut NONCLIENTMETRICSW).cast(),
            0,
        )
    } == 0
    {
        return Err("appearance_system_font_unavailable".into());
    }
    let name = &metrics.lfMessageFont.lfFaceName;
    let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    let system = String::from_utf16_lossy(&name[..length]);
    let dc = unsafe { GetDC(hwnd) };
    if dc.is_null() {
        return Err("appearance_font_catalog_unavailable".into());
    }
    let mut families = Families {
        names: Vec::new(),
        overflow: false,
    };
    let logfont = LOGFONTW {
        lfCharSet: 1,
        ..Default::default()
    }; // DEFAULT_CHARSET: enumerate installed families.
    unsafe {
        EnumFontFamiliesExW(
            dc,
            &logfont,
            Some(font_family),
            (&mut families as *mut Families) as isize,
            0,
        );
        ReleaseDC(hwnd, dc);
    }
    if system.is_empty()
        || families.names.is_empty()
        || families.overflow
        || !families
            .names
            .iter()
            .any(|n| n.eq_ignore_ascii_case("Consolas"))
    {
        return Err("appearance_font_catalog_unavailable".into());
    }
    Ok((families.names, system))
}
fn title_mode(hwnd: RawWindow, dark: bool) -> Result<()> {
    let dark = i32::from(dark);
    if unsafe { DwmSetWindowAttribute(hwnd, 20, (&dark as *const i32).cast(), 4) } < 0 {
        return Err("appearance_native_mode_unavailable".into());
    }
    Ok(())
}
#[derive(Default)]
struct AppearanceOwner {
    overrides: Option<String>,
    mode: Option<String>,
}
fn effective_dark(mode: Option<&str>, system: bool) -> bool {
    match mode {
        Some("dark") => true,
        Some("light") => false,
        _ => system,
    }
}
fn overrides(
    view: &platform::AppView,
    encoded: &str,
    dark: bool,
    previous: &AppearanceOwner,
    system: bool,
) -> Result<()> {
    // NSH parses the full override before changing tokens; do not use DWM's setter-only
    // immersive-mode attribute with DwmGetWindowAttribute as a fake transactional getter.
    view.set_theme_overrides(Some(encoded))
        .map_err(|_| "appearance_native_tokens_invalid")?;
    if let Err(error) = title_mode(view.hwnd().0, dark) {
        let restored = view.set_theme_overrides(previous.overrides.as_deref());
        let _ = title_mode(
            view.hwnd().0,
            effective_dark(previous.mode.as_deref(), system),
        );
        if restored.is_err() {
            return Err("appearance_native_rollback_failed".into());
        }
        return Err(error);
    }
    Ok(())
}
fn reset(view: &platform::AppView, owner: &mut AppearanceOwner) -> Result<()> {
    // Host invalidation must clear old tokens even if an OS theme query/title update fails.
    view.set_theme_overrides(None)
        .map_err(|_| "appearance_native_reset_failed")?;
    view.set_font_scale(None);
    *owner = AppearanceOwner::default();
    title_mode(view.hwnd().0, system_dark()?)?;
    Ok(())
}
fn apply(view: &platform::AppView, command: Command, owner: &mut AppearanceOwner) -> Result<Value> {
    if let Command::Reset { revision } = command {
        reset(view, owner)?;
        return Ok(json!({"revision":revision}));
    }
    let Command::Apply(Contract {
        mode,
        mut colors,
        fonts: requested,
    }) = command
    else {
        unreachable!()
    };
    let (families, system) = fonts(view.hwnd().0)?;
    let system_dark = system_dark()?;
    let mut unsupported = Vec::new();
    let mut family = |name: &str, fallback: &str| {
        if ["system-ui", "monospace"].contains(&name)
            || families
                .iter()
                .any(|family| family.eq_ignore_ascii_case(name))
        {
            name.to_owned()
        } else {
            unsupported.push(name.to_owned());
            fallback.to_owned()
        }
    };
    let ui = family(requested["ui"].as_str().expect("validated"), "system-ui");
    let mono = family(requested["mono"].as_str().expect("validated"), "monospace");
    let light = family(
        requested["assistantLight"].as_str().expect("validated"),
        &ui,
    );
    let dark = family(requested["assistantDark"].as_str().expect("validated"), &ui);
    // Match NSH 0.4's documented Windows generic mapping: system message font / Consolas.
    let physical = |name: &str| match name {
        "system-ui" => system.clone(),
        "monospace" => "Consolas".into(),
        _ => name.to_owned(),
    };
    colors["theme"] = json!({"font-sans":physical(&ui),"font-mono":physical(&mono)});
    let encoded = json!({"cssVars":colors}).to_string();
    overrides(
        view,
        &encoded,
        effective_dark(Some(&mode), system_dark),
        owner,
        system_dark,
    )?;
    view.set_font_scale(Some(1.0));
    owner.overrides = Some(encoded);
    owner.mode = Some(mode);
    unsupported.sort();
    unsupported.dedup();
    Ok(
        json!({"uiFontFamily":ui,"monoFontFamily":mono,"assistantFontFamilies":{"light":light,"dark":dark},"unsupportedFonts":unsupported,"systemColorScheme":if system_dark {"dark"} else {"light"}}),
    )
}
pub(super) fn run(
    source: platform::AppSource,
    options: platform::AppOptions,
    inbox: Option<Inbox>,
    services: crate::host_services::Port,
    dialogs: Dialogs,
) -> ExitCode {
    match run_owned(source, options, inbox, services, dialogs) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Yuri Native: {error}");
            ExitCode::FAILURE
        }
    }
}
fn run_owned(
    source: platform::AppSource,
    options: platform::AppOptions,
    inbox: Option<Inbox>,
    services: crate::host_services::Port,
    dialogs: Dialogs,
) -> Result<()> {
    run_windows(vec![super::Window {
        window_key: "primary".into(),
        source,
        options,
        inbox,
        services,
        dialogs,
        lifetime: None,
        persistence: None,
        restored: None,
    }])
}
struct OwnedWindow {
    view: Rc<platform::AppView>,
    hwnd: RawWindow,
    services: crate::host_services::Port,
    tabs: Option<Rc<crate::desktop_tab::Observer>>,
    lifetime: Option<crate::bridge::Owner>,
}
impl Drop for OwnedWindow {
    fn drop(&mut self) {
        self.services.shutdown();
        if let Some(observer) = &self.tabs {
            observer.retire();
        }
        self.view.stop();
        let destroyed = WINDOWS.with(|cell| {
            cell.borrow()
                .get(&(self.hwnd as usize))
                .is_some_and(|s| s.destroyed)
        });
        if !destroyed {
            unsafe {
                RemoveWindowSubclass(self.hwnd, Some(window_proc), SUBCLASS_ID);
                DestroyWindow(self.hwnd);
            }
        }
        WINDOWS.with(|cell| cell.borrow_mut().remove(&(self.hwnd as usize)));
        CATALOG.with(|cell| cell.borrow_mut().remove(self.hwnd as usize));
        self.lifetime.take();
    }
}
struct Timer(usize);
impl Drop for Timer {
    fn drop(&mut self) {
        unsafe {
            KillTimer(ptr::null_mut(), self.0);
        }
    }
}
pub(super) fn run_windows(windows: Vec<super::Window>) -> Result<()> {
    run_process_windows(windows, None)
}
pub(super) fn run_process_windows(
    windows: Vec<super::Window>,
    mut process_exit: Option<crate::bridge::process::ExitBarrier>,
) -> Result<()> {
    super::validate_windows(&windows)?;
    unsafe {
        SetProcessDpiAwarenessContext((-4isize) as *mut c_void);
    }
    let _apartment = Apartment::new()?;
    let app_id = wide(&windows[0].options.app_id);
    if unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) } < 0 {
        return Err("windows_app_identity_failed".into());
    }
    let timer = Timer(unsafe { SetTimer(ptr::null_mut(), 0, 50, None) });
    if timer.0 == 0 {
        return Err("windows_ui_timer_failed".into());
    }
    CATALOG.with(|cell| *cell.borrow_mut() = Catalog::default());
    if let Some(port) = &windows[0].persistence {
        CATALOG.with(|cell| cell.borrow_mut().install_persistence(port.clone()));
    }
    let mut polls: Vec<Box<dyn FnMut(bool) -> bool>> = Vec::new();
    let failure = Rc::new(Cell::new(false));
    for spec in windows {
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
        let window_id = services.window_id()?;
        let diagnostic_window_id = window_id.clone();
        let Dialogs {
            picks,
            saves,
            diagnostics,
            notifications,
            downloads,
        } = dialogs;
        let host = options.host.clone();
        crate::browser_view::windows::register(&options.components, services.browser());
        let view =
            platform::AppView::new(None, options).map_err(|_| "windows_view_create_failed")?;
        let hwnd = view.hwnd().0;
        let mut owned = OwnedWindow {
            view: view.clone(),
            hwnd,
            services: services.clone(),
            tabs: None,
            lifetime,
        };
        let tab_observer = if let Some(tabs) = services.tabs() {
            match crate::desktop_tab::install_observer(&tabs, hwnd) {
                Ok(observer) => Some(Rc::new(observer)),
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        owned.tabs = tab_observer.clone();
        CATALOG.with(|cell| {
            cell.borrow_mut()
                .insert(hwnd as usize, host.clone(), services.clone())
        })?;
        WINDOWS.with(|cell| {
            cell.borrow_mut().insert(
                hwnd as usize,
                WindowState {
                    services: services.clone(),
                    destroyed: false,
                    tabs: tab_observer.clone(),
                    geometry_dirty: true,
                },
            );
        });
        // Never show/load an editable app if the guard cannot be installed.
        if unsafe { SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0) } == 0 {
            return Err("windows_close_hook_failed".into());
        }
        let (sender, decisions) = mpsc::sync_channel::<(Value, HostReply)>(16);
        host.handle("desktop.window.closeDecision", move |mut call| {
            let value = call.take_data();
            if let Some(reply) = call.into_reply()
                && let Err(
                    mpsc::TrySendError::Full((_, reply))
                    | mpsc::TrySendError::Disconnected((_, reply)),
                ) = sender.try_send((value, reply))
            {
                reply.reject("close_owner_busy");
            }
        });
        let native_hwnd = view.hwnd();
        // Borrow only on this owner thread, while OwnedWindow pins the actual AppView.
        let native = unsafe { crate::window_geometry::windows::Window::borrow(&native_hwnd)? };
        let mut geometry = if let Some(saved) = &restored {
            if saved.geometry.fullscreen {
                return Err("window_fullscreen_requires_nsh_command".into());
            }
            native.restore_before_show(saved.geometry)?
        } else {
            native.capture(None)?
        };
        match source {
            platform::AppSource::Bundle(bundle) => view.load(platform::App::Js(bundle)),
            platform::AppSource::Rust(root) => view.load(platform::App::Rust(root)),
        }
        if restored.is_some() {
            native.show_restored(geometry)?;
        } else {
            view.show();
        }
        let mut generation = inbox.generation.load(Ordering::Acquire);
        let mut appearance = AppearanceOwner::default();
        let failed = failure.clone();
        let mut geometry_read_failed = false;
        polls.push(Box::new(move |capture_only| {
            if capture_only {
                capture_window(
                    &view,
                    &mut geometry,
                    &mut geometry_read_failed,
                    &window_key,
                    &services,
                    persistence.is_some(),
                    true,
                );
                return false;
            }
            let closing = CATALOG.with(|cell| {
                let mut catalog = cell.borrow_mut();
                catalog.expire(Instant::now());
                for _ in 0..16 {
                    let Ok((value, reply)) = decisions.try_recv() else {
                        break;
                    };
                    catalog.decide(hwnd as usize, &value, reply, Instant::now());
                }
                catalog.closing(hwnd as usize)
            });
            let destroyed = WINDOWS.with(|cell| {
                cell.borrow()
                    .get(&(hwnd as usize))
                    .is_none_or(|s| s.destroyed)
            });
            if closing || destroyed {
                services.shutdown();
                if let Some(owner) = owned.lifetime.as_mut() {
                    owner.begin_shutdown();
                }
                if services.shutdown_complete()
                    && owned.lifetime.as_ref().is_none_or(|owner| owner.stopped())
                {
                    if destroyed && !closing {
                        failed.set(true);
                    }
                    let _ = &owned;
                    return true;
                }
            }
            if !closing && !destroyed {
                capture_window(
                    &view,
                    &mut geometry,
                    &mut geometry_read_failed,
                    &window_key,
                    &services,
                    persistence.is_some(),
                    false,
                );
                let current = inbox.generation.load(Ordering::Acquire);
                if current != generation {
                    if reset(&view, &mut appearance).is_err() {
                        let _ = host.send(
                            "appearance.error",
                            json!({"code":"appearance_native_reset_failed"}),
                        );
                    }
                    generation = current;
                }
                inbox.drain(|command| apply(&view, command, &mut appearance));
                if let Some(observer) = &tab_observer {
                    observer.poll(
                        unsafe { GetForegroundWindow() == hwnd },
                        crate::file_download::is_presenting()
                            || crate::diagnostics::is_presenting()
                            || crate::documents::is_presenting()
                            || crate::attachments::is_presenting(),
                    );
                }
                if !closing
                    && !destroyed
                    && services.live()
                    && unsafe { GetForegroundWindow() == hwnd }
                    && !crate::file_download::is_presenting()
                    && !crate::diagnostics::is_presenting()
                    && !crate::documents::is_presenting()
                    && !crate::attachments::is_presenting()
                {
                    if let Some(job) = diagnostics
                        .as_ref()
                        .and_then(|diagnostics| diagnostics.try_recv())
                    {
                        unsafe {
                            job.show(hwnd, &diagnostic_window_id);
                        }
                    } else if let Some(job) = downloads
                        .as_ref()
                        .and_then(|downloads| downloads.try_recv())
                    {
                        unsafe {
                            job.show(&diagnostic_window_id, hwnd);
                        }
                    } else if let Some(job) = saves.as_ref().and_then(|saves| saves.try_recv()) {
                        unsafe {
                            job.show(hwnd);
                        }
                    } else if let Some(job) = picks.as_ref().and_then(|picks| picks.try_recv()) {
                        unsafe {
                            job.show(hwnd);
                        }
                    } else if let Some(job) =
                        notifications.as_ref().and_then(|inbox| inbox.try_recv())
                    {
                        unsafe {
                            job.run(hwnd);
                        }
                    }
                }
            }
            false
        }));
    }
    let mut message = MSG::default();
    let mut message_error = false;
    loop {
        let mut index = 0;
        while index < polls.len() {
            if polls[index](false) {
                drop(polls.remove(index));
            } else {
                index += 1;
            }
        }
        if CATALOG.with(|cell| cell.borrow().needs_final_capture()) {
            for poll in &mut polls {
                poll(true);
            }
        }
        CATALOG.with(|cell| cell.borrow_mut().drive_persistence());
        if polls.is_empty() && process_exit.as_mut().is_none_or(|barrier| barrier.poll()) {
            break;
        }
        // SAFETY: standard UI-thread message dispatch. Do not treat WM_QUIT as approval.
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
        if status < 0 {
            if !message_error {
                eprintln!("Yuri Native: windows_message_read_failed_window_retained");
                message_error = true;
            }
            unsafe {
                Sleep(50);
            }
            continue;
        }
        if status == 0 || message.message == WM_QUIT {
            request_quit(false);
            continue;
        }
        if message.message == WM_TIMER
            && message.hwnd == HWND(ptr::null_mut())
            && message.wParam.0 == timer.0
        {
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    if failure.get() {
        return Err("windows_window_destroyed_without_close_approval".into());
    }
    Ok(())
}
