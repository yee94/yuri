//! Host owner: independent tab events, never a close command.
//! Before AppView: `let tabs = desktop_tab::register(&components)?;`
//! Committed native publisher: `tabs.set_scope(scope.as_ref())?;` (same as terminal).
//! Mac UI after real window/content view:
//! `let observer = desktop_tab::install_observer(&tabs, &window, &view.view(), mtm)?;`
//! Win UI: `let observer = desktop_tab::install_observer(&tabs, hwnd)?;`
//! Existing Win window_proc: `desktop_tab::observe_window_message(hwnd,msg,wparam,lparam);`
//! then preserve its normal DefSubclassProc handling; do not install another subclass.
//! Existing UI loop: `observer.poll(actual_foreground, native_modal_blocked);`
//! Native modal gate includes actual picker/save/modal presentation, not JS guesses.
//! Retire authority synchronously: `tabs.set_scope(None)?;`
//! UI teardown: observer.retire(), drop observer BEFORE view.stop()/window destruction.
//! Mac local monitor always returns the original NSEvent; it never selects or closes.
//! JS binding is active/scope/lease/opaque owner/generation/layout revision/page rect.
//! Native event contains no tab id; the TS closure resolves its own authoritative id.
//! No component `command`, Host method, credentials, new window, child HWND or overlay.
//! Rects cannot describe the full occlusion tree: native+TS modal gates are both required.
//! Synthetic tests do not prove physical UI, macOS/Win32 clicks, focus/IME or DPI behavior.
#![allow(dead_code, unused_imports)]
#[path = "../src/desktop_tab.rs"]
mod desktop_tab;
#[cfg(target_os = "macos")]
#[path = "../src/desktop_tab_fixture.rs"]
mod fixture;
#[path = "../src/policy.rs"]
mod policy;
fn main() {
    #[cfg(target_os = "macos")]
    if let Err(error) = fixture::run() {
        panic!("{error}");
    }
}
