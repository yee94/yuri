//! Pure process-lifetime HTTP ownership receipts. The existing actor owns jobs and cancellation.
//! Request IDs and bound tickets are never reused or evicted, including across scope retirement.
use crate::policy::{self, Result};
use serde_json::Value;
use std::collections::HashMap;

pub const MAX_REQUESTS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub owner_id: String,
    pub request_id: String,
    pub window_id: String,
    pub scope: Value,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl Key {
    /// Validate the exact envelope and native window; route/method/body policy stays with the actor.
    pub fn parse(input: &Value, native_window: &str, request: bool) -> Result<Self> {
        let identity = ["ownerID", "requestID", "windowID", "expectedHost"];
        let fields: &[&str] = if request {
            &[
                "ownerID",
                "requestID",
                "windowID",
                "expectedHost",
                "path",
                "method",
                "body",
                "writerGrant",
            ]
        } else {
            &identity
        };
        let required: &[&str] = if request {
            &["ownerID", "requestID", "windowID", "expectedHost", "path"]
        } else {
            &identity
        };
        let parse = || -> Result<Self> {
            policy::keys(input, fields, required)?;
            if request {
                policy::string(input, "path")?;
            }
            let key = Self {
                owner_id: policy::string(input, "ownerID")?.into(),
                request_id: policy::string(input, "requestID")?.into(),
                window_id: policy::string(input, "windowID")?.into(),
                scope: policy::scope(&input["expectedHost"])?,
            };
            key.validate()?;
            Ok(key)
        };
        let key = parse().map_err(|_| "http_receipt_invalid".to_string())?;
        if key.window_id != native_window {
            return Err("http_receipt_stale".into());
        }
        Ok(key)
    }

    // Public fields permit construction by native code; do not admit malformed or uncanonical keys.
    fn validate(&self) -> Result<()> {
        if !valid_id(&self.owner_id)
            || !valid_id(&self.request_id)
            || !valid_id(&self.window_id)
            || policy::scope(&self.scope).ok().as_ref() != Some(&self.scope)
        {
            return Err("http_receipt_invalid".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum State {
    PreCancelled,
    Reserved,
    Running(u64),
    Cancelled,
    Finished,
}

struct Receipt {
    key: Key,
    state: State,
}

#[derive(Default)]
pub struct Book {
    receipts: HashMap<String, Receipt>,
    // Retain ticket ownership too: a late finish must never finish a different request.
    tickets: HashMap<u64, String>,
}

impl Book {
    /// true: newly reserved. false: consumed a matching pre-cancel without starting any job.
    /// Once reserved (even cancelled/finished), another reserve is always rejected.
    pub fn reserve(&mut self, key: &Key) -> Result<bool> {
        key.validate()?;
        if let Some(receipt) = self.receipts.get_mut(&key.request_id) {
            if receipt.key != *key {
                return Err("http_receipt_stale".into());
            }
            return match receipt.state {
                State::PreCancelled => {
                    receipt.state = State::Cancelled;
                    Ok(false)
                }
                _ => Err("http_receipt_reused".into()),
            };
        }
        self.insert(key, State::Reserved)?;
        Ok(true)
    }

    /// Bind a reserved request to the actor's unique ticket. Cancellation before binding is false.
    /// Never call Network::fetch when this returns false or an error.
    pub fn bind(&mut self, key: &Key, ticket: u64) -> Result<bool> {
        key.validate()?;
        let receipt = self
            .receipts
            .get_mut(&key.request_id)
            .ok_or("http_receipt_stale")?;
        if receipt.key != *key {
            return Err("http_receipt_stale".into());
        }
        match receipt.state {
            State::PreCancelled | State::Cancelled => Ok(false),
            State::Running(_) | State::Finished => Err("http_receipt_reused".into()),
            State::Reserved => {
                if self.tickets.contains_key(&ticket) {
                    return Err("http_receipt_reused".into());
                }
                self.tickets.insert(ticket, key.request_id.clone());
                receipt.state = State::Running(ticket);
                Ok(true)
            }
        }
    }

    /// Cancel exactly one identity, or remember cancellation before its request reaches the actor.
    /// Taking a running ticket retires it immediately; repeated/late cancels return None.
    pub fn cancel(&mut self, key: &Key) -> Result<Option<u64>> {
        key.validate()?;
        if let Some(receipt) = self.receipts.get_mut(&key.request_id) {
            if receipt.key != *key {
                return Err("http_receipt_stale".into());
            }
            return match receipt.state {
                State::Running(ticket) => {
                    receipt.state = State::Cancelled;
                    Ok(Some(ticket))
                }
                State::Reserved => {
                    receipt.state = State::Cancelled;
                    Ok(None)
                }
                _ => Ok(None),
            };
        }
        self.insert(key, State::PreCancelled)?;
        Ok(None)
    }

    /// Retire an active ticket, retaining its request ID and ticket as lifetime tombstones.
    /// A late completion after cancel/finish has no remaining authority and returns None.
    pub fn finish(&mut self, ticket: u64) -> Option<Key> {
        let id = self.tickets.get(&ticket)?;
        let receipt = self.receipts.get_mut(id)?;
        if !matches!(receipt.state, State::Running(current) if current == ticket) {
            return None;
        }
        receipt.state = State::Finished;
        Some(receipt.key.clone())
    }

    pub fn current(&self, key: &Key, ticket: u64) -> bool {
        self.receipts.get(&key.request_id).is_some_and(|receipt| {
            receipt.key == *key
                && matches!(receipt.state, State::Running(current) if current == ticket)
        })
    }

    fn insert(&mut self, key: &Key, state: State) -> Result<()> {
        if self.receipts.len() >= MAX_REQUESTS {
            return Err("http_receipt_capacity".into());
        }
        self.receipts.insert(
            key.request_id.clone(),
            Receipt {
                key: key.clone(),
                state,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "http_receipts_tests.rs"]
mod tests;
