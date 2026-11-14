package com.yee94.yuri.nsh;

/** Relay failures carry a kind instead of untrusted carrier/Host text. */
public final class RelayTunnelFailure extends Exception {
    public enum Kind {
        INVALID_CONFIGURATION("无效的 Relay 地址或 Host 公钥"),
        INVALID_REQUEST("无效的 Relay 请求"),
        INVALID_FRAME("Relay 协议或加密验证失败"),
        AUTHENTICATION("Relay 拒绝认证，请重新配对"),
        CLOSED("Relay 连接已关闭"),
        TIMEOUT("Relay 请求或连接超时"),
        LIMIT("Relay 请求超过并发或内存限制"),
        DISCONNECTED("Relay 连接中断"),
        HOST_ABORTED("Host 已中止 Relay 请求"),
        WEB_SOCKET_REJECTED("Host 拒绝或关闭了 WebSocket"),
        WEB_SOCKET_CLOSED("Host 拒绝或关闭了 WebSocket");

        public final String message;
        Kind(String message) { this.message = message; }
    }

    public final Kind kind;
    /** The rejected HTTP status or WebSocket close code, or 0. */
    public final int status;

    public RelayTunnelFailure(Kind kind) { this(kind, 0); }

    public RelayTunnelFailure(Kind kind, int status) { super(kind.message); this.kind = kind; this.status = status; }

    public boolean isAuthentication() {
        return kind == Kind.AUTHENTICATION || (kind == Kind.WEB_SOCKET_CLOSED && status == 4001);
    }
}
