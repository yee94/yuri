//! Connection-only native dispatcher. No HostChannel registration, Files, Vault,
//! credentials, runtime authority, or renderer-selected executable lives here.
use super::*;
use crate::connection_actor_port;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Mutex, Weak,
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    time::{Duration, Instant},
};

pub const CAPACITY: usize = 16;
pub enum Request {
    Snapshot,
    Save {
        request_id: String,
        revision: u64,
        instance: Instance,
    },
    Remove {
        request_id: String,
        revision: u64,
        id: String,
    },
    Start {
        request_id: String,
        id: String,
        intent: Intent,
    },
    Cancel {
        id: String,
        attempt: u64,
    },
}
pub enum Outcome {
    Complete(Value),
    Denied(Error),
    Unknown(Error),
}
pub type Reply = Box<dyn FnOnce(Outcome) + Send>;
pub type Lifecycle = Box<dyn FnOnce(Result<()>) + Send>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed(Error),
}
struct State {
    phase: Phase,
    owner: Weak<Owner>,
}
struct Shared {
    stop: AtomicBool,
    state: Mutex<State>,
}
struct Work {
    request: Request,
    current: Cancellation,
    reply: Reply,
}
enum Message {
    Work(Work),
    Wake,
}
struct Client {
    shared: Arc<Shared>,
    tx: SyncSender<Message>,
}
#[derive(Clone)]
pub struct Handle {
    client: Arc<Client>,
}

