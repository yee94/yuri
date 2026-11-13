//! Durable history-cache retirement intents and window-scoped cleanup receipts.
use super::*;
use std::collections::HashSet;

const KEY: &str = "historyRetirements";

pub(super) fn pending(state: &State) -> Result<notification_retirement::Pending> {
    notification_retirement::read(state.extra.get(KEY))
}

fn set_pending(state: &mut State, pending: &notification_retirement::Pending) {
    if pending.is_empty() { state.extra.remove(KEY); }
    else { state.extra.insert(KEY.into(), notification_retirement::encoded(pending)); }
}

pub(super) fn extend(prior: &State, next: &mut State) -> Result<bool> {
    let mut pending = pending(next)?;
    let before = pending.len();
    for connection in &prior.connections {
        if connection.authorization == "legacy" || next.connections.iter().any(|c|
            c.id == connection.id && c.authorization == connection.authorization) { continue; }
        let pair = (connection.id.clone(), connection.authorization.clone());
        if !pending.contains(&pair) {
            if pending.len() >= 256 { return Err("history_retirement_capacity".into()); }
            pending.push(pair);
        }
    }
    set_pending(next, &pending);
    Ok(pending.len() != before)
}

#[derive(Default)]
pub(super) struct Cleanup {
    owner: Option<String>,
    tickets: HashMap<String, (String, String)>,
    claimed: HashSet<String>,
}

impl Actor {
    pub(super) fn history_cleanup(&mut self, name: &str, value: &Value) -> Result<Value> {
        match name {
            "authorization.cache.ready" => {
                policy::keys(value, &[], &[])?;
                let owner = vault::id()?;
                self.history_cleanup = Cleanup { owner: Some(owner.clone()), ..Default::default() };
                let tickets = self.history_tickets()?;
                Ok(json!({"owner":owner,"tickets":tickets}))
            }
            "authorization.cache.retry" => {
                policy::keys(value, &[], &[])?;
                Ok(json!(true))
            }
            "authorization.cache.list" | "authorization.cache.claim" | "authorization.cache.ack" => {
                let keys: &[&str] = if name == "authorization.cache.list" { &["owner"] } else { &["owner", "ticket"] };
                policy::keys(value, keys, keys)?;
                let owner = policy::string(value, "owner")?;
                if self.history_cleanup.owner.as_deref() != Some(owner) { return Err("authorization_cache_stale_owner".into()); }
                if name == "authorization.cache.list" { return Ok(json!(self.history_tickets()?)); }
                let ticket = policy::string(value, "ticket")?;
                let pair = self.history_cleanup.tickets.get(ticket).cloned().ok_or("authorization_cache_invalid_ticket")?;
                let mut pending = pending(self.state())?;
                if !pending.contains(&pair) { return Err("authorization_cache_invalid_ticket".into()); }
                if name == "authorization.cache.claim" {
                    self.history_cleanup.claimed.insert(ticket.into());
                    return Ok(json!({"connectionID":pair.0,"authorizationID":pair.1}));
                }
                if !self.history_cleanup.claimed.contains(ticket) { return Err("authorization_cache_unclaimed_ticket".into()); }
                pending.retain(|candidate| candidate != &pair);
                let mut next = self.state().clone();
                set_pending(&mut next, &pending);
                if let Err(error) = next.persist(&*self.vault) {
                    if vault::invalidates_authority(&error) { self.quarantined = true; self.invalidate(); self.state = None; }
                    return Err(error);
                }
                self.state = Some(next);
                self.history_cleanup.tickets.remove(ticket);
                self.history_cleanup.claimed.remove(ticket);
                Ok(json!(true))
            }
            _ => Err("unsupported_desktop_capability".into()),
        }
    }

    fn history_tickets(&mut self) -> Result<Vec<String>> {
        let pending = pending(self.state())?;
        self.history_cleanup.tickets.retain(|_, pair| pending.contains(pair));
        self.history_cleanup.claimed.retain(|ticket| self.history_cleanup.tickets.contains_key(ticket));
        for pair in pending {
            if !self.history_cleanup.tickets.values().any(|value| value == &pair) {
                self.history_cleanup.tickets.insert(vault::id()?, pair);
            }
        }
        let mut tickets: Vec<_> = self.history_cleanup.tickets.keys().cloned().collect();
        tickets.sort();
        Ok(tickets)
    }
}
