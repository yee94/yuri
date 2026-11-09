//! UI-thread window catalog and all-or-none quit admission. No engine, disk or authority owner.
use crate::{
    close::{Admission, Reason, TIMEOUT},
    policy::Result,
    vault,
};
use nsh_engine::{HostChannel, HostReply};
use serde_json::Value;
use std::{collections::BTreeMap, sync::mpsc, time::Instant};

struct Window {
    gate: Admission,
    host: HostChannel,
    services: crate::host_services::Port,
    granted: Option<HostReply>,
    closing: bool,
    destroyed: bool,
    capture: Option<crate::host_services::WindowCapture>,
    capture_failed: bool,
    order: u64,
}

#[cfg(test)]
#[path = "window_kernel_tests.rs"]
mod tests;
#[derive(Default)]
pub(crate) struct Catalog {
    windows: BTreeMap<usize, Window>,
    quit: Option<Instant>,
    quit_serial: u64,
    quitting: bool,
    persistence: Option<crate::window_persistence::Port>,
    commit: Option<Commit>,
    last_capture: Option<Vec<crate::window_state::MainWindow>>,
    next_order: u64,
}
struct Commit {
    targets: Vec<usize>,
    quit: bool,
    capture: Vec<crate::window_state::MainWindow>,
    authorities: Vec<(usize, u64)>,
    expires: Instant,
    reply: Option<mpsc::Receiver<Result<()>>>,
}
impl Catalog {
    pub fn needs_final_capture(&self) -> bool {
        self.commit.is_some()
    }
    pub fn install_persistence(&mut self, port: crate::window_persistence::Port) {
        self.persistence = Some(port);
    }
    pub fn update_capture(
        &mut self,
        native: usize,
        record: Result<crate::host_services::WindowCapture>,
    ) {
        if let Some(window) = self.windows.get_mut(&native) {
            match record {
                Ok(record) => {
                    window.capture = Some(record);
                    window.capture_failed = false;
                }
                Err(_) => window.capture_failed = true,
            }
        }
    }
    fn records(&self) -> Result<Vec<crate::window_state::MainWindow>> {
        if self.windows.values().any(|w| {
            w.capture_failed
                || w.destroyed
                || w.capture
                    .as_ref()
                    .is_none_or(|capture| !w.services.reader().window_capture_current(capture))
        }) {
            return Err("window_state_capture_unresolved".into());
        }
        let mut windows: Vec<_> = self
            .windows
            .values()
            .filter_map(|w| {
                w.capture
                    .as_ref()?
                    .record
                    .clone()
                    .map(|record| (w.order, record))
            })
            .collect();
        if !windows.is_empty() && windows.len() != self.windows.len() {
            return Err("window_state_identity_unresolved".into());
        }
        windows.sort_by_key(|(order, _)| *order);
        Ok(windows.into_iter().map(|(_, record)| record).collect())
    }
    fn authorities(&self) -> Vec<(usize, u64)> {
        self.windows
            .iter()
            .filter_map(|(id, window)| Some((*id, window.capture.as_ref()?.epoch)))
            .collect()
    }
    pub fn drive_persistence(&mut self) {
        let Some(port) = self.persistence.clone() else {
            return;
        };
        if let Some(mut pending) = self.commit.take() {
            if pending.reply.is_none() {
                pending.authorities = self.authorities();
                match self.records().and_then(|capture| {
                    pending.capture = capture.clone();
                    port.flush(capture, pending.quit)
                }) {
                    Ok(reply) => pending.reply = Some(reply),
                    Err(error) => {
                        self.reject_commit(pending, &error);
                        return;
                    }
                }
            }
            match pending.reply.as_ref().expect("flush started").try_recv() {
                Ok(Ok(()))
                    if self
                        .records()
                        .is_ok_and(|records| records == pending.capture)
                        && self.authorities() == pending.authorities
                        && pending.targets.iter().all(|id| {
                            self.windows.get(id).is_some_and(|w| {
                                w.granted.is_some() && w.gate.closing() && !w.destroyed
                            })
                        }) =>
                {
                    self.approve_commit(&pending.targets, pending.quit)
                }
                Ok(Ok(())) => self.reject_commit(pending, "window_state_capture_stale"),
                Ok(Err(error)) => self.reject_commit(pending, &error),
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.reject_commit(pending, "window_state_worker_unavailable")
                }
                Err(mpsc::TryRecvError::Empty) => self.commit = Some(pending),
            }
            return;
        }
        if !self.quitting
            && !self.quit_pending()
            && let Ok(capture) = self.records()
            && self.last_capture.as_ref() != Some(&capture)
            && port.capture(capture.clone()).is_ok()
        {
            self.last_capture = Some(capture);
        }
    }
    fn reject_commit(&mut self, pending: Commit, error: &str) {
        self.reject_targets(&pending.targets, pending.quit, error);
    }
    fn reject_targets(&mut self, targets: &[usize], quit: bool, error: &str) {
        if quit {
            self.cancel_quit();
        } else {
            for id in targets {
                if let Some(window) = self.windows.get_mut(id) {
                    window.gate.cancel();
                    if let Some(reply) = window.granted.take() {
                        reply.reject(error);
                    }
                }
            }
        }
        if let Some(port) = &self.persistence {
            let _ = port.cancel_quit();
        }
    }
    fn approve_commit(&mut self, targets: &[usize], quit: bool) {
        if targets.iter().any(|id| {
            self.windows
                .get(id)
                .is_none_or(|window| !window.services.writer_close_ready())
        }) {
            self.reject_targets(targets, quit, "writer_close_unresolved");
            return;
        }
        if quit {
            self.quitting = true;
            for window in self.windows.values() {
                window.services.shutdown();
            }
        }
        for id in targets {
            if let Some(window) = self.windows.get_mut(id) {
                if !quit {
                    window.services.shutdown();
                }
                window.services.approve_final_close();
                window.closing = true;
                if let Some(reply) = window.granted.take() {
                    reply.resolve(serde_json::json!(true));
                }
            }
        }
    }
    fn prepare_commit(&mut self, targets: Vec<usize>, quit: bool, now: Instant) {
        if self.persistence.is_some() {
            self.commit = Some(Commit {
                targets,
                quit,
                capture: Vec::new(),
                authorities: Vec::new(),
                reply: None,
                expires: now + TIMEOUT,
            });
        } else {
            self.approve_commit(&targets, quit);
        }
    }
    pub fn insert(
        &mut self,
        native: usize,
        host: HostChannel,
        services: crate::host_services::Port,
    ) -> Result<()> {
        if self.quit.is_some()
            || self.quitting
            || self.commit.is_some()
            || self.windows.contains_key(&native)
            || self.windows.len() >= crate::window_state::MAX_WINDOWS
        {
            return Err("window_catalog_busy".into());
        }
        let id = services.window_id()?;
        if self
            .windows
            .values()
            .any(|w| w.services.window_id().is_ok_and(|other| other == id))
        {
            return Err("window_owner_duplicate".into());
        }
        let order = self.next_order;
        self.next_order = self
            .next_order
            .checked_add(1)
            .ok_or("window_generation_exhausted")?;
        self.windows.insert(
            native,
            Window {
                gate: Admission::new(id),
                host,
                services,
                granted: None,
                closing: false,
                destroyed: false,
                capture: None,
                capture_failed: false,
                order,
            },
        );
        Ok(())
    }
    pub fn remove(&mut self, native: usize) {
        if let Some(pending) = self.commit.take() {
            self.reject_commit(pending, "close_window_retired");
        }
        if self.quit.is_some() && !self.quitting {
            self.cancel_quit();
        }
        if let Some(window) = self.windows.remove(&native) {
            let committed_close = window.closing && !self.quitting;
            window.services.shutdown();
            if let Some(reply) = window.granted {
                reply.reject("close_window_retired");
            }
            if committed_close
                && let Some(port) = &self.persistence
                && let Ok(records) = self.records()
                && port.closed(records.clone()).is_ok()
            {
                self.last_capture = Some(records);
            }
        }
    }
    pub fn closing(&self, native: usize) -> bool {
        self.windows.get(&native).is_some_and(|w| w.closing)
    }
    pub fn native_destroyed(&mut self, native: usize) {
        if let Some(pending) = self.commit.take() {
            self.reject_commit(pending, "close_window_destroyed");
        }
        if self.quit_pending() && !self.quitting {
            self.cancel_quit();
        }
        if let Some(window) = self.windows.get_mut(&native) {
            window.destroyed = true;
        }
    }
    pub fn destroyed(&self, native: usize) -> bool {
        self.windows
            .get(&native)
            .is_some_and(|window| window.destroyed)
    }
    pub fn activity(&self, focused: Option<usize>) {
        for (id, window) in &self.windows {
            window.services.set_foreground(focused == Some(*id));
        }
    }
    pub fn quitting(&self) -> bool {
        self.quitting
    }
    pub fn quit_pending(&self) -> bool {
        self.quit.is_some()
    }
    pub fn quit_id(&self) -> Option<u64> {
        self.quit.map(|_| self.quit_serial)
    }
    pub fn services(&self, native: usize) -> Option<crate::host_services::Port> {
        self.windows.get(&native).map(|w| w.services.clone())
    }
    pub fn all_services(&self) -> Vec<crate::host_services::Port> {
        self.windows.values().map(|w| w.services.clone()).collect()
    }
    pub fn request_close(&mut self, native: usize, now: Instant) {
        if self.quit_pending() || self.quitting || self.commit.is_some() {
            return;
        }
        if let Some(window) = self.windows.get_mut(&native) {
            let Ok(nonce) = vault::id() else {
                return;
            };
            if let Some(event) = window.gate.request(Reason::Close, now, nonce)
                && window
                    .host
                    .send("desktop.window.closeRequested", event)
                    .is_err()
            {
                window.gate.delivery_failed();
            }
        }
    }
    pub fn request_quit(&mut self, now: Instant) {
        if self.quit_id().is_some() || self.quitting || self.commit.is_some() {
            return;
        }
        if self.windows.is_empty() {
            self.quitting = true;
            return;
        }
        // Cancel outstanding ordinary tickets first. Their late decisions cannot grant this quit.
        for window in self.windows.values_mut() {
            if window.gate.closing() {
                return;
            }
        }
        for window in self.windows.values_mut() {
            window.gate.cancel();
        }
        let Some(serial) = self.quit_serial.checked_add(1) else {
            return;
        };
        self.quit_serial = serial;
        self.quit = Some(now + TIMEOUT);
        for window in self.windows.values_mut() {
            let event = vault::id()
                .ok()
                .and_then(|nonce| window.gate.request(Reason::Quit, now, nonce));
            if event.is_none_or(|event| {
                window
                    .host
                    .send("desktop.window.closeRequested", event)
                    .is_err()
            }) {
                self.cancel_quit();
                return;
            }
        }
    }
    pub fn decide(&mut self, native: usize, value: &Value, reply: HostReply, now: Instant) {
        self.expire(now);
        let Some(window) = self.windows.get_mut(&native) else {
            reply.reject("close_ticket_stale");
            return;
        };
        match window.gate.decide(value, now) {
            Err(error) => reply.reject(error),
            Ok(approved) if self.quit.is_some() => {
                if !approved {
                    reply.resolve(serde_json::json!(true));
                    self.cancel_quit();
                } else {
                    // Keep the decision promise pending: the TS committing lock stays held.
                    window.granted = Some(reply);
                    if self.windows.values().all(|w| w.granted.is_some()) {
                        self.prepare_commit(self.windows.keys().copied().collect(), true, now);
                    }
                }
            }
            Ok(approved) => {
                if approved && self.commit.is_some() {
                    window.gate.cancel();
                    reply.reject("close_owner_busy");
                } else if approved {
                    window.granted = Some(reply);
                    self.prepare_commit(vec![native], false, now);
                } else {
                    reply.resolve(serde_json::json!(true));
                }
            }
        }
    }
    pub fn expire(&mut self, now: Instant) {
        if self
            .commit
            .as_ref()
            .is_some_and(|pending| now >= pending.expires)
            && let Some(pending) = self.commit.take()
        {
            self.reject_commit(pending, "window_state_flush_timeout");
        }
        if !self.quitting && self.quit.is_some_and(|deadline| now >= deadline) {
            self.cancel_quit();
        }
        for window in self.windows.values_mut() {
            window.gate.expire(now);
        }
    }
    pub fn cancel_quit(&mut self) {
        if self.quitting {
            return;
        }
        self.quit = None;
        self.commit = None;
        if let Some(port) = &self.persistence {
            let _ = port.cancel_quit();
        }
        for window in self.windows.values_mut() {
            window.gate.cancel();
            if let Some(reply) = window.granted.take() {
                reply.reject("close_quit_cancelled");
            }
        }
    }
}
