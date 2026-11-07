import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

const harness = `import Foundation
@main struct Harness {
 @MainActor static func main() async throws {
  let authority = RuntimeHostScope(hostID: "host", lease: UUID())
  let catalogURL = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("catalog.json")
  var current = true, requests: [TerminalRequest] = [], messages: [TerminalWireMessage] = [], events: [[String: Any]] = []
  var receives: [TerminalWireMessage] = [], receiver: CheckedContinuation<TerminalWireMessage, Error>?, closes = 0
  let socket = TerminalSocket(receive: {
    if !receives.isEmpty { return receives.removeFirst() }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }, send: { messages.append($0) }, close: { closes += 1; let waiting = receiver; receiver = nil; waiting?.resume(throwing: CancellationError()) })
  let bridge = TerminalBridge(capture: { scope in
    guard scope == authority else { throw TerminalFailure.stale }
    return TerminalTransport(expectedHost: authority, isCurrent: { current }, request: { request in
      requests.append(request)
      if case .create = request { return (200, ["sessionId": "pty-test"]) }
      return (200, ["success": true])
    }, open: { socket })
  }, emit: { events.append($0) }, catalog: TerminalCatalogStore(url: catalogURL))
  var body: [String: Any] = ["expectedHost": authority.publicValue, "owner": "terminal-test", "directory": "/project/worktree", "cols": 80, "rows": 24]
  let created = try await bridge.call("terminal.create", body) as! [String: Any]
  precondition(created["sessionId"] as? String == "pty-test")
  precondition(requests.first!.path == "/api/terminal/create" && requests.first!.body?["cwd"] as? String == "/project/worktree")
  body["sessionId"] = "pty-test"; body["cursor"] = 0; body["attachment"] = 5
  receives = [try TerminalProtocol.frame(["t": "ok", "v": 2]), try TerminalProtocol.frame(["t": "bok", "v": 2, "s": "pty-test"]), try TerminalProtocol.frame(["t": "d", "s": "pty-test", "i": 1, "d": "中文"]), try TerminalProtocol.frame(["t": "d", "s": "pty-test", "i": 1, "d": "duplicate"])]
  _ = try await bridge.call("terminal.attach", body)
  for _ in 0..<100 { await Task.yield() }
  precondition(events.filter { $0["type"] as? String == "data" }.count == 1)
  precondition(events.allSatisfy { (try? RuntimeHostScope($0["expectedHost"])) == authority && $0["attachment"] as? Int == 5 })
  let bind = try TerminalProtocol.control(messages.first!)!
  precondition(bind["t"] as? String == "b" && bind["v"] as? Int == 2 && bind["r"] as? Int == 0)
  body["data"] = "中文\\r"
  _ = try await bridge.call("terminal.input", body)
  if case .text(let text) = messages.last! { precondition(text == "中文\\r") } else { preconditionFailure() }
  _ = try await bridge.call("terminal.resize", body)
  precondition(requests.last!.path == "/api/terminal/pty-test/resize")
  bridge.setForeground(false)
  do { _ = try await bridge.call("terminal.input", body); preconditionFailure() } catch {}
  precondition(requests.count == 2 && closes > 0)
  bridge.setForeground(true); body["cursor"] = 1; body["attachment"] = 6
  receives = [try TerminalProtocol.frame(["t": "bok", "s": "pty-test", "v": 2])]
  _ = try await bridge.call("terminal.attach", body)
  for _ in 0..<100 { await Task.yield() }
  current = false
  let count = messages.count
  do { _ = try await bridge.call("terminal.input", body); preconditionFailure() } catch {}
  do { _ = try await bridge.call("terminal.close", body); preconditionFailure() } catch {}
  precondition(messages.count == count && requests.count == 2)
  current = true
  _ = try await bridge.call("terminal.close", body)
  precondition(requests.last!.method == "DELETE" && requests.last!.path == "/api/terminal/pty-test")
  let closedReceipt = try TerminalCatalogStore(url: catalogURL).contains(hostID: "host", owner: "terminal-test", directory: "/project/worktree", sessionID: "pty-test")
  precondition(!closedReceipt)
  _ = try await bridge.call("terminal.create", body)
  bridge.invalidate()
  precondition(!TerminalProtocol.directory("/project/../other") && !TerminalProtocol.directory("//host") && TerminalProtocol.directory("/中文 tree"))
  precondition(TerminalProtocol.integer(true) == nil)
  do { _ = try TerminalProtocol.control(.binary(Data([1, 0]))); preconditionFailure() } catch {}
  do { _ = try TerminalProtocol.size(["cols": true, "rows": 24]); preconditionFailure() } catch {}
  // Constructor-captured opaque scope: A→B→A is not the old A lease.
  var newLeaseBody = body; newLeaseBody["expectedHost"] = RuntimeHostScope(hostID: "host", lease: UUID()).publicValue
  do { _ = try await bridge.call("terminal.create", newLeaseBody); preconditionFailure() } catch {}
  // Durable metadata is admitted on a new bridge instance, never a supplied arbitrary PTY id.
  let store = TerminalCatalogStore(url: catalogURL)
  let remembered = try store.contains(hostID: "host", owner: "terminal-test", directory: "/project/worktree", sessionID: "pty-test"); precondition(remembered)
   var recoveryScope = authority
   let recovery = TerminalBridge(capture: { expected in
     guard expected == recoveryScope else { throw TerminalFailure.stale }
     let captured = recoveryScope
     return TerminalTransport(expectedHost: captured, isCurrent: { current && captured == recoveryScope }, request: { request in requests.append(request); return (200, ["success": true]) }, open: { socket })
  }, emit: { _ in }, catalog: store)
  _ = try await recovery.call("terminal.restore", body)
  var forged = body; forged["sessionId"] = "not-owned"
  do { _ = try await recovery.call("terminal.restore", forged); preconditionFailure() } catch {}
  current = false
   _ = try await recovery.call("terminal.detach", ["expectedHost": authority.publicValue, "owner": "terminal-test", "attachment": 6])
  do { _ = try await recovery.call("terminal.resize", body); preconditionFailure() } catch {}
   recovery.invalidate(); current = true
   // Old workspace dispose arrives after same durable Tab was restored on lease B.
   // Even an identical numeric attachment cannot cross the registered scope.
   recoveryScope = RuntimeHostScope(hostID: "host", lease: UUID())
   var restoredBody = body; restoredBody["expectedHost"] = recoveryScope.publicValue
   _ = try await recovery.call("terminal.restore", restoredBody)
   receives = [try TerminalProtocol.frame(["t": "bok", "s": "pty-test", "v": 2])]
   _ = try await recovery.call("terminal.attach", restoredBody)
   for _ in 0..<100 { await Task.yield() }
   let beforeCleanup = closes
   _ = try await recovery.call("terminal.detach", ["expectedHost": authority.publicValue, "owner": "terminal-test", "attachment": 6])
   precondition(closes == beforeCleanup)
   for invalid: Any in [NSNull(), true, -1, 0, "6"] {
     do { _ = try await recovery.call("terminal.detach", ["expectedHost": recoveryScope.publicValue, "owner": "terminal-test", "attachment": invalid]); preconditionFailure() } catch {}
   }
   do { _ = try await recovery.call("terminal.detach", ["expectedHost": recoveryScope.publicValue, "owner": "terminal-test"]); preconditionFailure() } catch {}
   precondition(closes == beforeCleanup)
   restoredBody["data"] = "new-lease-alive"
   _ = try await recovery.call("terminal.input", restoredBody)
   if case .text("new-lease-alive") = messages.last! {} else { preconditionFailure() }
   do { _ = try await recovery.call("terminal.attach", restoredBody); preconditionFailure() } catch {}
   _ = try await recovery.call("terminal.detach", ["expectedHost": recoveryScope.publicValue, "owner": "terminal-test", "attachment": 6])
   precondition(closes == beforeCleanup + 1)
   recovery.invalidate()
  // Actual fallback controller behavior: failed WS upgrade → SSE output and HTTP text input.
  var streamEvents: [[String: Any]] = [["type": "connected"], ["type": "data", "data": "SSE中文"]]
  var streamWaiter: CheckedContinuation<[String: Any], Error>?, fallbackEvents: [[String: Any]] = [], fallbackRequests: [TerminalRequest] = []
  var upgradeCount = 0, streamClosed = 0, explicitSSE = false, rejectHTTP = false
  let fallback = TerminalBridge(capture: { expected in
    guard expected == authority else { throw TerminalFailure.stale }
    return TerminalTransport(expectedHost: authority, isCurrent: { current }, request: { request in
      fallbackRequests.append(request)
      if case .create = request {
        if explicitSSE { return (200, ["sessionId": "sse-pty", "capabilities": ["stream": ["preferred": "sse", "transports": ["sse"]], "input": ["preferred": "http", "transports": ["http"]]]]) }
        return (200, ["sessionId": "sse-pty"])
      }
      if case .input = request, rejectHTTP { throw TerminalFailure.inputUnknown }
      return (200, ["success": true])
    }, open: { upgradeCount += 1; throw TerminalFailure.unavailable }, stream: { id in
      precondition(id == "sse-pty")
      return TerminalEventStream(receive: {
        if !streamEvents.isEmpty { return streamEvents.removeFirst() }
        return try await withCheckedThrowingContinuation { streamWaiter = $0 }
      }, close: { streamClosed += 1; let waiting = streamWaiter; streamWaiter = nil; waiting?.resume(throwing: CancellationError()) })
    })
  }, emit: { fallbackEvents.append($0) }, catalog: TerminalCatalogStore(url: catalogURL.deletingLastPathComponent().appendingPathComponent("fallback.json")))
  var sseBody = body; sseBody["owner"] = "fallback-owner"; sseBody.removeValue(forKey: "sessionId")
  _ = try await fallback.call("terminal.create", sseBody); sseBody["sessionId"] = "sse-pty"
  _ = try await fallback.call("terminal.attach", sseBody)
  for _ in 0..<100 { await Task.yield() }
  precondition(upgradeCount == 1 && fallbackEvents.contains { $0["transport"] as? String == "sse" && $0["replayUnavailable"] as? Bool == true })
  precondition(fallbackEvents.contains { $0["data"] as? String == "SSE中文" && $0["cursor"] as? Int == 1 })
  sseBody["data"] = "输入\\r"; _ = try await fallback.call("terminal.input", sseBody)
  precondition(fallbackRequests.last!.path == "/api/terminal/sse-pty/input" && fallbackRequests.last!.contentType == "text/plain" && fallbackRequests.last!.text == "输入\\r")
   _ = try await fallback.call("terminal.detach", ["expectedHost": authority.publicValue, "owner": "fallback-owner", "attachment": 6]); precondition(streamClosed == 1)
  do { _ = try await fallback.call("terminal.input", sseBody); preconditionFailure() } catch {}
  explicitSSE = true; streamEvents = [["type": "connected"]]; sseBody["owner"] = "explicit-sse-owner"
  _ = try await fallback.call("terminal.create", sseBody)
  _ = try await fallback.call("terminal.attach", sseBody)
  for _ in 0..<100 { await Task.yield() }
  precondition(upgradeCount == 1)
  rejectHTTP = true
  let writesBefore = fallbackRequests.filter { if case .input = $0 { return true }; return false }.count
  do { _ = try await fallback.call("terminal.input", sseBody); preconditionFailure() } catch {}
  for _ in 0..<100 { await Task.yield() }
  let writesAfter = fallbackRequests.filter { if case .input = $0 { return true }; return false }.count
  precondition(writesAfter == writesBefore + 1 && fallbackEvents.contains { $0["code"] as? String == "input_unknown" })
  fallback.invalidate()
  // Pure production document/navigation admission: only one exact local top-level GET.
  let entry = URL(string: "yuri-terminal://fixture/index.html")!, navigation = NativeTerminalNavigation(entry: URL(string: "yuri-terminal://fixture/index.html")!)
  precondition(navigation.allows(entry, method: "GET", mainFrame: true, loading: true))
  for url in ["https://external.invalid", "file:///etc/passwd", "javascript:alert(1)", "yuri-terminal://other/index.html", "yuri-terminal://fixture/index.html?token=x"] {
    precondition(!navigation.allows(URL(string: url), method: "GET", mainFrame: true, loading: true))
  }
  precondition(!navigation.allows(entry, method: "POST", mainFrame: true, loading: true))
  precondition(!navigation.allows(entry, method: "GET", mainFrame: false, loading: true))
  precondition(!navigation.allows(entry, method: "GET", mainFrame: true, loading: false))
  let admission = RuntimeHostAuthority(); _ = admission.setForeground(true, hostID: "A")
  let originalA = admission.scope(hostID: "A")!
  admission.rotate(hostID: "B"); admission.rotate(hostID: "A")
  do { _ = try admission.admit(originalA, hostID: "A", required: true); preconditionFailure() } catch {}
  precondition(admission.scope(hostID: "A") != originalA)
  let capabilities = try await fallback.call("terminal.capabilities", ["expectedHost": authority.publicValue]) as! [String: Any]
  precondition(capabilities["sseOutput"] as? Bool == true && capabilities["scope"] as? String == "native-opaque")
  let document = try NativeTerminalDocument.render(javascript: Data("globalThis.GhosttyWeb={};".utf8), wasm: Data([0,97,115,109]), palette: ["background":"#111111","foreground":"#dedede","cursor":"#dedede","selectionBackground":"#444444"], family: "Mono", size: 13, label: "</script><script>unsafe()</script>")
  precondition(!document.contains("<script>unsafe()") && document.contains("connect-src 'none'"))
  print("terminal Foundation fake transport passed")
 }
}`;

it.skipIf(process.platform !== 'darwin')('Foundation production PTY controller with fake sockets only; no Host/shell/engine/UIKit execution', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-foundation-'));
  try {
    const source = path.join(temporary, 'Harness.swift'), binary = path.join(temporary, 'test'); writeFileSync(source, harness);
    const compile = spawnSync('swiftc', ['-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/TerminalBridge.swift'), path.join(root, 'ios/NativeTerminalPreview.swift'), source, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync(binary, [temporary], { encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stdout + run.stderr).toBe(0); expect(run.stdout.trim()).toBe('terminal Foundation fake transport passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 80_000);

it.skipIf(process.platform !== 'darwin')('iOS SDK typechecks bridge registration using a declaration-only NativeShell stub, not the engine', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-sdk-'));
  const run = (args: string[]) => { const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 60_000 }); expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout.trim(); };
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temporary, 'NativeShell.swift');
    writeFileSync(stub, 'import Foundation\n@MainActor public final class NshAppView { public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) {} }');
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temporary, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temporary, '-parse-as-library', '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/TerminalBridge.swift'), path.join(root, 'ios/NativeTerminalPreview.swift')]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 130_000);
