
/// Arms exact-ID text font diagnostics in an explicitly enabled test SDK.
/// # Safety
/// `app` is a live embedding app; `ids` is a NUL-terminated UTF-8 JSON array.
#[cfg(feature = "font-diagnostics")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_text_font_diagnostics_begin(app: *mut NshApp, ids: *const c_char, generation: u64) -> *mut c_char {
    let _mtm = main_thread();
    // SAFETY: the embedding ABI requires a live app and NUL-terminated string.
    let app = unsafe { &*app };
    status(unsafe { utf8(ids, "diagnostic IDs") }.and_then(|ids| crate::font_diagnostics::begin(app.view.view(), ids, generation)))
}
/// Returns an owned diagnostic JSON string; free with `nsh_string_free`.
/// # Safety
/// `app` is a live embedding app, called on the main thread.
#[cfg(feature = "font-diagnostics")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_text_font_diagnostics_read(app: *mut NshApp, generation: u64) -> *mut c_char {
    let _mtm = main_thread();
    // SAFETY: the embedding ABI requires a live app.
    let app = unsafe { &*app };
    match crate::font_diagnostics::snapshot(app.view.view(), generation) {
        Ok(json) => error(json),
        Err(message) => error(serde_json::json!({"error":message}).to_string()),
    }
}
/// Stops this app's test capture without changing its rendered content.
/// # Safety
/// `app` is a live embedding app, called on the main thread.
#[cfg(feature = "font-diagnostics")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_text_font_diagnostics_stop(app: *mut NshApp) {
    let _mtm = main_thread();
    // SAFETY: the embedding ABI requires a live app.
    let app = unsafe { &*app };
    crate::font_diagnostics::stop(app.view.view());
}
