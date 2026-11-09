//! Rust-only SSH -> original connection actor mailbox contract. No Vault, network,
//! HostChannel registration or available flag lives here. The bridge owns submit
//! and must dispatch into its existing bounded actor queue, never another actor.
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
    mpsc::{self, Receiver, SyncSender},
};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Stale,
    Busy,
    Storage,
    CommitUnknown,
    Unavailable,
    Cancelled,
    Authentication,
}
/// Exact public registry row. The SSH adapter maps its Instance without dropping
/// any field; the original actor must revalidate against the current saved row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub id: String,
    pub label: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub remote_port: u16,
    pub local_port: u16,
    pub managed: bool,
}
pub struct Registry {
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "native SSH adapter consumes this typed reply")
    )]
    pub revision: u64,
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "native SSH adapter consumes this typed reply")
    )]
    pub instances: Vec<Target>,
}
/// Deliberately neither Debug nor Serialize. Not an SSH login password: managed
/// daemon auth material / an explicitly provisioned native external credential.
pub struct Secret(String);
impl Secret {
    pub fn new(value: String) -> Result<Self> {
        if value.is_empty() || value.len() > 4096 || value.contains('\0') {
            return Err(Error::Invalid);
        }
        Ok(Self(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
/// Opaque native receipt. Never a JS scope, origin match, bearer or reusable grant.
#[derive(Clone)]
pub struct Committed {
    pub connection_id: String,
    pub receipt: String,
}
/// A captured native Cancellation.check().is_ok() closure only. It must do no
/// I/O and never call actor/services/SSH Owner or acquire their state mutexes.
pub type Current = Arc<dyn Fn() -> bool + Send + Sync>;
/// Native Process-selected IDs only, for conservative GC/transport retention.
/// Never grants authority. No I/O, waiting on actor, or SSH state locks; unknown
/// must return true. The Process refreshes its bounded snapshot before dispatch.
pub type SelectionProtection = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Internal actor reply plus queued/admitted/abandoned fence. The handler calls
/// begin BEFORE work and current again before every continuation/durable commit.
/// A dropped/timed-out caller does not authorize committing a late operation.
pub struct Call<T> {
    state: Arc<AtomicU8>,
    reply: SyncSender<Result<T>>,
}
impl<T> Call<T> {
    pub fn begin(&self) -> Result<()> {
        self.state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| Error::Cancelled)
    }
    pub fn current(&self) -> bool {
        self.state.load(Ordering::Acquire) == 1
    }
    pub fn finish(self, result: Result<T>) {
        // A completed durable write must still be reported, even if cancellation
        // arrived during the write. No caller is allowed to infer rollback.
        let _ = self.reply.try_send(result);
        self.state.store(3, Ordering::Release);
    }
}
pub enum Command {
    Load(Call<Registry>),
    Save {
        expected_revision: u64,
        instances: Vec<Target>,
        call: Call<u64>,
    },
    Password {
        target: Target,
        call: Call<Secret>,
    },
    Restore {
        target: Target,
        current: Current,
        selection: Option<SelectionProtection>,
        call: Call<Option<Committed>>,
    },
    Authorize {
        target: Target,
        local_port: u16,
        password: Secret,
        current: Current,
        selection: Option<SelectionProtection>,
        call: Call<Committed>,
    },
    Healthy {
        committed: Committed,
        selection: Option<SelectionProtection>,
        call: Call<bool>,
    },
    Retire {
        committed: Committed,
        call: Call<()>,
    },
    Quarantine(Call<()>),
}
type Submit = Arc<dyn Fn(Command) -> Result<()> + Send + Sync>;
/// Only SSH service workers may wait on this port. Never invoke from engine/UI,
/// while holding SSH Owner state, or on the original connection actor itself.
#[derive(Clone)]
pub struct Port {
    submit: Submit,
    poison: Arc<dyn Fn() + Send + Sync>,
    timeout: Duration,
    selection: Option<SelectionProtection>,
}
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Rust-only API consumed by the separately installed native SSH adapter"
    )
)]
impl Port {
    /// Bridge-only construction. Err from submit proves the command was NOT kept
    /// or dispatched; use existing actor try_send (full => Busy), not blocking send.
    #[cfg(test)]
    pub(crate) fn new(submit: Submit) -> Self {
        Self::with_poison(submit, Arc::new(|| {}))
    }
    pub(crate) fn with_poison(submit: Submit, poison: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            submit,
            poison,
            timeout: Duration::from_secs(70),
            selection: None,
        }
    }
    fn invoke<T>(&self, mutation: bool, command: impl FnOnce(Call<T>) -> Command) -> Result<T> {
        self.invoke_with_timeout(mutation, command, self.timeout)
    }
    #[cfg(test)]
    pub(crate) fn with_timeout(&self, timeout: Duration) -> Self {
        let mut port = self.clone();
        port.timeout = timeout;
        port
    }
    pub(crate) fn with_selection_protection(&self, selection: SelectionProtection) -> Self {
        let mut port = self.clone();
        port.selection = Some(selection);
        port
    }
    fn invoke_with_timeout<T>(
        &self,
        mutation: bool,
        command: impl FnOnce(Call<T>) -> Command,
        timeout: Duration,
    ) -> Result<T> {
        let (reply, rx): (_, Receiver<Result<T>>) = mpsc::sync_channel(1);
        let state = Arc::new(AtomicU8::new(0));
        (self.submit)(command(Call {
            state: state.clone(),
            reply,
        }))?;
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                let prior = state.swap(2, Ordering::AcqRel);
                if prior == 0 {
                    Err(Error::Busy) // cancelled before admission; handler.begin rejects
                } else if mutation {
                    (self.poison)();
                    Err(Error::CommitUnknown) // never ordinary failure after dispatch
                } else {
                    Err(Error::Unavailable)
                }
            }
        }
    }
    pub fn load(&self) -> Result<Registry> {
        self.invoke(false, Command::Load)
    }
    pub fn save(&self, expected_revision: u64, instances: Vec<Target>) -> Result<u64> {
        self.invoke(true, |call| Command::Save {
            expected_revision,
            instances,
            call,
        })
    }
    pub fn password(&self, target: Target) -> Result<Secret> {
        self.invoke(true, |call| Command::Password { target, call })
    }
    pub fn restore(&self, target: Target, current: Current) -> Result<Option<Committed>> {
        self.invoke(true, |call| Command::Restore {
            target,
            current,
            selection: self.selection.clone(),
            call,
        })
    }
    pub fn authorize(
        &self,
        target: Target,
        local_port: u16,
        password: Secret,
        current: Current,
    ) -> Result<Committed> {
        self.invoke(true, |call| Command::Authorize {
            target,
            local_port,
            password,
            current,
            selection: self.selection.clone(),
            call,
        })
    }
    pub fn healthy(&self, committed: Committed) -> Result<bool> {
        self.invoke(false, |call| Command::Healthy { committed, selection: self.selection.clone(), call })
    }
    pub fn retire(&self, committed: Committed) -> Result<()> {
        self.invoke(true, |call| Command::Retire { committed, call })
    }
    /// The ActorPort adapter's void quarantine() must never swallow this error.
    /// Its service must remain terminally quarantined if the actor cannot ACK.
    pub fn quarantine(&self) -> Result<()> {
        (self.poison)();
        self.invoke(true, Command::Quarantine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_reply_and_full_queue_have_no_fallback_or_secret_projection() {
        let port = Port::new(Arc::new(|command| {
            let Command::Load(call) = command else {
                panic!("unexpected command")
            };
            call.begin()?;
            call.finish(Ok(Registry {
                revision: 7,
                instances: Vec::new(),
            }));
            Ok(())
        }));
        assert_eq!(port.load().unwrap().revision, 7);
        let full = Port::new(Arc::new(|_| Err(Error::Busy)));
        assert_eq!(full.save(0, Vec::new()), Err(Error::Busy));
        assert!(Secret::new(String::new()).is_err());
        assert!(Secret::new("not\0a-password".into()).is_err());
        assert_eq!(
            Secret::new("synthetic".into()).unwrap().expose(),
            "synthetic"
        );
    }
    #[test]
    fn timeout_before_admission_cancels_queued_call_but_admitted_write_is_unknown() {
        use std::sync::Mutex;
        let held = Arc::new(Mutex::new(None));
        let saved = held.clone();
        let queued = Port::new(Arc::new(move |command| {
            let Command::Save { call, .. } = command else {
                panic!("unexpected command")
            };
            *saved.lock().unwrap() = Some(call);
            Ok(())
        }));
        let send = |call| Command::Save {
            expected_revision: 0,
            instances: Vec::new(),
            call,
        };
        assert_eq!(
            queued.invoke_with_timeout(true, send, Duration::ZERO),
            Err(Error::Busy)
        );
        let call = held.lock().unwrap().take().unwrap();
        assert_eq!(call.begin(), Err(Error::Cancelled));
        let saved = held.clone();
        let admitted = Port::new(Arc::new(move |command| {
            let Command::Save { call, .. } = command else {
                panic!("unexpected command")
            };
            call.begin()?;
            *saved.lock().unwrap() = Some(call);
            Ok(())
        }));
        assert_eq!(
            admitted.invoke_with_timeout(true, send, Duration::ZERO),
            Err(Error::CommitUnknown)
        );
        let call = held.lock().unwrap().take().unwrap();
        assert!(!call.current());
        call.finish(Ok(1)); // a late durable outcome never makes the caller replay
    }
}
