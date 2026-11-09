//! Real AppKit/Win32 chooser adapters. No shell, JS path, bookmark or recent-file record.
use super::{Job, Result};
use std::{ffi::c_void, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
static PRESENTING: AtomicBool = AtomicBool::new(false);
pub(super) fn presenting() -> bool { PRESENTING.load(Ordering::Acquire) }
struct Guard;
impl Drop for Guard { fn drop(&mut self) { PRESENTING.store(false, Ordering::Release); } }
fn slot() -> Result<Guard> {
    PRESENTING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| Guard).map_err(|_| "diagnostics_panel_busy".into())
}
#[cfg(target_os = "macos")]
pub(super) unsafe fn schedule(mut job: Job, window: *mut c_void) {
    use nsh_platform_macos::objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    struct Deferred { job: Job, window: Retained<AnyObject>, _guard: Guard }
    unsafe extern "C" {
        static mut _dispatch_main_q: c_void;
        fn dispatch_async_f(queue: *mut c_void, context: *mut c_void, work: unsafe extern "C" fn(*mut c_void));
    }
    unsafe extern "C" fn run(context: *mut c_void) {
        let Deferred { job, window, _guard } = *unsafe { Box::from_raw(context.cast::<Deferred>()) };
        unsafe { job.present(Retained::as_ptr(&window).cast_mut().cast()); }
    }
    if MainThreadMarker::new().is_none() || window.is_null() { job.finish("failed", Some("diagnostics_window_unavailable")); return; }
    let guard = match slot() { Ok(v) => v, Err(_) => { job.finish("failed", Some("diagnostics_panel_busy")); return; } };
    let Some(window) = (unsafe { Retained::retain(window.cast::<AnyObject>()) }) else { job.finish("failed", Some("diagnostics_window_unavailable")); return; };
    let context = Box::into_raw(Box::new(Deferred { job, window, _guard: guard }));
    unsafe { dispatch_async_f(std::ptr::addr_of_mut!(_dispatch_main_q), context.cast(), run); }
}
#[cfg(target_os = "windows")]
pub(super) unsafe fn schedule(mut job: Job, window: *mut c_void) {
    let _guard = match slot() { Ok(v) => v, Err(_) => { job.finish("failed", Some("diagnostics_panel_busy")); return; } };
    unsafe { job.present(window); }
}
#[cfg(target_os = "macos")]
pub(super) unsafe fn choose(window: *mut c_void, cancelled: &Arc<AtomicBool>) -> Result<Option<PathBuf>> {
    use nsh_platform_macos::{
        objc2::{DeclaredClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, runtime::{AnyClass, AnyObject}, sel},
        objc2_app_kit::NSModalPanelRunLoopMode,
        objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes, NSString, NSTimer, NSURL},
    };
    let mtm = MainThreadMarker::new().ok_or("diagnostics_main_thread_required")?;
    if window.is_null() { return Err("diagnostics_window_unavailable".into()); }
    unsafe {
        let class = AnyClass::get(c"NSApplication").ok_or("diagnostics_panel_unavailable")?;
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        let modal: *mut AnyObject = msg_send![app, modalWindow];
        let sheet: *mut AnyObject = msg_send![window.cast::<AnyObject>(), attachedSheet];
        let visible: bool = msg_send![window.cast::<AnyObject>(), isVisible];
        let minimized: bool = msg_send![window.cast::<AnyObject>(), isMiniaturized];
        let active: bool = msg_send![app, isActive];
        if !modal.is_null() || !sheet.is_null() || !visible || minimized || !active { return Err("diagnostics_panel_busy".into()); }
        let class = AnyClass::get(c"NSSavePanel").ok_or("diagnostics_panel_unavailable")?;
        let panel: Retained<AnyObject> = msg_send![class, savePanel];
        let _: () = msg_send![&panel, setNameFieldStringValue: &*NSString::from_str("yuri-native-diagnostics.json")];
        let types = NSArray::from_retained_slice(&[NSString::from_str("json")]);
        let _: () = msg_send![&panel, setAllowedFileTypes: &*types];
        let _: () = msg_send![&panel, setAllowsOtherFileTypes: false];
        let _: () = msg_send![&panel, setCanCreateDirectories: false];
        // The exact-panel timer is registered in modal mode, not just GCD's main
        // queue (whose delivery is not a cancellation guarantee in nested loops).
        struct Poll { panel: Retained<AnyObject>, cancelled: Arc<AtomicBool> }
        define_class!(
            #[unsafe(super(NSObject))]
            #[thread_kind=MainThreadOnly]
            #[ivars=Poll]
            #[name="YuriNshDiagnosticsPanelPoll"]
            struct PanelPoll;
            unsafe impl NSObjectProtocol for PanelPoll {}
            impl PanelPoll {
                #[unsafe(method(tick:))]
                fn tick(&self, timer: &NSTimer) {
                    let poll = self.ivars();
                    if poll.cancelled.load(Ordering::Acquire) {
                        timer.invalidate();
                        let _: () = unsafe { msg_send![&poll.panel, cancel: std::ptr::null_mut::<AnyObject>()] };
                    }
                }
            }
        );
        if cancelled.load(Ordering::Acquire) { return Ok(None); }
        let poll = PanelPoll::alloc(mtm).set_ivars(Poll { panel: panel.clone(), cancelled: cancelled.clone() });
        let poll: Retained<PanelPoll> = msg_send![super(poll), init];
        let timer = NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(0.05, &poll, sel!(tick:), None, true);
        NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
        NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSModalPanelRunLoopMode);
        let response: isize = msg_send![&panel, runModal];
        timer.invalidate();
        if response == 0 { return Ok(None); }
        if response != 1 { return Err("diagnostics_panel_failed".into()); }
        let url: Option<Retained<NSURL>> = msg_send![&panel, URL];
        let url = url.ok_or("diagnostics_invalid_selection")?;
        if !url.isFileURL() { return Err("diagnostics_invalid_selection".into()); }
        url.path().map(|s| Some(PathBuf::from(s.to_string()))).ok_or("diagnostics_invalid_selection".into())
    }
}
#[cfg(target_os = "windows")]
pub(super) unsafe fn choose(window: *mut c_void, cancelled: &Arc<AtomicBool>) -> Result<Option<PathBuf>> {
    use super::windows_abi::OpenFileName;
    use std::{os::windows::ffi::OsStringExt, ptr};
    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetSaveFileNameW(dialog: *mut OpenFileName) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindowThreadProcessId(window: *mut c_void, process: *mut u32) -> u32;
        fn IsWindowEnabled(window: *mut c_void) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn SetWindowLongPtrW(window: *mut c_void, index: i32, value: isize) -> isize;
        fn GetWindowLongPtrW(window: *mut c_void, index: i32) -> isize;
        fn GetParent(window: *mut c_void) -> *mut c_void;
        fn PostMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> i32;
        fn SetTimer(window: *mut c_void, id: usize, interval: u32, callback: Option<unsafe extern "system" fn(*mut c_void, u32, usize, u32)>) -> usize;
        fn KillTimer(window: *mut c_void, id: usize) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" { fn GetCurrentThreadId() -> u32; }
    unsafe extern "system" fn hook(window: *mut c_void, message: u32, _: usize, data: isize) -> usize {
        unsafe {
            if message == 0x110 { // WM_INITDIALOG: lParam is this exact OPENFILENAMEW.
                let dialog = &*(data as *const OpenFileName);
                SetWindowLongPtrW(window, -21, dialog.data); // GWLP_USERDATA on the hook child only.
                if SetTimer(window, 1, 50, None) == 0 { PostMessageW(GetParent(window), 0x111, 2, 0); }
            } else if message == 0x113 { // WM_TIMER; the Arc lives until GetSaveFileNameW returns.
                let flag = GetWindowLongPtrW(window, -21) as *const AtomicBool;
                if !flag.is_null() && (*flag).load(Ordering::Acquire) { PostMessageW(GetParent(window), 0x111, 2, 0); }
            } else if message == 2 { KillTimer(window, 1); }
        }
        0
    }
    if window.is_null() || unsafe { GetWindowThreadProcessId(window, ptr::null_mut()) != GetCurrentThreadId() } {
        return Err("diagnostics_main_thread_required".into());
    }
    if unsafe { IsWindowEnabled(window) == 0 || GetForegroundWindow() != window } { return Err("diagnostics_panel_busy".into()); }
    let mut buffer = vec![0u16; 32768];
    let name: Vec<u16> = "yuri-native-diagnostics.json".encode_utf16().collect();
    buffer[..name.len()].copy_from_slice(&name);
    let filter: Vec<u16> = "JSON\0*.json\0\0".encode_utf16().collect();
    let extension: Vec<u16> = "json\0".encode_utf16().collect();
    let mut dialog: OpenFileName = unsafe { std::mem::zeroed() };
    dialog.size = std::mem::size_of::<OpenFileName>() as u32;
    dialog.owner = window; dialog.filter = filter.as_ptr(); dialog.filter_index = 1;
    dialog.file = buffer.as_mut_ptr(); dialog.max_file = buffer.len() as u32;
    dialog.default_extension = extension.as_ptr(); dialog.flags = super::windows_abi::SAVE_FLAGS;
    dialog.flags |= 0x20; // OFN_ENABLEHOOK; cancellation is for this exact dialog child.
    dialog.hook = hook as *const () as *mut c_void;
    dialog.data = Arc::as_ptr(cancelled) as isize;
    if cancelled.load(Ordering::Acquire) { return Ok(None); }
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 { Ok(None) } else { Err("diagnostics_panel_failed".into()) };
    }
    let len = buffer.iter().position(|b| *b == 0).filter(|n| *n > 0).ok_or("diagnostics_invalid_selection")?;
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]))))
}
