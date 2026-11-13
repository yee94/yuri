//! Production native process owner: one secure transaction lane, distinct runtime Actors on one worker.
//! No JS create grant: secondary production admission still awaits the writer consumer lifecycle.
use super::*;
use std::{
    collections::{BTreeMap, HashSet},
    sync::Mutex,
};

#[path = "window_factory.rs"]
pub(crate) mod factory;
#[path = "window_process_vault.rs"]
mod secure;
#[cfg(test)]
#[path = "window_process_tests.rs"]
mod tests;

pub(crate) struct WindowRequest {
    pub window_key: String,
    pub host: HostChannel,
    pub capabilities: Value,
    pub metadata: Value,
    pub appearance: appearance::Port,
    pub restore_target: Option<String>,
}
enum Command {
    Open(WindowRequest, mpsc::SyncSender<Result<Owner>>),
}

/// A bounded retention projection, never a source of authentication or writer grants.
#[derive(Default)]
struct SelectedConnections(Mutex<Option<HashSet<String>>>);
impl SelectedConnections {
    fn protects(&self, id: &str) -> bool {
        self.0.lock().map_or(true, |selected| selected.as_ref().is_none_or(|ids| ids.contains(id)))
    }
    fn refresh(&self, lane: &secure::Lane, windows: &BTreeMap<String, Context>, closing: bool) {
        let selected = if closing { None } else { lane.cached_selection().and_then(|cold| {
            let mut ids = HashSet::new();
            if let Some(id) = cold { ids.insert(id); }
            // Stopping contexts remain protected until their real retirement barrier.
            for context in windows.values() {
                if context.actor.quarantined || context.actor.native_poison.load(Ordering::Acquire) { return None; }
                let state = context.actor.state.as_ref()?;
                if let Some(id) = &state.selected { ids.insert(id.clone()); }
            }
            Some(ids)
        }) };
        if let Ok(mut current) = self.0.lock() { *current = selected; }
    }
}

