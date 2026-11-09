//! Direct WinHTTP WebSocket. The OS owns TLS/framing; auth is only the captured header.
//! Synchronous handshake/write have finite timeouts. A single reader owns fragment assembly;
//! WinHttpWebSocketClose cancels its outstanding Receive before handles are released.
use super::*;
use std::{ffi::c_void, ptr, thread::JoinHandle};
type Handle = *mut c_void;
#[link(name = "winhttp")]
unsafe extern "system" {
    fn WinHttpOpen(
        agent: *const u16,
        access: u32,
        proxy: *const u16,
        bypass: *const u16,
        flags: u32,
    ) -> Handle;
    fn WinHttpConnect(session: Handle, server: *const u16, port: u16, reserved: u32) -> Handle;
    fn WinHttpOpenRequest(
        connection: Handle,
        verb: *const u16,
        path: *const u16,
        version: *const u16,
        referer: *const u16,
        accept: *const *const u16,
        flags: u32,
    ) -> Handle;
    fn WinHttpSetTimeouts(
        handle: Handle,
        resolve: i32,
        connect: i32,
        send: i32,
        receive: i32,
    ) -> i32;
    fn WinHttpSetOption(handle: Handle, option: u32, buffer: *const c_void, length: u32) -> i32;
    fn WinHttpSendRequest(
        request: Handle,
        headers: *const u16,
        length: u32,
        optional: *const c_void,
        optional_length: u32,
        total: u32,
        context: usize,
    ) -> i32;
    fn WinHttpReceiveResponse(request: Handle, reserved: *mut c_void) -> i32;
    fn WinHttpQueryHeaders(
        request: Handle,
        level: u32,
        name: *const u16,
        buffer: *mut c_void,
        length: *mut u32,
        index: *mut u32,
    ) -> i32;
    fn WinHttpWebSocketCompleteUpgrade(request: Handle, context: usize) -> Handle;
    fn WinHttpWebSocketSend(socket: Handle, kind: u32, buffer: *const c_void, length: u32) -> u32;
    fn WinHttpWebSocketReceive(
        socket: Handle,
        buffer: *mut c_void,
        length: u32,
        read: *mut u32,
        kind: *mut u32,
    ) -> u32;
    fn WinHttpWebSocketClose(
        socket: Handle,
        status: u16,
        reason: *const c_void,
        length: u32,
    ) -> u32;
    fn WinHttpCloseHandle(handle: Handle) -> i32;
}
struct Owned(Handle);
impl Owned {
    fn new(handle: Handle) -> Result<Self> {
        if handle.is_null() {
            Err("terminal_ws_upgrade_failed".into())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn option(handle: Handle, number: u32, value: u32) -> Result<()> {
    if unsafe { WinHttpSetOption(handle, number, (&value as *const u32).cast(), 4) } == 0 {
        Err("terminal_ws_policy_failed".into())
    } else {
        Ok(())
    }
}
pub struct Socket {
    socket: Owned,
    _connection: Owned,
    _session: Owned,
    rx: mpsc::Receiver<Event>,
    full: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}
impl Drop for Socket {
    fn drop(&mut self) {
        // Documented cancellation of a synchronous Receive; no PTY DELETE/kill.
        unsafe {
            WinHttpWebSocketClose(self.socket.0, 1001, ptr::null(), 0);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Socket {
    pub fn open(origin: &str, token: &str, current: &dyn Fn() -> bool) -> Result<Self> {
        if !current() {
            return Err("terminal_scope_stale".into());
        }
        let (scheme, authority) = origin.split_once("://").ok_or("terminal_request_invalid")?;
        let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
            let (host, rest) = rest.split_once(']').ok_or("terminal_request_invalid")?;
            (
                host,
                if rest.is_empty() {
                    None
                } else {
                    Some(rest.strip_prefix(':').ok_or("terminal_request_invalid")?)
                },
            )
        } else {
            authority
                .rsplit_once(':')
                .map(|(h, p)| (h, Some(p)))
                .unwrap_or((authority, None))
        };
        let port = port
            .map(str::parse::<u16>)
            .transpose()
            .map_err(|_| "terminal_request_invalid")?
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        unsafe {
            let session = Owned::new(WinHttpOpen(
                wide("Yuri Native Terminal").as_ptr(),
                0,
                ptr::null(),
                ptr::null(),
                0,
            ))?;
            if WinHttpSetTimeouts(session.0, 15000, 15000, 5000, 15000) == 0 {
                return Err("terminal_ws_policy_failed".into());
            }
            let connection = Owned::new(WinHttpConnect(session.0, wide(host).as_ptr(), port, 0))?;
            let request = Owned::new(WinHttpOpenRequest(
                connection.0,
                wide("GET").as_ptr(),
                wide("/api/terminal/ws").as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                if scheme == "https" { 0x00800000 } else { 0 },
            ))?;
            option(request.0, 88, 0)?; // REDIRECT_POLICY_NEVER
            option(request.0, 63, 1 | 4)?; // DISABLE_COOKIES | DISABLE_AUTHENTICATION (no ambient credentials)
            option(request.0, 77, 2)?; // AUTOLOGON_SECURITY_LEVEL_HIGH
            if WinHttpSetOption(request.0, 114, ptr::null(), 0) == 0 {
                return Err("terminal_ws_policy_failed".into());
            }
            let headers = wide(&format!(
                "Authorization: Bearer {token}\r\nOrigin: {origin}\r\nCache-Control: no-store\r\n"
            ));
            if WinHttpSendRequest(
                request.0,
                headers.as_ptr(),
                (headers.len() - 1) as u32,
                ptr::null(),
                0,
                0,
                0,
            ) == 0
                || WinHttpReceiveResponse(request.0, ptr::null_mut()) == 0
            {
                return Err("terminal_ws_upgrade_failed".into());
            }
            let mut status = 0u32;
            let mut length = 4;
            if WinHttpQueryHeaders(
                request.0,
                19 | 0x20000000,
                ptr::null(),
                (&mut status as *mut u32).cast(),
                &mut length,
                ptr::null_mut(),
            ) == 0
                || status != 101
            {
                return Err("terminal_ws_upgrade_failed".into());
            }
            let socket = Owned::new(WinHttpWebSocketCompleteUpgrade(request.0, 0))?;
            option(socket.0, 115, 1000)?; // WEB_SOCKET_CLOSE_TIMEOUT
            option(socket.0, 5, 5000)?;
            if !current() {
                return Err("terminal_scope_stale".into());
            }
            let (tx, rx) = mpsc::sync_channel(8);
            let full = Arc::new(AtomicBool::new(false));
            let signals = Signals {
                tx,
                overflow: full.clone(),
            };
            // HINTERNET may be used for one Send and one Receive concurrently. Socket's Drop
            // cancels then joins this reader; it never releases handles under a pending call.
            let handle = socket.0 as usize;
            let reader = std::thread::Builder::new()
                .name("yuri-terminal-ws-read".into())
                .spawn(move || {
                    let mut buffer = [0u8; 65_536];
                    let mut bytes = Vec::new();
                    let mut text = None;
                    loop {
                        let mut read = 0;
                        let mut kind = 0;
                        if WinHttpWebSocketReceive(
                            handle as Handle,
                            buffer.as_mut_ptr().cast(),
                            buffer.len() as u32,
                            &mut read,
                            &mut kind,
                        ) != 0
                            || read as usize > buffer.len()
                            || kind > 3
                        {
                            signals.emit(Event::Failed);
                            return;
                        }
                        let is_text = kind >= 2;
                        if text.is_some_and(|prior| prior != is_text)
                            || bytes.len() + read as usize > LIMIT
                        {
                            signals.emit(Event::Failed);
                            return;
                        }
                        text = Some(is_text);
                        bytes.extend_from_slice(&buffer[..read as usize]);
                        if kind == 0 || kind == 2 {
                            let data = std::mem::take(&mut bytes);
                            text = None;
                            let message = if is_text {
                                match String::from_utf8(data) {
                                    Ok(s) => Message::Text(s),
                                    Err(_) => {
                                        signals.emit(Event::Failed);
                                        return;
                                    }
                                }
                            } else {
                                Message::Binary(data)
                            };
                            signals.emit(Event::Message(message));
                            if signals.overflow.load(Ordering::Acquire) {
                                return;
                            }
                        }
                    }
                })
                .map_err(|_| "terminal_ws_worker_failed")?;
            Ok(Self {
                socket,
                _connection: connection,
                _session: session,
                rx,
                full,
                reader: Some(reader),
            })
        }
    }
    pub fn poll(&mut self, current: &dyn Fn() -> bool) -> Result<Option<Message>> {
        match wait(
            &self.rx,
            &self.full,
            Instant::now() + Duration::from_secs(1),
            current,
        )? {
            Some(Event::Message(message)) => Ok(Some(message)),
            None => Ok(None),
            _ => Err("terminal_ws_disconnected".into()),
        }
    }
    pub fn send(&mut self, message: Message, current: &dyn Fn() -> bool) -> Result<()> {
        if !current() {
            return Err("terminal_scope_stale".into());
        }
        let (kind, bytes) = match message {
            Message::Text(s) => (2, s.into_bytes()),
            Message::Binary(b) => (0, b),
        };
        if bytes.len() > 65_536 {
            return Err("terminal_input_limit".into());
        }
        if unsafe {
            WinHttpWebSocketSend(
                self.socket.0,
                kind,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
            )
        } != 0
            || !current()
        {
            Err("terminal_ws_send_unknown".into())
        } else {
            Ok(())
        }
    }
}
