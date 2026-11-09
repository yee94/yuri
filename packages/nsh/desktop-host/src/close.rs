//! Window-private, fail-closed close admission; no UI or engine liveness heuristics.
use crate::policy::{self, Result};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub const TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Clone, Copy)]
pub enum Reason {
    Close,
    Quit,
}
struct Pending {
    ticket: String,
    expires: Instant,
}
pub struct Admission {
    window_id: String,
    generation: u64,
    pending: Option<Pending>,
    closing: bool,
}
impl Admission {
    pub fn new(window_id: String) -> Self {
        Self {
            window_id,
            generation: 0,
            pending: None,
            closing: false,
        }
    }
    pub fn closing(&self) -> bool {
        self.closing
    }
    pub fn expire(&mut self, now: Instant) {
        if self.pending.as_ref().is_some_and(|p| now >= p.expires) {
            self.pending = None;
        }
    }
    pub fn request(&mut self, reason: Reason, now: Instant, nonce: String) -> Option<Value> {
        self.expire(now);
        if self.closing || self.pending.is_some() {
            return None;
        }
        self.generation = self.generation.checked_add(1)?;
        let ticket = format!("{}:{}:{nonce}", self.window_id, self.generation);
        self.pending = Some(Pending {
            ticket: ticket.clone(),
            expires: now + TIMEOUT,
        });
        Some(
            json!({"ticket":ticket,"reason":match reason {Reason::Close=>"close",Reason::Quit=>"quit"},"windowID":self.window_id,"generation":self.generation}),
        )
    }
    pub fn delivery_failed(&mut self) {
        self.pending = None;
    }
    /// Cancels an uncommitted process-wide quit without reusing its generation.
    pub fn cancel(&mut self) {
        self.pending = None;
        self.closing = false;
    }
    #[cfg(any(target_os = "windows", test))]
    fn cancel_ticket(&mut self, ticket: &str) {
        if self.pending.as_ref().is_some_and(|p| p.ticket == ticket) {
            self.pending = None;
        }
    }
    pub fn decide(&mut self, value: &Value, now: Instant) -> Result<bool> {
        policy::keys(value, &["ticket", "approved"], &["ticket", "approved"])?;
        let ticket = policy::string(value, "ticket")?;
        let approved = value["approved"]
            .as_bool()
            .ok_or("close_decision_invalid")?;
        self.expire(now);
        if self.closing || !self.pending.as_ref().is_some_and(|p| p.ticket == ticket) {
            return Err("close_ticket_stale".into());
        }
        self.pending = None;
        self.closing = approved;
        Ok(approved)
    }
}

