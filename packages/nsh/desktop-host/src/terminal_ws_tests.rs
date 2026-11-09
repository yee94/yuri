//! Real platform socket + synthetic localhost protocol; never a PTY or a user Host.
use super::*;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, ChildStdout, Command, Stdio},
};
pub(crate) struct Server {
    child: Child,
    out: BufReader<ChildStdout>,
    pub origin: String,
}
impl Server {
    pub fn new(mode: &str) -> Self {
        let mut child = Command::new("python3")
            .args(["-u", "-c", include_str!("../fixtures/terminal-ws.py"), mode])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        let port: u16 = line.trim().parse().unwrap();
        Self {
            child,
            out,
            origin: format!("http://127.0.0.1:{port}"),
        }
    }
    pub fn finish(&mut self) {
        let mut text = String::new();
        self.out.read_to_string(&mut text).unwrap();
        assert!(
            self.child.wait().unwrap().success(),
            "synthetic server: {text}"
        );
        assert!(text.contains("\"ok\": true"));
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn capture(origin: &str, valid: Arc<AtomicBool>) -> Captured {
    Captured::direct(
        json!({"hostID":"synthetic-ws","lease":"00000000-0000-4000-8000-000000000123"}),
        origin,
        "synthetic-ws-token",
        true,
        Arc::new(move || valid.load(Ordering::Acquire)),
    )
    .unwrap()
}
#[test]
fn real_native_websocket_v2_auth_fragmented_output_input_gap_reconnect_replay_and_retire() {
    let mut server = Server::new("replay");
    let valid = Arc::new(AtomicBool::new(true));
    let (ports, port) = mpsc::sync_channel(1);
    let (events, event) = mpsc::channel();
    let authority = capture(&server.origin, valid.clone());
    let first = std::thread::spawn(move || {
        stream(
            &authority,
            "synthetic-session",
            0,
            Arc::new(AtomicBool::new(false)),
            |port| ports.send(port).unwrap(),
            |value| {
                events.send(value).unwrap();
                Ok(())
            },
        )
    });
    let input = port.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        event.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "connected"
    );
    let first_frame = event.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(first_frame["cursor"], 1);
    assert_eq!(first_frame["data"], "原生首帧");
    assert_eq!(first_frame["replayGap"], false);
    input.input("中\0\r\n").unwrap();
    let gap = event.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(gap["cursor"], 3);
    assert_eq!(gap["replayGap"], true);
    assert!(first.join().unwrap().is_err());
    assert!(input.input("must never replay").is_err());
    let (events, event) = mpsc::channel();
    let authority = capture(&server.origin, valid.clone());
    let retire = valid.clone();
    let second = std::thread::spawn(move || {
        stream(
            &authority,
            "synthetic-session",
            3,
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |value| {
                events.send(value).unwrap();
                Ok(())
            },
        )
    });
    assert_eq!(
        event.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "connected"
    );
    let replay = event.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(replay["cursor"], 4);
    assert_eq!(replay["data"], "replayed");
    assert_eq!(replay["replayGap"], false);
    retire.store(false, Ordering::Release);
    assert_eq!(second.join().unwrap().unwrap_err(), "terminal_scope_stale");
    assert!(event.try_recv().is_err());
    server.finish();
}
#[test]
fn real_native_websocket_denies_redirect_and_bounds_platform_message_before_delivery() {
    let mut redirect = Server::new("redirect");
    let valid = Arc::new(AtomicBool::new(true));
    let captured = capture(&redirect.origin, valid.clone());
    assert_eq!(
        stream(
            &captured,
            "synthetic-session",
            0,
            Arc::new(AtomicBool::new(false)),
            |_| panic!("no bind after redirect"),
            |_| panic!("no success after redirect")
        )
        .unwrap_err(),
        "terminal_ws_prebind_failed"
    );
    redirect.finish();
    let mut oversized = Server::new("oversize");
    let captured = capture(&oversized.origin, valid);
    let mut connected = false;
    assert!(
        stream(
            &captured,
            "synthetic-session",
            0,
            Arc::new(AtomicBool::new(false)),
            |_| {},
            |value| {
                assert_eq!(value["type"], "connected");
                connected = true;
                Ok(())
            }
        )
        .is_err()
    );
    assert!(connected);
    oversized.finish();
}
#[test]
fn mux_decoder_rejects_wrong_session_legacy_bytes_data_before_bind_and_unsafe_cursor() {
    assert!(Decoder::new("s", SAFE_CURSOR + 1).is_err());
    for value in [
        json!({"t":"d","s":"s","i":1,"d":"bad"}),
        json!({"t":"bok","s":"other","v":2}),
        json!({"t":"bok","s":"s","v":1}),
    ] {
        assert!(Decoder::new("s", 0).unwrap().receive(frame(value)).is_err());
    }
    let mut decoder = Decoder::new("s", 0).unwrap();
    assert!(
        decoder
            .receive(Message::Text("legacy output".into()))
            .is_err()
    );
    assert!(decoder.receive(Message::Binary(vec![2])).is_err());
    decoder
        .receive(frame(json!({"t":"bok","s":"s","v":2})))
        .unwrap();
    assert!(
        decoder
            .receive(frame(json!({"t":"po","v":2})))
            .unwrap()
            .is_none()
    );
    assert!(
        matches!(frame(json!({"t":"p","v":2})),Message::Binary(bytes) if bytes.first()==Some(&1) && serde_json::from_slice::<Value>(&bytes[1..]).unwrap()==json!({"t":"p","v":2}))
    );
    for id in [json!(-1), json!(1.5), json!(SAFE_CURSOR + 1)] {
        assert!(
            decoder
                .receive(frame(json!({"t":"d","s":"s","i":id,"d":"bad"})))
                .is_err()
        );
    }
    assert_eq!(decoder.cursor, 0);
    assert!(
        decoder
            .receive(frame(json!({"t":"e","s":"other","c":"SESSION_NOT_FOUND"})))
            .is_err()
    );
    assert!(
        decoder
            .receive(frame(json!({"t":"x","s":"s","exitCode":SAFE_CURSOR+1})))
            .is_err()
    );
    assert_eq!(
        decoder
            .receive(frame(json!({"t":"e","c":"WRITE_FAIL"})))
            .unwrap_err(),
        "input_unknown"
    );
    assert_eq!(
        decoder
            .receive(frame(json!({"t":"e","c":"SESSION_NOT_FOUND"})))
            .unwrap_err(),
        "session_not_found"
    );
    let exited = decoder
        .receive(frame(json!({"t":"x","s":"s","exitCode":0,"signal":null})))
        .unwrap()
        .unwrap();
    assert_eq!(exited["type"], "exit");
    assert_eq!(exited["exitCode"], 0);
    assert!(!decoder.bound);
}
