"""Short-lived loopback only, no PTY/shell/files/dependencies. Strict native auth/origin gates."""
import base64
import hashlib
import json
import socket
import struct
import sys

mode = sys.argv[1]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(4)
listener.settimeout(10)
port = listener.getsockname()[1]
origin = f"http://127.0.0.1:{port}"
print(port, flush=True)


def exact(conn, size):
    result = b""
    while len(result) < size:
        data = conn.recv(size - len(result))
        if not data:
            raise EOFError()
        result += data
    return result


def read(conn):
    while True:
        first, second = exact(conn, 2)
        length = second & 127
        if length == 126:
            length = struct.unpack("!H", exact(conn, 2))[0]
        if length == 127:
            length = struct.unpack("!Q", exact(conn, 8))[0]
        assert second & 128 and length <= 65536
        mask = exact(conn, 4)
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(exact(conn, length)))
        opcode = first & 15
        if opcode == 9:
            send(conn, data, 10)
            continue
        return opcode, data


def send(conn, data, opcode=2, final=True):
    size = len(data)
    header = bytes([(128 if final else 0) | opcode])
    header += bytes([size]) if size < 126 else (b"\x7e" + struct.pack("!H", size) if size < 65536 else b"\x7f" + struct.pack("!Q", size))
    conn.sendall(header + data)


def control(conn, value, fragmented=False):
    data = b"\x01" + json.dumps(value, ensure_ascii=False).encode()
    if fragmented:
        send(conn, data[:4], final=False)
        send(conn, data[4:], opcode=0)
    else:
        send(conn, data)


def accept(path="/api/terminal/ws"):
    conn, _ = listener.accept()
    conn.settimeout(10)
    raw = b""
    while not raw.endswith(b"\r\n\r\n"):
        raw += exact(conn, 1)
        assert len(raw) <= 8192
    lines = raw.decode().split("\r\n")
    headers = dict((key.lower(), value.strip()) for key, value in (line.split(":", 1) for line in lines[1:] if line))
    assert headers.get("authorization") == "Bearer synthetic-ws-token"
    assert "cookie" not in headers
    assert lines[0] == f"GET {path} HTTP/1.1"
    if path == "/api/terminal/ws":
        assert headers.get("origin") == origin
    return conn, headers


def upgrade():
    conn, headers = accept()
    assert headers["upgrade"].lower() == "websocket"
    digest = hashlib.sha1((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.b64encode(digest) + b"\r\n\r\n")
    return conn


try:
    if mode == "redirect":
        target = socket.socket()
        target.bind(("127.0.0.1", 0))
        target.listen(1)
        target.settimeout(1)
        conn, _ = accept()
        conn.sendall(f"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target.getsockname()[1]}/api/terminal/ws\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
        conn.close()
        try:
            redirected, _ = target.accept()
            redirected.close()
            raise AssertionError("redirected native credential request")
        except socket.timeout:
            pass
        target.close()
    elif mode == "fallback":
        conn, _ = accept()
        conn.sendall(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        conn.close()
        conn, _ = accept("/api/terminal/synthetic-session/stream")
        body = b'data: {"type":"connected"}\r\n\r\ndata: {"type":"data","data":"SSE-with-explicit-gap"}\r\n\r\n'
        conn.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        conn.close()
    elif mode == "unknown":
        conn = upgrade()
        opcode, data = read(conn)
        assert opcode == 2 and json.loads(data[1:])["t"] == "b"
        control(conn, {"t": "bok", "s": "synthetic-session", "v": 2})
        opcode, data = read(conn)
        assert opcode == 1 and data == b"once-only"
        control(conn, {"t": "e", "c": "WRITE_FAIL", "f": False})
        opcode, data = read(conn)
        assert opcode == 8, "unknown input cannot cause HTTP fallback/replay"
        send(conn, data, 8)
        conn.close()
    elif mode == "replay":
        for turn in range(2):
            conn = upgrade()
            opcode, data = read(conn)
            assert opcode == 2 and data[0] == 1
            assert json.loads(data[1:]) == {"t": "b", "s": "synthetic-session", "r": 0 if turn == 0 else 3, "v": 2}
            control(conn, {"t": "ok", "v": 2})
            control(conn, {"t": "bok", "v": 2, "s": "synthetic-session"})
            if turn == 0:
                control(conn, {"t": "d", "s": "synthetic-session", "i": 1, "d": "原生首帧"}, fragmented=True)
                opcode, data = read(conn)
                assert opcode == 1 and data == "中\x00\r\n".encode()
                control(conn, {"t": "d", "s": "synthetic-session", "i": 3, "d": "gap"})
                conn.shutdown(socket.SHUT_RDWR)
            else:
                control(conn, {"t": "d", "s": "synthetic-session", "i": 3, "d": "duplicate"})
                control(conn, {"t": "d", "s": "synthetic-session", "i": 4, "d": "replayed"})
                opcode, data = read(conn)
                assert opcode == 8, "retire must detach, never send input or PTY kill"
                send(conn, data, 8)
            conn.close()
    elif mode == "oversize":
        conn = upgrade()
        read(conn)
        control(conn, {"t": "bok", "v": 2, "s": "synthetic-session"})
        try:
            send(conn, b"\x01" + b"x" * 1048576)
            read(conn)
        except (EOFError, ConnectionError):
            pass
        conn.close()
    else:
        raise AssertionError("unknown synthetic mode")
    print(json.dumps({"ok": True, "mode": mode}), flush=True)
finally:
    listener.close()
