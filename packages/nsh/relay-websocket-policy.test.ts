import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native Relay WebSocket admission accepts only exact desktop, dictation and terminal paths', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-relay-ws-policy-'));
  try {
    const program = path.join(temporary, 'Policy.swift');
    const binary = path.join(temporary, 'policy');
    writeFileSync(program, `import Foundation
@main struct Check {
  static func main() async throws {
    for path in ["/api/remote-desktop/ws", "/api/dictation/ws", "/api/terminal/ws"] { precondition(RelayTunnel.allowsWebSocketPath(path)) }
    for path in ["/api/global/event/ws", "/api/dictation/ws/", "/api/dictation/ws?extra=1", "/api/dictation/ws#fragment", "/api/dictation/%77s", "/api/dictation/../dictation/ws", "/api//dictation/ws", "https://example.invalid/api/dictation/ws", "/api/terminal/ws/", "/api/terminal/ws?extra=1", "/api/terminal/%77s", "/api/arbitrary/ws", ""] { precondition(!RelayTunnel.allowsWebSocketPath(path)) }
    let original = NativeSocketInbox()
    try await original.didOpen()
    do {
      try await original.consume(type: 9, payload: Data(count: 512 * 1024 + 1))
      preconditionFailure("Existing endpoints must retain their message limit")
    } catch RelayTunnel.Failure.limit {}
    let terminal = NativeSocketInbox(maxMessageBytes: 1024 * 1024)
    try await terminal.didOpen()
    for _ in 0..<15 { try await terminal.consume(type: 9, payload: Data(count: 65536), more: true) }
    try await terminal.consume(type: 9, payload: Data(count: 65536))
    guard case .binary(let bytes) = try await terminal.receive() else { preconditionFailure("Binary message lost") }
    precondition(bytes.count == 1024 * 1024)
    do {
      try await terminal.consume(type: 9, payload: Data(count: 1024 * 1024 + 1))
      preconditionFailure("Terminal message limit must remain bounded")
    } catch RelayTunnel.Failure.limit {}
    print("exact Relay path policy passed")
  }
}`);
    const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-warnings-as-errors', '-parse-as-library', path.join(root, 'ios/RelayTunnel.swift'), path.join(root, 'ios/SessionMessageStream.swift'), program, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('exact Relay path policy passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
