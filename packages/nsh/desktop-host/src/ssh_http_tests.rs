use super::*;
use serde_json::json;
use std::sync::{Mutex, atomic::AtomicUsize};

fn grant(cancel: Cancellation) -> SyncGrant {
    SyncGrant {
        instance: super::super::Instance::parse(&json!({"id":"http-fixture","label":"Synthetic HTTP","host":"ssh.example.invalid","user":"fixture","port":22,"remotePort":3210,"localPort":0,"managed":true})).unwrap(),
        committed: super::super::Committed { connection_id: "native-http-fixture".into(), receipt: "synthetic-private-receipt".into() },
        cancel,
    }
}
fn response(value: Value) -> native::Response {
    native::Response {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    }
}
fn remote(port: native::Port) -> Adapter {
    Adapter::remote(port, grant(Cancellation::default())).unwrap()
}
fn transfer(kind: Kind) -> Transfer {
    Transfer {
        kind,
        bytes: b"synthetic-private-transfer".to_vec(),
    }
}
fn fixture(
    work: impl Fn(native::Request) -> native::Result<native::Response> + Send + Sync + 'static,
) -> native::Port {
    native::Port::new(Arc::new(move |pending| {
        match &pending.authority {
            native::Authority::Remote(receipt) => {
                assert_eq!(receipt.connection_id, "native-http-fixture");
                assert_eq!(receipt.receipt, "synthetic-private-receipt");
            }
            native::Authority::Local(_) => panic!("no local service producer"),
        }
        assert!((pending.current)());
        pending.call.begin()?;
        pending.call.dispatch()?;
        let result = work(pending.request);
        pending.call.finish(result);
        Ok(())
    }))
}

#[test]
fn six_fixed_requests_keep_exact_native_receipt_and_private_bytes() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let adapter = remote(fixture(move |request| {
        let (name, value) = match request {
            native::Request::CredentialsInventory => (
                "credentials-inventory",
                response(json!({"providerCredentials":{"bytes":27}})),
            ),
            native::Request::MagpieInventory => (
                "magpie-inventory",
                response(json!({"magpie":{"available":true,"installed":true}})),
            ),
            native::Request::CredentialsExport => (
                "credentials-export",
                native::Response {
                    status: 200,
                    body: b"synthetic-private-credentials".to_vec(),
                },
            ),
            native::Request::MagpieExport => (
                "magpie-export",
                native::Response {
                    status: 200,
                    body: b"synthetic-private-magpie".to_vec(),
                },
            ),
            native::Request::CredentialsImport(bytes) => {
                assert_eq!(bytes, b"synthetic-private-credentials");
                ("credentials-import", response(json!({"ok":true})))
            }
            native::Request::MagpieImport(bytes) => {
                assert_eq!(bytes, b"synthetic-private-magpie");
                (
                    "magpie-import",
                    response(
                        json!({"ok":true,"magpieWarnings":["sign_in_required","plugin_install_failed","agent_settings_skipped"]}),
                    ),
                )
            }
        };
        seen.lock().unwrap().push(name);
        Ok(value)
    }));
    let cancel = Cancellation::default();
    assert_eq!(
        adapter.inventory(Kind::Credentials, &cancel),
        Ok(Inventory::Credentials { bytes: Some(27) })
    );
    assert_eq!(
        adapter.inventory(Kind::Magpie, &cancel),
        Ok(Inventory::Magpie {
            available: true,
            installed: true
        })
    );
    let credentials = adapter.export(Kind::Credentials, &cancel).unwrap();
    assert_eq!(
        adapter.import(credentials, &cancel),
        Ok(Ack { warnings: vec![] })
    );
    let magpie = adapter.export(Kind::Magpie, &cancel).unwrap();
    assert_eq!(
        adapter.import(magpie, &cancel),
        Ok(Ack {
            warnings: vec![
                Warning::SignInRequired,
                Warning::PluginInstallFailed,
                Warning::AgentSettingsSkipped
            ]
        })
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "credentials-inventory",
            "magpie-inventory",
            "credentials-export",
            "credentials-import",
            "magpie-export",
            "magpie-import"
        ]
    );
}