pub(crate) struct Process {
    tx: SyncSender<Command>,
    closing: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    windows: Arc<Mutex<BTreeMap<String, host_services::Port>>>,
    anchor: Owner,
}
#[cfg(not(test))]
static NATIVE_PROCESS_INSTALLED: AtomicBool = AtomicBool::new(false);
impl Process {
    #[cfg(test)]
    pub fn native(_: Value) -> Result<Self> {
        Err("native_process_disabled_in_tests".into())
    }
    /// One native process lane for the application lifetime, including Dock reopen.
    /// Intentionally sticky even on failed startup/shutdown: never remint a Vault lane
    /// to clear an unresolved commit or failed service stop in the same process.
    #[cfg(not(test))]
    pub fn native(metadata: Value) -> Result<Self> {
        NATIVE_PROCESS_INSTALLED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "window_process_already_installed")?;
        Self::install_inner(
            Box::new(vault::NativeVault::default()),
            nsh_engine::net::network(),
            std::env::var_os("NSH_ALLOW_HTTP_LOOPBACK").is_some_and(|s| s == "1"),
            metadata,
        )
    }
    #[cfg(test)]
    pub fn install(
        vault: Box<dyn Vault>,
        network: Arc<dyn Network>,
        loopback: bool,
        metadata: Value,
    ) -> Result<Self> {
        Self::install_inner(vault, network, loopback, metadata)
    }
    fn install_inner(
        vault: Box<dyn Vault>,
        network: Arc<dyn Network>,
        loopback: bool,
        metadata: Value,
    ) -> Result<Self> {
        let lane = secure::Lane::new(vault);
        let anchor = assemble_target(
            &HostChannel::default(),
            &json!({"host":[]}),
            lane.view(false),
            network.clone(),
            loopback,
            metadata,
            appearance::Port::unavailable(),
            None,
        )?;
        let Built { actor, rx, mut owner } = anchor;
        let anchor_context = Context::new(actor, rx, &owner);
        let (tx, commands) = mpsc::sync_channel(16);
        let closing = Arc::new(AtomicBool::new(false));
        let stopped = closing.clone();
        let done = Arc::new(AtomicBool::new(false));
        let joined = done.clone();
        let windows = Arc::new(Mutex::new(BTreeMap::new()));
        let catalog = windows.clone();
        let selections = Arc::new(SelectedConnections::default());
        let selection_reader = selections.clone();
        owner.native_port = owner.native_port.with_selection_protection(Arc::new(move |id| selection_reader.protects(id)));
        let anchor_native = owner.native_port.clone();
        let anchor_http = owner.native_http_port.clone();
        let anchor_services = owner.services.clone();
        let worker = std::thread::Builder::new()
            .name("yuri-window-process".into())
            .spawn(move || {
                run(
                    lane,
                    network,
                    loopback,
                    commands,
                    stopped,
                    catalog,
                    anchor_context,
                    anchor_native,
                    anchor_http,
                    anchor_services,
                    selections,
                );
            })
            .map_err(|_| "window_process_start_failed")?;
        let failed_start = owner.actor_stop.clone();
        let failed_closing = closing.clone();
        std::thread::Builder::new()
            .name("yuri-window-process-join".into())
            .spawn(move || {
                if worker.join().is_ok() {
                    joined.store(true, Ordering::Release);
                }
            })
            .map_err(|_| {
                failed_closing.store(true, Ordering::Release);
                failed_start.store(true, Ordering::Release);
                "window_process_join_failed"
            })?;
        Ok(Self {
            tx,
            closing,
            done,
            windows,
            anchor: owner,
        })
    }
    /// Nonblocking admission only. Do not load an Engine until this exact native reply is Ok.
    pub fn open_window(&self, request: WindowRequest) -> Result<mpsc::Receiver<Result<Owner>>> {
        if self.closing.load(Ordering::Acquire) {
            return Err("window_process_closing".into());
        }
        let (reply, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Command::Open(request, reply))
            .map_err(|_| "window_process_busy")?;
        Ok(rx)
    }
    /// Exactly one service; native typed ports always route to this process anchor, not a view.
    pub fn install_ssh(
        &mut self,
        driver: crate::ssh::Result<Arc<dyn crate::ssh::Driver>>,
        version: String,
    ) -> Result<()> {
        self.anchor.install_ssh(driver, version)
    }
    pub fn connection_actor_port(&self) -> crate::connection_actor_port::Port {
        self.anchor.connection_actor_port()
    }
    pub fn connection_actor_http_port(&self) -> crate::connection_actor_http_port::Port {
        self.anchor.connection_actor_http_port()
    }
    pub fn shutdown(&mut self) {
        self.closing.store(true, Ordering::Release);
        let windows: Vec<_> = self
            .windows
            .lock()
            .map(|windows| windows.values().cloned().collect())
            .unwrap_or_default();
        for services in windows {
            services.shutdown();
        }
        self.anchor.begin_shutdown();
    }
    pub fn stopped(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The OS loop owns this barrier independently of the last view/factory closure.
/// No window count, timeout or failed SSH stop can stand in for the original join.
pub(crate) struct ExitBarrier {
    process: std::rc::Rc<std::cell::RefCell<Process>>,
    started: bool,
}
impl ExitBarrier {
    pub fn new(process: std::rc::Rc<std::cell::RefCell<Process>>) -> Self {
        Self {
            process,
            started: false,
        }
    }
    pub fn poll(&mut self) -> bool {
        let mut process = self.process.borrow_mut();
        if !self.started {
            self.started = true;
            process.shutdown();
        }
        process.stopped()
    }
}

struct Context {
    cleanup_failed: bool,
    actor: Actor,
    rx: mpsc::Receiver<Message>,
    stop: Arc<AtomicBool>,
    admission: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    generation: u64,
}
impl Context {
    fn new(actor: Actor, rx: mpsc::Receiver<Message>, owner: &Owner) -> Self {
        Self {
            cleanup_failed: false,
            actor,
            rx,
            stop: owner.actor_stop.clone(),
            admission: owner.stop.clone(),
            done: owner.actor_done.clone(),
            generation: 0,
        }
    }
    fn sync(&mut self, lane: &secure::Lane, receipts: &HashSet<String>, native: Option<&connection_actor_storage::Native>) -> Result<()> {
        if self.actor.quarantined {
            return Err(vault::COMMIT_UNKNOWN.into());
        }
        if let Some(error) = lane.failure() {
            return Err(error);
        }
        let receipts_changed = &self.actor.native_receipts != receipts;
        self.actor.native_receipts = receipts.clone();
        let generation = lane.generation();
        let Some(old) = self.actor.state.as_ref() else {
            self.generation = generation;
            return Ok(());
        };
        if self.generation == generation && !receipts_changed {
            return Ok(());
        }
        let mut next = State::load(&*self.actor.vault, self.actor.loopback)?;
        let prior_history = history_retirement::pending(old)?;
        let history_changed = history_retirement::pending(&next)?.iter().any(|pair|
            !prior_history.contains(pair));
        next.native.inherit_live(&old.native);
        if let Some(native) = native { next.native.inherit_live(native); }
        // Shared registry/credentials are authoritative. Selection and lease belong ONLY to this view.
        next.selected = old
            .selected
            .clone()
            .filter(|id| next.connections.iter().any(|c| &c.id == id));
        next.scope = old.scope.clone();
        let unchanged = match (old.current(), next.current()) {
            (Ok(a), Ok(b)) => {
                a.id == b.id
                    && a.url == b.url
                    && a.token == b.token
                    && a.authorization == b.authorization
            }
            (Err(_), Err(_)) => old.selected == next.selected,
            _ => false,
        };
        let live = self.actor.native_selected_live(&next);
        let invalidates = !unchanged || !live || (next.scope.is_none() && next.selected.is_some());
        if invalidates {
            self.actor.invalidate();
            next.rotate()?;
            if !live {
                next.scope = None;
            }
        }
        self.actor.state = Some(next);
        if history_changed { let _ = self.actor.host.send("authorization.cache.pending", json!({})); }
        self.generation = generation;
        let retained: HashSet<_> = self
            .actor
            .state()
            .native
            .bindings
            .iter()
            .map(|b| b.receipt.clone())
            .collect();
        self.actor
            .native_receipts
            .retain(|receipt| retained.contains(receipt));
        self.actor.retire_native_http_stale();
        if invalidates {
            self.actor.authorize_services();
        }
        Ok(())
    }
    fn fence_unknown(&mut self) {
        self.actor.native_poison.store(true, Ordering::Release);
        if self.actor.services.live() {
            self.actor.services.shutdown();
        }
        if !self.actor.quarantined {
            self.actor.native_quarantine();
        }
    }
    fn retire(mut self) {
        if let Some(writer) = &self.actor.writer {
            writer.retire();
        }
        self.admission.store(true, Ordering::Release);
        self.actor.services.shutdown();
        self.actor.quarantined = true;
        self.actor.invalidate();
        while let Ok(message) = self.rx.try_recv() {
            if let Message::Call(_, _, reply) = message {
                reply.reject("native_host_unavailable");
            }
        }
        let done = self.done.clone();
        drop(self);
        done.store(true, Ordering::Release);
    }
    fn step(
        &mut self,
        lane: &secure::Lane,
        receipts: Option<&HashSet<String>>,
        native: Option<&connection_actor_storage::Native>,
        http: &mut HttpOwners,
    ) {
        let current = receipts
            .cloned()
            .unwrap_or_else(|| self.actor.native_receipts.clone());
        if self.sync(lane, &current, native).is_err() {
            self.fence_unknown();
        }
        for _ in 0..16 {
            if self.stop.load(Ordering::Acquire) {
                break;
            }
            match self.rx.try_recv() {
                Ok(message) => {
                    // First real window call retains the original lazy load. Import
                    // the anchor's fence before receive can admit connection.select.
                    if let Some(native) = native && self.actor.state.is_none()
                        && matches!(&message, Message::Call(..))
                        && !self.admission.load(Ordering::Acquire) {
                        let _ = self.actor.load_with_native(Some(native));
                    }
                    let current = receipts
                        .cloned()
                        .unwrap_or_else(|| self.actor.native_receipts.clone());
                    if self.sync(lane, &current, native).is_err() {
                        self.fence_unknown();
                    }
                    if let Message::Call(name, value, reply) = message {
                        if let Err(error) = http.admit(&mut self.actor, &name, &value) {
                            reply.reject(error);
                            continue;
                        }
                        if !self.actor.receive(
                            Message::Call(name, value, reply),
                            self.admission.load(Ordering::Acquire),
                        ) {
                            self.stop.store(true, Ordering::Release);
                            break;
                        }
                    } else if !self
                        .actor
                        .receive(message, self.admission.load(Ordering::Acquire))
                    {
                        self.stop.store(true, Ordering::Release);
                        break;
                    }
                    self.generation = lane.generation();
                    if self.actor.quarantined || self.actor.native_poison.load(Ordering::Acquire) {
                        lane.poison(vault::COMMIT_UNKNOWN);
                        self.fence_unknown();
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.stop.store(true, Ordering::Release);
                    break;
                }
            }
        }
        self.actor.tick();
        self.generation = lane.generation();
    }
}

#[derive(Default)]
struct HttpOwners(std::collections::HashMap<String, http_receipts::Key>);
impl HttpOwners {
    fn admit(&mut self, actor: &mut Actor, name: &str, value: &Value) -> Result<()> {
        if !matches!(name, "runtime.http.request" | "runtime.http.cancel") {
            return Ok(());
        }
        if !actor.services.live() {
            return Err("native_host_unavailable".into());
        }
        actor.load()?;
        actor.state().admit(value.get("expectedHost"), true)?;
        let key = http_receipts::Key::parse(
            value,
            &actor.services.window_id()?,
            name == "runtime.http.request",
        )?;
        if let Some(prior) = self.0.get(&key.request_id) {
            return if prior == &key {
                Ok(())
            } else {
                Err("http_receipt_stale".into())
            };
        }
        if self.0.len() >= http_receipts::MAX_REQUESTS {
            return Err("http_receipt_capacity".into());
        }
        self.0.insert(key.request_id.clone(), key);
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    lane: secure::Lane,
    network: Arc<dyn Network>,
    loopback: bool,
    commands: mpsc::Receiver<Command>,
    closing: Arc<AtomicBool>,
    catalog: Arc<Mutex<BTreeMap<String, host_services::Port>>>,
    mut anchor: Context,
    native: crate::connection_actor_port::Port,
    http: crate::connection_actor_http_port::Port,
    anchor_services: host_services::Port,
    selections: Arc<SelectedConnections>,
) {
    let mut windows: BTreeMap<String, Context> = BTreeMap::new();
    let mut http_owners = HttpOwners::default();
    let writers = Arc::new(Mutex::new(writer::Book::default()));
    loop {
        for _ in 0..16 {
            let Ok(command) = commands.try_recv() else {
                break;
            };
            let Command::Open(request, reply) = command;
            let result = (|| {
                if closing.load(Ordering::Acquire) {
                    return Err("window_process_closing".into());
                }
                if let Some(error) = lane.failure() {
                    return Err(error);
                }
                if windows.len() >= crate::window_state::MAX_WINDOWS {
                    return Err("window_capacity".into());
                }
                if request.window_key.is_empty()
                    || request.window_key.len() > 128
                    || !request.window_key.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
                    })
                    || windows.contains_key(&request.window_key)
                {
                    return Err("window_identity_invalid".into());
                }
                let prior = request.host.params();
                // These native-owned fields are installed once, before any Engine loads.
                // A retired Engine may still hold its channel: never rebind that channel
                // to a new context merely because its old stable key has left the live map.
                if ["windowKey", "windowKind", "windowCoordination"]
                    .iter()
                    .any(|name| prior.contains_key(*name))
                {
                    return Err("window_channel_reused".into());
                }
                let mut params = prior.clone();
                params.insert("windowKey".into(), json!(request.window_key));
                params.insert("windowKind".into(), json!("main"));
                params.insert("windowCoordination".into(), json!("multi-engine"));
                request.host.set_params(params);
                if windows.iter().any(|(key, c)| {
                    c.actor
                        .host
                        .params()
                        .get("windowKey")
                        .and_then(Value::as_str)
                        != Some(key.as_str())
                }) {
                    request.host.set_params(prior);
                    return Err("window_channel_shared".into());
                }
                let Built {
                    mut actor,
                    rx,
                    mut owner,
                } = assemble_target(
                    &request.host,
                    &request.capabilities,
                    lane.view(request.window_key == "primary"),
                    network.clone(),
                    loopback,
                    request.metadata,
                    request.appearance,
                    request.restore_target,
                )?;
                owner.shared_lane = true;
                owner.native_port = native.clone();
                owner.native_http_port = http.clone();
                actor.process_view = true;
                actor.writer = Some(writer::Port::new(
                    writers.clone(),
                    &owner.services,
                    request.window_key.clone(),
                )?);
                let writer = actor.writer.clone().expect("native writer installed");
                owner
                    .services
                    .install_writer_close_guard(Arc::new(move || writer.can_close()))?;
                owner.services.window_id()?;
                if let Some(ssh) = anchor_services.ssh() {
                    owner.services.install_shared_ssh(ssh)?;
                }
                {
                    let mut catalog = catalog.lock().map_err(|_| "window_process_unavailable")?;
                    if closing.load(Ordering::Acquire) {
                        return Err("window_process_closing".into());
                    }
                    catalog.insert(request.window_key.clone(), owner.services.clone());
                }
                windows.insert(request.window_key, Context::new(actor, rx, &owner));
                Ok(owner)
            })();
            let _ = reply.try_send(result);
        }
        selections.refresh(&lane, &windows, closing.load(Ordering::Acquire));
        anchor.step(&lane, None, None, &mut http_owners);
        let receipts = anchor.actor.native_receipts.clone();
        let native_state = anchor.actor.state.as_ref().map(|s| &s.native);
        for context in windows.values_mut() {
            if closing.load(Ordering::Acquire) {
                context.stop.store(true, Ordering::Release);
            }
            if let Some(ssh) = anchor_services.ssh()
                && context.actor.services.ssh().is_none()
            {
                let _ = context.actor.services.install_shared_ssh(ssh);
            }
            context.step(&lane, Some(&receipts), native_state, &mut http_owners);
        }
        let retired: Vec<_> = windows
            .iter()
            .filter(|(_, c)| c.stop.load(Ordering::Acquire))
            .map(|(key, _)| key.clone())
            .collect();
        for key in retired {
            if let Some(context) = windows.get_mut(&key) {
                if !context.actor.services.shutdown_complete() {
                    continue;
                }
                if context.cleanup_failed {
                    continue;
                }
                if context.actor.services.final_close_approved()
                    && let Some(writer) = context.actor.writer.clone()
                    && writer.final_close(&mut context.actor).is_err()
                {
                    context.cleanup_failed = true;
                    writer.retire();
                    continue;
                }
            }
            if let Some(context) = windows.remove(&key) {
                context.retire();
            }
            if let Ok(mut catalog) = catalog.lock() {
                catalog.remove(&key);
            }
        }
        if closing.load(Ordering::Acquire)
            && windows.is_empty()
            && anchor.stop.load(Ordering::Acquire)
        {
            anchor.retire();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
