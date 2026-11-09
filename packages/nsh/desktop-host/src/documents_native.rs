//! UI-thread system dialogs only. The OS owns destination/overwrite confirmation.
use super::{Job, Result};
use std::{
    ffi::c_void,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
static PRESENTING: AtomicBool = AtomicBool::new(false);
pub(super) fn presenting() -> bool {
    PRESENTING.load(Ordering::Acquire)
}
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        PRESENTING.store(false, Ordering::Release);
    }
}
fn slot() -> Result<Guard> {
    PRESENTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| Guard)
        .map_err(|_| "documents_panel_busy".into())
}
#[cfg(target_os = "macos")]
pub(super) unsafe fn schedule(mut job: Job, window: *mut c_void) {
    use nsh_platform_macos::objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    struct Deferred {
        job: Job,
        window: Retained<AnyObject>,
        _guard: Guard,
    }
    unsafe extern "C" {
        static mut _dispatch_main_q: c_void;
        fn dispatch_async_f(
            queue: *mut c_void,
            context: *mut c_void,
            work: unsafe extern "C" fn(*mut c_void),
        );
    }
    unsafe extern "C" fn run(context: *mut c_void) {
        let Deferred {
            job,
            window,
            _guard,
        } = *unsafe { Box::from_raw(context.cast::<Deferred>()) };
        unsafe {
            job.present(Retained::as_ptr(&window).cast_mut().cast());
        }
    }
    if MainThreadMarker::new().is_none() || window.is_null() {
        job.fail("documents_window_unavailable");
        return;
    }
    let guard = match slot() {
        Ok(v) => v,
        Err(e) => {
            job.fail(&e);
            return;
        }
    };
    let Some(window) = (unsafe { Retained::retain(window.cast::<AnyObject>()) }) else {
        job.fail("documents_window_unavailable");
        return;
    };
    let context = Box::into_raw(Box::new(Deferred {
        job,
        window,
        _guard: guard,
    }));
    unsafe {
        dispatch_async_f(
            std::ptr::addr_of_mut!(_dispatch_main_q),
            context.cast(),
            run,
        );
    }
}
#[cfg(target_os = "windows")]
pub(super) unsafe fn schedule(mut job: Job, window: *mut c_void) {
    let _guard = match slot() {
        Ok(v) => v,
        Err(e) => {
            job.fail(&e);
            return;
        }
    };
    unsafe {
        job.present(window);
    }
}

#[cfg(target_os = "macos")]
pub(super) unsafe fn choose(window: *mut c_void, name: &str) -> Result<Option<PathBuf>> {
    use nsh_platform_macos::{
        objc2::{
            MainThreadMarker, msg_send,
            rc::Retained,
            runtime::{AnyClass, AnyObject},
        },
        objc2_foundation::{NSArray, NSString, NSURL},
    };
    let _mtm = MainThreadMarker::new().ok_or("documents_main_thread_required")?;
    if window.is_null() {
        return Err("documents_window_unavailable".into());
    }
    unsafe {
        let application = AnyClass::get(c"NSApplication").ok_or("documents_panel_unavailable")?;
        let application: *mut AnyObject = msg_send![application, sharedApplication];
        let modal: *mut AnyObject = msg_send![application, modalWindow];
        let sheet: *mut AnyObject = msg_send![window.cast::<AnyObject>(), attachedSheet];
        if !modal.is_null() || !sheet.is_null() {
            return Err("documents_panel_busy".into());
        }
        let class = AnyClass::get(c"NSSavePanel").ok_or("documents_panel_unavailable")?;
        let panel: Retained<AnyObject> = msg_send![class, savePanel];
        let _: () = msg_send![&panel, setNameFieldStringValue: &*NSString::from_str(name)];
        let types = NSArray::from_retained_slice(&[NSString::from_str("md")]);
        let _: () = msg_send![&panel, setAllowedFileTypes: &*types];
        let _: () = msg_send![&panel, setAllowsOtherFileTypes: false];
        let _: () = msg_send![&panel, setCanCreateDirectories: false];
        let answer: isize = msg_send![&panel, runModal];
        if answer == 0 {
            return Ok(None);
        }
        if answer != 1 {
            return Err("documents_panel_failed".into());
        }
        let url: Option<Retained<NSURL>> = msg_send![&panel, URL];
        let url = url.ok_or("documents_invalid_selection")?;
        if !url.isFileURL() {
            return Err("documents_invalid_selection".into());
        }
        url.path()
            .map(|v| Some(PathBuf::from(v.to_string())))
            .ok_or("documents_invalid_selection".into())
    }
}
#[cfg(target_os = "windows")]
pub(super) unsafe fn choose(window: *mut c_void, name: &str) -> Result<Option<PathBuf>> {
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
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    if window.is_null()
        || unsafe { GetWindowThreadProcessId(window, ptr::null_mut()) != GetCurrentThreadId() }
    {
        return Err("documents_main_thread_required".into());
    }
    if unsafe { IsWindowEnabled(window) } == 0 {
        return Err("documents_panel_busy".into());
    }
    let mut buffer = vec![0u16; 32768];
    let filename: Vec<u16> = name.encode_utf16().collect();
    buffer[..filename.len()].copy_from_slice(&filename);
    let filter: Vec<u16> = "Markdown\0*.md\0\0".encode_utf16().collect();
    let extension: Vec<u16> = "md\0".encode_utf16().collect();
    let mut dialog: OpenFileName = unsafe { std::mem::zeroed() };
    dialog.size = std::mem::size_of::<OpenFileName>() as u32;
    dialog.owner = window;
    dialog.filter = filter.as_ptr();
    dialog.filter_index = 1;
    dialog.file = buffer.as_mut_ptr();
    dialog.max_file = buffer.len() as u32;
    dialog.default_extension = extension.as_ptr();
    // OVERWRITEPROMPT | PATHMUSTEXIST | NOCHANGEDIR | EXPLORER | NOREADONLYRETURN | DONTADDTORECENT.
    dialog.flags = super::windows_abi::SAVE_FLAGS;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err("documents_panel_failed".into())
        };
    }
    let length = buffer
        .iter()
        .position(|c| *c == 0)
        .ok_or("documents_invalid_selection")?;
    if length == 0 {
        return Err("documents_invalid_selection".into());
    }
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    ))))
}
