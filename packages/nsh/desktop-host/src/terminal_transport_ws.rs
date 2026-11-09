//! PTY-v2 mux wire shared by native platforms. A worker owns each physical socket.
//! Server `i` is replay authority; presentation ACKs never enter this module.
use super::socket::{Message, Socket};
use super::*;
pub const SAFE_CURSOR: u64 = 9_007_199_254_740_991;
pub struct Input {
    data: String,
    reply: mpsc::SyncSender<Result<()>>,
}
#[derive(Clone)]
pub struct Port {
    tx: mpsc::SyncSender<Input>,
    stop: Arc<AtomicBool>,
}
impl Port {
    pub fn input(&self, data: &str) -> Result<()> {
        if data.is_empty() || data.len() > 65_536 || self.stop.load(Ordering::Acquire) {
            return Err("terminal_not_bound".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Input {
                data: data.into(),
                reply: tx,
            })
            .map_err(|_| "terminal_input_rejected")?;
        rx.recv_timeout(Duration::from_secs(6))
            .map_err(|_| "input_unknown")?
    }
}
fn frame(value: Value) -> Message {
    let mut bytes = vec![1];
    bytes.extend(value.to_string().as_bytes());
    Message::Binary(bytes)
}
pub struct Decoder {
    session: String,
    pub cursor: u64,
    pub bound: bool,
}
impl Decoder {
    pub fn new(session: &str, cursor: u64) -> Result<Self> {
        if !identifier(session) || cursor > SAFE_CURSOR {
            return Err("terminal_request_invalid".into());
        }
        Ok(Self {
            session: session.into(),
            cursor,
            bound: false,
        })
    }
    pub fn receive(&mut self, message: Message) -> Result<Option<Value>> {
        let bytes = match message {
            Message::Binary(bytes) if bytes.len() <= socket::LIMIT && bytes.first() == Some(&1) => {
                bytes
            }
            Message::Text(text) if text.is_empty() => return Ok(None),
            _ => return Err("terminal_ws_protocol".into()),
        };
        let value: Value =
            serde_json::from_slice(&bytes[1..]).map_err(|_| "terminal_ws_protocol")?;
        let kind = value["t"].as_str().ok_or("terminal_ws_protocol")?;
        if matches!(kind, "bok" | "d" | "x") && value["s"] != self.session {
            return Err("terminal_ws_protocol".into());
        }
        if kind == "e"
            && value
                .get("s")
                .is_some_and(|session| session != &self.session)
        {
            return Err("terminal_ws_protocol".into());
        }
        match kind {
            "ok" | "po" if value["v"] == 2 => Ok(None),
            "bok" if value["v"] == 2 && !self.bound => {
                self.bound = true;
                Ok(Some(
                    json!({"type":"connected","transport":"ws","replayUnavailable":false,"runtime":value["runtime"],"ptyBackend":value["ptyBackend"]}),
                ))
            }
            "d" if self.bound => {
                let id = value["i"]
                    .as_u64()
                    .filter(|i| *i > 0 && *i <= SAFE_CURSOR)
                    .ok_or("terminal_ws_protocol")?;
                let data = value["d"].as_str().ok_or("terminal_ws_protocol")?;
                if data.encode_utf16().count() > 1_000_000 {
                    return Err("terminal_response_overflow".into());
                }
                if id <= self.cursor {
                    return Ok(None);
                }
                let gap = id > self.cursor + 1;
                self.cursor = id;
                Ok(Some(
                    json!({"type":"data","data":data,"cursor":id,"replayGap":gap,"transport":"ws"}),
                ))
            }
            "x" if self.bound => {
                let mut event = json!({"type":"exit","transport":"ws"});
                for key in ["exitCode", "signal"] {
                    if let Some(number) = value.get(key) {
                        if !number.is_null()
                            && number
                                .as_i64()
                                .is_none_or(|n| n.unsigned_abs() > SAFE_CURSOR)
                        {
                            return Err("terminal_ws_protocol".into());
                        }
                        event[key] = number.clone();
                    }
                }
                self.bound = false;
                Ok(Some(event))
            }
            "e" => Err(match value["c"].as_str() {
                Some("SESSION_NOT_FOUND") => "session_not_found",
                Some("WRITE_FAIL") => "input_unknown",
                _ => "terminal_ws_protocol",
            }
            .into()),
            _ => Err("terminal_ws_protocol".into()),
        }
    }
}
pub fn stream(
    capture: &Captured,
    session: &str,
    cursor: u64,
    stop: Arc<AtomicBool>,
    publish: impl FnOnce(Port),
    mut emit: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let current = || capture.valid() && !stop.load(Ordering::Acquire);
    if !current() {
        return Err("terminal_scope_stale".into());
    }
    let mut decoder = Decoder::new(session, cursor)?;
    let mut socket = match Socket::open(&capture.origin, &capture.token, &current) {
        Ok(socket) => socket,
        Err(_) if current() => return Err("terminal_ws_prebind_failed".into()),
        Err(error) => return Err(error),
    };
    socket.send(
        frame(json!({"t":"b","s":session,"r":cursor,"v":2})),
        &current,
    )?;
    let (tx, rx) = mpsc::sync_channel(4);
    publish(Port {
        tx,
        stop: stop.clone(),
    });
    let mut deadline = Instant::now() + Duration::from_secs(15);
    let mut heartbeat = Instant::now() + Duration::from_secs(20);
    loop {
        if !current() {
            return Err("terminal_scope_stale".into());
        }
        if Instant::now() >= deadline {
            return Err("terminal_ws_timeout".into());
        }
        if decoder.bound
            && let Ok(input) = rx.try_recv()
        {
            let result = socket
                .send(Message::Text(input.data), &current)
                .map_err(|_| "input_unknown".to_owned());
            let failed = result.is_err();
            let _ = input.reply.try_send(result);
            if failed {
                return Err("input_unknown".into());
            }
        }
        if Instant::now() >= heartbeat {
            socket.send(frame(json!({"t":"p","v":2})), &current)?;
            heartbeat = Instant::now() + Duration::from_secs(20);
        }
        if let Some(message) = socket.poll(&current)? {
            if let Some(event) = decoder.receive(message)? {
                let exited = event["type"] == "exit";
                emit(event)?;
                if exited {
                    return Ok(());
                }
            }
            if decoder.bound {
                deadline = Instant::now() + Duration::from_secs(60);
            }
        }
    }
}
#[cfg(test)]
#[path = "terminal_ws_tests.rs"]
pub(crate) mod tests;
