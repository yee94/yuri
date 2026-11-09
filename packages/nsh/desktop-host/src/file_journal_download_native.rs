//! System save destination; no path from JS, no custom imitation dialog.
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
        .map_err(|_| "download_panel_busy".into())
}
#[derive(Clone, Copy)]
struct ChooserGate {
    live: bool,
    active: bool,
    exact_owner: bool,
    visible: bool,
    minimized: bool,
    enabled: bool,
    unoccupied: bool,
}
// Sample OS facts at actual presentation, never a cached dequeue-time flag.
// This gate is chooser-only: it does not change a running transfer's authority.
fn gated_chooser<T>(
    current: &dyn Fn() -> bool,
    mut probe: impl FnMut() -> ChooserGate,
    show: impl FnOnce() -> T,
) -> Result<T> {
    // Re-read OS state after the final authority check too: Reader.current may
    // briefly wait for publication, during which the actual owner can lose key.
    for _ in 0..2 {
        if !current() {
            return Err("download_scope_stale".into());
        }
        let state = probe();
        if !state.live {
            return Err("download_window_unavailable".into());
        }
        if !state.active
            || !state.exact_owner
            || !state.visible
            || state.minimized
            || !state.enabled
        {
            return Err("download_window_not_foreground".into());
        }
        if !state.unoccupied {
            return Err("download_panel_busy".into());
        }
    }
    Ok(show())
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
        job.fail("download_window_unavailable");
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
        job.fail("download_window_unavailable");
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
pub(super) unsafe fn choose(
    window: *mut c_void,
    name: &str,
    current: &dyn Fn() -> bool,
) -> Result<Option<PathBuf>> {
    use nsh_platform_macos::{
        objc2::{
            MainThreadMarker, msg_send,
            rc::Retained,
            runtime::{AnyClass, AnyObject},
        },
        objc2_foundation::{NSString, NSURL},
    };
    let _main = MainThreadMarker::new().ok_or("download_main_thread_required")?;
    if window.is_null() {
        return Err("download_window_unavailable".into());
    }
    unsafe {
        let class = AnyClass::get(c"NSApplication").ok_or("download_panel_unavailable")?;
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        if app.is_null() {
            return Err("download_window_unavailable".into());
        }
        let modal: *mut AnyObject = msg_send![app, modalWindow];
        let sheet: *mut AnyObject = msg_send![window.cast::<AnyObject>(), attachedSheet];
        if !modal.is_null() || !sheet.is_null() {
            return Err("download_panel_busy".into());
        }
        let class = AnyClass::get(c"NSSavePanel").ok_or("download_panel_unavailable")?;
        let panel: Retained<AnyObject> = msg_send![class, savePanel];
        let _: () = msg_send![&panel,setNameFieldStringValue:&*NSString::from_str(name)];
        let _: () = msg_send![&panel,setAllowsOtherFileTypes:true];
        let _: () = msg_send![&panel,setCanCreateDirectories:false];
        let answer: isize = gated_chooser(
            current,
            || {
                let key: *mut AnyObject = msg_send![app, keyWindow];
                let active: bool = msg_send![app, isActive];
                let owner_key: bool = msg_send![window.cast::<AnyObject>(), isKeyWindow];
                let visible: bool = msg_send![window.cast::<AnyObject>(), isVisible];
                let minimized: bool = msg_send![window.cast::<AnyObject>(), isMiniaturized];
                let modal: *mut AnyObject = msg_send![app, modalWindow];
                let sheet: *mut AnyObject = msg_send![window.cast::<AnyObject>(), attachedSheet];
                ChooserGate {
                    live: true,
                    active,
                    exact_owner: owner_key && key.cast::<c_void>() == window,
                    visible,
                    minimized,
                    enabled: true,
                    unoccupied: modal.is_null() && sheet.is_null(),
                }
            },
            || msg_send![&panel, runModal],
        )?;
        if answer == 0 {
            return Ok(None);
        }
        if answer != 1 {
            return Err("download_panel_failed".into());
        }
        let url: Option<Retained<NSURL>> = msg_send![&panel, URL];
        let url = url.ok_or("download_invalid_selection")?;
        if !url.isFileURL() {
            return Err("download_invalid_selection".into());
        }
        url.path()
            .map(|v| Some(PathBuf::from(v.to_string())))
            .ok_or("download_invalid_selection".into())
    }
}
#[cfg(target_os = "windows")]
pub(super) unsafe fn choose(
    window: *mut c_void,
    name: &str,
    current: &dyn Fn() -> bool,
) -> Result<Option<PathBuf>> {
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
        fn IsWindow(window: *mut c_void) -> i32;
        fn IsWindowVisible(window: *mut c_void) -> i32;
        fn IsIconic(window: *mut c_void) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    if window.is_null()
        || unsafe { GetWindowThreadProcessId(window, ptr::null_mut()) != GetCurrentThreadId() }
    {
        return Err("download_main_thread_required".into());
    }
    if unsafe { IsWindowEnabled(window) } == 0 {
        return Err("download_panel_busy".into());
    }
    let mut buffer = vec![0u16; 32768];
    let filename: Vec<u16> = name.encode_utf16().collect();
    buffer[..filename.len()].copy_from_slice(&filename);
    let filter: Vec<u16> = "All files\0*.*\0\0".encode_utf16().collect();
    let mut dialog: OpenFileName = unsafe { std::mem::zeroed() };
    dialog.size = std::mem::size_of::<OpenFileName>() as u32;
    dialog.owner = window;
    dialog.filter = filter.as_ptr();
    dialog.filter_index = 1;
    dialog.file = buffer.as_mut_ptr();
    dialog.max_file = buffer.len() as u32;
    dialog.flags = super::windows_abi::SAVE_FLAGS;
    let answer = gated_chooser(
        current,
        || unsafe {
            let foreground = GetForegroundWindow();
            ChooserGate {
                live: IsWindow(window) != 0
                    && GetWindowThreadProcessId(window, ptr::null_mut()) == GetCurrentThreadId(),
                active: foreground == window,
                exact_owner: foreground == window,
                visible: IsWindowVisible(window) != 0,
                minimized: IsIconic(window) != 0,
                enabled: IsWindowEnabled(window) != 0,
                unoccupied: true,
            }
        },
        || unsafe { GetSaveFileNameW(&mut dialog) },
    )?;
    if answer == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err("download_panel_failed".into())
        };
    }
    let len = buffer
        .iter()
        .position(|c| *c == 0)
        .ok_or("download_invalid_selection")?;
    if len == 0 {
        return Err("download_invalid_selection".into());
    }
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..len],
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn foreground() -> ChooserGate {
        ChooserGate {
            live: true,
            active: true,
            exact_owner: true,
            visible: true,
            minimized: false,
            enabled: true,
            unoccupied: true,
        }
    }
    #[test]
    fn every_os_gate_is_required_before_synthetic_chooser_invocation() {
        let good = foreground();
        for denied in [
            ChooserGate {
                live: false,
                ..good
            },
            ChooserGate {
                active: false,
                ..good
            },
            ChooserGate {
                exact_owner: false,
                ..good
            },
            ChooserGate {
                visible: false,
                ..good
            },
            ChooserGate {
                minimized: true,
                ..good
            },
            ChooserGate {
                enabled: false,
                ..good
            },
            ChooserGate {
                unoccupied: false,
                ..good
            },
        ] {
            let calls = Cell::new(0);
            assert!(gated_chooser(&|| true, || denied, || calls.set(calls.get() + 1)).is_err());
            assert_eq!(calls.get(), 0);
        }
        assert_eq!(
            gated_chooser(&|| true, foreground, || "synthetic chooser").unwrap(),
            "synthetic chooser"
        );
    }
    #[test]
    fn deferred_delivery_resamples_owner_after_focus_switch_hide_or_close() {
        let actual = Cell::new(foreground());
        for changed in [
            ChooserGate {
                active: false,
                ..foreground()
            },
            ChooserGate {
                exact_owner: false,
                ..foreground()
            },
            ChooserGate {
                visible: false,
                ..foreground()
            },
            ChooserGate {
                live: false,
                ..foreground()
            },
            ChooserGate {
                minimized: true,
                ..foreground()
            },
        ] {
            actual.set(foreground());
            let deferred =
                || gated_chooser(&|| true, || actual.get(), || panic!("late chooser opened"));
            actual.set(changed);
            assert!(deferred().is_err());
        }
    }
    #[test]
    fn scope_retirement_during_os_probe_cannot_open_chooser_or_mutate_authority() {
        let current = Cell::new(true);
        assert_eq!(
            gated_chooser(
                &|| current.get(),
                || {
                    current.set(false);
                    foreground()
                },
                || ()
            )
            .unwrap_err(),
            "download_scope_stale"
        );
        let current = Cell::new(true);
        assert!(
            gated_chooser(
                &|| current.get(),
                || ChooserGate {
                    exact_owner: false,
                    ..foreground()
                },
                || ()
            )
            .is_err()
        );
        assert!(
            current.get(),
            "ordinary foreground loss is NOT authority retirement"
        );
    }
    #[test]
    fn final_authority_check_cannot_leave_a_stale_foreground_snapshot() {
        let actual = Cell::new(foreground());
        let checks = Cell::new(0);
        let current = || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                actual.set(ChooserGate {
                    exact_owner: false,
                    ..foreground()
                });
            }
            true
        };
        assert_eq!(
            gated_chooser(&current, || actual.get(), || panic!("late chooser opened")).unwrap_err(),
            "download_window_not_foreground"
        );
        assert_eq!(checks.get(), 2);
    }
}
