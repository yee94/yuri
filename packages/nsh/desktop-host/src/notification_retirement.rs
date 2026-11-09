//! Durable cross-store deny intents. Written in the same Vault transaction as
//! deletion/re-authorization; removed only after the receipt Store's tombstone.
use super::*;

pub(super) type Pending = Vec<(String, String)>;
pub(super) fn read(value: Option<&Value>) -> Result<Pending> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 256)
        .ok_or("secure_store_invalid")?;
    let mut pending = Vec::new();
    for row in rows {
        policy::keys(
            row,
            &["hostID", "authorizationID"],
            &["hostID", "authorizationID"],
        )?;
        let mut pair = Vec::new();
        for key in ["hostID", "authorizationID"] {
            let id = policy::string(row, key)?;
            if id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || id == "legacy"
            {
                return Err("secure_store_invalid".into());
            }
            pair.push(id.to_owned());
        }
        let pair = (pair.remove(0), pair.remove(0));
        if pending.contains(&pair) {
            return Err("secure_store_invalid".into());
        }
        pending.push(pair);
    }
    Ok(pending)
}
pub(super) fn encoded(pending: &Pending) -> Value {
    Value::Array(
        pending
            .iter()
            .map(|(host, authorization)| json!({"hostID":host,"authorizationID":authorization}))
            .collect(),
    )
}
pub(super) fn extend(prior: &State, next: &mut State) -> Result<()> {
    for connection in &prior.connections {
        if connection.authorization == "legacy"
            || next.connections.iter().any(|current| {
                current.id == connection.id && current.authorization == connection.authorization
            })
        {
            continue;
        }
        let pair = (connection.id.clone(), connection.authorization.clone());
        if !next.notification_retirements.contains(&pair) {
            if next.notification_retirements.len() >= 256 {
                return Err("notification_retirement_capacity".into());
            }
            next.notification_retirements.push(pair);
        }
    }
    Ok(())
}

impl Actor {
    /// Called only by the connection actor, never UI/engine callbacks. A new Vault
    /// transaction clears each intent only after the exact Store deny is durable.
    pub(super) fn recover_notification_retirements(&mut self) {
        if self.state().notification_error.as_deref() == Some("notification_store_unknown") {
            return;
        }
        let Some(owner) = self.services.notifications() else {
            return;
        };
        let pending = self.state().notification_retirements.clone();
        for (host, authorization) in pending {
            if let Err(error) = owner.commit_retirement(&host, &authorization) {
                self.state.as_mut().unwrap().notification_error = Some(error);
                return;
            }
            let mut cleared = self.state().clone();
            cleared
                .notification_retirements
                .retain(|pair| pair != &(host.clone(), authorization.clone()));
            if let Err(error) = cleared.persist(&*self.vault) {
                if vault::invalidates_authority(&error) {
                    self.quarantined = true;
                    self.invalidate();
                }
                self.state.as_mut().unwrap().notification_error = Some(error);
                return;
            }
            self.state = Some(cleared);
        }
        self.state.as_mut().unwrap().notification_error = None;
        // The Store retains failed OS cleanup independently of Vault handoff. At most
        // one explicit retry per connection action; no timer or notification send.
        match owner.pending_retirement_cleanups() {
            Ok(pending) if !pending.is_empty() => {
                let (host, authorization) = &pending[0];
                let result = owner
                    .retry_retirement_cleanup(host, authorization)
                    .and_then(|rx| {
                        rx.recv_timeout(Duration::from_secs(2))
                            .map_err(|_| "notification_cleanup_pending".to_owned())?
                    });
                if let Err(error) = result {
                    self.state.as_mut().unwrap().notification_error = Some(error);
                }
            }
            Err(error) => self.state.as_mut().unwrap().notification_error = Some(error),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_vault_records_roundtrip_bounded_exact_retirement_intents_without_changing_credentials()
     {
        #[derive(Default)]
        struct Memory(std::sync::Mutex<Option<Vec<u8>>>);
        impl Vault for Memory {
            fn read(&self) -> Result<Option<Vec<u8>>> {
                Ok(self.0.lock().unwrap().clone())
            }
            fn write(&self, value: &[u8]) -> Result<()> {
                *self.0.lock().unwrap() = Some(value.to_vec());
                Ok(())
            }
        }
        let store = Memory::default();
        let mut state = State::default();
        state
            .notification_retirements
            .push(("removed-host".into(), "revoked-auth".into()));
        state.persist(&store).unwrap();
        let loaded = State::load(&store, false).unwrap();
        assert_eq!(
            loaded.notification_retirements,
            state.notification_retirements
        );
        for value in [
            json!(null),
            json!([{"hostID":"a","authorizationID":"legacy"}]),
            json!([{"hostID":"a","authorizationID":"b","token":"no"}]),
            json!([{"hostID":"a","authorizationID":"b"},{"hostID":"a","authorizationID":"b"}]),
        ] {
            assert!(read(Some(&value)).is_err());
        }
        assert!(
            read(Some(&Value::Array(vec![
                json!({"hostID":"a","authorizationID":"b"});
                257
            ])))
            .is_err()
        );
    }
}
