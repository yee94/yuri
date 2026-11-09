//! Native-only, bounded event recorder. Install after bridge fallback; no Vault restore.
use crate::policy::Result;
use nsh_engine::{HostChannel, HostReply};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, Ordering}}};
#[path = "diagnostics_schema.rs"]
mod schema;
#[path = "diagnostics_export.rs"]
mod export;
#[path = "diagnostics_native.rs"]
mod native;
// The existing safe-save implementation is compiled unchanged into this owner.
// Its pub(super) types belong to each owner; reuse the audited source without
// widening documents' private visibility or creating a second implementation.
#[allow(clippy::duplicate_mod)]
#[path = "documents_files.rs"]
mod files;
#[cfg(any(target_os = "windows", test))]
#[allow(clippy::duplicate_mod)]
#[path = "documents_windows_abi.rs"]
mod windows_abi;

pub const METHODS: &[&str] = &["native.diagnostics.status", "native.diagnostics.setEnabled", "native.diagnostics.append", "native.diagnostics.export"];
/// Rust-only committed authority; never construct from a HostChannel payload.
#[derive(Clone, PartialEq, Eq)]
pub struct Scope {
    host_id: String,
    runtime_lease: String,
    authorization_id: String,
    window_id: String,
}
impl Scope {
    pub fn committed(expected_host: &Value, authorization_id: &str, window_id: &str) -> Result<Self> {
        let scope = crate::policy::scope(expected_host)?;
        for id in [authorization_id, window_id] {
            if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
                return Err("diagnostics_authority_invalid".into());
            }
        }
        Ok(Self { host_id: scope["hostID"].as_str().unwrap().into(), runtime_lease: scope["lease"].as_str().unwrap().into(),
            authorization_id: authorization_id.into(), window_id: window_id.into() })
    }
}
/// Must read the SAME native actor publication (including authorization + window).
/// None means no live runtime; not temporary AppKit/Win32 dialog deactivation.
pub type Capture = Arc<dyn Fn() -> Option<Scope> + Send + Sync>;
/// Native metadata only. Missing data loads false; corrupt/inaccessible/unknown
/// data MUST return Err, not false. Ok from save proves the exact bool committed.
/// Never store events, credentials, paths or call back into Host/services here.
/// Calls are serialized under the recorder gate; implementations must be bounded.
pub trait Preference: Send {
    fn load(&mut self) -> Result<bool>;
    fn save(&mut self, enabled: bool) -> Result<()>;
}
#[derive(Default)]
enum PreferenceState {
    #[default]
    ProcessLocal,
    Ready,
    LoadFailed,
    SaveFailed,
}
impl PreferenceState {
    fn name(&self) -> &'static str {
        match self {
            Self::ProcessLocal => "process-local",
            Self::Ready => "ready",
            Self::LoadFailed => "load-failed",
            Self::SaveFailed => "save-failed",
        }
    }
}
#[derive(Default)]
struct Book {
    enabled: bool,
    stopped: bool,
    epoch: u64,
    scope: Option<Scope>,
    lease: Option<String>,
    ring: VecDeque<String>,
    bytes: usize,
    dropped: u64,
    export: Option<Arc<Mutex<Option<HostReply>>>>,
    cancelled: Option<Arc<AtomicBool>>,
    // Unknown disk commit is sticky: schema 2 has no export receipt/retry protocol.
    unknown: bool,
    preference: Option<Box<dyn Preference>>,
    preference_state: PreferenceState,
}
impl Book {
    fn clear(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.scope = None; self.lease = None; self.ring.clear(); self.bytes = 0; self.dropped = 0;
        if let Some(cancelled) = &self.cancelled { cancelled.store(true, Ordering::Release); }
        // Keep the slot until the old queued/modal/writing Job actually releases it.
        if let Some(reply) = &self.export { settle(reply, json!({"outcome":"cancelled"})); }
    }
    fn status(&self) -> Value {
        json!({"schemaVersion":2,"mode":"event-recorder","enabled":self.enabled,"recordingLease":self.lease,
            "eventCount":self.ring.len(),"maxEntries":schema::MAX_ENTRIES,"maxBytes":schema::MAX_BYTES,
            "preferenceState":self.preference_state.name()})
    }
    fn set_enabled(&mut self, enabled: bool) -> Result<Value> {
        if !enabled {
            // Consent withdrawal takes effect BEFORE any metadata I/O, even if
            // the save fails or an export is already queued/modal/staged.
            let scope = self.scope.clone();
            self.enabled = false;
            self.clear();
            self.scope = scope;
            if let Some(preference) = &mut self.preference {
                if preference.save(false).is_err() {
                    self.preference_state = PreferenceState::SaveFailed;
                    return Err("diagnostics_preference_save_failed".into());
                }
                self.preference_state = PreferenceState::Ready;
            }
            return Ok(self.status());
        }
        if self.export.is_some() { return Err("diagnostics_export_busy".into()); }
        if matches!(self.preference_state, PreferenceState::LoadFailed) {
            return Err("diagnostics_preference_load_failed".into());
        }
        if self.enabled {
            if self.scope.is_some() && self.lease.is_none() { self.lease = Some(crate::vault::id()?); }
            return Ok(self.status());
        }
        // A failed RNG must not save consent that this request cannot activate.
        let lease = if self.scope.is_some() { Some(crate::vault::id()?) } else { None };
        if let Some(preference) = &mut self.preference {
            if preference.save(true).is_err() {
                self.preference_state = PreferenceState::SaveFailed;
                return Err("diagnostics_preference_save_failed".into());
            }
            self.preference_state = PreferenceState::Ready;
        }
        let scope = self.scope.clone();
        self.clear(); self.scope = scope; self.enabled = true; self.lease = lease;
        Ok(self.status())
    }
    fn append(&mut self, input: &Value) -> Result<Value> {
        if !self.enabled || self.lease.as_deref() != input["lease"].as_str() || self.scope.as_ref().is_none_or(|s| Some(s.host_id.as_str()) != input["hostID"].as_str()) {
            return Err("diagnostics_lease_stale".into());
        }
        let (events, dropped) = schema::events(input)?;
        self.dropped = self.dropped.saturating_add(dropped).min(9_007_199_254_740_991);
        for event in events {
            while self.ring.len() >= schema::MAX_ENTRIES || self.bytes + event.len() > schema::MAX_BYTES {
                let old = self.ring.pop_front().expect("bounded validated event");
                self.bytes -= old.len(); self.dropped = self.dropped.saturating_add(1).min(9_007_199_254_740_991);
            }
            self.bytes += event.len(); self.ring.push_back(event);
        }
        Ok(json!({"accepted":true}))
    }
    fn report(&self, snapshot: &Value, client: &Value) -> Result<Vec<u8>> {
        let context = schema::context(snapshot, client)?;
        let events: Vec<Value> = self.ring.iter().map(|r| serde_json::from_str(r).expect("validated native row")).collect();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "diagnostics_clock_failed")?.as_millis();
        let report = json!({"schema":"yuri.client-diagnostics.v1","kind":"nsh-client-diagnostics","mode":"event-recorder",
            "exportedAt":now as u64,"feats":if events.is_empty() {vec![]} else {vec!["transcript"]},
            "eventCount":events.len(),"events":events,"dropped":self.dropped,"context":context,
            "coverage":"runtime-global-and-chat-events-content-free","maxEntries":schema::MAX_ENTRIES,"maxBytes":schema::MAX_BYTES});
        let data = serde_json::to_vec(&report).map_err(|_| "diagnostics_export_failed")?;
        if data.len() > schema::MAX_EXPORT_BYTES { return Err("diagnostics_export_limit".into()); }
        Ok(data)
    }
}
fn settle(reply: &Arc<Mutex<Option<HostReply>>>, result: Value) {
    if let Some(reply) = reply.lock().unwrap_or_else(|e| e.into_inner()).take() { reply.resolve(result); }
}
pub struct Owner { book: Arc<Mutex<Book>> }
impl Owner {
    /// Call synchronously BEFORE publishing a new Host/runtime lease/authorization/window,
    /// or true background suspension. Uses the same gate as final disk commit.
    pub fn invalidate(&self) { self.book.lock().unwrap_or_else(|e| e.into_inner()).clear(); }
}
impl Drop for Owner {
    fn drop(&mut self) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        book.stopped = true; book.clear();
    }
}
#[derive(Clone)]
pub struct Port(mpsc::SyncSender<Job>);
pub struct Inbox(mpsc::Receiver<Job>);
impl Inbox { pub fn try_recv(&self) -> Option<Job> { self.0.try_recv().ok() } }
pub fn channel() -> (Port, Inbox) { let (tx,rx) = mpsc::sync_channel(1); (Port(tx),Inbox(rx)) }
pub fn is_presenting() -> bool { native::presenting() }
pub use export::Job;
enum Action {
    Reply(Value),
    Export { data: Vec<u8>, count: usize, epoch: u64 },
}

