//! System dialogs grant local paths privately. All file I/O and hashing run on the worker.
use super::{FILE_LIMIT, Result, Source};
use std::{
    io::Read,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

// Logical cancellation does not claim to dismiss a system-owned dialog. Keep the native
// presentation slot until its actual completion, so a fresh pick cannot nest another modal.
static DIALOG_ACTIVE: AtomicBool = AtomicBool::new(false);
pub(super) fn is_presenting() -> bool {
    DIALOG_ACTIVE.load(Ordering::Acquire)
}

struct DialogGuard;
impl Drop for DialogGuard {
    fn drop(&mut self) {
        DIALOG_ACTIVE.store(false, Ordering::Release);
    }
}
fn dialog_slot() -> Result<DialogGuard> {
    DIALOG_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| DialogGuard)
        .map_err(|_| "attachment_picker_busy".into())
}

#[test]
fn presentation_snapshot_tracks_reserved_slot_until_guard_completion_without_ui() {
    assert!(!super::is_presenting());
    let guard = dialog_slot().unwrap();
    assert!(super::is_presenting());
    assert!(dialog_slot().is_err());
    assert!(super::is_presenting());
    drop(guard);
    assert!(!super::is_presenting());
}

#[cfg(target_os = "macos")]
pub(super) unsafe fn schedule(job: super::PickJob, window: *mut std::ffi::c_void) {
    use nsh_platform_macos::objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    use std::ffi::c_void;
    struct Deferred {
        job: super::PickJob,
        window: Retained<AnyObject>,
        _guard: DialogGuard,
    }
    unsafe extern "C" {
        static mut _dispatch_main_q: c_void;
        fn dispatch_async_f(
            queue: *mut c_void,
            context: *mut c_void,
            work: unsafe extern "C" fn(*mut c_void),
        );
    }
    unsafe extern "C" fn perform(context: *mut c_void) {
        // The context and retained window are produced and consumed only on the main thread.
        let context = unsafe { Box::from_raw(context.cast::<Deferred>()) };
        unsafe {
            context
                .job
                .finish(Retained::as_ptr(&context.window).cast_mut().cast());
        }
    }
    if MainThreadMarker::new().is_none() || window.is_null() {
        let _ = job
            .reply
            .try_send(Err("attachment_window_unavailable".into()));
        return;
    }
    let guard = match dialog_slot() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = job.reply.try_send(Err(error));
            return;
        }
    };
    let Some(window) = (unsafe { Retained::retain(window.cast::<AnyObject>()) }) else {
        let _ = job
            .reply
            .try_send(Err("attachment_window_unavailable".into()));
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
            perform,
        );
    }
}

#[cfg(target_os = "windows")]
pub(super) unsafe fn schedule(job: super::PickJob, window: *mut std::ffi::c_void) {
    let guard = match dialog_slot() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = job.reply.try_send(Err(error));
            return;
        }
    };
    // The HWND is only passed to the OS as dialog owner, never dereferenced on this thread.
    let owner = window as usize;
    let _ = std::thread::Builder::new()
        .name("yuri-attachment-dialog".into())
        .spawn(move || {
            let _guard = guard;
            unsafe {
                job.finish(owner as *mut std::ffi::c_void);
            }
        });
}

