//! Sensitive config-sync bytes on the original actor; no JS, disk, URL or bearer API.
use crate::connection_actor_port::{Committed, Current};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub const MAX_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_PENDING: usize = 2;
pub const TIMEOUT: Duration = Duration::from_secs(300);
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Stale,
    Busy,
    Unavailable,
    Cancelled,
    Authentication,
    CommitUnknown,
    Unknown,
}
/// No Debug/Serialize: transfers can contain provider keys and portable authorizations.
pub enum Request {
    CredentialsInventory,
    CredentialsExport,
    CredentialsImport(Vec<u8>),
    MagpieInventory,
    MagpieExport,
    MagpieImport(Vec<u8>),
}
impl Request {
    pub(crate) fn wire(&self) -> (&'static str, &'static str, bool, usize) {
        match self {
            Self::CredentialsInventory => (
                "GET",
                "/api/yuri/config-sync/credentials/inventory",
                false,
                1024 * 1024,
            ),
            Self::CredentialsExport => (
                "GET",
                "/api/yuri/config-sync/download/credentials",
                true,
                MAX_BYTES,
            ),
            Self::CredentialsImport(_) => (
                "PUT",
                "/api/yuri/config-sync/credentials",
                false,
                1024 * 1024,
            ),
            Self::MagpieInventory => (
                "GET",
                "/api/yuri/config-sync/magpie/inventory",
                false,
                1024 * 1024,
            ),
            Self::MagpieExport => (
                "GET",
                "/api/yuri/config-sync/download/magpie",
                true,
                MAX_BYTES,
            ),
            Self::MagpieImport(_) => ("PUT", "/api/yuri/config-sync/magpie", false, 1024 * 1024),
        }
    }
    pub(crate) fn mutation(&self) -> bool {
        matches!(self, Self::CredentialsImport(_) | Self::MagpieImport(_))
    }
    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::CredentialsImport(bytes) | Self::MagpieImport(bytes)
                if bytes.is_empty() || bytes.len() > MAX_BYTES =>
            {
                Err(Error::Invalid)
            }
            _ => Ok(()),
        }
    }
    pub(crate) fn body(self) -> Option<Vec<u8>> {
        match self {
            Self::CredentialsImport(bytes) | Self::MagpieImport(bytes) => Some(bytes),
            _ => None,
        }
    }
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
/// No constructor is exported: this client currently has no native local-service producer.
pub struct LocalServiceGrant {
    _private: (),
}
pub enum Authority {
    Remote(Committed),
    Local(LocalServiceGrant),
}

struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(crate) struct Call {
    state: Arc<AtomicU8>,
    reply: mpsc::SyncSender<Result<Response>>,
    _permit: Permit,
    mutation: bool,
    dispatched: AtomicBool,
}
impl Call {
    pub fn begin(&self) -> Result<()> {
        self.state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| Error::Cancelled)
    }
    pub fn dispatch(&self) -> Result<()> {
        self.state
            .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Error::Cancelled)?;
        self.dispatched.store(true, Ordering::Release);
        Ok(())
    }
    pub fn current(&self) -> bool {
        matches!(self.state.load(Ordering::Acquire), 1 | 2)
    }
    pub fn failure(&self, before_dispatch: Error) -> Error {
        if self.mutation && self.dispatched.load(Ordering::Acquire) {
            Error::Unknown
        } else {
            before_dispatch
        }
    }
    pub fn finish(self, result: Result<Response>) {
        let _ = self.reply.try_send(result);
        self.state.store(3, Ordering::Release);
    }
}
pub(crate) struct Pending {
    pub authority: Authority,
    pub request: Request,
    pub current: Current,
    pub call: Call,
}
type Submit = Arc<dyn Fn(Pending) -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct Port {
    submit: Submit,
    pending: Arc<AtomicUsize>,
    timeout: Duration,
}
impl Port {
    pub(crate) fn new(submit: Submit) -> Self {
        Self {
            submit,
            pending: Arc::new(AtomicUsize::new(0)),
            timeout: TIMEOUT,
        }
    }
    /// Never resolve the current remote Host or a guessed localhost as a local source.
    pub fn local_service(&self) -> Result<LocalServiceGrant> {
        Err(Error::Unavailable)
    }
    /// Service workers only; Current is the same lock-free Cancellation closure as the typed actor port.
    pub fn request(
        &self,
        authority: Authority,
        request: Request,
        current: Current,
    ) -> Result<Response> {
        request.validate()?;
        if matches!(&authority, Authority::Local(_)) {
            return Err(Error::Unavailable);
        }
        if !current() {
            return Err(Error::Cancelled);
        }
        self.pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_PENDING).then_some(n + 1)
            })
            .map_err(|_| Error::Busy)?;
        let permit = Permit(self.pending.clone());
        let mutation = request.mutation();
        let state = Arc::new(AtomicU8::new(0));
        let (reply, rx) = mpsc::sync_channel(1);
        (self.submit)(Pending {
            authority,
            request,
            current: current.clone(),
            call: Call {
                state: state.clone(),
                reply,
                _permit: permit,
                mutation,
                dispatched: AtomicBool::new(false),
            },
        })?;
        let deadline = Instant::now() + self.timeout;
        loop {
            if !current() || Instant::now() >= deadline {
                if let Ok(result) = rx.try_recv() {
                    return result;
                }
                let prior = state.swap(4, Ordering::AcqRel);
                return Err(if mutation && prior >= 2 {
                    Error::Unknown
                } else if !current() {
                    Error::Cancelled
                } else if prior == 0 {
                    Error::Busy
                } else {
                    Error::Unavailable
                });
            }
            match rx.recv_timeout(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            ) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let prior = state.swap(4, Ordering::AcqRel);
                    return Err(if mutation && prior >= 2 {
                        Error::Unknown
                    } else {
                        Error::Unavailable
                    });
                }
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn with_timeout(&self, timeout: Duration) -> Self {
        Self {
            timeout,
            ..self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn authority() -> Authority {
        Authority::Remote(Committed {
            connection_id: "synthetic".into(),
            receipt: "synthetic-receipt".into(),
        })
    }
    #[test]
    fn queued_timeout_abandons_admission_but_dispatched_write_is_unknown() {
        let held = Arc::new(Mutex::new(None));
        let keeping = held.clone();
        let queued = Port::new(Arc::new(move |work| {
            *keeping.lock().unwrap() = Some(work);
            Ok(())
        }))
        .with_timeout(Duration::ZERO);
        assert!(matches!(
            queued.request(
                authority(),
                Request::CredentialsImport(vec![1]),
                Arc::new(|| true)
            ),
            Err(Error::Busy)
        ));
        let work = held.lock().unwrap().take().unwrap();
        assert_eq!(work.call.begin(), Err(Error::Cancelled));
        drop(work);
        let keeping = held.clone();
        let dispatched = Port::new(Arc::new(move |work| {
            work.call.begin()?;
            work.call.dispatch()?;
            *keeping.lock().unwrap() = Some(work);
            Ok(())
        }))
        .with_timeout(Duration::ZERO);
        assert!(matches!(
            dispatched.request(
                authority(),
                Request::MagpieImport(vec![1]),
                Arc::new(|| true)
            ),
            Err(Error::Unknown)
        ));
        let work = held.lock().unwrap().take().unwrap();
        assert!(!work.call.current());
        assert_eq!(work.call.failure(Error::Cancelled), Error::Unknown);
        work.call.finish(Ok(Response {
            status: 200,
            body: vec![1],
        }));
    }
    #[test]
    fn no_local_service_grant_can_be_inferred_from_a_remote_or_localhost() {
        let port = Port::new(Arc::new(|_| panic!("local service is not installed")));
        assert!(matches!(port.local_service(), Err(Error::Unavailable)));
        assert!(matches!(
            port.request(
                Authority::Local(LocalServiceGrant { _private: () }),
                Request::CredentialsInventory,
                Arc::new(|| true)
            ),
            Err(Error::Unavailable)
        ));
    }
}
