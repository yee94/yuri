package com.yee94.yuri.nsh;

/** Bounded inbox parity with TerminalStreamInbox in ios/TerminalTransport.swift. */
public final class TerminalStreamInboxTest {
    public static void main(String[] args) throws Exception {
        pushReceive();
        overflow();
        failureAndEnd();
        timeout();
        System.out.println("TerminalStreamInboxTest OK");
    }

    private static void pushReceive() throws Exception {
        TerminalStreamInbox inbox = new TerminalStreamInbox();
        Check.failure("connectionFailed", () -> inbox.waitOpen(10), "not opened");
        inbox.didOpen();
        inbox.waitOpen(10);
        Check.failure("protocolViolation", () -> inbox.didOpen(), "double open");
        inbox.push("one");
        inbox.push(new byte[] { 1, 2, 3 });
        Check.equal("one", inbox.receive(10), "text order");
        byte[] binary = (byte[]) inbox.receive(10);
        Check.equal(3, binary.length, "binary length");
        Check.equal(0, inbox.queued(), "queue drained");
    }

    private static void overflow() throws Exception {
        TerminalStreamInbox inbox = new TerminalStreamInbox();
        inbox.didOpen();
        StringBuilder large = new StringBuilder();
        for (int i = 0; i < TerminalStreamInbox.MAX_MESSAGES; i++) inbox.push("x");
        Check.failure("overflow", () -> inbox.push("y"), "message bound");

        TerminalStreamInbox bytes = new TerminalStreamInbox();
        bytes.didOpen();
        Check.failure("overflow", () -> bytes.push(new byte[TerminalProtocol.MESSAGE_LIMIT + 1]), "message bytes bound");

        TerminalStreamInbox total = new TerminalStreamInbox();
        total.didOpen();
        total.push(new byte[700_000]);
        total.push(new byte[700_000]);
        Check.failure("overflow", () -> total.push(new byte[700_000]), "total byte bound");
        large.setLength(0);
    }

    private static void failureAndEnd() throws Exception {
        TerminalStreamInbox failed = new TerminalStreamInbox();
        failed.didOpen();
        failed.push("queued");
        failed.fail(TerminalFailure.of("protocolViolation"));
        Check.failure("connectionFailed", () -> failed.receive(10), "failure is a connection failure");

        TerminalStreamInbox ended = new TerminalStreamInbox();
        ended.didOpen();
        ended.push("tail");
        ended.end(TerminalFailure.of("connectionFailed"));
        Check.equal("tail", ended.receive(10), "queued value survives end");
        Check.failure("connectionFailed", () -> ended.receive(10), "end after drain");
    }

    private static void timeout() throws Exception {
        TerminalStreamInbox inbox = new TerminalStreamInbox();
        inbox.didOpen();
        long started = System.currentTimeMillis();
        Check.failure("connectionFailed", () -> inbox.receive(50), "receive timeout");
        Check.isTrue(System.currentTimeMillis() - started >= 40, "waited for the deadline");
    }
}
