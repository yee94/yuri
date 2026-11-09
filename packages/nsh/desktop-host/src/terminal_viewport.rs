//! Terminal-only native registration. The desktop Host actor publishes its
//! admitted scope here after successful authority transitions, never from JS.
//! No PTY, network, credential store or application navigation is owned here.
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[path = "terminal_document.rs"]
pub mod document;
pub const COMPONENT: &str = "yuri.terminal.viewport";
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Default)]
pub struct Registration {
    scope: Arc<Mutex<Option<Value>>>,
    prepared: bool,
}
impl Registration {
    pub(crate) fn prepared() -> Self {
        Self {
            prepared: true,
            ..Default::default()
        }
    }
    pub fn set_scope(&self, value: Option<&Value>) -> Result<()> {
        if value.is_some_and(|v| !scope(v)) {
            return Err("terminal_scope_invalid".into());
        }
        *self
            .scope
            .lock()
            .map_err(|_| "terminal_scope_unavailable")? = value.cloned();
        Ok(())
    }
    pub(crate) fn current(&self, expected: &Value) -> bool {
        scope(expected)
            && self
                .scope
                .lock()
                .is_ok_and(|v| v.as_ref() == Some(expected))
    }
    /// `prepared` is not renderer ready. Only an event from an actual initialized
    /// Ghostty/WASM instance can release the TS workspace construction gate.
    pub fn capabilities(&self, input: &Value) -> Result<Value> {
        if input.as_object().is_none_or(|v| v.len() != 1) || !self.current(&input["expectedHost"]) {
            return Err("terminal_scope_stale".into());
        }
        if !self.prepared {
            return Err("terminal_native_renderer_unavailable".into());
        }
        Ok(
            json!({"expectedHost":input["expectedHost"],"component":COMPONENT,"version":1,"native":true,"inline":true,"vt":true,"inputReceipts":true,"outputAcknowledgements":true,"hostAppearance":true,"selection":true,"ime":true,"bracketedPaste":true}),
        )
    }
    /// Install AFTER the generic bridge's unsupported handlers; scope admission
    /// remains native-owned through set_scope, and stale requests always reject.
    pub fn install_capability(&self, host: &nsh_engine::HostChannel) {
        let registration = self.clone();
        host.handle(
            "terminal.desktop.capabilities",
            move |mut call| match registration.capabilities(&call.take_data()) {
                Ok(value) => call.resolve(value),
                Err(error) => call.reject(error),
            },
        );
    }
}
fn scope(value: &Value) -> bool {
    crate::policy::scope(value).is_ok_and(|scope| scope == *value)
}
#[cfg(target_os = "macos")]
#[path = "terminal_viewport_macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::register;

#[cfg(target_os = "windows")]
#[path = "terminal_desktop_windows.rs"]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::register;