#[test]
fn local_unavailable_never_submits_or_substitutes_remote_authority() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let port = native::Port::new(Arc::new(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        Err(Error::Unavailable)
    }));
    assert!(matches!(
        Adapter::local(port, Cancellation::default()),
        Err(Error::Unavailable)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn invalid_native_receipt_is_rejected_before_any_actor_call() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let port = native::Port::new(Arc::new(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        Err(Error::Unavailable)
    }));
    for (connection_id, receipt) in [
        ("bad/id".into(), "synthetic".into()),
        ("valid".into(), String::new()),
        ("valid".into(), "x".repeat(4097)),
    ] {
        let mut scope = grant(Cancellation::default());
        scope.committed.connection_id = connection_id;
        scope.committed.receipt = receipt;
        assert!(matches!(
            Adapter::remote(port.clone(), scope),
            Err(Error::Invalid)
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn failed_or_empty_exports_never_become_importable_transfers() {
    for (status, body, error) in [
        (200, Vec::new(), Error::Invalid),
        (401, b"synthetic-private-error".to_vec(), Error::Unavailable),
        (302, b"synthetic-private-error".to_vec(), Error::Unavailable),
    ] {
        let adapter = remote(fixture(move |request| {
            assert!(matches!(
                request,
                native::Request::CredentialsExport | native::Request::MagpieExport
            ));
            Ok(native::Response {
                status,
                body: body.clone(),
            })
        }));
        for kind in [Kind::Credentials, Kind::Magpie] {
            assert!(
                matches!(adapter.export(kind, &Cancellation::default()), Err(failure) if failure == error)
            );
        }
    }
}

#[test]
fn inventory_empty_success_is_distinct_from_failure_and_metadata_is_exact() {
    let cancel = Cancellation::default();
    assert_eq!(
        remote(fixture(|_| Ok(response(
            json!({"providerCredentials":null})
        ))))
        .inventory(Kind::Credentials, &cancel),
        Ok(Inventory::Credentials { bytes: None })
    );
    for value in [
        json!({}),
        json!({"providerCredentials":{}}),
        json!({"providerCredentials":{"bytes":0}}),
        json!({"providerCredentials":{"bytes":-1}}),
        json!({"providerCredentials":{"bytes":native::MAX_BYTES+1}}),
        json!({"providerCredentials":{"bytes":1,"key":"synthetic-private"}}),
    ] {
        let adapter = remote(fixture(move |_| Ok(response(value.clone()))));
        assert_eq!(
            adapter.inventory(Kind::Credentials, &cancel),
            Err(Error::Invalid)
        );
    }
    for value in [
        json!({"magpie":null}),
        json!({"magpie":{"available":true,"installed":false}}),
        json!({"magpie":{"available":false,"installed":"no"}}),
        json!({"magpie":{"available":false,"installed":false,"path":"synthetic-private"}}),
    ] {
        let adapter = remote(fixture(move |_| Ok(response(value.clone()))));
        assert_eq!(
            adapter.inventory(Kind::Magpie, &cancel),
            Err(Error::Invalid)
        );
    }
    let adapter = remote(fixture(|_| {
        Ok(native::Response {
            status: 500,
            body: b"synthetic-private-upstream-error".to_vec(),
        })
    }));
    assert_eq!(
        adapter.inventory(Kind::Credentials, &cancel),
        Err(Error::Unavailable)
    );
    let adapter = remote(fixture(|_| {
        Ok(native::Response {
            status: 200,
            body: vec![b' '; METADATA_LIMIT + 1],
        })
    }));
    assert_eq!(
        adapter.inventory(Kind::Magpie, &cancel),
        Err(Error::Invalid)
    );
}

#[test]
fn every_native_error_keeps_its_disposition_without_quarantine_or_retry() {
    for error in [
        Error::Invalid,
        Error::Stale,
        Error::Busy,
        Error::Unavailable,
        Error::Cancelled,
        Error::Authentication,
        Error::CommitUnknown,
        Error::Unknown,
    ] {
        let adapter = remote(fixture(move |_| Err(error)));
        assert_eq!(
            adapter.inventory(Kind::Credentials, &Cancellation::default()),
            Err(error)
        );
        let adapter = remote(fixture(move |_| Err(error)));
        assert_eq!(
            adapter.import(transfer(Kind::Credentials), &Cancellation::default()),
            Err(error)
        );
    }
}

#[test]
fn malformed_or_non_success_import_ack_is_unknown_and_fences_writes_only() {
    let cases = vec![
        (200, b"not json".to_vec()),
        (500, b"synthetic-private-failure".to_vec()),
        (302, Vec::new()),
        (200, br#"{"ok":false}"#.to_vec()),
        (200, br#"{"ok":true,"secret":"synthetic-private"}"#.to_vec()),
        (
            200,
            br#"{"ok":true,"magpieWarnings":["untrusted-warning"]}"#.to_vec(),
        ),
        (
            200,
            br#"{"ok":true,"magpieWarnings":["sign_in_required","sign_in_required"]}"#.to_vec(),
        ),
        (200, vec![b' '; METADATA_LIMIT + 1]),
    ];
    for (status, body) in cases {
        let writes = Arc::new(AtomicUsize::new(0));
        let seen = writes.clone();
        let adapter = remote(fixture(move |request| match request {
            native::Request::MagpieImport(_) => {
                seen.fetch_add(1, Ordering::SeqCst);
                Ok(native::Response {
                    status,
                    body: body.clone(),
                })
            }
            native::Request::CredentialsInventory => {
                Ok(response(json!({"providerCredentials":null})))
            }
            _ => panic!("unexpected request"),
        }));
        let cancel = Cancellation::default();
        assert_eq!(
            adapter.import(transfer(Kind::Magpie), &cancel),
            Err(Error::Unknown)
        );
        assert_eq!(
            adapter.import(transfer(Kind::Credentials), &cancel),
            Err(Error::Unknown)
        );
        assert_eq!(
            adapter.inventory(Kind::Credentials, &cancel),
            Ok(Inventory::Credentials { bytes: None })
        );
        assert_eq!(
            adapter.import(transfer(Kind::Magpie), &cancel),
            Err(Error::Unknown)
        );
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn native_unknown_fences_imports_but_commit_unknown_retires_all_adapter_requests() {
    for error in [Error::Unknown, Error::CommitUnknown] {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let adapter = remote(fixture(move |request| {
            seen.fetch_add(1, Ordering::SeqCst);
            match request {
                native::Request::CredentialsImport(_) => Err(error),
                _ => Ok(response(json!({"providerCredentials":null}))),
            }
        }));
        let cancel = Cancellation::default();
        assert_eq!(
            adapter.import(transfer(Kind::Credentials), &cancel),
            Err(error)
        );
        assert_eq!(
            adapter.import(transfer(Kind::Credentials), &cancel),
            Err(error)
        );
        let read = adapter.inventory(Kind::Credentials, &cancel);
        if error == Error::CommitUnknown {
            assert_eq!(read, Err(Error::CommitUnknown));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(read, Ok(Inventory::Credentials { bytes: None }));
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }
}

#[test]
fn cancellation_from_either_native_grant_or_operation_prevents_dispatch() {
    for cancel_grant in [true, false] {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let port = native::Port::new(Arc::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(Error::Unavailable)
        }));
        let lifetime = Cancellation::default();
        let cancel = Cancellation::default();
        let adapter = Adapter::remote(port, grant(lifetime.clone())).unwrap();
        if cancel_grant {
            lifetime.cancel();
        } else {
            cancel.cancel();
        }
        assert_eq!(
            adapter.import(transfer(Kind::Credentials), &cancel),
            Err(Error::Cancelled)
        );
        assert!(matches!(
            adapter.export(Kind::Magpie, &cancel),
            Err(Error::Cancelled)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn cancelled_dispatched_import_is_unknown_and_never_replayed() {
    let cancel = Cancellation::default();
    let trigger = cancel.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let held = Arc::new(Mutex::new(None));
    let keep = held.clone();
    let port = native::Port::new(Arc::new(move |pending| {
        seen.fetch_add(1, Ordering::SeqCst);
        pending.call.begin()?;
        pending.call.dispatch()?;
        trigger.cancel();
        *keep.lock().unwrap() = Some(pending);
        Ok(())
    }));
    let adapter = remote(port);
    assert_eq!(
        adapter.import(transfer(Kind::Credentials), &cancel),
        Err(Error::Unknown)
    );
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .call
        .finish(Ok(response(json!({"ok":true}))));
    assert_eq!(
        adapter.import(transfer(Kind::Credentials), &Cancellation::default()),
        Err(Error::Unknown)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_import_is_busy_without_retention_and_completed_import_releases_lane() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::sync_channel(1);
    let port = native::Port::new(Arc::new(move |pending| {
        pending.call.begin()?;
        pending.call.dispatch()?;
        tx.send(pending).map_err(|_| Error::Unavailable)
    }));
    let adapter = Arc::new(remote(port));
    let worker = adapter.clone();
    let thread = std::thread::spawn(move || {
        worker.import(transfer(Kind::Credentials), &Cancellation::default())
    });
    let first = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        adapter.import(transfer(Kind::Magpie), &Cancellation::default()),
        Err(Error::Busy)
    );
    assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    first.call.finish(Ok(response(json!({"ok":true}))));
    assert_eq!(thread.join().unwrap(), Ok(Ack { warnings: vec![] }));
    let worker = adapter.clone();
    let thread =
        std::thread::spawn(move || worker.import(transfer(Kind::Magpie), &Cancellation::default()));
    rx.recv_timeout(Duration::from_secs(3))
        .unwrap()
        .call
        .finish(Ok(response(json!({"ok":true}))));
    assert_eq!(thread.join().unwrap(), Ok(Ack { warnings: vec![] }));
}
