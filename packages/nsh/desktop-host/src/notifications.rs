//! Independent notification slice. Install after the generic bridge; no credential/HTTP access.
//! The worker, not Engine/UI callbacks, owns OS waits. See desktop-notifications.md for integration.
#[cfg(target_os = "macos")]
#[path = "notifications_macos.rs"]
pub mod macos;
#[path = "notifications_policy.rs"]
pub mod policy;
#[path = "notifications_store.rs"]
pub mod store;
#[cfg(target_os = "windows")]
#[path = "notifications_windows.rs"]
pub mod windows;
use nsh_engine::{HostChannel, HostReply};
use policy::{INVALID, Result, STALE, UNAVAILABLE};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const METHODS: &[&str] = &[
    "notification.status",
    "notification.request",
    "notification.openSettings",
    "notification.configure",
    "notification.live",
    "notification.test",
    "notification.launch.peek",
    "notification.launch.claim",
    "notification.launch.ack",
];
/// Created only by the native connection actor after durable authorization commit. No bearer/origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub host_id: String,
    pub authorization_id: String,
    pub runtime_lease: String,
}
impl Identity {
    fn validate(&self) -> Result<()> {
        for s in [&self.host_id, &self.authorization_id, &self.runtime_lease] {
            policy::id(&json!(s), 128)?;
        }
        if self.authorization_id == "legacy" {
            return Err(STALE.into());
        }
        Ok(())
    }
}
/// Native driver created ON the worker, including COM apartment initialization. No UI callbacks
/// may block waiting for this worker. `add` means accepted/unknown, never visible/delivered.
pub trait Driver {
    fn status(&mut self) -> Result<Value>;
    fn request(&mut self, current: &dyn Fn() -> bool) -> Result<Value>;
    fn add(&mut self, receipt: &str, title: &str, body: &str) -> Result<()>;
    /// Must verify absence. A void OS remove is not retirement completion evidence.
    fn remove(&mut self, receipts: &[String]) -> Result<()>;
}
pub type Factory = Box<dyn FnOnce(Activation) -> Result<Box<dyn Driver>> + Send>;
pub type Store = Box<dyn store::Store>;
pub struct UiJob {
    reply: Option<HostReply>,
    receipt: Option<String>,
    shared: Arc<Shared>,
    generation: u64,
}
pub struct UiInbox(mpsc::Receiver<UiJob>);
impl UiInbox {
    pub fn try_recv(&self) -> Option<UiJob> {
        self.0.try_recv().ok()
    }
}
impl UiJob {
    /// Only explicit openSettings; execute on native UI thread, outside borrowed pump state.
    /// `window` is the live owning NSWindow*/HWND, never a JS value. An activation only focuses
    /// this window; routing/Host selection remains exclusively in the existing TS root.
    pub unsafe fn run(self, window: *mut std::ffi::c_void) {
        if let Some(receipt) = self.receipt.as_ref() {
            if self.shared.stopped.load(Ordering::Acquire) {
                return;
            }
            // A durable ACK can hold the Store lock. UI focus must defer, not wait for disk.
            let active = match self.shared.inbox.try_lock() {
                Ok(inbox) => Some(inbox.active(receipt)),
                Err(std::sync::TryLockError::WouldBlock) => None,
                Err(std::sync::TryLockError::Poisoned(_)) => Some(false),
            };
            let Some(active) = active else {
                let ui = self.shared.ui.clone();
                let _ = ui.try_send(self);
                return;
            };
            if !active || self.shared.stopped.load(Ordering::Acquire) {
                return;
            }
            #[cfg(target_os = "macos")]
            let _ = unsafe { macos::focus_window(window) };
            #[cfg(target_os = "windows")]
            let _ = unsafe { windows::focus_window(window) };
            return;
        }
        let Some(reply) = self.reply else {
            return;
        };
        if self.shared.stopped.load(Ordering::Acquire)
            || !self.shared.foreground.load(Ordering::Acquire)
            || self.generation != self.shared.generation.load(Ordering::Acquire)
        {
            reply.reject(STALE);
            return;
        }
        #[cfg(target_os = "macos")]
        let result = macos::open_settings();
        #[cfg(target_os = "windows")]
        let result = windows::open_settings();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let result: Result<()> = Err("notification_unsupported".into());
        match result {
            Ok(()) => reply.resolve(Value::Null),
            Err(e) => reply.reject(e),
        }
    }
}
struct Shared {
    stopped: Arc<AtomicBool>,
    foreground: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    identity: Mutex<Option<Identity>>,
    inbox: Mutex<Inbox>,
    host: HostChannel,
    ui: mpsc::SyncSender<UiJob>,
}
/// Native UI lifecycle handle only: no Owner/identity/Store/HostChannel/window ownership.
/// Clone once when installing the native UI; its methods never acquire a mutex, perform I/O,
/// enqueue work or wait for ACK/OS completion. Stop is terminal and dominates foreground.
#[derive(Clone)]
pub struct Control {
    stopped: Arc<AtomicBool>,
    foreground: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}