/// Returns after spawning, never waits for the original actor. Lifecycle/reply
/// callbacks run on this service worker and must only enqueue short notifications.
pub fn install(
    port: connection_actor_port::Port,
    driver: Arc<dyn Driver>,
    version: String,
    on_ready: Lifecycle,
    on_stopped: Lifecycle,
) -> Result<Handle> {
    if !app_version(&version) {
        return Err(Error::Invalid);
    }
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        state: Mutex::new(State {
            phase: Phase::Starting,
            owner: Weak::new(),
        }),
    });
    let (tx, rx) = mpsc::sync_channel(CAPACITY);
    let state = shared.clone();
    std::thread::Builder::new()
        .name("yuri-ssh-service".into())
        .spawn(move || worker(port, driver, version, state, rx, on_ready, on_stopped))
        .map_err(|_| Error::Unavailable)?;
    Ok(Handle {
        client: Arc::new(Client { shared, tx }),
    })
}
impl Handle {
    pub fn phase(&self) -> Phase {
        self.client
            .shared
            .state
            .lock()
            .map_or(Phase::Failed(Error::CommitUnknown), |v| v.phase)
    }
    /// Ok means queued, not executed or committed. Err proves no retention and
    /// does not invoke reply. Cancellation before dispatch receives Denied.
    pub fn submit(&self, request: Request, current: Cancellation, reply: Reply) -> Result<()> {
        current.check()?;
        let state = self
            .client
            .shared
            .state
            .lock()
            .map_err(|_| Error::CommitUnknown)?;
        if self.client.shared.stop.load(Ordering::Acquire) || state.phase != Phase::Ready {
            return Err(Error::Unavailable);
        }
        match self.client.tx.try_send(Message::Work(Work {
            request,
            current,
            reply,
        })) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(Error::Busy),
            Err(TrySendError::Disconnected(_)) => Err(Error::Unavailable),
        }
    }
    /// Synchronous admission/Current fence only: no Port/driver I/O or waiting.
    /// on_stopped is the completion barrier; the original actor must outlive it.
    pub fn shutdown(&self) {
        self.client.stop();
    }
}
impl Client {
    fn stop(&self) {
        self.shared.fence();
        let _ = self.tx.try_send(Message::Wake);
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Shared {
    fn fence(&self) {
        self.stop.store(true, Ordering::Release);
        let owner = if let Ok(mut state) = self.state.lock() {
            if matches!(state.phase, Phase::Starting | Phase::Ready) {
                state.phase = Phase::Stopping;
            }
            state.owner.upgrade()
        } else {
            None
        };
        if let Some(owner) = owner {
            owner.fence();
        }
    }
    fn phase(&self, phase: Phase) {
        if let Ok(mut state) = self.state.lock() {
            state.phase = phase;
        }
    }
}
fn lifecycle(callback: Lifecycle, result: Result<()>) -> bool {
    catch_unwind(AssertUnwindSafe(|| callback(result))).is_ok()
}
fn reply(callback: Reply, result: Outcome) {
    let _ = catch_unwind(AssertUnwindSafe(|| callback(result)));
}
fn invoke(owner: &Arc<Owner>, request: Request) -> Result<Value> {
    match request {
        Request::Snapshot => owner.snapshot(),
        Request::Save {
            request_id,
            revision,
            instance,
        } => owner.save(&request_id, revision, instance),
        Request::Remove {
            request_id,
            revision,
            id,
        } => owner.remove(&request_id, revision, &id),
        Request::Start {
            request_id,
            id,
            intent,
        } => owner.start(&id, &request_id, intent),
        Request::Cancel { id, attempt } => owner.cancel(&id, attempt),
    }
}
fn worker(
    port: connection_actor_port::Port,
    driver: Arc<dyn Driver>,
    version: String,
    shared: Arc<Shared>,
    rx: Receiver<Message>,
    on_ready: Lifecycle,
    on_stopped: Lifecycle,
) {
    let service = match actor::create(port, driver, version) {
        Ok(service) => service,
        Err(error) => {
            shared.phase(Phase::Failed(error));
            lifecycle(on_ready, Err(error));
            lifecycle(on_stopped, Err(error));
            return;
        }
    };
    let ready = if let Ok(mut state) = shared.state.lock() {
        state.owner = Arc::downgrade(&service.owner);
        if shared.stop.load(Ordering::Acquire) {
            false
        } else {
            state.phase = Phase::Ready;
            true
        }
    } else {
        false
    };
    if !ready {
        shared.fence();
    }
    if !lifecycle(on_ready, if ready { Ok(()) } else { Err(Error::Cancelled) }) {
        shared.fence();
    }
    let mut uncertain = false;
    let mut next_tick = Instant::now() + Duration::from_secs(1);
    while !shared.stop.load(Ordering::Acquire) {
        let wait = next_tick
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(250));
        match rx.recv_timeout(wait) {
            Ok(Message::Work(work)) => {
                if shared.stop.load(Ordering::Acquire) || work.current.check().is_err() {
                    reply(work.reply, Outcome::Denied(Error::Cancelled));
                    continue;
                }
                let mutation = !matches!(&work.request, Request::Snapshot);
                let result = invoke(&service.owner, work.request);
                let outcome = match result {
                    Ok(value) => Outcome::Complete(value),
                    Err(error)
                        if !mutation
                            || matches!(
                                error,
                                Error::Invalid
                                    | Error::Stale
                                    | Error::Busy
                                    | Error::Storage
                                    | Error::Authentication
                            ) =>
                    {
                        Outcome::Denied(error)
                    }
                    Err(error) => Outcome::Unknown(error),
                };
                let terminal = matches!(
                    &outcome,
                    Outcome::Unknown(_) | Outcome::Denied(Error::CommitUnknown)
                ) || service.adapter.quarantine_failure().is_some();
                uncertain |= matches!(&outcome, Outcome::Unknown(_));
                reply(work.reply, outcome);
                if terminal {
                    shared.fence();
                }
            }
            Ok(Message::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                shared.fence();
                break;
            }
        }
        if !shared.stop.load(Ordering::Acquire) && Instant::now() >= next_tick {
            service.owner.tick();
            if service.owner.snapshot().is_err() {
                shared.fence();
            }
            next_tick = Instant::now() + Duration::from_secs(1);
        }
    }
    shared.fence();
    while let Ok(message) = rx.try_recv() {
        if let Message::Work(work) = message {
            reply(work.reply, Outcome::Denied(Error::Cancelled));
        }
    }
    let result = service.owner.shutdown_and_wait().and({
        if uncertain {
            Err(Error::CommitUnknown)
        } else {
            Ok(())
        }
    });
    let result = service.adapter.quarantine_failure().map_or(result, Err);
    shared.phase(match result {
        Ok(()) => Phase::Stopped,
        Err(error) => Phase::Failed(error),
    });
    lifecycle(on_stopped, result);
}

#[cfg(test)]
#[path = "ssh_service_tests.rs"]
mod tests;
