//! Native direct WebSocket only. No JS socket, URL token, Relay or credential source.
use crate::policy::Result;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub const LIMIT: usize = 1_048_576;
#[derive(Debug)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
}
pub enum Event {
    Open,
    Message(Message),
    Failed,
    Sent(bool),
}
pub struct Signals {
    pub tx: mpsc::SyncSender<Event>,
    pub overflow: Arc<AtomicBool>,
}
impl Signals {
    pub fn emit(&self, event: Event) {
        if self.tx.try_send(event).is_err() {
            self.overflow.store(true, Ordering::Release);
        }
    }
}
pub fn wait(
    rx: &mpsc::Receiver<Event>,
    full: &AtomicBool,
    deadline: Instant,
    current: &dyn Fn() -> bool,
) -> Result<Option<Event>> {
    if !current() {
        return Err("terminal_scope_stale".into());
    }
    if full.load(Ordering::Acquire) {
        return Err("terminal_response_overflow".into());
    }
    if Instant::now() >= deadline {
        return Err("terminal_ws_timeout".into());
    }
    match rx.recv_timeout(Duration::from_millis(20)) {
        Ok(event) => {
            if current() {
                Ok(Some(event))
            } else {
                Err("terminal_scope_stale".into())
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
        Err(_) => Err("terminal_ws_disconnected".into()),
    }
}
#[cfg(target_os = "macos")]
#[path = "terminal_socket_macos.rs"]
mod native;
#[cfg(target_os = "windows")]
#[path = "terminal_socket_windows.rs"]
mod native;
pub use native::Socket;
