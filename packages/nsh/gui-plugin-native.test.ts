import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

it.skipIf(process.platform !== 'darwin')('Foundation lease rejects stale/closed/unsafe reads without a network or NSH engine', () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-plugin-foundation-'));
  try {
    const built = spawnSync('node', [path.join(root, 'scripts/build-gui-plugin-preview.mjs')], { encoding: 'utf8', timeout: 60_000 });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const source = path.join(temporary, 'Fixture.swift'), executable = path.join(temporary, 'fixture');
    writeFileSync(source, `import Foundation
@main struct Fixture {
 @MainActor static func main() async throws {
  let root = URL(fileURLWithPath:CommandLine.arguments[1], isDirectory:true)
  let production = try GuiPluginPreviewAssets(stagedDirectory:URL(fileURLWithPath:CommandLine.arguments[2], isDirectory:true))
  let productionEntry = try production.read("/index.html", limit:65536)
  precondition(String(data:productionEntry.data, encoding:.utf8)!.contains("startGuiPluginPreview"))
  let productionJS = try production.read("/assets/entry.js", limit:GuiPluginPreviewScope.limit)
  precondition(productionJS.data.count > 100000)
  let preferences = "yuri.inst.synthetic.gui-plugins.disabled"
  let nativeStore = try GuiPluginPreviewStorage(directory:root.appendingPathComponent("storage"), runtimeKey:"synthetic-host", preferenceKey:preferences)
  _ = try nativeStore.transact(["method":"set", "key":preferences, "value":"[\\"disabled\\"]"])
  let reloadedStore = try GuiPluginPreviewStorage(directory:root.appendingPathComponent("storage"), runtimeKey:"synthetic-host", preferenceKey:preferences)
  let persisted = try reloadedStore.transact(["method":"get", "key":preferences]) as? String
  precondition(persisted == "[\\"disabled\\"]")
  do { _ = try nativeStore.transact(["method":"set", "key":"yuri.gui-plugin.[\\"other-host\\",\\"plugin\\",\\"global\\",\\"count\\"]", "value":"{}"]); fatalError("cross Host store") } catch {}
  let assets = try GuiPluginPreviewAssets(directory:root, manifest:["/index.html":"text/html; charset=utf-8", "/assets/entry.js":"text/javascript"])
  let entry = try assets.read("/index.html", limit:1024)
  precondition(String(data:entry.data, encoding:.utf8)!.contains("synthetic-local-entry"))
  do { _ = try assets.read("/assets/missing.js", limit:1024); fatalError("invented missing asset") } catch {}
  do { _ = try GuiPluginPreviewAssets(directory:root, manifest:["/index.html":"text/html", "/assets/escape.js":"text/javascript"]); fatalError("allowed asset symlink escape") } catch {}
  let scope = RuntimeHostScope(hostID:"synthetic-host", lease:UUID())
  var count = 0, cancelled = 0
  let large = GuiPluginPreviewByteStream(status:200, mime:"application/json", read: { limit in
   precondition(limit == 65536)
   if count == 529 { return nil }
   count += 1; return Data(repeating:120, count:65536)
  }, cancel:{cancelled += 1})
  let stream = try GuiPluginPreviewStreamLease(large, check:{})
  var total = 0
  while let bytes = try await stream.next() { total += bytes.count; precondition(bytes.first == 120 && bytes.last == 120) }
  precondition(total == 529 * 65536 && total > 32 * 1024 * 1024 && cancelled == 1)
  stream.stop(); precondition(cancelled == 1)
  let rpc = try GuiPluginPreviewRequest(["method":"POST", "route":"/api/rpc/contract/read?location=opaque%20value", "headers":["content-type":"application/json", "x-opencode-directory":"/work"], "body":"{\\"input\\":{\\"exact\\":true}}"])
  precondition(rpc.method == "POST" && rpc.headers["x-opencode-directory"] == "/work")
  precondition(rpc.body == Data("{\\"input\\":{\\"exact\\":true}}".utf8))
  let intent = try GuiPluginPreviewIntent(["sessionId":"s", "directory":"/work", "path":"reports/a.report.json", "expectedHost":scope.publicValue, "owner":"owner-A"])
  let standalone = try GuiPluginPreviewIntent(["directory":"/work", "path":"reports/a.report.json", "expectedHost":scope.publicValue, "owner":"standalone"])
  precondition(standalone.sessionID == nil && standalone.json["sessionId"] == nil)
  let noMatch = GuiPluginPreviewMatch(); noMatch.finish(.success(false))
  let unmatched = try await noMatch.wait(); precondition(!unmatched)
  let cancelledMatch = GuiPluginPreviewMatch()
  cancelledMatch.finish(.failure(CancellationError()))
  do { _ = try await cancelledMatch.wait(); fatalError("cancelled preparation adopted late match") } catch is CancellationError {}
  cancelledMatch.finish(.success(true))
  do { _ = try await cancelledMatch.wait(); fatalError("late match replaced cancellation") } catch is CancellationError {}
  precondition(intent.path == "reports/a.report.json")
  for input in [["sessionId":"s", "directory":"/work", "path":"https://outside.invalid"], ["sessionId":"", "directory":"/work", "path":"a.report"]] {
    var scoped: [String:Any] = input; scoped["expectedHost"] = scope.publicValue; scoped["owner"] = "owner-A"
   do { _ = try GuiPluginPreviewIntent(scoped); fatalError("accepted invalid intent") } catch {}
  }
  let asset = try GuiPluginPreviewScope.asset(URL(string:"yuri-plugin://owner/assets/entry.js")!, owner:"owner")
  precondition(asset == "/assets/entry.js")
  for value in ["yuri-plugin://other/index.html", "yuri-plugin://owner/api/plugin/gui", "yuri-plugin://owner/assets/%252e.js", "yuri-plugin://owner/index.html?token=x"] {
   do { _ = try GuiPluginPreviewScope.asset(URL(string:value)!, owner:"owner"); fatalError("accepted invalid asset") } catch {}
  }
  for value in ["/api/config/settings", "/api/plugin/gui?apiKey=x", "/api/plugin/gui?%74oken=x", "/api/plugin/gui#x", "/api/%70lugin/gui", "https://outside.invalid/api/plugin"] {
   do { _ = try GuiPluginPreviewScope.request(["method":"GET", "route":value]); fatalError("accepted invalid request") } catch {}
  }
  var current = true, reads = 0
  let transport = ResourceWebPreviewTransport(readFile: { route, limit in
   reads += 1
   precondition(route == "/api/plugin/gui?id=synthetic")
   return ResourceWebPreviewResponse(status:200, mime:"application/json", data:Data("{}".utf8))
  }, isCurrent: { current })
  var activeScope = scope
  let admissionCurrent = { (expected: RuntimeHostScope) in current && expected == activeScope }
  let absent = GuiPluginPreviewLease(transport, expectedHost:scope, isCurrent:admissionCurrent)
  do { _ = try await absent.read(["method":"GET", "route":"/api/plugin"]); fatalError("pretended resource transport supports GUI") } catch GuiPluginPreviewFailure.unsupported {} 
  precondition(reads == 0)
  let lease = GuiPluginPreviewLease(transport, expectedHost:scope, isCurrent:admissionCurrent, readGui: { expectedHost, request, limit in
    precondition(expectedHost == scope); let value = try await transport.readFile(request.route, limit)
    return GuiPluginPreviewResponse(status:value.status, mime:value.mime, data:value.data)
  })
  _ = try await lease.read(["method":"GET", "route":"/api/plugin/gui?id=synthetic"])
  precondition(reads == 1)
  current = false
  do { _ = try await lease.read(["method":"GET", "route":"/api/plugin/gui?id=synthetic"]); fatalError("stale read") } catch {}
  current = true; activeScope = RuntimeHostScope(hostID:scope.hostID, lease:UUID())
  do { _ = try await lease.read(["method":"GET", "route":"/api/plugin/gui?id=synthetic"]); fatalError("accepted renewed same-Host lease") } catch {}
  activeScope = scope; lease.close(); lease.close()
  do { _ = try await lease.read(["method":"GET", "route":"/api/plugin/gui?id=synthetic"]); fatalError("closed read") } catch {}
  precondition(reads == 1)
  var responseHeaders = ["X-Yuri-File-Exists":"true"]
  let optional = GuiPluginPreviewLease(transport, expectedHost:scope, isCurrent:admissionCurrent, readGui: { _,_,_ in
   GuiPluginPreviewResponse(status:200,mime:"text/plain",data:Data(),headers:responseHeaders)
  })
  let empty = try await optional.read(["method":"GET","route":"/api/fs/read?path=empty&optional=true"])
  precondition(empty.data.isEmpty && empty.headers["x-yuri-file-exists"] == "true")
  responseHeaders = ["x-yuri-file-exists":"false"]
  let missing = try await optional.read(["method":"GET","route":"/api/fs/read?path=missing&optional=true"])
  precondition(missing.data.isEmpty && missing.headers["x-yuri-file-exists"] == "false")
  let metadata = try GuiPluginPreviewStreamLease(GuiPluginPreviewByteStream(status:200,mime:"text/plain",read:{_ in nil},cancel:{},headers:responseHeaders),check:{})
  precondition(metadata.headers["x-yuri-file-exists"] == "false"); metadata.stop()
  responseHeaders["set-cookie"] = "synthetic-forbidden"
  do { _ = try await optional.read(["method":"GET","route":"/api/fs/read?path=extra&optional=true"]); fatalError("extra response header accepted") } catch {}
  do { _ = try GuiPluginPreviewStreamLease(GuiPluginPreviewByteStream(status:200,mime:"text/plain",read:{_ in nil},cancel:{},headers:responseHeaders),check:{}); fatalError("extra stream header accepted") } catch {}
  let delayedTransport = ResourceWebPreviewTransport(readFile: { _, _ in
   current = false
   return ResourceWebPreviewResponse(status:200, mime:"application/json", data:Data("{}".utf8))
  }, isCurrent: { current })
  let delayed = GuiPluginPreviewLease(delayedTransport, expectedHost:scope, isCurrent:admissionCurrent, readGui: { expectedHost, request, limit in
    precondition(expectedHost == scope); let value = try await delayedTransport.readFile(request.route, limit)
    return GuiPluginPreviewResponse(status:value.status, mime:value.mime, data:value.data)
  })
  do { _ = try await delayed.read(["method":"GET", "route":"/api/plugin"]); fatalError("adopted stale response") } catch {}
  print("GUI Foundation lifecycle passed")
 }
}`);
    const fs = path.join(temporary, 'assets');
    // Synthetic local bundle bytes only; no WebKit or plugin executes here.
    mkdirSync(path.join(fs, 'assets'), { recursive: true });
    writeFileSync(path.join(fs, 'index.html'), '<script src="/assets/entry.js"></script><!-- synthetic-local-entry -->');
    writeFileSync(path.join(fs, 'assets/entry.js'), '/* synthetic trusted asset; not executed */');
    writeFileSync(path.join(temporary, 'outside.js'), '/* outside asset root */');
    symlinkSync(path.join(temporary, 'outside.js'), path.join(fs, 'assets/escape.js'));
    run(['swiftc', '-swift-version', '5', '-parse-as-library', ...['RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginResourceResolver.swift'].map(file => path.join(root, 'ios', file)), source, '-o', executable]);
    const result = spawnSync(executable, [fs, path.join(root, '.nsh/gui-plugin-preview')], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('GUI Foundation lifecycle passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);

it.skipIf(process.platform !== 'darwin')('typechecks isolated WKWebView and registration using the real Apple SDK, without running UIKit', () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-plugin-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temporary, 'NativeShell.swift');
    writeFileSync(stub, '@MainActor public final class NshAppView { public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {} }');
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios26.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temporary, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temporary, '-parse-as-library', '-typecheck', ...['RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'ResourceWebPreviewView.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginResourceResolver.swift'].map(file => path.join(root, 'ios', file)), path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift')]);
    const source = readFileSync(path.join(root, 'ios/GuiPluginPreviewBridge.swift'), 'utf8');
    expect(source).not.toMatch(/URLSession|RelayTunnel\s*\(|evaluateJavaScript\(|localStorage|Authorization/);
    expect(source).toContain('configuration.websiteDataStore = .nonPersistent()');
    expect(source).toContain('message.frameInfo.isMainFrame');
    expect(source).toContain('encodedContentRuleList: ResourceWebPreviewScope.networkRules');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 130_000);
