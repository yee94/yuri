import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('exact native tickets and pending stream retirement preserve the newer same-scope owner', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-plugin-ownership-'));
  try {
    const source = path.join(temporary, 'Fixture.swift'), binary = path.join(temporary, 'fixture');
    writeFileSync(source, `import Foundation
@main struct Fixture {
 @MainActor static func main() async throws {
  let scope = RuntimeHostScope(hostID:"synthetic-host", lease:UUID())
  let resource = ResourceWebPreviewTransport(readFile:{ _,_ in ResourceWebPreviewResponse(status:200,mime:"text/html",data:Data()) },isCurrent:{true})
  let capture: (RuntimeHostScope) throws -> GuiPluginPreviewCapture = { expected in
   precondition(expected == scope)
   return GuiPluginPreviewCapture(expectedHost:scope,isCurrent:{$0 == scope},resource:resource,
    readAsset:{_,_ in ResourceWebPreviewResponse(status:200,mime:"text/html",data:Data())},
    labels:GuiPluginPreviewLabels(loading:"synthetic",failed:"synthetic",back:"synthetic",close:"synthetic",retry:"synthetic"))
  }
  func intent(_ owner:String) -> [String:Any] { ["owner":owner,"expectedHost":scope.publicValue,"sessionId":"s","directory":"/work","path":"a.report"] }
  func close(_ owner:String) -> [String:Any] { ["owner":owner,"expectedHost":scope.publicValue] }
  let ownership = GuiPluginPreviewOwnership()
  let a = try ownership.begin(intent("A"),capture:capture)
  precondition(ownership.startClosing(a)); precondition(ownership.retire(a))
  let b = try ownership.begin(intent("B"),capture:capture)
  let lateA = try ownership.closing(close("A"),capture:capture); precondition(lateA == nil)
  precondition(!ownership.startClosing(a)); precondition(!ownership.retire(a)); precondition(ownership.matches(b))
  let before = try ownership.closing(close("before"),capture:capture); precondition(before == nil)
  precondition(ownership.matches(b)); precondition(ownership.startClosing(b)); precondition(ownership.retire(b))
  do { _ = try ownership.begin(intent("before"),capture:capture); fatalError("close-before-present re-admitted") } catch {}
  let opening = try ownership.begin(intent("opening"),capture:capture)
  let exact = try ownership.closing(close("opening"),capture:capture)
  precondition(exact === opening); precondition(ownership.startClosing(opening)); precondition(ownership.retire(opening))
  let newer = try ownership.begin(intent("newer"),capture:capture)
  precondition(!ownership.matches(opening)); precondition(!ownership.startClosing(opening)); precondition(!ownership.retire(opening)); precondition(ownership.matches(newer))

  var document = "old", requestTask = UUID(), oldStops = 0, newStops = 0
  let oldTask = requestTask
  var blocked: CheckedContinuation<Data?, Error>?
  var entered: CheckedContinuation<Void, Never>?
  let old = try GuiPluginPreviewStreamLease(GuiPluginPreviewByteStream(status:200,mime:"text/plain",read:{_ in
   try await withCheckedThrowingContinuation { blocked = $0; entered?.resume(); entered = nil }
  },cancel:{oldStops += 1}),check:{})
  var registry = ["1":old]
  let pending = Task { @MainActor in
   do { _ = try await old.next() } catch {
    old.retire(from:&registry,requestID:"1",document:"old",currentDocument:document,task:oldTask,currentTask:requestTask)
   }
  }
  await withCheckedContinuation { entered = $0 }
  old.stop(); registry.removeAll(); document = "new"; requestTask = UUID()
  let new = try GuiPluginPreviewStreamLease(GuiPluginPreviewByteStream(status:200,mime:"text/plain",read:{_ in Data("new".utf8)},cancel:{newStops += 1}),check:{})
  registry["1"] = new
  blocked?.resume(throwing:GuiPluginPreviewFailure.response)
  await pending.value
  precondition(registry["1"] === new && oldStops == 1 && newStops == 0)
  let bytes = try await new.next(); precondition(bytes == Data("new".utf8))
  new.stop()
  print("Exact GUI ownership regression passed")
 }
}`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...['RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginResourceResolver.swift'].map(file => path.join(root, 'ios', file)), source, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Exact GUI ownership regression passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);
