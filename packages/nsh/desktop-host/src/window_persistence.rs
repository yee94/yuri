//! One process-owned storage lane. No native UI waits for a disk flush or writes from Drop.
use crate::{
    policy::Result,
    window_state::{self, MainWindow, Snapshot},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

#[cfg(test)]
#[path = "window_persistence_tests.rs"]
pub(crate) mod tests;

#[derive(Clone)]
pub struct Status {
    pub snapshot: Option<Snapshot>,
    pub error: Option<String>,
}
enum Command {
    Capture(Vec<MainWindow>),
    Flush {
        windows: Vec<MainWindow>,
        quit: bool,
        reply: mpsc::SyncSender<Result<()>>,
    },
    Closed(Vec<MainWindow>),
    CancelQuit,
}
#[derive(Clone)]
pub struct Port {
    tx: mpsc::SyncSender<()>,
    inbox: Arc<Mutex<VecDeque<Command>>>,
    status: Arc<Mutex<Status>>,
}
impl Port {
    pub fn native() -> Result<Self> {
        Self::install(|| {
            let (path, store) = crate::notification_store_grant::native_granted("window-state")?;
            window_state::Owner::from_granted_store(&path, store)
        })
    }
    pub(super) fn install(
        factory: impl FnOnce() -> Result<window_state::Owner> + Send + 'static,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::sync_channel(1);
        let inbox = Arc::new(Mutex::new(VecDeque::new()));
        let incoming = inbox.clone();
        let (ready, initial) = mpsc::sync_channel(1);
        let status = Arc::new(Mutex::new(Status {
            snapshot: None,
            error: None,
        }));
        let published = status.clone();
        std::thread::Builder::new()
            .name("yuri-window-state".into())
            .spawn(move || {
                let mut owner = match factory() {
                    Ok(owner) => owner,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                let loaded = owner.snapshot().map(|_| ()).and_then(|()| {
                    if owner.failure().is_some() {
                        Err("window_state_read_failed".into())
                    } else {
                        Ok(())
                    }
                });
                publish(&owner, loaded.as_ref().err().cloned(), false, &published);
                if loaded.is_err() {
                    let _ = ready.send(loaded);
                    return;
                }
                let _ = ready.send(Ok(()));
                let mut restoring = true;
                loop {
                    let wait = owner.deadline().map_or(Duration::from_secs(1), |deadline| {
                        deadline.saturating_duration_since(Instant::now())
                    });
                    let command = match incoming.lock() {
                        Ok(mut queue) => queue.pop_front(),
                        Err(_) => break,
                    };
                    let mut acknowledged = None;
                    let (outcome, may_clear) = match command {
                        Some(Command::Capture(windows)) => {
                            (capture(&mut owner, &mut restoring, windows), true)
                        }
                        Some(Command::Flush {
                            windows,
                            quit,
                            reply,
                        }) => {
                            owner.cancel_quit();
                            let result =
                                capture(&mut owner, &mut restoring, windows).and_then(|()| {
                                    if quit {
                                        owner.freeze_quit();
                                    }
                                    owner.flush()
                                });
                            if result.is_err() && quit {
                                owner.cancel_quit();
                            }
                            acknowledged = Some((reply, result.clone()));
                            (result, true)
                        }
                        Some(Command::Closed(windows)) => (
                            capture(&mut owner, &mut restoring, windows)
                                .and_then(|()| owner.flush()),
                            true,
                        ),
                        Some(Command::CancelQuit) => {
                            owner.cancel_quit();
                            (Ok(()), false)
                        }
                        None => match rx.recv_timeout(wait) {
                            Ok(()) => continue,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                (owner.flush_due(Instant::now()).map(|_| ()), false)
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        },
                    };
                    publish(&owner, outcome.err(), may_clear, &published);
                    // Publish failure/snapshot before exposing the disk barrier ACK.
                    if let Some((reply, result)) = acknowledged {
                        let _ = reply.try_send(result);
                    }
                    if owner
                        .deadline()
                        .is_some_and(|deadline| deadline <= Instant::now())
                    {
                        let result = owner.flush_due(Instant::now());
                        publish(&owner, result.err(), false, &published);
                    }
                }
            })
            .map_err(|_| "window_state_worker_failed")?;
        // Startup-only barrier before creating any AppView; all I/O remains on the worker.
        initial
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "window_state_startup_unavailable")??;
        Ok(Self { tx, inbox, status })
    }
    pub fn status(&self) -> Result<Status> {
        self.status
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "window_state_unavailable".into())
    }
    pub fn same_lane(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.status, &other.status)
    }
    fn enqueue(&self, command: Command) -> Result<()> {
        let mut queue = self.inbox.lock().map_err(|_| "window_state_unavailable")?;
        // Only the undispatched trailing COMPLETE capture may be replaced. Never cross a barrier.
        if matches!(command, Command::Capture(_))
            && matches!(queue.back(), Some(Command::Capture(_)))
        {
            queue.pop_back();
        }
        let reserved_cancel = matches!(command, Command::CancelQuit);
        if reserved_cancel && matches!(queue.back(), Some(Command::CancelQuit)) {
            return Ok(());
        }
        if queue.len() >= if reserved_cancel { 17 } else { 16 } {
            return Err("window_state_busy".into());
        }
        queue.push_back(command);
        match self.tx.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(())) => {
                queue.pop_back();
                Err("window_state_worker_unavailable".into())
            }
        }
    }
    pub fn capture(&self, windows: Vec<MainWindow>) -> Result<()> {
        self.enqueue(Command::Capture(windows))
    }
    pub fn flush(
        &self,
        windows: Vec<MainWindow>,
        quit: bool,
    ) -> Result<mpsc::Receiver<Result<()>>> {
        let (reply, rx) = mpsc::sync_channel(1);
        self.enqueue(Command::Flush {
            windows,
            quit,
            reply,
        })?;
        Ok(rx)
    }
    pub fn cancel_quit(&self) -> Result<()> {
        self.enqueue(Command::CancelQuit)
    }
    pub fn closed(&self, remaining: Vec<MainWindow>) -> Result<()> {
        // A committed last close preserves its last complete restoration catalog.
        if remaining.is_empty() {
            return Ok(());
        }
        self.enqueue(Command::Closed(remaining))
    }
}
fn capture(
    owner: &mut window_state::Owner,
    restoring: &mut bool,
    windows: Vec<MainWindow>,
) -> Result<()> {
    if owner.failure() == Some(window_state::Failure::Unknown) {
        return Err("window_state_unknown".into());
    }
    if windows.is_empty() {
        if owner.snapshot()?.is_some() {
            return Err("window_state_identity_unresolved".into());
        }
        if *restoring {
            owner.finish_restore()?;
            *restoring = false;
        }
        return Ok(());
    }
    Snapshot {
        revision: 1,
        windows: windows.clone(),
    }
    .value()?;
    if *restoring {
        if let Some(saved) = owner.snapshot()?
            && (saved.windows.len() != windows.len()
                || saved
                    .windows
                    .iter()
                    .zip(&windows)
                    .any(|(a, b)| a.window_key != b.window_key))
        {
            return Err("window_state_restore_incomplete".into());
        }
        owner.finish_restore()?;
        *restoring = false;
    }
    let revision = owner.snapshot()?.map_or(0, |s| s.revision);
    owner.stage(revision, windows, Instant::now())
}
fn publish(
    owner: &window_state::Owner,
    error: Option<String>,
    may_clear: bool,
    status: &Mutex<Status>,
) {
    if let Ok(mut status) = status.lock() {
        status.snapshot = owner.snapshot().ok().flatten().cloned();
        if error.is_some() {
            status.error = error;
        } else if may_clear && owner.failure().is_none() {
            status.error = None;
        }
    }
}
