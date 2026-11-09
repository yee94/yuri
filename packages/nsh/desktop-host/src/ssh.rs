//! Local SSH service. The existing Host actor injects storage and committed authority;
//! this module never opens another Vault or publishes a runtime lease of its own.
use serde_json::{Value, json};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

#[path = "ssh_process.rs"]
pub mod process;
#[path = "ssh_sync.rs"]
#[cfg(test)]
pub mod sync;
#[path = "ssh_io.rs"]
#[cfg(test)]
pub mod io;
#[cfg(test)]
#[path = "ssh_http.rs"]
pub mod http;
#[path = "ssh_actor.rs"]
pub mod actor;
#[path = "ssh_service.rs"]
pub mod service;
#[path = "ssh_owner.rs"]
mod owner;
pub use owner::Owner;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error { Invalid, Stale, Busy, Storage, CommitUnknown, Unavailable, Cancelled, Ssh, Runtime, Bootstrap, Authentication, #[cfg(test)] SyncUnknown }
impl Error {
    pub fn code(self) -> &'static str { match self {
        Self::Invalid => "ssh_invalid", Self::Stale => "ssh_stale", Self::Busy => "ssh_busy", Self::Storage => "ssh_storage",
        Self::CommitUnknown => "ssh_commit_unknown", Self::Unavailable => "ssh_unavailable", Self::Cancelled => "ssh_cancelled",
        Self::Ssh => "ssh_transport", Self::Runtime => "ssh_runtime", Self::Bootstrap => "ssh_bootstrap", Self::Authentication => "ssh_authentication", #[cfg(test)] Self::SyncUnknown => "ssh_sync_unknown",
    } }
}
/// Not Debug/Serialize: passwords and bearer material never enter a public snapshot.
pub struct Secret(String);
impl Secret {
    pub fn new(value: String) -> Result<Self> {
        if value.is_empty() || value.len() > 4096 || value.contains('\0') { return Err(Error::Invalid); }
        Ok(Self(value))
    }
    pub fn expose(&self) -> &str { &self.0 }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub id: String, pub label: String, pub host: String, pub user: String, pub port: u16,
    pub remote_port: u16, pub local_port: u16, pub managed: bool,
}
fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    value[key].as_str().filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).map(str::to_owned).ok_or(Error::Invalid)
}
pub fn identifier(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) }
pub fn app_version(value: &str) -> bool {
    if value.len() > 80 { return false; }
    let core = value.split(['-', '+']).next().unwrap_or("");
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3 && parts.iter().all(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        && value.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
}
fn exact(value: &Value, fields: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or(Error::Invalid)?;
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) { return Err(Error::Invalid); } Ok(())
}
impl Instance {
    pub fn parse(value: &Value) -> Result<Self> {
        exact(value, &["id", "label", "host", "user", "port", "remotePort", "localPort", "managed"])?;
        let id = text(value, "id", 128)?;
        let label = text(value, "label", 240)?;
        let host = text(value, "host", 253)?;
        let user = text(value, "user", 64)?;
        // Explicit direct targets only. No raw SSH options, command, URL, ProxyCommand or Relay descriptor.
        if !identifier(&id) || !host.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric) || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            || !user.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) || user.starts_with('-') { return Err(Error::Invalid); }
        let port = |key: &str, zero: bool| value[key].as_u64().filter(|n| *n <= 65535 && (zero || *n > 0)).map(|n| n as u16).ok_or(Error::Invalid);
        Ok(Self { id, label, host, user, port: port("port", false)?, remote_port: port("remotePort", false)?, local_port: port("localPort", true)?, managed: value["managed"].as_bool().ok_or(Error::Invalid)? })
    }
    pub fn public(&self) -> Value { json!({"id":self.id,"label":self.label,"host":self.host,"user":self.user,"port":self.port,"remotePort":self.remote_port,"localPort":self.local_port,"managed":self.managed}) }
}
#[derive(Clone)]
pub struct Cancellation { cancelled:Arc<AtomicBool>, parents:Arc<[Cancellation]> }
impl Default for Cancellation { fn default() -> Self { Self { cancelled:Arc::new(AtomicBool::new(false)), parents:Arc::from([]) } } }
impl Cancellation {
    pub fn cancel(&self) { self.cancelled.store(true, Ordering::Release); }
    pub fn check(&self) -> Result<()> { if self.cancelled.load(Ordering::Acquire) { return Err(Error::Cancelled); } for parent in self.parents.iter() { parent.check()?; } Ok(()) }
    #[cfg(test)]
    pub(crate) fn linked(&self, other:&Self)->Self { Self { parents:Arc::from([self.clone(),other.clone()]), ..Self::default() } }
}
pub struct Inspection { pub version: Option<String>, pub node_major: u64 }
pub trait Tunnel: Send { fn alive(&mut self) -> bool; fn close(&mut self); }
pub struct Forward { pub port: u16, pub tunnel: Box<dyn Tunnel> }
pub trait Driver: Send + Sync {
    fn inspect(&self, instance: &Instance, cancel: &Cancellation) -> Result<Inspection>;
    fn initialize(&self, instance: &Instance, version: &str, password: &Secret, cancel: &Cancellation) -> Result<()>;
    fn forward(&self, instance: &Instance, cancel: &Cancellation) -> Result<Forward>;
}
/// Opaque actor receipt, not a bearer or a JS-supplied scope. Retirement must compare it exactly.
#[derive(Clone)]
pub struct Committed { pub connection_id: String, pub receipt: String }
/// Rust-only capture for sync transport. It is neither a bearer nor a JS capability.
#[cfg(test)]
pub struct SyncGrant { pub instance: Instance, pub committed: Committed, pub cancel: Cancellation }
pub struct Registry { pub revision: u64, pub instances: Vec<Instance> }
pub trait ActorPort: Send + Sync {
    fn load(&self) -> Result<Registry>;
    /// CAS, preserving all other fields in the existing actor's secure record.
    fn save(&self, expected_revision: u64, instances: &[Instance]) -> Result<u64>;
    fn password(&self, instance: &Instance) -> Result<Secret>;
    /// Direct-only saved SSH endpoint. No Relay descriptor, credential, fallback or identity merging.
    fn restore(&self, instance: &Instance, cancel: &Cancellation) -> Result<Option<Committed>>;
    /// Authenticated probe + durable connection commit in the original actor. No JS token handoff.
    fn authorize(&self, instance: &Instance, local_port: u16, password: &Secret, cancel: &Cancellation) -> Result<Committed>;
    fn healthy(&self, receipt: &Committed) -> Result<bool>;
    fn retire(&self, receipt: &Committed) -> Result<()>;
    fn quarantine(&self);
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent { Connect, Restore, Check }

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