/// Client version/build are native bundle metadata, not JS or another Host's version.
/// Preference is process-local/default OFF; no disk preferences, permissions or dialogs here.
pub fn install(host: &HostChannel, capture: Capture, port: Port, version: Value, build: Value) -> Owner {
    install_with_preference(host, capture, port, version, build, None)
}

/// Loads once, without writes. Failed load installs a disabled, explicit-error
/// owner, rather than silently granting recording or falling back to another store.
pub fn install_with_preference(host: &HostChannel, capture: Capture, port: Port, version: Value, build: Value, mut preference: Option<Box<dyn Preference>>) -> Owner {
    let (enabled, preference_state) = match preference.as_mut().map(|p| p.load()) {
        Some(Ok(enabled)) => (enabled, PreferenceState::Ready),
        Some(Err(_)) => (false, PreferenceState::LoadFailed),
        None => (false, PreferenceState::ProcessLocal),
    };
    let book = Book { enabled, preference_state, preference, ..Book::default() };
    install_book(host, capture, port, version, build, book)
}

fn install_book(host: &HostChannel, capture: Capture, port: Port, version: Value, build: Value, initial: Book) -> Owner {
    let book = Arc::new(Mutex::new(initial));
    let client = schema::client(&version, &build);
    for &method in METHODS {
        let book = book.clone(); let capture = capture.clone(); let port = port.clone(); let client = client.clone();
        host.handle(method, move |mut call| {
            let input = call.take_data();
            let Some(reply) = call.into_reply() else { return };
            let result = (|| -> Result<Action> {
                // Device consent withdrawal never depends on Host capture, RNG,
                // current runtime authorization or an in-flight export finishing.
                if method == "native.diagnostics.setEnabled" {
                    schema::exact(&input, &["enabled"])?;
                    let enabled = input["enabled"].as_bool().ok_or("diagnostics_invalid_schema")?;
                    if !enabled {
                        let mut locked = book.lock().map_err(|_| "diagnostics_owner_unavailable")?;
                        if locked.stopped { return Err("diagnostics_scope_retired".into()); }
                        return Ok(Action::Reply(locked.set_enabled(false)?));
                    }
                }
                // Capture outside the gate: actor retirement holds its publisher lock.
                // Epoch fences an old capture racing invalidate; no inverse lock order.
                let epoch = book.lock().map_err(|_| "diagnostics_owner_unavailable")?.epoch;
                let scope = capture();
                let mut locked = book.lock().map_err(|_| "diagnostics_owner_unavailable")?;
                if locked.stopped || locked.epoch != epoch { return Err("diagnostics_scope_retired".into()); }
                if locked.scope != scope {
                    locked.clear(); locked.scope = scope;
                }
                // Disable must not depend on minting a replacement recording lease.
                if method != "native.diagnostics.setEnabled" && locked.enabled && locked.scope.is_some() && locked.lease.is_none() { locked.lease = Some(crate::vault::id()?); }
                match method {
                    "native.diagnostics.status" => {
                        if !input.is_null() { schema::exact(&input, &[])?; }
                        Ok(Action::Reply(locked.status()))
                    }
                    "native.diagnostics.setEnabled" => {
                        schema::exact(&input, &["enabled"])?;
                        let enabled = input["enabled"].as_bool().ok_or("diagnostics_invalid_schema")?;
                        Ok(Action::Reply(locked.set_enabled(enabled)?))
                    }
                    "native.diagnostics.append" => Ok(Action::Reply(locked.append(&input)?)),
                    "native.diagnostics.export" => {
                        schema::exact(&input, &["hostID", "snapshot"])?;
                        let host_id = schema::text(&input, "hostID", 256)?;
                        if !locked.enabled { return Err("diagnostics_disabled".into()); }
                        if locked.unknown { return Err("diagnostics_write_unknown".into()); }
                        if locked.export.is_some() { return Err("diagnostics_export_busy".into()); }
                        if locked.scope.as_ref().is_none_or(|s| s.host_id != host_id) { return Err("diagnostics_scope_retired".into()); }
                        let data = locked.report(&input["snapshot"], &client)?;
                        // Reply ownership moves below, after admission has succeeded.
                        Ok(Action::Export { data, count: locked.ring.len(), epoch: locked.epoch })
                    }
                    _ => unreachable!(),
                }
            })();
            match result {
                Ok(Action::Export { data, count, epoch }) => {
                    // Re-check capture epoch while installing the mailbox item.
                    let mut locked = book.lock().unwrap_or_else(|e| e.into_inner());
                    if locked.stopped || epoch != locked.epoch || locked.export.is_some() {
                        reply.resolve(json!({"outcome":"cancelled"})); return;
                    }
                    let shared_reply = Arc::new(Mutex::new(Some(reply)));
                    let cancelled = Arc::new(AtomicBool::new(false));
                    locked.export = Some(shared_reply.clone());
                    locked.cancelled = Some(cancelled.clone());
                    let job = Job::new(book.clone(), capture.clone(), locked.scope.clone().unwrap(), locked.epoch, data,
                        count, shared_reply, cancelled);
                    drop(locked);
                    if let Err(mpsc::TrySendError::Full(mut job) | mpsc::TrySendError::Disconnected(mut job)) = port.0.try_send(job) {
                        job.finish("failed", Some("diagnostics_ui_unavailable"));
                    }
                }
                Ok(Action::Reply(value)) => reply.resolve(value),
                Err(error) if method == "native.diagnostics.export" => reply.resolve(json!({"outcome":"failed","error":error})),
                Err(error) => reply.reject(error),
            }
        });
    }
    Owner { book }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "diagnostics_preference_tests.rs"]
mod preference_tests;
