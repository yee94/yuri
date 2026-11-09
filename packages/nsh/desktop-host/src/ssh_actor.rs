//! Adapter to the original actor's exact typed mailbox; no Vault or Host authority here.
use super::*;
use crate::connection_actor_port as mailbox;
use std::sync::{Mutex, atomic::AtomicBool};

pub struct Adapter {
    port: mailbox::Port,
    retired: AtomicBool,
    quarantine_failure: Mutex<Option<Error>>,
}
pub struct Service {
    pub owner: Arc<Owner>,
    pub adapter: Arc<Adapter>,
}
/// Call on an SSH service worker: Owner::new waits for the original actor's load reply.
/// This does NOT register HostChannel capabilities, set available, or install another actor.
pub fn create(port: mailbox::Port, driver: Arc<dyn Driver>, version: String) -> Result<Service> {
    let adapter = Arc::new(Adapter::new(port));
    let owner = Owner::new(adapter.clone(), driver, version)?;
    Ok(Service { owner, adapter })
}
impl Adapter {
    pub fn new(port: mailbox::Port) -> Self {
        Self {
            port,
            retired: AtomicBool::new(false),
            quarantine_failure: Mutex::new(None),
        }
    }
    pub fn quarantine_failure(&self) -> Option<Error> {
        self.quarantine_failure
            .lock()
            .map_or(Some(Error::CommitUnknown), |v| *v)
    }
    fn current(&self) -> Result<()> {
        if self.retired.load(Ordering::Acquire) {
            Err(Error::CommitUnknown)
        } else {
            Ok(())
        }
    }
    fn reply<T>(&self, result: mailbox::Result<T>) -> Result<T> {
        result.map_err(|failure| {
            if failure == mailbox::Error::CommitUnknown {
                self.retired.store(true, Ordering::Release);
            }
            error(failure)
        })
    }
    fn committed(&self, value: mailbox::Committed) -> Result<Committed> {
        if !identifier(&value.connection_id)
            || value.receipt.is_empty()
            || value.receipt.len() > 4096
        {
            self.retired.store(true, Ordering::Release);
            return Err(Error::CommitUnknown);
        }
        Ok(Committed {
            connection_id: value.connection_id,
            receipt: value.receipt,
        })
    }
}
fn error(error: mailbox::Error) -> Error {
    match error {
        mailbox::Error::Invalid => Error::Invalid,
        mailbox::Error::Stale => Error::Stale,
        mailbox::Error::Busy => Error::Busy,
        mailbox::Error::Storage => Error::Storage,
        mailbox::Error::CommitUnknown => Error::CommitUnknown,
        mailbox::Error::Unavailable => Error::Unavailable,
        mailbox::Error::Cancelled => Error::Cancelled,
        mailbox::Error::Authentication => Error::Authentication,
    }
}
fn target(instance: &Instance) -> Result<mailbox::Target> {
    Instance::parse(&instance.public())?;
    Ok(mailbox::Target {
        id: instance.id.clone(),
        label: instance.label.clone(),
        host: instance.host.clone(),
        user: instance.user.clone(),
        port: instance.port,
        remote_port: instance.remote_port,
        local_port: instance.local_port,
        managed: instance.managed,
    })
}
fn instance(target: mailbox::Target) -> Result<Instance> {
    let row = Instance {
        id: target.id,
        label: target.label,
        host: target.host,
        user: target.user,
        port: target.port,
        remote_port: target.remote_port,
        local_port: target.local_port,
        managed: target.managed,
    };
    Instance::parse(&row.public())
}
fn receipt(value: &Committed) -> mailbox::Committed {
    mailbox::Committed {
        connection_id: value.connection_id.clone(),
        receipt: value.receipt.clone(),
    }
}
fn current(cancel: &Cancellation) -> mailbox::Current {
    let cancel = cancel.clone();
    Arc::new(move || cancel.check().is_ok())
}
impl ActorPort for Adapter {
    fn load(&self) -> Result<Registry> {
        self.current()?;
        let registry = self.reply(self.port.load())?;
        Ok(Registry {
            revision: registry.revision,
            instances: registry
                .instances
                .into_iter()
                .map(instance)
                .collect::<Result<_>>()?,
        })
    }
    fn save(&self, revision: u64, instances: &[Instance]) -> Result<u64> {
        self.current()?;
        self.reply(self.port.save(
            revision,
            instances.iter().map(target).collect::<Result<_>>()?,
        ))
    }
    fn password(&self, instance: &Instance) -> Result<Secret> {
        self.current()?;
        let secret = self.reply(self.port.password(target(instance)?))?;
        Secret::new(secret.expose().to_owned())
    }
    fn restore(&self, instance: &Instance, cancel: &Cancellation) -> Result<Option<Committed>> {
        self.current()?;
        cancel.check()?;
        self.reply(self.port.restore(target(instance)?, current(cancel)))?
            .map(|value| self.committed(value))
            .transpose()
    }
    fn authorize(
        &self,
        instance: &Instance,
        port: u16,
        password: &Secret,
        cancel: &Cancellation,
    ) -> Result<Committed> {
        self.current()?;
        cancel.check()?;
        if port == 0 {
            return Err(Error::Invalid);
        }
        let password = mailbox::Secret::new(password.expose().to_owned()).map_err(error)?;
        self.committed(self.reply(self.port.authorize(
            target(instance)?,
            port,
            password,
            current(cancel),
        ))?)
    }
    fn healthy(&self, committed: &Committed) -> Result<bool> {
        self.current()?;
        self.reply(self.port.healthy(receipt(committed)))
    }
    fn retire(&self, committed: &Committed) -> Result<()> {
        self.reply(self.port.retire(receipt(committed)))
    }
    fn quarantine(&self) {
        self.retired.store(true, Ordering::Release);
        if let Err(failure) = self.port.quarantine() && let Ok(mut fault) = self.quarantine_failure.lock() {
            *fault = Some(error(failure));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::AtomicUsize, time::Duration};

    fn fixture_target() -> Instance {
        Instance {
            id: "native-port-fixture".into(),
            label: "Synthetic native mailbox".into(),
            host: "ssh.example.invalid".into(),
            user: "fixture".into(),
            port: 22,
            remote_port: 3210,
            local_port: 0,
            managed: false,
        }
    }
    #[test]
    fn exact_typed_roundtrip_cancellation_and_quarantine_error_are_not_swallowed() {
        let row = Instance {
            id: "synthetic-actor".into(),
            label: "原生 SSH".into(),
            host: "ssh.example.invalid".into(),
            user: "fixture".into(),
            port: 2222,
            remote_port: 3210,
            local_port: 4210,
            managed: false,
        };
        let expected = target(&row).unwrap();
        let saved = Arc::new(Mutex::new(Vec::new()));
        let audit = saved.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let captured = calls.clone();
        let port = mailbox::Port::new(Arc::new(move |command| {
            match command {
                mailbox::Command::Load(call) => {
                    call.begin()?;
                    call.finish(Ok(mailbox::Registry {
                        revision: 7,
                        instances: vec![expected.clone()],
                    }));
                }
                mailbox::Command::Save {
                    expected_revision,
                    instances,
                    call,
                } => {
                    call.begin()?;
                    assert_eq!(expected_revision, 7);
                    assert_eq!(instances, vec![expected.clone()]);
                    *audit.lock().unwrap() = instances;
                    call.finish(Ok(8));
                }
                mailbox::Command::Password { target, call } => {
                    call.begin()?;
                    assert_eq!(target, expected);
                    call.finish(Ok(mailbox::Secret::new(
                        "synthetic-native-secret-only".into(),
                    )?));
                }
                mailbox::Command::Restore {
                    target,
                    current,
                    call,
                    ..
                } => {
                    call.begin()?;
                    assert_eq!(target, expected);
                    assert!(current());
                    captured.lock().unwrap().push(current);
                    call.finish(Ok(None));
                }
                mailbox::Command::Authorize {
                    target,
                    local_port,
                    password,
                    current,
                    call,
                    ..
                } => {
                    call.begin()?;
                    assert_eq!(target, expected);
                    assert_eq!(local_port, 4210);
                    assert_eq!(password.expose(), "synthetic-native-secret-only");
                    assert!(current());
                    captured.lock().unwrap().push(current);
                    call.finish(Ok(mailbox::Committed {
                        connection_id: "native-connection".into(),
                        receipt: "opaque-native-receipt".into(),
                    }));
                }
                mailbox::Command::Healthy { committed, call, .. } => {
                    call.begin()?;
                    assert_eq!(committed.receipt, "opaque-native-receipt");
                    call.finish(Ok(true));
                }
                mailbox::Command::Retire { committed, call } => {
                    call.begin()?;
                    assert_eq!(committed.receipt, "opaque-native-receipt");
                    call.finish(Ok(()));
                }
                mailbox::Command::Quarantine(call) => {
                    call.begin()?;
                    call.finish(Err(mailbox::Error::Busy));
                }
            }
            Ok(())
        }));
        let adapter = Adapter {
            port,
            retired: AtomicBool::new(false),
            quarantine_failure: Mutex::new(None),
        };
        assert_eq!(adapter.load().unwrap().instances, vec![row.clone()]);
        assert_eq!(adapter.save(7, std::slice::from_ref(&row)).unwrap(), 8);
        assert_eq!(saved.lock().unwrap().len(), 1);
        let password = adapter.password(&row).unwrap();
        let cancel = Cancellation::default();
        assert!(adapter.restore(&row, &cancel).unwrap().is_none());
        let receipt = adapter.authorize(&row, 4210, &password, &cancel).unwrap();
        assert!(adapter.healthy(&receipt).unwrap());
        cancel.cancel();
        assert!(calls.lock().unwrap().iter().all(|f| !f()));
        adapter.retire(&receipt).unwrap();
        adapter.quarantine();
        assert_eq!(adapter.quarantine_failure(), Some(Error::Busy));
        assert!(matches!(adapter.load(), Err(Error::CommitUnknown)));
    }
    #[test]
    fn all_original_actor_errors_keep_their_disposition() {
        for (original, mapped) in [
            (mailbox::Error::Invalid, Error::Invalid),
            (mailbox::Error::Stale, Error::Stale),
            (mailbox::Error::Busy, Error::Busy),
            (mailbox::Error::Storage, Error::Storage),
            (mailbox::Error::CommitUnknown, Error::CommitUnknown),
            (mailbox::Error::Unavailable, Error::Unavailable),
            (mailbox::Error::Cancelled, Error::Cancelled),
            (mailbox::Error::Authentication, Error::Authentication),
        ] {
            assert_eq!(error(original), mapped);
        }
    }

    #[test]
    fn full_queue_and_unadmitted_timeout_remain_busy_without_poison_or_retirement() {
        let submitted = Arc::new(AtomicUsize::new(0));
        let poisoned = Arc::new(AtomicUsize::new(0));
        let count = submitted.clone();
        let poison = poisoned.clone();
        let adapter = Adapter::new(mailbox::Port::with_poison(
            Arc::new(move |command| {
                count.fetch_add(1, Ordering::SeqCst);
                match command {
                    mailbox::Command::Save { .. } => Err(mailbox::Error::Busy),
                    mailbox::Command::Load(call) => {
                        call.begin()?;
                        call.finish(Ok(mailbox::Registry {
                            revision: 0,
                            instances: Vec::new(),
                        }));
                        Ok(())
                    }
                    _ => panic!("unexpected native call"),
                }
            }),
            Arc::new(move || {
                poison.fetch_add(1, Ordering::SeqCst);
            }),
        ));
        assert_eq!(adapter.save(0, &[]), Err(Error::Busy));
        assert_eq!(adapter.load().unwrap().revision, 0);
        assert_eq!(submitted.load(Ordering::SeqCst), 2);
        assert_eq!(poisoned.load(Ordering::SeqCst), 0);

        let held = Arc::new(Mutex::new(None));
        let queued = held.clone();
        let poison = poisoned.clone();
        let port = mailbox::Port::with_poison(
            Arc::new(move |command| {
                let mailbox::Command::Save { call, .. } = command else {
                    panic!("unexpected native call");
                };
                *queued.lock().unwrap() = Some(call);
                Ok(())
            }),
            Arc::new(move || {
                poison.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .with_timeout(Duration::ZERO);
        let adapter = Adapter::new(port);
        assert_eq!(adapter.save(0, &[]), Err(Error::Busy));
        assert_eq!(
            held.lock().unwrap().take().unwrap().begin(),
            Err(mailbox::Error::Cancelled)
        );
        assert!(adapter.current().is_ok());
        assert_eq!(poisoned.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn every_admitted_mutation_timeout_keeps_native_poison_and_adapter_terminal_without_replay() {
        for action in ["save", "password", "restore", "authorize", "retire"] {
            let submitted = Arc::new(AtomicUsize::new(0));
            let poisoned = Arc::new(AtomicUsize::new(0));
            let held = Arc::new(Mutex::new(Vec::new()));
            let capture = held.clone();
            let count = submitted.clone();
            let poison = poisoned.clone();
            let port = mailbox::Port::with_poison(
                Arc::new(move |command| {
                    count.fetch_add(1, Ordering::SeqCst);
                    match &command {
                        mailbox::Command::Save { call, .. } => call.begin()?,
                        mailbox::Command::Password { call, .. } => call.begin()?,
                        mailbox::Command::Restore { call, .. } => call.begin()?,
                        mailbox::Command::Authorize { call, .. } => call.begin()?,
                        mailbox::Command::Retire { call, .. } => call.begin()?,
                        _ => panic!("unexpected native call"),
                    }
                    capture.lock().unwrap().push(command);
                    Ok(())
                }),
                Arc::new(move || {
                    poison.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .with_timeout(Duration::ZERO);
            let adapter = Adapter::new(port);
            let row = fixture_target();
            let cancel = Cancellation::default();
            let result = match action {
                "save" => adapter.save(0, std::slice::from_ref(&row)).map(|_| ()),
                "password" => adapter.password(&row).map(|_| ()),
                "restore" => adapter.restore(&row, &cancel).map(|_| ()),
                "authorize" => adapter
                    .authorize(
                        &row,
                        4210,
                        &Secret::new("synthetic-secret".into()).unwrap(),
                        &cancel,
                    )
                    .map(|_| ()),
                "retire" => adapter.retire(&Committed {
                    connection_id: "synthetic-connection".into(),
                    receipt: "synthetic-receipt".into(),
                }),
                _ => unreachable!(),
            };
            assert_eq!(result, Err(Error::CommitUnknown), "{action}");
            assert_eq!(poisoned.load(Ordering::SeqCst), 1);
            assert!(matches!(adapter.load(), Err(Error::CommitUnknown)));
            assert!(matches!(adapter.password(&row), Err(Error::CommitUnknown)));
            assert_eq!(submitted.load(Ordering::SeqCst), 1);
            cancel.cancel();
            for command in held.lock().unwrap().drain(..) {
                match command {
                    mailbox::Command::Save { call, .. } => {
                        assert!(!call.current());
                        call.finish(Ok(1));
                    }
                    mailbox::Command::Password { call, .. } => {
                        assert!(!call.current());
                        call.finish(Ok(
                            mailbox::Secret::new("late-native-secret".into()).unwrap()
                        ));
                    }
                    mailbox::Command::Restore { call, current, .. } => {
                        assert!(!call.current());
                        assert!(!current());
                        call.finish(Ok(None));
                    }
                    mailbox::Command::Authorize { call, current, .. } => {
                        assert!(!call.current());
                        assert!(!current());
                        call.finish(Ok(mailbox::Committed {
                            connection_id: "late-native-connection".into(),
                            receipt: "late-native-receipt".into(),
                        }));
                    }
                    mailbox::Command::Retire { call, .. } => {
                        assert!(!call.current());
                        call.finish(Ok(()));
                    }
                    _ => unreachable!(),
                }
            }
            assert!(matches!(adapter.load(), Err(Error::CommitUnknown)));
            assert_eq!(submitted.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn external_missing_native_credential_is_authentication_with_no_generated_fallback() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let adapter = Adapter::new(mailbox::Port::new(Arc::new(move |command| {
            count.fetch_add(1, Ordering::SeqCst);
            let mailbox::Command::Password { target, call } = command else {
                panic!("credential failure must not start another native action");
            };
            call.begin()?;
            assert!(!target.managed);
            call.finish(Err(mailbox::Error::Authentication));
            Ok(())
        })));
        assert!(matches!(
            adapter.password(&fixture_target()),
            Err(Error::Authentication)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(adapter.current().is_ok());
    }

    #[test]
    fn malformed_committed_ack_is_unknown_not_an_authentication_rejection() {
        for restore in [false, true] {
            let adapter = Adapter::new(mailbox::Port::new(Arc::new(move |command| {
                let value = mailbox::Committed {
                    connection_id: "native-connection".into(),
                    receipt: String::new(),
                };
                match command {
                    mailbox::Command::Authorize { call, .. } => {
                        assert!(!restore);
                        call.begin()?;
                        call.finish(Ok(value));
                    }
                    mailbox::Command::Restore { call, .. } => {
                        assert!(restore);
                        call.begin()?;
                        call.finish(Ok(Some(value)));
                    }
                    _ => panic!("unexpected native call after malformed commit"),
                }
                Ok(())
            })));
            let row = fixture_target();
            let cancel = Cancellation::default();
            let result = if restore {
                adapter.restore(&row, &cancel).map(|_| ())
            } else {
                adapter
                    .authorize(
                        &row,
                        4210,
                        &Secret::new("synthetic-secret".into()).unwrap(),
                        &cancel,
                    )
                    .map(|_| ())
            };
            assert_eq!(result, Err(Error::CommitUnknown));
            assert!(matches!(adapter.load(), Err(Error::CommitUnknown)));
        }
    }
}