pub(super) fn mime(name: &str) -> &'static str {
    if let Some(mime) = nsh_core::picker::mime_for_name(name) {
        return mime;
    }
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}
pub(super) fn read(source: &Source, cancelled: &AtomicBool) -> Result<Vec<u8>> {
    #[cfg(not(test))]
    let Source::Path(path) = source;
    #[cfg(test)]
    let path = match source {
        Source::Path(path) => path,
        #[cfg(test)]
        Source::Bytes(bytes) => return Ok(bytes.clone()),
    };
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4);
    } // O_NOFOLLOW | O_NONBLOCK: opening a FIFO must not block before fstat rejects it.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1);
    } // OPEN_REPARSE_POINT; share read only
    let mut handle = options.open(path).map_err(|_| "attachment_open_failed")?;
    let metadata = handle.metadata().map_err(|_| "attachment_stat_failed")?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("attachment_reparse_point".into());
        }
    }
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > FILE_LIMIT as u64 {
        return Err("attachment_size_or_type_invalid".into());
    }
    let expected = metadata.len() as usize;
    let mut bytes = Vec::with_capacity(expected);
    let mut chunk = [0; 65536];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("attachment_cancelled".into());
        }
        let count = handle
            .read(&mut chunk)
            .map_err(|_| "attachment_read_failed")?;
        if count == 0 {
            break;
        }
        if count > expected - bytes.len() {
            return Err("attachment_file_changed".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() != expected {
        return Err("attachment_file_changed".into());
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
pub(super) unsafe fn pick(window: *mut std::ffi::c_void, images: bool) -> Result<Vec<PathBuf>> {
    use nsh_platform_macos::{
        objc2::{
            MainThreadMarker, msg_send,
            rc::Retained,
            runtime::{AnyClass, AnyObject},
        },
        objc2_foundation::{NSArray, NSString, NSURL},
    };
    let _mtm = MainThreadMarker::new().ok_or("attachment_main_thread_required")?;
    if window.is_null() {
        return Err("attachment_window_unavailable".into());
    }
    let class = AnyClass::get(c"NSOpenPanel").ok_or("attachment_picker_unavailable")?;
    // Same documented AppKit panel as NSH's private file_requests module. runModal runs
    // AppKit's nested event loop; no filesystem work, hashing or upload is performed here.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class, openPanel];
        let _: () = msg_send![&panel, setCanChooseFiles: true];
        let _: () = msg_send![&panel, setCanChooseDirectories: false];
        let _: () = msg_send![&panel, setResolvesAliases: false];
        let _: () = msg_send![&panel, setAllowsMultipleSelection: true];
        if images {
            let types: Vec<_> = [
                "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "tif", "tiff", "bmp",
                "svg",
            ]
            .iter()
            .map(|s| NSString::from_str(s))
            .collect();
            let types = NSArray::from_retained_slice(&types);
            let _: () = msg_send![&panel, setAllowedFileTypes: &*types];
        }
        // A modal panel is application-modal; window presence is required, but the UI
        // owner remains responsible for serialization with other native presentations.
        let answer: isize = msg_send![&panel, runModal];
        if answer == 0 {
            return Ok(vec![]);
        }
        if answer != 1 {
            return Err("attachment_picker_failed".into());
        }
        let urls: Retained<NSArray<NSURL>> = msg_send![&panel, URLs];
        if urls.len() > super::COUNT_LIMIT {
            return Err("attachment_count_limit".into());
        }
        urls.iter()
            .map(|url| {
                if !url.isFileURL() {
                    return Err("attachment_not_local_file".into());
                }
                url.path()
                    .map(|s| PathBuf::from(s.to_string()))
                    .ok_or("attachment_invalid_path".into())
            })
            .collect()
    }
}

#[cfg(target_os = "windows")]
pub(super) unsafe fn pick(window: *mut std::ffi::c_void, images: bool) -> Result<Vec<PathBuf>> {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt};
    // Win32 common-dialog ABI. No shell command, user profile lookup or new crate dependency.
    #[repr(C)]
    struct OpenFileName {
        size: u32,
        owner: *mut c_void,
        instance: *mut c_void,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_directory: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_extension: *const u16,
        data: isize,
        hook: *mut c_void,
        template: *const u16,
        reserved: *mut c_void,
        reserved_size: u32,
        flags_ex: u32,
    }
    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetOpenFileNameW(value: *mut OpenFileName) -> i32;
        fn CommDlgExtendedError() -> u32;
    }
    if window.is_null() {
        return Err("attachment_window_unavailable".into());
    }
    let filter: Vec<u16> = if images {
        "Images\0*.jpg;*.jpeg;*.png;*.gif;*.webp;*.heic;*.heif;*.avif;*.tif;*.tiff;*.bmp;*.svg\0\0"
    } else {
        "All files\0*.*\0\0"
    }
    .encode_utf16()
    .collect();
    let mut buffer = vec![0u16; 32768];
    // SAFETY: zero is valid for all optional pointers/flags in OPENFILENAMEW.
    let mut dialog: OpenFileName = unsafe { std::mem::zeroed() };
    dialog.size = std::mem::size_of::<OpenFileName>() as u32;
    dialog.owner = window;
    dialog.filter = filter.as_ptr();
    dialog.file = buffer.as_mut_ptr();
    dialog.max_file = buffer.len() as u32;
    // EXPLORER | ALLOWMULTISELECT | FILEMUSTEXIST | PATHMUSTEXIST | NOCHANGEDIR | DONTADDTORECENT.
    dialog.flags = 0x00080000 | 0x00000200 | 0x00001000 | 0x00000800 | 0x00000008 | 0x02000000;
    if unsafe { GetOpenFileNameW(&mut dialog) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(vec![])
        } else {
            Err("attachment_picker_failed".into())
        };
    }
    let parts: Vec<_> = buffer
        .split(|c| *c == 0)
        .take_while(|v| !v.is_empty())
        .collect();
    if parts.is_empty() || parts.len() > super::COUNT_LIMIT + 1 {
        return Err("attachment_count_limit".into());
    }
    let first = PathBuf::from(std::ffi::OsString::from_wide(parts[0]));
    if parts.len() == 1 {
        return Ok(vec![first]);
    }
    parts[1..]
        .iter()
        .map(|name| {
            let name = PathBuf::from(std::ffi::OsString::from_wide(name));
            if name.components().count() != 1 || name.is_absolute() {
                return Err("attachment_invalid_path".into());
            }
            Ok(first.join(name))
        })
        .collect()
}

