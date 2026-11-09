//! Metadata-only harness. Uses the real Darwin Rust std, NOT a fabricated Windows std.
//! NSH/Win32 signatures below are audited stand-ins, not the real Windows crate or SDK.
//! Actual native_ui_windows.rs and browser_view_windows.rs are frontend-checked, never run.
#![allow(dead_code, non_snake_case, unused_imports)]
extern crate self as nsh_platform_windows;
use appearance::Inbox;
use serde_json::Value;
use std::{ffi::c_void, process::ExitCode, rc::Rc};

pub mod windows {
    pub mod Win32 {
        pub mod Foundation {
            use std::ffi::c_void;
            #[repr(transparent)]
            #[derive(Clone, Copy, Default, PartialEq, Eq)]
            pub struct HWND(pub *mut c_void);
            #[repr(transparent)]
            pub struct BOOL(pub i32);
            #[repr(transparent)]
            #[derive(Default)]
            pub struct WPARAM(pub usize);
            #[repr(transparent)]
            #[derive(Default)]
            pub struct LPARAM(pub isize);
            #[repr(C)]
            #[derive(Default)]
            pub struct POINT {
                pub x: i32,
                pub y: i32,
            }
        }
        pub mod Graphics {
            pub mod Gdi {
                #[repr(C)]
                pub struct LOGFONTW {
                    pub lfHeight: i32,
                    pub lfWidth: i32,
                    pub lfEscapement: i32,
                    pub lfOrientation: i32,
                    pub lfWeight: i32,
                    pub lfItalic: u8,
                    pub lfUnderline: u8,
                    pub lfStrikeOut: u8,
                    pub lfCharSet: u8,
                    pub lfOutPrecision: u8,
                    pub lfClipPrecision: u8,
                    pub lfQuality: u8,
                    pub lfPitchAndFamily: u8,
                    pub lfFaceName: [u16; 32],
                }
                impl Default for LOGFONTW {
                    fn default() -> Self {
                        unsafe { std::mem::zeroed() }
                    }
                }
            }
        }
        pub mod UI {
            pub mod WindowsAndMessaging {
                use super::super::{Foundation::*, Graphics::Gdi::LOGFONTW};
                #[repr(C)]
                #[derive(Default)]
                pub struct MSG {
                    pub hwnd: HWND,
                    pub message: u32,
                    pub wParam: WPARAM,
                    pub lParam: LPARAM,
                    pub time: u32,
                    pub pt: POINT,
                    pub lPrivate: u32,
                }
                #[repr(C)]
                #[derive(Default)]
                pub struct NONCLIENTMETRICSW {
                    pub cbSize: u32,
                    pub iBorderWidth: i32,
                    pub iScrollWidth: i32,
                    pub iScrollHeight: i32,
                    pub iCaptionWidth: i32,
                    pub iCaptionHeight: i32,
                    pub lfCaptionFont: LOGFONTW,
                    pub iSmCaptionWidth: i32,
                    pub iSmCaptionHeight: i32,
                    pub lfSmCaptionFont: LOGFONTW,
                    pub iMenuWidth: i32,
                    pub iMenuHeight: i32,
                    pub lfMenuFont: LOGFONTW,
                    pub lfStatusFont: LOGFONTW,
                    pub lfMessageFont: LOGFONTW,
                    pub iPaddedBorderWidth: i32,
                }
                pub unsafe fn GetMessageW(_: *mut MSG, _: Option<HWND>, _: u32, _: u32) -> BOOL {
                    unimplemented!("metadata-only")
                }
                pub unsafe fn TranslateMessage(_: *const MSG) -> BOOL {
                    unimplemented!("metadata-only")
                }
                pub unsafe fn DispatchMessageW(_: *const MSG) -> LRESULT {
                    unimplemented!("metadata-only")
                }
                pub struct LRESULT(pub isize);
            }
        }
    }
}
use windows::Win32::Foundation::HWND;
#[derive(Clone)]
pub struct ComponentContext;
impl ComponentContext {
    pub fn set_size(&self, _: f64, _: f64) {
        unimplemented!("metadata-only")
    }
    pub fn emit(&self, _: &str, _: Value) {
        unimplemented!("metadata-only")
    }
}
pub trait NativeComponent {
    fn window(&self) -> Option<HWND> {
        None
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>);
    fn command(&mut self, _: &str, _: &Value) {}
}
#[derive(Default)]
pub struct Components;
impl Components {
    pub fn register(&self, _: &str, _: Rc<dyn Fn(ComponentContext) -> Box<dyn NativeComponent>>) {
        unimplemented!("metadata-only")
    }
}
pub struct AppOptions {
    pub host: nsh_engine::HostChannel,
    pub app_id: String,
    pub components: Components,
    pub storage: Option<std::sync::Arc<dyn nsh_engine::StorageBackend>>,
}
struct Window {
    window_key: String,
    source: AppSource,
    options: AppOptions,
    inbox: Option<Inbox>,
    services: host_services::Port,
    dialogs: Dialogs,
    lifetime: Option<bridge::Owner>,
    persistence: Option<window_persistence::Port>,
    restored: Option<window_state::MainWindow>,
}
fn validate_windows(_: &[Window]) -> policy::Result<()> {
    unimplemented!("metadata-only")
}
mod bridge {
    pub mod process {
        pub struct ExitBarrier;
        impl ExitBarrier {
            pub fn poll(&mut self) -> bool {
                unimplemented!("metadata-only")
            }
        }
    }
    pub struct Owner;
    impl Owner {
        pub fn begin_shutdown(&mut self) {
            unimplemented!("metadata-only")
        }
        pub fn stopped(&self) -> bool {
            unimplemented!("metadata-only")
        }
    }
}
pub enum AppSource {
    Bundle(nsh_engine::Bundle),
    Rust(nsh_engine::Root),
}
pub use nsh_engine::App;
pub struct AppView;
impl AppView {
    pub fn new(_: Option<HWND>, _: AppOptions) -> Result<Rc<Self>, String> {
        unimplemented!("metadata-only")
    }
    pub fn hwnd(&self) -> HWND {
        unimplemented!("metadata-only")
    }
    pub fn set_theme_overrides(&self, _: Option<&str>) -> Result<(), String> {
        unimplemented!("metadata-only")
    }
    pub fn set_font_scale(&self, _: Option<f32>) {
        unimplemented!("metadata-only")
    }
    pub fn load(&self, _: App) {
        unimplemented!("metadata-only")
    }
    pub fn show(&self) {
        unimplemented!("metadata-only")
    }
    pub fn stop(&self) {
        unimplemented!("metadata-only")
    }
}
mod host_services {
    #[derive(Clone, Debug, PartialEq)]
    pub struct WindowCapture {
        pub record: Option<crate::window_state::MainWindow>,
        pub epoch: u64,
    }
    pub struct Reader;
    impl Reader {
        pub fn window_record(
            &self,
            _: &str,
            _: crate::window_geometry::Geometry,
        ) -> crate::policy::Result<WindowCapture> {
            unimplemented!("metadata-only")
        }
        pub fn window_capture_current(&self, _: &WindowCapture) -> bool {
            unimplemented!("metadata-only")
        }
    }
    #[derive(Clone)]
    pub struct Port;
    impl Port {
        pub fn writer_close_ready(&self) -> bool {
            unimplemented!("metadata-only")
        }
        pub fn approve_final_close(&self) {
            unimplemented!("metadata-only")
        }
        pub fn reader(&self) -> Reader {
            unimplemented!("metadata-only")
        }
        pub fn publish(&self, _: &serde_json::Value, _: &str, _: &str, _: &str, _: bool) {
            unimplemented!("metadata-only")
        }
        pub fn new(_: std::sync::Arc<dyn nsh_engine::Network>) -> Self {
            unimplemented!("metadata-only")
        }
        pub fn live(&self) -> bool {
            unimplemented!("metadata-only")
        }
        pub fn window_id(&self) -> crate::policy::Result<String> {
            unimplemented!("metadata-only")
        }
        pub fn set_runtime_suspended(&self, _: bool) {
            unimplemented!("metadata-only")
        }
        pub fn set_foreground(&self, _: bool) {
            unimplemented!("metadata-only")
        }
        pub fn tabs(&self) -> Option<crate::desktop_tab::Registration> {
            unimplemented!("metadata-only")
        }
        pub fn browser(&self) -> crate::browser_view::Port {
            unimplemented!("metadata-only")
        }
        pub fn shutdown(&self) {
            unimplemented!("metadata-only")
        }
        pub fn shutdown_complete(&self) -> bool {
            unimplemented!("metadata-only")
        }
    }
}
mod attachments {
    pub fn is_presenting() -> bool {
        unimplemented!("metadata-only")
    }
    pub struct Inbox;
    pub struct PickJob;
    impl Inbox {
        pub fn try_recv(&self) -> Option<PickJob> {
            unimplemented!("metadata-only")
        }
    }
    impl PickJob {
        pub unsafe fn show(self, _: *mut std::ffi::c_void) {
            unimplemented!("metadata-only")
        }
    }
}
mod documents {
    pub fn is_presenting() -> bool {
        unimplemented!("metadata-only")
    }
    pub struct Inbox;
    pub struct Job;
    impl Inbox {
        pub fn try_recv(&self) -> Option<Job> {
            unimplemented!("metadata-only")
        }
    }
    impl Job {
        pub unsafe fn show(self, _: *mut std::ffi::c_void) {
            unimplemented!("metadata-only")
        }
    }
}
mod diagnostics {
    pub fn is_presenting() -> bool {
        unimplemented!("metadata-only")
    }
    pub struct Inbox;
    pub struct Job;
    impl Inbox {
        pub fn try_recv(&self) -> Option<Job> {
            unimplemented!("metadata-only")
        }
    }
    impl Job {
        pub unsafe fn show(self, _: *mut std::ffi::c_void, _: &str) {
            unimplemented!("metadata-only")
        }
    }
}
struct Dialogs {
    picks: Option<attachments::Inbox>,
    saves: Option<documents::Inbox>,
    diagnostics: Option<diagnostics::Inbox>,
    notifications: Option<notifications::UiInbox>,
    downloads: Option<file_download::Inbox>,
}
mod file_download {
    pub struct Inbox;
    pub struct Job;
    pub fn is_presenting() -> bool {
        unimplemented!("metadata-only")
    }
    impl Inbox {
        pub fn try_recv(&self) -> Option<Job> {
            unimplemented!("metadata-only")
        }
    }
    impl Job {
        pub unsafe fn show(self, _: &str, _: *mut std::ffi::c_void) {
            unimplemented!("metadata-only")
        }
    }
}
mod notifications {
    pub type Store = Box<dyn store::Store>;
    pub mod store {
        pub trait Store: Send {
            fn load(&mut self) -> crate::policy::Result<Option<serde_json::Value>>;
            fn commit(&mut self, next: &serde_json::Value) -> crate::policy::Result<()>;
        }
        pub struct FileStore;
        impl FileStore {
            pub fn in_private_directory(_: &std::path::Path) -> crate::policy::Result<Self> {
                unimplemented!("metadata-only")
            }
        }
        impl Store for FileStore {
            fn load(&mut self) -> crate::policy::Result<Option<serde_json::Value>> {
                unimplemented!("metadata-only")
            }
            fn commit(&mut self, _: &serde_json::Value) -> crate::policy::Result<()> {
                unimplemented!("metadata-only")
            }
        }
    }
    pub struct UiInbox;
    pub struct Job;
    impl UiInbox {
        pub fn try_recv(&self) -> Option<Job> {
            unimplemented!("metadata-only")
        }
    }
    impl Job {
        pub unsafe fn run(self, _: *mut std::ffi::c_void) {
            unimplemented!("metadata-only")
        }
    }
}
mod notification_store_grant {
    pub fn native_granted(
        _: &str,
    ) -> crate::policy::Result<(std::path::PathBuf, crate::notifications::Store)> {
        unimplemented!("metadata-only")
    }
}
// Actual source modules and the Windows-selected browser core are inserted by the checker.
// __ACTUAL_MODULES__
const _: () = {
    use windows::Win32::{
        Graphics::Gdi::LOGFONTW,
        UI::WindowsAndMessaging::{MSG, NONCLIENTMETRICSW},
    };
    assert!(std::mem::size_of::<LOGFONTW>() == 92);
    assert!(std::mem::size_of::<NONCLIENTMETRICSW>() == 504);
    assert!(std::mem::size_of::<MSG>() == 48);
};
