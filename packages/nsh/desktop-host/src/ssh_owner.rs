use super::*;
use std::{collections::HashMap, sync::{Mutex, Condvar}, time::{Duration, Instant}};

struct Session { tunnel: Option<Box<dyn Tunnel>>, committed: Committed }
struct Entry {
    attempt: u64, request: String, intent: Intent, phase: &'static str, error: Option<Error>,
    retry: u8, due: Option<Instant>, cancel: Cancellation, session: Option<Session>, committed: Option<Committed>, running: bool, probing: bool,
    retained: Vec<Session>,
}
struct State {
    registry: Registry, entries: HashMap<String, Entry>, requests: HashMap<String, String>,
    live: bool, quarantine: bool, saving: bool, workers: usize, sequence: u64,
}
pub struct Owner { state: Mutex<State>, workers_changed:Condvar, operation_threads:Mutex<Vec<std::thread::JoinHandle<()>>>, actor: Arc<dyn ActorPort>, driver: Arc<dyn Driver>, version: String }
impl Owner {
    pub fn new(actor: Arc<dyn ActorPort>, driver: Arc<dyn Driver>, version: String) -> Result<Arc<Self>> {
        if !app_version(&version) { return Err(Error::Invalid); }
        let registry = actor.load()?;
        if registry.revision > 9_007_199_254_740_000 || registry.instances.len() > 32 || registry.instances.iter().any(|row| Instance::parse(&row.public()).is_err()) { return Err(Error::Invalid); }
        let mut ids = std::collections::HashSet::new();
        if registry.instances.iter().any(|row| !ids.insert(&row.id)) { return Err(Error::Invalid); }
        Ok(Arc::new(Self { state: Mutex::new(State { registry, entries: HashMap::new(), requests: HashMap::new(), live: true, quarantine: false, saving: false, workers: 0, sequence: 0 }), workers_changed:Condvar::new(), operation_threads:Mutex::new(Vec::new()), actor, driver, version }))
    }
    pub fn snapshot(&self) -> Result<Value> {
        let s = self.state.lock().map_err(|_| Error::Unavailable)?;
        if s.quarantine { return Err(Error::CommitUnknown); }
        if !s.live { return Err(Error::Unavailable); }
        Ok(json!({"revision":s.registry.revision,"saving":s.saving,"instances":s.registry.instances.iter().map(Instance::public).collect::<Vec<_>>(),
            "receipts":s.requests.keys().collect::<Vec<_>>(),"statuses":s.registry.instances.iter().filter_map(|row| s.entries.get(&row.id).map(|e| json!({"id":row.id,"attempt":e.attempt,"requestID":e.request,"phase":e.phase,"error":e.error.map(Error::code),"retry":e.retry,"running":e.running,"connectionID":e.committed.as_ref().map(|v| &v.connection_id)}))).collect::<Vec<_>>()}))
    }
    fn admit(s: &mut State, request: &str, fingerprint: &str) -> Result<bool> {
        if !identifier(request) { return Err(Error::Invalid); }
        if !s.live || s.quarantine { return Err(Error::Unavailable); }
        if let Some(prior) = s.requests.get(request) { return if prior == fingerprint { Ok(false) } else { Err(Error::Invalid) }; }
        // Never evict a receipt and accidentally replay its mutation. A new process reloads durable authority.
        if s.requests.len() >= 4096 { return Err(Error::Busy); }
        Ok(true)
    }
    pub fn save(&self, request: &str, revision: u64, instance: Instance) -> Result<Value> { self.mutate(request, revision, &instance.id.clone(), Some(instance)) }
    pub fn remove(&self, request: &str, revision: u64, id: &str) -> Result<Value> { self.mutate(request, revision, id, None) }
    fn mutate(&self, request: &str, revision: u64, id: &str, instance: Option<Instance>) -> Result<Value> {
        if !identifier(id) || instance.as_ref().is_some_and(|row| Instance::parse(&row.public()).is_err()) { return Err(Error::Invalid); }
        let fingerprint = json!(["registry",revision,id,instance.as_ref().map(Instance::public)]).to_string();
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        if !Self::admit(&mut s, request, &fingerprint)? { drop(s); return self.snapshot(); }
        if s.saving || s.entries.get(id).is_some_and(|e| e.running || e.probing || e.session.is_some() || !e.retained.is_empty() || e.due.is_some()) { return Err(Error::Busy); }
        if s.registry.revision != revision { return Err(Error::Stale); }
        let mut rows = s.registry.instances.clone();
        if let Some(row) = instance { if let Some(old) = rows.iter_mut().find(|v| v.id == id) { *old = row; } else { if rows.len() >= 32 { return Err(Error::Invalid); } rows.push(row); } }
        else { if !rows.iter().any(|v| v.id == id) { return Err(Error::Stale); } rows.retain(|v| v.id != id); }
        s.saving = true;
        drop(s);
        // Actor callbacks must run without the SSH mutex; adapter may re-enter snapshot or a mailbox.
        let result = self.actor.save(revision, &rows);
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        s.saving = false;
        match result {
            Ok(next) if next > revision && next <= 9_007_199_254_740_000 => { s.registry = Registry { revision: next, instances: rows }; s.entries.remove(id); s.requests.insert(request.into(), fingerprint); }
            Ok(_) | Err(Error::CommitUnknown) => { drop(s); self.quarantine(); return Err(Error::CommitUnknown); }
            Err(error) => return Err(error),
        }
        drop(s); self.snapshot()
    }
    pub fn start(self: &Arc<Self>, id: &str, request: &str, intent: Intent) -> Result<Value> { self.launch(id, request, intent, None) }
    fn launch(self: &Arc<Self>, id: &str, request: &str, intent: Intent, recovery: Option<(u64, u8)>) -> Result<Value> {
        let fingerprint = format!("start:{id}:{intent:?}");
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        if !Self::admit(&mut s, request, &fingerprint)? { drop(s); return self.snapshot(); }
        if s.saving { return Err(Error::Busy); }
        if let Some((attempt, _)) = recovery
            && !s.entries.get(id).is_some_and(|e| e.attempt == attempt && e.cancel.check().is_ok() && e.due.is_some_and(|due| due <= Instant::now())) { return Err(Error::Stale); }
        let retry = recovery.map_or(0, |(_, retry)| retry);
        let instance = s.registry.instances.iter().find(|row| row.id == id).cloned().ok_or(Error::Invalid)?;
        if s.entries.get(id).is_some_and(|e| e.probing) { return Err(Error::Busy); }
        if let Some(e) = s.entries.get(id).filter(|e| e.running) {
            if e.intent != intent || e.cancel.check().is_err() { return Err(Error::Busy); }
            s.requests.insert(request.into(), fingerprint); drop(s); return self.snapshot();
        }
        if s.workers >= 4 || s.sequence >= 9_007_199_254_740_000 || (intent == Intent::Check && s.entries.get(id).is_some_and(|e| e.session.is_some())) { return Err(Error::Busy); }
        if s.entries.get(id).is_some_and(|e| e.retained.len() >= 2) { return Err(Error::Busy); }
        let retained = s.entries.remove(id).map_or_else(Vec::new, |mut e| {
            e.cancel.cancel();
            if let Some(session) = e.session.take() { e.retained.push(session); }
            e.retained
        });
        s.sequence += 1;
        let attempt = s.sequence;
        let cancel = Cancellation::default();
        s.entries.insert(id.into(), Entry { attempt, request: request.into(), intent, phase: "auth_check", error: None, retry, due: None, cancel: cancel.clone(), session: None, committed: None, running: true, probing: false, retained });
        s.requests.insert(request.into(), fingerprint); s.workers += 1;
        drop(s);
        let owner = self.clone();
        let mut threads=match self.operation_threads.lock(){Ok(threads)=>threads,Err(_)=>{self.finish(id,attempt,Err(Error::CommitUnknown));return Err(Error::CommitUnknown);}};
        threads.retain(|thread|!thread.is_finished());
        if threads.len()>=4 {drop(threads);self.finish(id,attempt,Err(Error::Busy));return self.snapshot();}
        // Each worker counts until physical exit, including cancelled operations.
        let spawned=std::thread::Builder::new().name("yuri-ssh-operation".into()).spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||owner.run(&instance, attempt, intent, &cancel))).unwrap_or(Err(Error::CommitUnknown));
            owner.finish(&instance.id, attempt, result);
        });
        let failed=match spawned{Ok(thread)=>{threads.push(thread);false},Err(_)=>true};
        drop(threads);
        if failed { self.finish(id, attempt, Err(Error::Unavailable)); }
        self.snapshot()
    }
    fn phase(&self, id: &str, attempt: u64, phase: &'static str) -> Result<()> {
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        if !s.live || s.quarantine { return Err(Error::Cancelled); }
        let e = s.entries.get_mut(id).filter(|e| e.attempt == attempt && e.running).ok_or(Error::Cancelled)?;
        e.cancel.check()?; e.phase = phase; Ok(())
    }
    fn run(&self, instance: &Instance, attempt: u64, intent: Intent, cancel: &Cancellation) -> Result<()> {
        cancel.check()?;
        // A live prior session owns its tunnel. Reusing that endpoint for a new
        // receipt would let either attempt's cleanup close the other's transport.
        let cold_restore = intent == Intent::Restore && self.state.lock().map_err(|_| Error::Unavailable)?
            .entries.get(&instance.id).is_some_and(|e| e.attempt == attempt && e.retained.is_empty());
        if cold_restore {
            match self.actor.restore(instance, cancel) {
                Ok(Some(committed)) => return self.ready(&instance.id, attempt, Session { tunnel: None, committed }),
                Ok(None) | Err(Error::Authentication) | Err(Error::Ssh) | Err(Error::Unavailable) => {},
                Err(error) => return Err(error),
            }
        }
        self.phase(&instance.id, attempt, "remote_probe")?;
        let info = self.driver.inspect(instance, cancel)?;
        cancel.check()?;
        if instance.managed && info.node_major < 22 { return Err(Error::Runtime); }
        if intent == Intent::Check { return self.phase(&instance.id, attempt, "checked"); }
        let password = self.actor.password(instance)?;
        cancel.check()?;
        if instance.managed {
            self.phase(&instance.id, attempt, if info.version.as_deref() == Some(&self.version) { "server_detecting" } else if info.version.is_some() { "updating" } else { "installing" })?;
            self.driver.initialize(instance, &self.version, &password, cancel)?;
        }
        self.phase(&instance.id, attempt, "forwarding")?;
        let mut forward = self.driver.forward(instance, cancel)?;
        if let Err(error) = cancel.check() { forward.tunnel.close(); return Err(error); }
        self.phase(&instance.id, attempt, "auth_check").inspect_err(|_| forward.tunnel.close())?;
        let committed = match self.actor.authorize(instance, forward.port, &password, cancel) { Ok(value) => value, Err(error) => { forward.tunnel.close(); return Err(error); } };
        self.ready(&instance.id, attempt, Session { tunnel: Some(forward.tunnel), committed })
    }
    fn ready(&self, id: &str, attempt: u64, session: Session) -> Result<()> {
        if !identifier(&session.committed.connection_id) { self.close(session); return Err(Error::Authentication); }
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        let allowed = s.live && !s.quarantine;
        if let Some(e) = s.entries.get_mut(id).filter(|e| allowed && e.attempt == attempt && e.cancel.check().is_ok()) {
            e.phase = "ready"; e.committed = Some(session.committed.clone()); e.session = Some(session); Ok(())
        } else { drop(s); self.close(session); Err(Error::Cancelled) }
    }
    fn finish(&self, id: &str, attempt: u64, result: Result<()>) {
        if result == Err(Error::CommitUnknown) { self.quarantine(); }
        if let Ok(mut s) = self.state.lock() {
            s.workers = s.workers.saturating_sub(1);
            self.workers_changed.notify_all();
            if let Some(e) = s.entries.get_mut(id).filter(|e| e.attempt == attempt) {
                e.running = false;
                if e.cancel.check().is_err() { e.phase = "idle"; e.error = None; e.due = None; }
                else if let Err(error) = result {
                    e.error = Some(error); e.phase = "error";
                    if e.retry > 0 && e.retry < 5 && matches!(error, Error::Ssh | Error::Unavailable) { e.phase = "reconnecting"; e.due = Some(Instant::now() + Duration::from_secs(1 << e.retry)); }
                }
            }
        }
    }
    fn close(&self, mut session: Session) {
        if let Some(tunnel) = &mut session.tunnel { tunnel.close(); }
        // Retirement failure is not a harmless disconnected badge: revoke original actor authority.
        if self.actor.retire(&session.committed).is_err() { self.quarantine(); }
    }
    pub fn cancel(&self, id: &str, attempt: u64) -> Result<Value> {
        let mut s = self.state.lock().map_err(|_| Error::Unavailable)?;
        let e = s.entries.get_mut(id).filter(|e| e.attempt == attempt).ok_or(Error::Stale)?;
        e.cancel.cancel(); e.phase = "idle"; e.error = None; e.due = None; e.committed = None;
        let session = e.session.take(); drop(s);
        if let Some(session) = session { self.close(session); }
        self.snapshot()
    }
    /// Run on a service scheduler worker, NOT inside the actor mailbox or engine thread.
    /// Calls are bounded/coalesced; no OS process or authentication occurs while holding state.
    pub fn tick(self: &Arc<Self>) {
        self.probe_retained();
        let now = Instant::now();
        let mut probes = Vec::new(); let mut retries = Vec::new();
        if let Ok(mut s) = self.state.lock() {
            if !s.live || s.quarantine || s.saving { return; }
            for (id, e) in &mut s.entries {
                if e.running || e.probing { continue; }
                if e.due.is_some_and(|due| now >= due) { retries.push((id.clone(), e.attempt, e.retry + 1)); }
                if e.phase == "ready" && let Some(session) = e.session.take() { e.probing = true; probes.push((id.clone(), e.attempt, session)); }
            }
        }
        for (id, attempt, mut session) in probes {
            let health = if session.tunnel.as_mut().is_none_or(|t| t.alive()) { self.actor.healthy(&session.committed) } else { Ok(false) };
            if health == Err(Error::CommitUnknown) { self.quarantine(); }
            let alive = health.unwrap_or(false);
            let mut s = match self.state.lock() { Ok(s) => s, Err(_) => { self.close(session); continue; } };
            let allowed = s.live && !s.quarantine;
            if let Some(e) = s.entries.get_mut(&id).filter(|e| allowed && e.attempt == attempt && e.cancel.check().is_ok()) {
                e.probing = false;
                if alive || matches!(health,Err(Error::Busy|Error::Unavailable)) { e.session = Some(session); continue; }
                e.committed = None; e.phase = "reconnecting"; e.error = Some(Error::Ssh); e.retry = 0; e.due = Some(now + Duration::from_secs(1));
            } else if let Some(e) = s.entries.get_mut(&id).filter(|e| e.attempt == attempt) { e.probing = false; }
            drop(s); self.close(session);
        }
        for (id, attempt, retry) in retries { let _ = self.launch(&id, &format!("recovery-{attempt}-{retry}"), Intent::Connect, Some((attempt, retry))); }
    }
    fn probe_retained(&self) {
        let mut probes = Vec::new();
        if let Ok(mut s) = self.state.lock() {
            if !s.live || s.quarantine || s.saving { return; }
            for (id, e) in &mut s.entries {
                if e.running || e.probing || e.retained.is_empty() { continue; }
                e.probing = true;
                probes.push((id.clone(), e.attempt, std::mem::take(&mut e.retained)));
            }
        }
        for (id, attempt, sessions) in probes {
            let mut keep = Vec::new();
            let mut close = Vec::new();
            for mut session in sessions {
                let health = if session.tunnel.as_mut().is_none_or(|t| t.alive()) { self.actor.healthy(&session.committed) } else { Ok(false) };
                if health == Err(Error::CommitUnknown) { self.quarantine(); }
                if matches!(health, Ok(true) | Err(Error::Busy | Error::Unavailable)) { keep.push(session); }
                else { close.push(session); }
            }
            if let Ok(mut s) = self.state.lock() {
                let allowed = s.live && !s.quarantine;
                if let Some(e) = s.entries.get_mut(&id).filter(|e| allowed && e.attempt == attempt) {
                    e.probing = false;
                    e.retained.append(&mut keep);
                } else if let Some(e) = s.entries.get_mut(&id).filter(|e| e.attempt == attempt) { e.probing = false; }
            }
            close.append(&mut keep);
            for session in close { self.close(session); }
        }
    }
    #[cfg(test)]
    pub fn capture_sync(&self, id: &str, attempt: u64) -> Result<SyncGrant> {
        let s = self.state.lock().map_err(|_| Error::Unavailable)?;
        if !s.live || s.quarantine { return Err(Error::Unavailable); }
        let e = s.entries.get(id).filter(|e| e.attempt == attempt && e.phase == "ready" && !e.running).ok_or(Error::Stale)?;
        e.cancel.check()?;
        Ok(SyncGrant { instance: s.registry.instances.iter().find(|v| v.id == id).cloned().ok_or(Error::Stale)?, committed: e.committed.as_ref().ok_or(Error::Stale)?.clone(), cancel: e.cancel.clone() })
    }
    #[cfg(test)]
    pub fn sync_current(&self, grant: &SyncGrant) -> bool {
        self.state.lock().ok().is_some_and(|s| s.live && !s.quarantine && grant.cancel.check().is_ok()
            && s.registry.instances.iter().any(|v| v == &grant.instance)
            && s.entries.get(&grant.instance.id).is_some_and(|e| e.phase == "ready" && e.committed.as_ref().is_some_and(|v| v.connection_id == grant.committed.connection_id && v.receipt == grant.committed.receipt)))
    }
    fn drain(&self, quarantine: bool) -> Vec<Session> {
        let mut sessions = Vec::new();
        if let Ok(mut s) = self.state.lock() {
            if quarantine { s.quarantine = true; } else { s.live = false; }
            for e in s.entries.values_mut() { e.cancel.cancel(); e.due = None; sessions.append(&mut e.retained); if let Some(session) = e.session.take() { sessions.push(session); } }
        }
        sessions
    }
    fn quarantine(&self) { let sessions = self.drain(true); self.actor.quarantine(); for mut session in sessions { if let Some(t) = &mut session.tunnel { t.close(); } } }
    pub fn shutdown(&self) { for session in self.drain(false) { self.close(session); } }
    pub(super) fn fence(&self) {
        if let Ok(mut s)=self.state.lock(){s.live=false;for entry in s.entries.values_mut(){entry.cancel.cancel();entry.due=None;}}
    }
    pub(super) fn shutdown_and_wait(&self)->Result<()> {
        self.shutdown();
        let mut state=self.state.lock().map_err(|_|Error::CommitUnknown)?;
        while state.workers>0 {state=self.workers_changed.wait(state).map_err(|_|Error::CommitUnknown)?;}
        let mut result=if state.quarantine{Err(Error::CommitUnknown)}else{Ok(())};
        drop(state);
        let threads=std::mem::take(&mut *self.operation_threads.lock().map_err(|_|Error::CommitUnknown)?);
        for thread in threads{if thread.join().is_err(){result=Err(Error::CommitUnknown);}}
        result
    }
}
impl Drop for Owner { fn drop(&mut self) { self.shutdown(); } }