pub(super) fn sha256(bytes: &[u8]) -> Result<String> {
    let mut output = [0u8; 32];
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn CC_SHA256(data: *const std::ffi::c_void, len: u32, digest: *mut u8) -> *mut u8;
        }
        if bytes.len() > u32::MAX as usize {
            return Err("attachment_digest_failed".into());
        }
        // CommonCrypto is supplied by libSystem; no third-party hashing or content copies.
        if unsafe {
            CC_SHA256(
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                output.as_mut_ptr(),
            )
        }
        .is_null()
        {
            return Err("attachment_digest_failed".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::{ffi::c_void, ptr};
        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptOpenAlgorithmProvider(
                handle: *mut *mut c_void,
                name: *const u16,
                implementation: *const u16,
                flags: u32,
            ) -> i32;
            fn BCryptHash(
                handle: *mut c_void,
                secret: *const u8,
                secret_len: u32,
                input: *const u8,
                input_len: u32,
                output: *mut u8,
                output_len: u32,
            ) -> i32;
            fn BCryptCloseAlgorithmProvider(handle: *mut c_void, flags: u32) -> i32;
        }
        let name: Vec<u16> = "SHA256\0".encode_utf16().collect();
        let mut handle = ptr::null_mut();
        if bytes.len() > u32::MAX as usize
            || unsafe { BCryptOpenAlgorithmProvider(&mut handle, name.as_ptr(), ptr::null(), 0) }
                < 0
        {
            return Err("attachment_digest_failed".into());
        }
        let status = unsafe {
            BCryptHash(
                handle,
                ptr::null(),
                0,
                bytes.as_ptr(),
                bytes.len() as u32,
                output.as_mut_ptr(),
                32,
            )
        };
        unsafe {
            BCryptCloseAlgorithmProvider(handle, 0);
        }
        if status < 0 {
            return Err("attachment_digest_failed".into());
        }
    }
    Ok(output.iter().map(|b| format!("{b:02x}")).collect())
}
