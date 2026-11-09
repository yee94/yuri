//! Mac metadata/ABI carrier only. The actual Windows renderer source is checked,
//! not a rewritten renderer. This NSH public surface shim does not emulate Win32
//! or validate its linker/SDK/runtime, and no Windows DLL is ever called.
#![allow(non_snake_case, dead_code)]
use serde_json::Value;
use std::rc::Rc;
pub mod Win32 {
    pub mod Foundation {
        #[derive(Clone, Copy)]
        pub struct HWND(pub *mut std::ffi::c_void);
    }
}
pub struct ComponentContext;
impl ComponentContext {
    pub fn emit(&self, _: &str, _: Value) {}
}
pub trait NativeComponent {
    fn window(&self) -> Option<Win32::Foundation::HWND> {
        None
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>);
    fn command(&mut self, _: &str, _: &Value) {}
}
pub struct Components;
impl Components {
    pub fn register(&self, _: &str, _: Rc<dyn Fn(ComponentContext) -> Box<dyn NativeComponent>>) {}
}