// A Windows shutdown query cannot await JS: veto first, then allow an approved normal app exit.
// ENDSESSION(false) must not cancel an unrelated X/quit request; ENDSESSION(true) is not consent.
#[cfg(any(target_os = "windows", test))]
pub struct WindowsAdmission {
    pub gate: Admission,
    session_ticket: Option<String>,
}
#[cfg(any(target_os = "windows", test))]
impl WindowsAdmission {
    pub fn new(window_id: String) -> Self {
        Self {
            gate: Admission::new(window_id),
            session_ticket: None,
        }
    }
    pub fn query_session(&mut self, now: Instant, nonce: String) -> (bool, Option<Value>) {
        if self.gate.closing() {
            return (true, None);
        }
        let event = self.gate.request(Reason::Quit, now, nonce);
        if let Some(event) = &event {
            self.session_ticket = event["ticket"].as_str().map(str::to_owned);
        }
        (false, event)
    }
    pub fn end_session(&mut self, ending: bool) -> bool {
        if !ending {
            if let Some(ticket) = self.session_ticket.take() {
                self.gate.cancel_ticket(&ticket);
            }
            return false;
        }
        !self.gate.closing()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_session_end_notifications_are_not_approval_or_unrelated_cancellation() {
        let now = Instant::now();
        let mut window = WindowsAdmission::new("windows-a".into());
        let (allowed, event) = window.query_session(now, "query".into());
        assert!(!allowed);
        let event = event.unwrap();
        assert_eq!(event["reason"], "quit");
        assert!(window.end_session(true));
        assert!(!window.gate.closing());
        assert!(!window.end_session(false));
        assert!(
            window
                .gate
                .decide(&json!({"ticket":event["ticket"],"approved":true}), now)
                .is_err()
        );
        let normal = window
            .gate
            .request(Reason::Close, now, "normal".into())
            .unwrap();
        let (allowed, event) = window.query_session(now, "ignored".into());
        assert!(!allowed);
        assert!(event.is_none());
        window.end_session(false);
        assert!(
            window
                .gate
                .decide(&json!({"ticket":normal["ticket"],"approved":true}), now)
                .unwrap()
        );
        assert!(window.query_session(now, "after-approval".into()).0);
        assert!(!window.end_session(true));
    }
    #[test]
    fn invalid_false_duplicate_and_stale_decisions_preserve_window() {
        let now = Instant::now();
        let mut gate = Admission::new("window-a".into());
        let a = gate.request(Reason::Close, now, "nonce-a".into()).unwrap();
        for value in [
            json!({}),
            json!({"ticket":a["ticket"],"approved":"true"}),
            json!({"ticket":a["ticket"],"approved":true,"extra":1}),
            json!({"ticket":"other","approved":true}),
        ] {
            assert!(gate.decide(&value, now).is_err());
            assert!(!gate.closing());
        }
        assert!(
            gate.request(Reason::Quit, now, "duplicate".into())
                .is_none()
        );
        let no = json!({"ticket":a["ticket"],"approved":false});
        assert!(!gate.decide(&no, now).unwrap());
        assert!(!gate.closing());
        assert!(gate.decide(&no, now).is_err());
        let b = gate.request(Reason::Quit, now, "nonce-b".into()).unwrap();
        assert_eq!(b["generation"], 2);
        assert_eq!(b["reason"], "quit");
        assert!(
            gate.decide(&json!({"ticket":a["ticket"],"approved":true}), now)
                .is_err()
        );
        assert!(
            gate.decide(&json!({"ticket":b["ticket"],"approved":true}), now)
                .unwrap()
        );
        assert!(gate.closing());
        assert!(
            gate.decide(&json!({"ticket":b["ticket"],"approved":true}), now)
                .is_err()
        );
    }
    #[test]
    fn timeout_is_not_approval_and_a_late_confirmation_cannot_close_retry() {
        let now = Instant::now();
        let mut gate = Admission::new("window-a".into());
        let a = gate.request(Reason::Close, now, "nonce".into()).unwrap();
        let later = now + TIMEOUT;
        assert!(
            gate.decide(&json!({"ticket":a["ticket"],"approved":true}), later)
                .is_err()
        );
        assert!(!gate.closing());
        let b = gate.request(Reason::Close, later, "nonce".into()).unwrap();
        assert_ne!(a["ticket"], b["ticket"]);
        assert!(
            gate.decide(&json!({"ticket":a["ticket"],"approved":false}), later)
                .is_err()
        );
        assert!(
            gate.decide(&json!({"ticket":b["ticket"],"approved":true}), later)
                .unwrap()
        );
    }
    #[test]
    fn tickets_are_window_private_and_failed_delivery_allows_retry_without_closing() {
        let now = Instant::now();
        let mut a = Admission::new("window-a".into());
        let mut b = Admission::new("window-b".into());
        let event = a.request(Reason::Close, now, "same-nonce".into()).unwrap();
        b.request(Reason::Close, now, "same-nonce".into()).unwrap();
        assert!(
            b.decide(&json!({"ticket":event["ticket"],"approved":true}), now)
                .is_err()
        );
        assert!(!b.closing());
        a.delivery_failed();
        assert!(!a.closing());
        assert!(a.request(Reason::Quit, now, "retry".into()).is_some());
    }
}
