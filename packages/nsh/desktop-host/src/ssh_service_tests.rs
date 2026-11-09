use super::*;
use crate::connection_actor_port as port;
use std::sync::{Condvar, atomic::AtomicUsize};

#[derive(Default)]
struct Gate {
    held: Mutex<bool>,
    changed: Condvar,
}
impl Gate {
    fn hold(&self) {
        *self.held.lock().unwrap() = true;
    }
    fn release(&self) {
        *self.held.lock().unwrap() = false;
        self.changed.notify_all();
    }
    fn wait(&self) {
        let held = self.held.lock().unwrap();
        let (held, _) = self
            .changed
            .wait_timeout_while(held, Duration::from_secs(5), |v| *v)
            .unwrap();
        assert!(!*held, "synthetic gate timed out");
    }
}
#[derive(Default)]
struct Transport {
    inspected: AtomicUsize,
    gate: Gate,
    closed: Arc<AtomicUsize>,
    thread_exit: Option<(Arc<Gate>, Arc<AtomicBool>)>,
}
struct ThreadExit(std::cell::RefCell<Option<(Arc<Gate>, Arc<AtomicBool>)>>);
impl Drop for ThreadExit {
    fn drop(&mut self) {
        if let Some((gate, entered)) = self.0.get_mut().take() {
            entered.store(true, Ordering::Release);
            gate.wait();
        }
    }
}
thread_local! {static THREAD_EXIT:ThreadExit=const{ThreadExit(std::cell::RefCell::new(None))};}
struct Session(Arc<AtomicUsize>);
impl Tunnel for Session {
    fn alive(&mut self) -> bool {
        true
    }
    fn close(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl Driver for Transport {
    fn inspect(&self, _: &Instance, cancel: &Cancellation) -> Result<Inspection> {
        if let Some(exit) = &self.thread_exit {
            THREAD_EXIT.with(|v| *v.0.borrow_mut() = Some(exit.clone()));
        }
        self.inspected.fetch_add(1, Ordering::SeqCst);
        self.gate.wait();
        cancel.check()?;
        Ok(Inspection {
            version: Some("1.2.3".into()),
            node_major: 24,
        })
    }
    fn initialize(&self, _: &Instance, _: &str, _: &Secret, cancel: &Cancellation) -> Result<()> {
        cancel.check()
    }
    fn forward(&self, _: &Instance, cancel: &Cancellation) -> Result<Forward> {
        cancel.check()?;
        Ok(Forward {
            port: 4210,
            tunnel: Box::new(Session(self.closed.clone())),
        })
    }
}
fn target() -> Instance {
    Instance::parse(&json!({"id":"worker-fixture","label":"Synthetic worker","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true})).unwrap()
}
fn row() -> port::Target {
    let v = target();
    port::Target {
        id: v.id,
        label: v.label,
        host: v.host,
        user: v.user,
        port: v.port,
        remote_port: v.remote_port,
        local_port: v.local_port,
        managed: v.managed,
    }
}
#[derive(Default)]
struct Actor {
    load_gate: Gate,
    save_gate: Gate,
    saves: AtomicUsize,
    retires: AtomicUsize,
    calls: AtomicUsize,
    load_error: Mutex<Option<port::Error>>,
    save_error: Mutex<Option<port::Error>>,
    health_error: Mutex<Option<port::Error>>,
    health_calls: AtomicUsize,
    quarantine_error: Mutex<Option<port::Error>>,
}
impl Actor {
    fn port(self: &Arc<Self>) -> port::Port {
        let actor = self.clone();
        port::Port::new(Arc::new(move |command| {
            assert_ne!(std::thread::current().name(), Some("main"));
            actor.calls.fetch_add(1, Ordering::SeqCst);
            match command {
                port::Command::Load(call) => {
                    assert_eq!(std::thread::current().name(), Some("yuri-ssh-service"));
                    call.begin()?;
                    actor.load_gate.wait();
                    call.finish(match *actor.load_error.lock().unwrap() {
                        Some(e) => Err(e),
                        None => Ok(port::Registry {
                            revision: 1,
                            instances: vec![row()],
                        }),
                    });
                }
                port::Command::Save {
                    expected_revision,
                    call,
                    ..
                } => {
                    call.begin()?;
                    actor.saves.fetch_add(1, Ordering::SeqCst);
                    actor.save_gate.wait();
                    call.finish(match *actor.save_error.lock().unwrap() {
                        Some(e) => Err(e),
                        None => Ok(expected_revision + 1),
                    });
                }
                port::Command::Password { call, .. } => {
                    call.begin()?;
                    call.finish(Ok(port::Secret::new(
                        "native-only-synthetic-password".into(),
                    )?));
                }
                port::Command::Authorize { current, call, .. } => {
                    call.begin()?;
                    if !current() {
                        call.finish(Err(port::Error::Cancelled));
                    } else {
                        call.finish(Ok(port::Committed {
                            connection_id: "worker-connection".into(),
                            receipt: "native-only-synthetic-receipt".into(),
                        }));
                    }
                }
                port::Command::Restore { current, call, .. } => {
                    call.begin()?;
                    assert!(current());
                    call.finish(Ok(None));
                }
                port::Command::Healthy { call, .. } => {
                    call.begin()?;
                    actor.health_calls.fetch_add(1, Ordering::SeqCst);
                    call.finish(match *actor.health_error.lock().unwrap() {
                        Some(error) => Err(error),
                        None => Ok(true),
                    });
                }
                port::Command::Retire { call, .. } => {
                    call.begin()?;
                    actor.retires.fetch_add(1, Ordering::SeqCst);
                    call.finish(Ok(()));
                }
                port::Command::Quarantine(call) => {
                    call.begin()?;
                    call.finish(match *actor.quarantine_error.lock().unwrap() {
                        Some(e) => Err(e),
                        None => Ok(()),
                    });
                }
            }
            Ok(())
        }))
    }
}
struct Installed {
    handle: Handle,
    ready: Receiver<Result<()>>,
    stopped: Receiver<Result<()>>,
}
fn start(actor: &Arc<Actor>, driver: Arc<Transport>) -> Installed {
    let (ready_tx, ready) = mpsc::channel();
    let (stop_tx, stopped) = mpsc::channel();
    let handle = install(
        actor.port(),
        driver,
        "1.2.3".into(),
        Box::new(move |r| {
            let _ = ready_tx.send(r);
        }),
        Box::new(move |r| {
            let _ = stop_tx.send(r);
        }),
    )
    .unwrap();
    Installed {
        handle,
        ready,
        stopped,
    }
}
fn request(handle: &Handle, request: Request) -> Receiver<Outcome> {
    let (tx, rx) = mpsc::channel();
    handle
        .submit(
            request,
            Cancellation::default(),
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        )
        .unwrap();
    rx
}
fn receive(rx: &Receiver<Outcome>) -> Value {
    match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
        Outcome::Complete(value) => value,
        Outcome::Denied(e) => panic!("unexpected denied {e:?}"),
        Outcome::Unknown(e) => panic!("unexpected unknown {e:?}"),
    }
}
fn wait(check: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(3);
    while !check() {
        assert!(Instant::now() < until, "synthetic worker timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn install_runs_native_port_on_worker_and_connection_commands_return_only_public_metadata() {
    let actor = Arc::new(Actor::default());
    let driver = Arc::new(Transport::default());
    let service = start(&actor, driver.clone());
    assert_eq!(
        service.ready.recv_timeout(Duration::from_secs(3)).unwrap(),
        Ok(())
    );
    assert_eq!(service.handle.phase(), Phase::Ready);
    let snapshot = receive(&request(&service.handle, Request::Snapshot));
    assert_eq!(snapshot["instances"][0]["id"], "worker-fixture");
    let mut changed = target();
    changed.label = "Changed".into();
    let saved = receive(&request(
        &service.handle,
        Request::Save {
            request_id: "worker-save".into(),
            revision: 1,
            instance: changed,
        },
    ));
    assert_eq!(saved["revision"], 2);
    receive(&request(
        &service.handle,
        Request::Start {
            request_id: "worker-connect".into(),
            id: "worker-fixture".into(),
            intent: Intent::Connect,
        },
    ));
    let public = loop {
        let value = receive(&request(&service.handle, Request::Snapshot));
        if value["statuses"][0]["phase"] == "ready" && value["statuses"][0]["running"] == false {
            break value;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    assert!(!public.to_string().contains("native-only"));
    let attempt = public["statuses"][0]["attempt"].as_u64().unwrap();
    receive(&request(
        &service.handle,
        Request::Cancel {
            id: "worker-fixture".into(),
            attempt,
        },
    ));
    assert_eq!(actor.retires.load(Ordering::SeqCst), 1);
    receive(&request(
        &service.handle,
        Request::Remove {
            request_id: "worker-remove".into(),
            revision: 2,
            id: "worker-fixture".into(),
        },
    ));
    service.handle.shutdown();
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
    assert_eq!(service.handle.phase(), Phase::Stopped);
    assert_eq!(driver.closed.load(Ordering::SeqCst), 1);
}

#[test]
fn startup_failure_or_shutdown_during_load_never_admits_requests() {
    let actor = Arc::new(Actor::default());
    *actor.load_error.lock().unwrap() = Some(port::Error::Storage);
    let service = start(&actor, Arc::new(Transport::default()));
    assert_eq!(
        service.ready.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err(Error::Storage)
    );
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Err(Error::Storage)
    );
    assert_eq!(service.handle.phase(), Phase::Failed(Error::Storage));
    assert_eq!(
        service.handle.submit(
            Request::Snapshot,
            Cancellation::default(),
            Box::new(|_| panic!("rejected request must not be kept"))
        ),
        Err(Error::Unavailable)
    );
    let actor = Arc::new(Actor::default());
    actor.load_gate.hold();
    let service = start(&actor, Arc::new(Transport::default()));
    wait(|| actor.calls.load(Ordering::SeqCst) == 1);
    assert_eq!(service.handle.phase(), Phase::Starting);
    service.handle.shutdown();
    actor.load_gate.release();
    assert_eq!(
        service.ready.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err(Error::Cancelled)
    );
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
}

#[test]
fn capacity_is_bounded_and_queued_cancellation_or_shutdown_never_dispatches_the_write() {
    let actor = Arc::new(Actor::default());
    let service = start(&actor, Arc::new(Transport::default()));
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    actor.save_gate.hold();
    let running = request(
        &service.handle,
        Request::Save {
            request_id: "held-save".into(),
            revision: 1,
            instance: target(),
        },
    );
    wait(|| actor.saves.load(Ordering::SeqCst) == 1);
    let mut queued = Vec::new();
    for n in 0..CAPACITY {
        let cancel = Cancellation::default();
        let (tx, rx) = mpsc::channel();
        service
            .handle
            .submit(
                Request::Save {
                    request_id: format!("queued-{n}"),
                    revision: 2,
                    instance: target(),
                },
                cancel.clone(),
                Box::new(move |r| {
                    let _ = tx.send(r);
                }),
            )
            .unwrap();
        cancel.cancel();
        queued.push(rx);
    }
    assert_eq!(
        service.handle.submit(
            Request::Snapshot,
            Cancellation::default(),
            Box::new(|_| panic!("full request must not be retained"))
        ),
        Err(Error::Busy)
    );
    service.handle.shutdown();
    actor.save_gate.release();
    assert!(matches!(
        running.recv_timeout(Duration::from_secs(3)).unwrap(),
        Outcome::Unknown(_)
    ));
    for rx in queued {
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            Outcome::Denied(Error::Cancelled)
        ));
    }
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Err(Error::CommitUnknown)
    );
    assert_eq!(actor.saves.load(Ordering::SeqCst), 1);
}

#[test]
fn readonly_health_queue_pressure_does_not_retire_a_committed_connection() {
    let actor = Arc::new(Actor::default());
    *actor.health_error.lock().unwrap() = Some(port::Error::Busy);
    let service = start(&actor, Arc::new(Transport::default()));
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    receive(&request(
        &service.handle,
        Request::Start {
            request_id: "health-connect".into(),
            id: "worker-fixture".into(),
            intent: Intent::Connect,
        },
    ));
    wait(|| actor.health_calls.load(Ordering::SeqCst) > 0);
    let value = receive(&request(&service.handle, Request::Snapshot));
    assert_eq!(value["statuses"][0]["phase"], "ready");
    assert_eq!(value["statuses"][0]["connectionID"], "worker-connection");
    assert_eq!(actor.retires.load(Ordering::SeqCst), 0);
    service.handle.shutdown();
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
    assert_eq!(actor.retires.load(Ordering::SeqCst), 1);
}

#[test]
fn cancelled_queued_request_is_denied_without_stopping_or_replaying_other_requests() {
    let actor = Arc::new(Actor::default());
    let service = start(&actor, Arc::new(Transport::default()));
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    actor.save_gate.hold();
    let running = request(
        &service.handle,
        Request::Save {
            request_id: "queue-blocker".into(),
            revision: 1,
            instance: target(),
        },
    );
    wait(|| actor.saves.load(Ordering::SeqCst) == 1);
    let cancel = Cancellation::default();
    let (tx, rx) = mpsc::channel();
    service
        .handle
        .submit(
            Request::Save {
                request_id: "cancel-before-admission".into(),
                revision: 2,
                instance: target(),
            },
            cancel.clone(),
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        )
        .unwrap();
    cancel.cancel();
    actor.save_gate.release();
    assert_eq!(receive(&running)["revision"], 2);
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
        Outcome::Denied(Error::Cancelled)
    ));
    assert_eq!(
        receive(&request(&service.handle, Request::Snapshot))["revision"],
        2
    );
    assert_eq!(actor.saves.load(Ordering::SeqCst), 1);
    service.handle.shutdown();
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
}

#[test]
fn shutdown_callback_waits_for_cancelled_operation_physical_exit() {
    let actor = Arc::new(Actor::default());
    let exit_gate = Arc::new(Gate::default());
    exit_gate.hold();
    let exit_entered = Arc::new(AtomicBool::new(false));
    let driver = Arc::new(Transport {
        thread_exit: Some((exit_gate.clone(), exit_entered.clone())),
        ..Transport::default()
    });
    driver.gate.hold();
    let service = start(&actor, driver.clone());
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    receive(&request(
        &service.handle,
        Request::Start {
            request_id: "held-connect".into(),
            id: "worker-fixture".into(),
            intent: Intent::Connect,
        },
    ));
    wait(|| driver.inspected.load(Ordering::SeqCst) == 1);
    service.handle.shutdown();
    assert_eq!(service.handle.phase(), Phase::Stopping);
    assert!(matches!(
        service.stopped.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    driver.gate.release();
    wait(|| exit_entered.load(Ordering::Acquire));
    assert!(matches!(
        service.stopped.recv_timeout(Duration::from_millis(30)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    exit_gate.release();
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
    assert_eq!(service.handle.phase(), Phase::Stopped);
}

#[test]
fn commit_unknown_retires_dispatcher_and_reports_quarantine_failure_not_ordinary_stop() {
    let actor = Arc::new(Actor::default());
    *actor.save_error.lock().unwrap() = Some(port::Error::CommitUnknown);
    *actor.quarantine_error.lock().unwrap() = Some(port::Error::Busy);
    let service = start(&actor, Arc::new(Transport::default()));
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    let rx = request(
        &service.handle,
        Request::Save {
            request_id: "unknown-save".into(),
            revision: 1,
            instance: target(),
        },
    );
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(3)).unwrap(),
        Outcome::Unknown(Error::CommitUnknown)
    ));
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Err(Error::Busy)
    );
    assert_eq!(service.handle.phase(), Phase::Failed(Error::Busy));
    assert_eq!(actor.saves.load(Ordering::SeqCst), 1);
}

#[test]
fn last_handle_drop_stops_worker_and_callback_panic_cannot_strand_service() {
    let actor = Arc::new(Actor::default());
    let service = start(&actor, Arc::new(Transport::default()));
    service
        .ready
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    service
        .handle
        .submit(
            Request::Snapshot,
            Cancellation::default(),
            Box::new(|_| panic!("synthetic reply failure")),
        )
        .unwrap();
    receive(&request(&service.handle, Request::Snapshot));
    let clone = service.handle.clone();
    drop(service.handle);
    assert!(matches!(
        service.stopped.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    drop(clone);
    assert_eq!(
        service
            .stopped
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Ok(())
    );
}