impl Control {
    pub fn set_foreground(&self, foreground: bool) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        self.foreground.store(foreground, Ordering::Release);
        // Close the setter/shutdown race without a retry loop or a UI-visible lock.
        if self.stopped.load(Ordering::Acquire) {
            self.foreground.store(false, Ordering::Release);
        }
    }
    /// Logical fence only, not OS cleanup/join or a claim that an admitted ACK was rolled back.
    pub fn shutdown(&self) {
        let already_stopped = self.stopped.swap(true, Ordering::AcqRel);
        self.foreground.store(false, Ordering::Release);
        if !already_stopped {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}
/// Cloneable OS ingress. Only UUID receipt + exact system action; never trusts an OS route.
#[derive(Clone)]
pub struct Activation(Arc<Shared>);
impl Activation {
    pub fn receive(&self, receipt: &str) -> Result<bool> {
        if !policy::uuid(receipt) {
            return Err(INVALID.into());
        }
        let accepted = self
            .0
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .receive(receipt)?;
        if accepted {
            let _ = self.0.ui.try_send(UiJob {
                reply: None,
                receipt: Some(receipt.into()),
                shared: self.0.clone(),
                generation: self.0.generation.load(Ordering::Acquire),
            });
            let _ = self.0.host.send("notification.launch.available", json!({}));
        }
        Ok(accepted)
    }
    /// Foreground delegate must re-check immediately before presenting; no implicit authorization.
    pub fn may_present(&self, receipt: &str) -> bool {
        self.allowed(receipt, true)
    }
    pub fn current_submission(&self, receipt: &str) -> bool {
        self.allowed(receipt, false)
    }
    fn allowed(&self, receipt: &str, presentation: bool) -> bool {
        let s = &self.0;
        if s.stopped.load(Ordering::Acquire) {
            return false;
        }
        let Ok(identity) = s.identity.lock() else {
            return false;
        };
        let Ok(inbox) = s.inbox.lock() else {
            return false;
        };
        let Some(row) = inbox.root["rows"]
            .as_array()
            .and_then(|r| r.iter().find(|r| r["record"]["receipt"] == receipt))
        else {
            return false;
        };
        !s.stopped.load(Ordering::Acquire)
            && !inbox.poisoned
            && identity.as_ref().is_some_and(|i| {
                row["record"]["connectionID"] == i.host_id
                    && row["record"]["authorizationID"] == i.authorization_id
            })
            && row["retired"] != true
            && row["generation"].as_u64() == Some(s.generation.load(Ordering::Acquire))
            && (!presentation
                || row["test"] == true
                || !s.foreground.load(Ordering::Acquire)
                || row["mode"] == "always")
    }
}
pub struct Owner {
    shared: Arc<Shared>,
    tx: mpsc::SyncSender<Command>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Owner {
    pub fn control(&self) -> Control {
        Control {
            stopped: self.shared.stopped.clone(),
            foreground: self.shared.foreground.clone(),
            generation: self.shared.generation.clone(),
        }
    }
    /// UI owner publishes actual native application activity, never JS guesses/minimize heuristics.
    pub fn set_foreground(&self, foreground: bool) {
        self.control().set_foreground(foreground);
    }
    /// Synchronous fence BEFORE changing native runtime authority; no I/O, no waiting for OS add.
    pub fn publish(&self, identity: Option<Identity>) -> Result<()> {
        if let Some(i) = &identity {
            i.validate()?;
        }
        let mut current = self.shared.identity.lock().map_err(|_| UNAVAILABLE)?;
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(STALE.into());
        }
        self.shared.generation.fetch_add(1, Ordering::AcqRel);
        *current = identity;
        if self.shared.stopped.load(Ordering::Acquire) {
            *current = None;
            return Err(STALE.into());
        }
        Ok(())
    }
    /// Optional native lifecycle ingress; installed platform delegates already receive their
    /// Activation from the factory, so production need not obtain this additional handle.
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "optional native lifecycle ingress")
    )]
    pub fn activation(&self) -> Activation {
        Activation(self.shared.clone())
    }
    /// Only explicit revoke/re-authorize/remove, NOT a lease/foreground change. Completes only
    /// after durable tombstone and real OS absence readback. Failed cleanup remains retryable.
    /// Optional combined operation: journaled Host actors use the split commit/cleanup seam.
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "optional combined retirement wrapper; production may use split handoff"
        )
    )]
    pub fn retire_authorization(
        &self,
        host: &str,
        authorization: &str,
    ) -> Result<mpsc::Receiver<Result<()>>> {
        self.commit_retirement(host, authorization)?;
        self.retry_retirement_cleanup(host, authorization)
    }
    /// Durable native deny barrier ONLY, independent of the OS driver and worker mailbox.
    /// A connection actor may clear its cross-store retirement intent after this returns Ok,
    /// not after OS cleanup. Idempotent replay never requests permission or replays connect.
    pub fn commit_retirement(&self, host: &str, authorization: &str) -> Result<()> {
        validate_retirement(host, authorization)?;
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(STALE.into());
        }
        {
            let mut current = self.shared.identity.lock().map_err(|_| UNAVAILABLE)?;
            if self.shared.stopped.load(Ordering::Acquire) {
                return Err(STALE.into());
            }
            if current
                .as_ref()
                .is_some_and(|i| i.host_id == host && i.authorization_id == authorization)
            {
                self.shared.generation.fetch_add(1, Ordering::AcqRel);
                *current = None;
            }
        }
        self.shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .retire(host, authorization)
    }
    /// OS cleanup ONLY for an already durable tombstone. The ready empty result does not
    /// consult a driver or enqueue work. Non-empty unsupported cleanup remains retryable.
    pub fn retry_retirement_cleanup(
        &self,
        host: &str,
        authorization: &str,
    ) -> Result<mpsc::Receiver<Result<()>>> {
        validate_retirement(host, authorization)?;
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(STALE.into());
        }
        let empty = self
            .shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .cleanup_empty(host, authorization)?;
        let (tx, rx) = mpsc::sync_channel(1);
        if empty {
            let _ = tx.try_send(Ok(()));
            return Ok(rx);
        }
        self.tx
            .try_send(Command::Retire(host.into(), authorization.into(), tx))
            .map_err(|_| UNAVAILABLE)?;
        Ok(rx)
    }
    /// Pending OS cleanup lives in this Store after the connection actor has cleared its
    /// Vault intent. A failed/unsupported driver never makes that durable retry list empty.
    pub fn pending_retirement_cleanups(&self) -> Result<Vec<(String, String)>> {
        let inbox = self.shared.inbox.lock().map_err(|_| UNAVAILABLE)?;
        if inbox.poisoned {
            return Err(UNAVAILABLE.into());
        }
        let mut pending = Vec::new();
        for row in inbox.root["rows"].as_array().ok_or(INVALID)? {
            if row["retired"] != true {
                continue;
            }
            let pair = (
                row["record"]["connectionID"]
                    .as_str()
                    .ok_or(INVALID)?
                    .to_owned(),
                row["record"]["authorizationID"]
                    .as_str()
                    .ok_or(INVALID)?
                    .to_owned(),
            );
            if !pending.contains(&pair) {
                pending.push(pair);
            }
        }
        Ok(pending)
    }
    pub fn shutdown(&mut self) {
        self.control().shutdown();
        // Do not join on the UI thread. The worker owns/finishes the in-flight OS operation,
        // removes late notifications, rejects queued calls, and drops its COM/UN owner itself.
        self.worker.take();
    }
}
fn validate_retirement(host: &str, authorization: &str) -> Result<()> {
    policy::id(&json!(host), 128)?;
    policy::id(&json!(authorization), 128)?;
    if authorization == "legacy" {
        return Err(INVALID.into());
    }
    Ok(())
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.shutdown();
    }
}
enum Command {
    Call(&'static str, Value, HostReply, u64),
    Retire(String, String, mpsc::SyncSender<Result<()>>),
}
pub fn install(host: &HostChannel, storage: Store, factory: Factory) -> Result<(Owner, UiInbox)> {
    let inbox = Inbox::load(storage)?;
    let (tx, rx) = mpsc::sync_channel(32);
    let (ui, ui_rx) = mpsc::sync_channel(4);
    let shared = Arc::new(Shared {
        stopped: Arc::new(AtomicBool::new(false)),
        foreground: Arc::new(AtomicBool::new(false)),
        generation: Arc::new(AtomicU64::new(1)),
        identity: Mutex::new(None),
        inbox: Mutex::new(inbox),
        host: host.clone(),
        ui: ui.clone(),
    });
    let state = shared.clone();
    let (ready, initialized) = mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("yuri-notifications".into())
        .spawn(move || {
            let mut driver = native_pool(|| factory(Activation(state.clone())));
            let _ = ready.try_send(());
            let mut engine = Engine {
                shared: state.clone(),
                configuration: None,
                lease: String::new(),
                generation: 0,
                seen: VecDeque::new(),
                claims: HashMap::new(),
            };
            // One startup recovery attempt, not a timer/poll. Tombstones survive unsupported OS,
            // denied cleanup and crashes. No authorization request or notification send here.
            let retirements: Vec<String> = state
                .inbox
                .lock()
                .ok()
                .into_iter()
                .flat_map(|inbox| {
                    inbox.root["rows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|r| r["retired"] == true)
                        .filter_map(|r| r["record"]["receipt"].as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .collect();
            if !retirements.is_empty()
                && let Ok(driver) = &mut driver
                && native_pool(|| driver.remove(&retirements)).is_ok()
                && let Ok(mut inbox) = state.inbox.lock()
            {
                let _ = inbox.finish_retired(&retirements);
            }
            loop {
                let command = match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(v) => v,
                    Err(mpsc::RecvTimeoutError::Timeout)
                        if !state.stopped.load(Ordering::Acquire) =>
                    {
                        continue;
                    }
                    Err(_) => break,
                };
                match command {
                    Command::Call(name, body, reply, generation) => {
                        if state.stopped.load(Ordering::Acquire) {
                            reply.reject(STALE);
                            continue;
                        }
                        if name == "notification.openSettings" {
                            if policy::keys(&body, &[]).is_err() {
                                reply.reject(INVALID);
                            } else if !state.foreground.load(Ordering::Acquire) {
                                reply.reject(UNAVAILABLE);
                            } else if ui
                                .try_send(UiJob {
                                    reply: Some(reply),
                                    receipt: None,
                                    shared: state.clone(),
                                    generation,
                                })
                                .is_err()
                            { /* dropped HostReply rejects */
                            }
                            continue;
                        }
                        let result =
                            native_pool(|| engine.call(name, body, generation, &mut driver));
                        match result {
                            Ok(v) => reply.resolve(v),
                            Err(e) => reply.reject(e),
                        }
                    }
                    Command::Retire(h, a, reply) => {
                        let result = native_pool(|| engine.cleanup_available(&mut driver, &h, &a));
                        let _ = reply.try_send(result);
                    }
                }
            }
            // Physical metadata retirement may wait, but only on this worker, never the UI
            // Control. In-flight durable writes settle; normal launch receipts stay intact.
            if let Ok(mut identity) = state.identity.lock() {
                *identity = None;
            }
            native_pool(|| drop(driver));
        })
        .map_err(|_| UNAVAILABLE)?;
    if initialized.recv_timeout(Duration::from_secs(5)).is_err() {
        shared.stopped.store(true, Ordering::Release);
        return Err(UNAVAILABLE.into());
    }
    for &method in METHODS {
        let tx = tx.clone();
        let state = Arc::downgrade(&shared);
        host.handle(method, move |mut call| {
            let body = call.take_data();
            let Some(reply) = call.into_reply() else {
                return;
            };
            let Some(state) = state.upgrade() else {
                reply.reject(STALE);
                return;
            };
            if state.stopped.load(Ordering::Acquire) {
                reply.reject(STALE);
                return;
            }
            if body.to_string().len() > 32 * 1024 {
                reply.reject(INVALID);
                return;
            }
            let command = Command::Call(
                method,
                body,
                reply,
                state.generation.load(Ordering::Acquire),
            );
            if let Err(
                mpsc::TrySendError::Full(Command::Call(_, _, reply, _))
                | mpsc::TrySendError::Disconnected(Command::Call(_, _, reply, _)),
            ) = tx.try_send(command)
            {
                reply.reject(UNAVAILABLE);
            }
        });
    }
    Ok((
        Owner {
            shared,
            tx,
            worker: Some(worker),
        },
        UiInbox(ui_rx),
    ))
}
struct Engine {
    shared: Arc<Shared>,
    configuration: Option<Value>,
    lease: String,
    generation: u64,
    seen: VecDeque<String>,
    claims: HashMap<String, (u64, String)>,
}
fn native_pool<T>(call: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    {
        nsh_platform_macos::objc2::rc::autoreleasepool(|_| call())
    }
    #[cfg(not(target_os = "macos"))]
    {
        call()
    }
}
impl Engine {
    fn identity(&self, generation: u64) -> Result<Identity> {
        let identity = self.shared.identity.lock().map_err(|_| UNAVAILABLE)?;
        if self.shared.stopped.load(Ordering::Acquire)
            || generation != self.shared.generation.load(Ordering::Acquire)
        {
            return Err(STALE.into());
        }
        identity.clone().ok_or_else(|| STALE.into())
    }
    fn call(
        &mut self,
        name: &str,
        body: Value,
        generation: u64,
        driver: &mut Result<Box<dyn Driver>>,
    ) -> Result<Value> {
        if name == "notification.launch.peek" {
            policy::keys(&body, &[])?;
            return Ok(
                json!({"record": self.shared.inbox.lock().map_err(|_| UNAVAILABLE)?.peek()?}),
            );
        }
        if name == "notification.status" || name == "notification.request" {
            policy::keys(&body, &[])?;
            let driver = driver.as_mut().map_err(|e| e.clone())?;
            if name == "notification.status" {
                return driver.status();
            }
            if !self.shared.foreground.load(Ordering::Acquire) {
                return Err(UNAVAILABLE.into());
            }
            let current = || {
                !self.shared.stopped.load(Ordering::Acquire)
                    && self.shared.foreground.load(Ordering::Acquire)
                    && generation == self.shared.generation.load(Ordering::Acquire)
            };
            if !current() {
                return Err(STALE.into());
            }
            let result = driver.request(&current);
            if self.shared.stopped.load(Ordering::Acquire)
                || generation != self.shared.generation.load(Ordering::Acquire)
            {
                return Err(STALE.into());
            }
            return result;
        }
        let identity = self.identity(generation)?;
        if name == "notification.configure" {
            policy::keys(&body, &["hostID", "enabled", "mode", "events", "language"])?;
            let events = body["events"].as_array().ok_or(INVALID)?;
            let mut unique = std::collections::HashSet::new();
            if body["hostID"] != identity.host_id
                || !body["enabled"].is_boolean()
                || !["always", "hidden-only"].contains(&body["mode"].as_str().unwrap_or(""))
                || !policy::LANGUAGES.contains(&body["language"].as_str().unwrap_or(""))
                || events.len() > 8
                || events.iter().any(|e| {
                    !policy::KINDS.contains(&e.as_str().unwrap_or("")) || !unique.insert(e.as_str())
                })
            {
                return Err(INVALID.into());
            }
            if self.generation != generation || self.configuration.as_ref() != Some(&body) {
                let lease = crate::vault::id()?;
                self.shared
                    .generation
                    .compare_exchange(
                        generation,
                        generation + 1,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .map_err(|_| STALE)?;
                self.lease = lease;
                self.configuration = Some(body);
                self.generation = generation + 1;
                self.seen.clear();
                self.claims.clear();
            }
            return Ok(json!({"lease": self.lease}));
        }
        if name.starts_with("notification.launch.") {
            let ack = name == "notification.launch.ack";
            policy::keys(
                &body,
                if ack {
                    &["receipt", "connectionID", "lease", "expectedRevision"]
                } else {
                    &["receipt", "connectionID"]
                },
            )?;
            if !self.shared.foreground.load(Ordering::Acquire)
                || generation != self.generation
                || self.lease.is_empty()
                || body["connectionID"] != identity.host_id
            {
                return Err(STALE.into());
            }
            let receipt = body["receipt"].as_str().ok_or(INVALID)?;
            // Fixed lock order: native identity -> private inbox. Publish/revocation cannot
            // linearize in the middle of a successful durable ACK for an older runtime.
            let authority = self.shared.identity.lock().map_err(|_| UNAVAILABLE)?;
            if authority.as_ref() != Some(&identity)
                || generation != self.shared.generation.load(Ordering::Acquire)
                || self.shared.stopped.load(Ordering::Acquire)
            {
                return Err(STALE.into());
            }
            let mut inbox = self.shared.inbox.lock().map_err(|_| UNAVAILABLE)?;
            let record = inbox.claim(receipt, &identity)?;
            let revision = record["revision"].as_u64().ok_or(INVALID)?;
            if ack {
                if body["lease"] != self.lease
                    || body["expectedRevision"].as_u64() != Some(revision)
                    || self.claims.get(receipt) != Some(&(revision, self.lease.clone()))
                {
                    return Err(STALE.into());
                }
                inbox.ack(receipt)?;
                drop(inbox);
                drop(authority);
                self.claims.remove(receipt);
                // ACK commits independently of best-effort OS visual cleanup. A failed OS
                // removal must not turn a durable consumed receipt into an unknown ACK.
                if let Ok(driver) = driver.as_mut() {
                    let _ = driver.remove(&[receipt.into()]);
                }
                return Ok(json!({"ok": true}));
            }
            if !self.claims.contains_key(receipt) && self.claims.len() >= 16 {
                return Err(UNAVAILABLE.into());
            }
            self.claims
                .insert(receipt.into(), (revision, self.lease.clone()));
            return Ok(
                json!({"route": {"hostID": identity.host_id, "lease": self.lease, "target": record["admission"]["target"]}, "record": record}),
            );
        }
        let test = name == "notification.test";
        let (language, admission, mode) = if test {
            policy::keys(&body, &["hostID", "language"])?;
            if body["hostID"] != identity.host_id
                || !self.shared.foreground.load(Ordering::Acquire)
                || !policy::LANGUAGES.contains(&body["language"].as_str().unwrap_or(""))
            {
                return Err(INVALID.into());
            }
            (
                body["language"].as_str().unwrap().to_owned(),
                Value::Null,
                "always".to_owned(),
            )
        } else {
            if name != "notification.live" {
                return Err(INVALID.into());
            }
            policy::keys(&body, &["lease", "eventID", "kind", "target", "admission"])?;
            policy::admission(&body["admission"])?;
            if self.generation != generation || body["lease"] != self.lease {
                return Err(STALE.into());
            }
            if body["eventID"] != body["admission"]["eventID"]
                || body["kind"] != body["admission"]["kind"]
                || body["target"] != body["admission"]["target"]
            {
                return Err(INVALID.into());
            }
            let event = body["eventID"].as_str().ok_or(INVALID)?.to_owned();
            if self.seen.contains(&event)
                || self
                    .shared
                    .inbox
                    .lock()
                    .map_err(|_| UNAVAILABLE)?
                    .has_event(&identity, &event)
            {
                return Ok(json!({"result": "duplicate"}));
            }
            let config = self.configuration.as_ref().ok_or(STALE)?;
            if config["enabled"] != true
                || !config["events"]
                    .as_array()
                    .ok_or(INVALID)?
                    .contains(&body["kind"])
                || (self.shared.foreground.load(Ordering::Acquire) && config["mode"] != "always")
            {
                self.seen.push_back(event);
                if self.seen.len() > 256 {
                    self.seen.pop_front();
                }
                return Ok(json!({"result": "suppressed"}));
            }
            (
                config["language"].as_str().ok_or(INVALID)?.into(),
                body["admission"].clone(),
                config["mode"].as_str().ok_or(INVALID)?.into(),
            )
        };
        let driver = driver.as_mut().map_err(|e| e.clone())?;
        let status = driver.status()?;
        if !["authorized", "provisional", "ephemeral"]
            .contains(&status["authorization"].as_str().unwrap_or(""))
        {
            return Err("notification_denied".into());
        }
        self.identity(generation)?;
        let receipt = crate::vault::id()?;
        // Persist BEFORE OS submission. An unknown/late add keeps its receipt, never auto-replays.
        self.shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .reserve(&receipt, &identity, admission, generation, test, &mode)?;
        let (title, text) = policy::copy(&language, test);
        let added = driver.add(&receipt, title, text);
        let valid = self.identity(generation).is_ok()
            && self
                .shared
                .inbox
                .lock()
                .map_err(|_| UNAVAILABLE)?
                .active(&receipt);
        if !valid {
            let _ = driver.remove(std::slice::from_ref(&receipt));
            return Err(STALE.into());
        }
        added?;
        if !test {
            self.seen
                .push_back(body["eventID"].as_str().unwrap().into());
            if self.seen.len() > 256 {
                self.seen.pop_front();
            }
        }
        Ok(json!({"result": "scheduled"}))
    }
    fn cleanup(&mut self, driver: &mut dyn Driver, host: &str, authorization: &str) -> Result<()> {
        let receipts = self
            .shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .retired(host, authorization);
        if receipts.is_empty() {
            return Ok(());
        }
        driver.remove(&receipts)?;
        self.shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .finish_retired(&receipts)
    }
    fn cleanup_available(
        &mut self,
        driver: &mut Result<Box<dyn Driver>>,
        host: &str,
        authorization: &str,
    ) -> Result<()> {
        if self
            .shared
            .inbox
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .cleanup_empty(host, authorization)?
        {
            return Ok(());
        }
        let driver = driver.as_mut().map_err(|error| error.clone())?;
        self.cleanup(driver.as_mut(), host, authorization)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Inbox {
    storage: Store,
    root: Value,
    pending: VecDeque<String>,
    poisoned: bool,
}
impl Inbox {
    fn load(mut storage: Store) -> Result<Self> {
        let root = storage
            .load()?
            .unwrap_or_else(|| json!({"v": 1, "rows": [], "retirements": []}));
        policy::keys(&root, &["v", "rows", "retirements"])?;
        let rows = root["rows"].as_array().ok_or(INVALID)?;
        if root["v"] != 1 || rows.len() > 256 {
            return Err(INVALID.into());
        }
        let retirements = root["retirements"].as_array().ok_or(INVALID)?;
        if retirements.len() > 256 {
            return Err(INVALID.into());
        }
        for row in retirements {
            policy::keys(row, &["host", "authorization"])?;
            policy::id(&row["host"], 128)?;
            if policy::id(&row["authorization"], 128)? == "legacy" {
                return Err(INVALID.into());
            }
        }
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            policy::keys(
                row,
                &["record", "queued", "retired", "test", "generation", "mode"],
            )?;
            if !row["queued"].is_boolean()
                || !row["retired"].is_boolean()
                || !row["test"].is_boolean()
                || row["generation"].as_u64().is_none()
                || !["always", "hidden-only"].contains(&row["mode"].as_str().unwrap_or(""))
            {
                return Err(INVALID.into());
            }
            if row["test"] == true {
                // Test receipts are never routes; persisted only to fence foreground presentation/cleanup.
                policy::keys(
                    &row["record"],
                    &["receipt", "connectionID", "authorizationID"],
                )?;
                if !policy::uuid(row["record"]["receipt"].as_str().ok_or(INVALID)?) {
                    return Err(INVALID.into());
                }
                policy::id(&row["record"]["connectionID"], 128)?;
                policy::id(&row["record"]["authorizationID"], 128)?;
            } else {
                policy::record(&row["record"])?;
            }
            if !ids.insert(row["record"]["receipt"].as_str()) {
                return Err(INVALID.into());
            }
            let marker = json!({"host":row["record"]["connectionID"],"authorization":row["record"]["authorizationID"]});
            if retirements.contains(&marker) != (row["retired"] == true) {
                return Err(INVALID.into());
            }
        }
        Ok(Self {
            storage,
            root,
            pending: VecDeque::new(),
            poisoned: false,
        })
    }
    fn commit(&mut self, next: Value) -> Result<()> {
        if self.poisoned {
            return Err(UNAVAILABLE.into());
        }
        if let Err(e) = self.storage.commit(&next) {
            if e == "notification_store_unknown" {
                self.poisoned = true;
            }
            return Err(e);
        }
        self.root = next;
        Ok(())
    }
    fn reserve(
        &mut self,
        receipt: &str,
        identity: &Identity,
        admission: Value,
        generation: u64,
        test: bool,
        mode: &str,
    ) -> Result<()> {
        if self.root["retirements"]
            .as_array()
            .ok_or(INVALID)?
            .iter()
            .any(|r| {
                r["host"] == identity.host_id && r["authorization"] == identity.authorization_id
            })
        {
            return Err(STALE.into());
        }
        let mut next = self.root.clone();
        let rows = next["rows"].as_array_mut().ok_or(INVALID)?;
        if !policy::uuid(receipt) || rows.iter().any(|r| r["record"]["receipt"] == receipt) {
            return Err(INVALID.into());
        }
        if rows.len() >= 256 {
            return Err(UNAVAILABLE.into());
        } // Never evict an unacknowledged click.
        let time = now();
        let record = if test {
            json!({"receipt":receipt,"connectionID":identity.host_id,"authorizationID":identity.authorization_id})
        } else {
            json!({"v":1,"receipt":receipt,"revision":1,"connectionID":identity.host_id,"authorizationID":identity.authorization_id,"admission":admission,"createdAt":time,"expiresAt":time+604_800_000})
        };
        rows.push(json!({"record":record,"queued":false,"retired":false,"generation":generation,"test":test,"mode":mode}));
        self.commit(next)
    }
    fn active(&self, receipt: &str) -> bool {
        !self.poisoned
            && self.root["rows"].as_array().is_some_and(|r| {
                r.iter()
                    .any(|r| r["record"]["receipt"] == receipt && r["retired"] != true)
            })
    }
    fn has_event(&self, identity: &Identity, event: &str) -> bool {
        self.root["rows"].as_array().into_iter().flatten().any(|r| {
            r["record"]["connectionID"] == identity.host_id
                && r["record"]["authorizationID"] == identity.authorization_id
                && r["record"]["admission"]["eventID"] == event
        })
    }
    fn receive(&mut self, receipt: &str) -> Result<bool> {
        let mut next = self.root.clone();
        let Some(row) = next["rows"]
            .as_array_mut()
            .ok_or(INVALID)?
            .iter_mut()
            .find(|r| {
                r["record"]["receipt"] == receipt && r["retired"] != true && r["test"] != true
            })
        else {
            return Ok(false);
        };
        if row["queued"] == true {
            return Ok(true);
        }
        row["queued"] = json!(true);
        if let Err(e) = self.commit(next) {
            if !self.pending.iter().any(|s| s == receipt) && self.pending.len() < 256 {
                self.pending.push_back(receipt.into());
            }
            return Err(e);
        }
        self.pending.retain(|s| s != receipt);
        Ok(true)
    }
    fn peek(&mut self) -> Result<Value> {
        for id in self.pending.clone() {
            self.receive(&id)?;
        }
        if self.poisoned {
            return Err(UNAVAILABLE.into());
        }
        Ok(self.root["rows"]
            .as_array()
            .ok_or(INVALID)?
            .iter()
            .find(|r| r["queued"] == true && r["retired"] != true && r["test"] != true)
            .map(|r| r["record"].clone())
            .unwrap_or(Value::Null))
    }
    fn claim(&mut self, receipt: &str, identity: &Identity) -> Result<Value> {
        let record = self.peek()?;
        if record["receipt"] != receipt
            || record["connectionID"] != identity.host_id
            || record["authorizationID"] != identity.authorization_id
            || record["createdAt"].as_u64().is_none_or(|t| t > now())
            || record["expiresAt"].as_u64().is_none_or(|t| t <= now())
        {
            return Err(STALE.into());
        }
        Ok(record)
    }
    fn ack(&mut self, receipt: &str) -> Result<()> {
        let mut next = self.root.clone();
        next["rows"]
            .as_array_mut()
            .ok_or(INVALID)?
            .retain(|r| r["record"]["receipt"] != receipt);
        self.commit(next)
    }
    fn retire(&mut self, host: &str, authorization: &str) -> Result<()> {
        if self.poisoned {
            return Err(UNAVAILABLE.into());
        }
        let mut next = self.root.clone();
        let retired = next["retirements"].as_array_mut().ok_or(INVALID)?;
        let marker = json!({"host":host,"authorization":authorization});
        if !retired.contains(&marker) {
            if retired.len() >= 256 {
                return Err(UNAVAILABLE.into());
            }
            retired.push(marker);
        }
        for row in next["rows"].as_array_mut().ok_or(INVALID)? {
            if row["record"]["connectionID"] == host
                && row["record"]["authorizationID"] == authorization
            {
                row["retired"] = json!(true);
            }
        }
        if next == self.root {
            return Ok(());
        }
        self.commit(next)
    }
    fn cleanup_empty(&self, host: &str, authorization: &str) -> Result<bool> {
        if self.poisoned {
            return Err(UNAVAILABLE.into());
        }
        let marker = json!({"host":host,"authorization":authorization});
        if !self.root["retirements"]
            .as_array()
            .ok_or(INVALID)?
            .contains(&marker)
        {
            return Err(STALE.into());
        }
        Ok(self.retired(host, authorization).is_empty())
    }
    fn retired(&self, host: &str, authorization: &str) -> Vec<String> {
        self.root["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| {
                r["retired"] == true
                    && r["record"]["connectionID"] == host
                    && r["record"]["authorizationID"] == authorization
            })
            .filter_map(|r| r["record"]["receipt"].as_str().map(str::to_owned))
            .collect()
    }
    fn finish_retired(&mut self, receipts: &[String]) -> Result<()> {
        let mut next = self.root.clone();
        next["rows"]
            .as_array_mut()
            .ok_or(INVALID)?
            .retain(|r| !receipts.iter().any(|id| r["record"]["receipt"] == *id));
        self.commit(next)
    }
}
#[cfg(test)]
#[path = "notifications_tests.rs"]
mod tests;
