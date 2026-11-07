#!/usr/bin/env bun
// Run the production Swift bridge against a local fixture, without a simulator or Keychain writes.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../../web/server/lib/relay/e2ee.js';
import { encodeTunnelFrame, decodeTunnelFrame } from '../../web/server/lib/relay/tunnel-codec.js';

if (typeof Bun === 'undefined') throw new Error('Run with bun: the native Relay fixture uses Bun.serve WebSockets without installing dependencies');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuri-nsh-bridge-'));
const credential = `yuri_client_${randomUUID()}`;
let passwordIssued = false;
let attachmentVerified = false;
let redemptions = 0;
let networkRequests = 0;
const sockets = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  function json(value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
  if (url.pathname === '/fixture-audit') return json({ requests: networkRequests });
  networkRequests += 1;
  if (url.pathname === '/health') return json({ serverId: 'native_fixture' });
  if (url.pathname === '/api/client-auth/pairing/redeem') { redemptions += 1; return json({ clientToken: credential, server: { label: 'Relay fixture' } }); }
  if (url.pathname === '/auth/session') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    passwordIssued ||= args.password === 'fixture-password' && args.issueClientToken === true && args.trustDevice === true && args.clientKind === 'mobile';
    if (args.password === 'slow-fixture') return setTimeout(() => json({ clientToken: credential }), 300);
    return json({ clientToken: credential });
  }
  if (url.pathname.startsWith('/api/fs/prompt-attachments/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const digest = createHash('sha256').update(body).digest('hex');
    attachmentVerified = req.method === 'PUT' && url.searchParams.get('storage') === 'temporary'
      && req.headers.authorization === `Bearer ${credential}` && req.headers['x-yuri-sha256'] === digest
      && Number(req.headers['x-yuri-content-length']) === body.length && req.headers['x-yuri-mime'] === 'text/plain'
      && decodeURIComponent(req.headers['x-yuri-filename']) === '附件 #.txt';
    return json({ success: true, path: '/fixture/附件 #.txt', sha256: digest, size: body.length, mime: 'text/plain' });
  }
  if (url.pathname === '/api/config/settings') {
    if (url.searchParams.has('slow')) return setTimeout(() => json({ stale: true }), 300);
    const authorized = req.headers.authorization === `Bearer ${credential}`;
    return json({ authorized }, authorized ? 200 : 401);
  }
  if (url.pathname === '/api/fs/read') {
    if (url.searchParams.has('html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>SPA fallback</html>'); }
    if (url.searchParams.has('oversized')) { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(32 * 1024 * 1024 + 1) }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('native fixture 文本');
  }
  if (url.pathname.startsWith('/api/fs/serve/')) {
    if (req.headers.authorization !== `Bearer ${credential}`) return json({ error: 'unauthorized' }, 401);
    if (url.pathname.endsWith('/redirect')) { res.writeHead(302, { Location: '/api/config/settings' }); return res.end(); }
    if (url.pathname.endsWith('/declared-large')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' }); return res.end(); }
    if (url.pathname.endsWith('/chunked-large')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write(Buffer.alloc(600)); return res.end(Buffer.alloc(600)); }
    if (url.pathname.endsWith('/slow')) return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('stale resource'); }, 300);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('neutral resource 文本');
  }
  if (url.pathname === '/api/plain') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('not JSON'); }
  if (url.pathname === '/api/redirect') { res.writeHead(302, { Location: '/api/config/settings' }); return res.end(); }
  if (url.pathname === '/api/event') {
    const old = url.searchParams.has('old');
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      res.write(`:${' '.repeat(4096)}\n\ndata: ${old ? 'old' : 'new'}\n\n`);
      if (url.searchParams.has('unicode')) {
        const text = Buffer.from('data: 原生 Relay 😀\r\n\r\n');
        for (let index = 0; index < text.length; index++) setTimeout(() => { if (!res.destroyed) res.write(text.subarray(index, index + 1)); }, index * 2);
      }
    }, old ? 200 : 0);
  }
  json({ error: 'unexpected fixture path' }, 404);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const keys = await generateEcdhKeyPair();
const wire = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req, instance) {
    if (instance.upgrade(req, { data: { handshake: createHostHandshake(keys.privateKey), incoming: Promise.resolve(), outgoing: Promise.resolve(), streams: new Map() } })) return;
    return new Response('Expected WebSocket', { status: 400 });
  },
  websocket: {
    message(socket, message) {
      const state = socket.data;
      const send = (type, streamID, payload = new Uint8Array()) => {
        state.outgoing = state.outgoing.then(async () => socket.send(await state.channel.encryptor.encrypt(encodeTunnelFrame(type, streamID, payload))));
        return state.outgoing;
      };
      state.incoming = state.incoming.then(async () => {
        if (typeof message === 'string') {
          const result = await state.handshake.handleText(message);
          if (result.type !== 'established' || result.batch !== false) throw new Error('Unexpected native handshake');
          state.channel = result.channel; socket.send(result.replyText); return;
        }
        const frame = decodeTunnelFrame(await state.channel.decryptor.decrypt(message));
        const { frameType: type, streamId: id, payload } = frame;
        if (type === 11) return send(12, id);
        if (type === 5) { state.streams.get(id)?.controller.abort(); state.streams.delete(id); return; }
        if (type === 1) { state.streams.set(id, { head: JSON.parse(new TextDecoder().decode(payload)), body: [], controller: new AbortController() }); return; }
        const stream = state.streams.get(id);
        if (!stream) return;
        if (type === 2) { stream.body.push(Buffer.from(payload)); return; }
        if (type !== 4) throw new Error('Unexpected mux frame');
        void (async () => {
          const { head, controller } = stream;
          const response = await fetch(`http://127.0.0.1:${server.address().port}${head.path}${head.query ? '?' + head.query : ''}`, { method: head.method, headers: head.headers, body: ['GET', 'HEAD'].includes(head.method) ? undefined : Buffer.concat(stream.body), signal: controller.signal, redirect: 'manual' });
          await send(3, id, new TextEncoder().encode(JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers) })));
          if (response.body) {
            for await (const chunk of response.body) {
              for (let offset = 0; offset < chunk.length; offset += 65526) await send(2, id, chunk.subarray(offset, offset + 65526));
            }
          }
          await send(4, id); state.streams.delete(id);
        })().catch(() => { if (!stream.controller.signal.aborted) socket.close(1011); });
      }).catch(() => socket.close(1011));
    },
    close(socket) { for (const stream of socket.data.streams.values()) stream.controller.abort(); },
  },
});
const relayPayload = { v: 2, pairingId: 'native_fixture_pair', secret: 'fixture-one-time-secret', candidates: [
  { type: 'lan', url: 'http://127.0.0.1:1', priority: 1 },
  { type: 'relay', relayUrl: `ws://127.0.0.1:${wire.port}`, serverId: 'native_fixture', hostEncPubJwk: await exportPublicKeyJwk(keys.publicKey), priority: 30 },
] };
const relayLink = `yuri://connect?v=2&p=${Buffer.from(JSON.stringify(relayPayload)).toString('base64url')}`;
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}
try {
  await writeFile(path.join(temporary, 'NativeShell.swift'), `
import Foundation
@MainActor public final class NshAppView {
    public init() {}
    public var handlers: [String: (Any?) async throws -> Any?] = [:]
    public var events: [(String, [String: Any])] = []
    public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) { handlers[name] = handler }
    public func send(_ name: String, _ data: Any? = nil) { events.append((name, data as? [String: Any] ?? [:])) }
}
`);
  await run('xcrun', ['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(temporary, 'NativeShell.swift'), '-o', path.join(temporary, 'libNativeShell.dylib')]);
  // The production value type is shared. Only persistence is replaced: this test never writes Keychain.
  const store = await readFile(path.join(root, 'ios/ConnectionStore.swift'), 'utf8');
  const desktop = await readFile(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  const desktopContract = desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline'));
  // Keep every production store method, including editor/version/replacement logic;
  // substitute ONLY the Keychain initializer and persistence sink with memory.
  function substitute(source, start, end, replacement) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    if (from < 0 || to < from) throw new Error('Production ConnectionStore fixture boundary changed');
    return source.slice(0, from) + replacement + source.slice(to);
  }
  let fixtureStore = store.replace('import Security\n', '');
  fixtureStore = substitute(fixtureStore, '    init() throws {', '    var selected:', `    var saved = 0
    var failNextWrite = false
    private(set) var persisted = Data()
    init() throws { state = State() }
`);
  fixtureStore = substitute(fixtureStore, '    private func persist(_ data: Data) throws {', '    func save(', `    private func persist(_ data: Data) throws {
        if failNextWrite { failNextWrite = false; throw ConnectionEditorFailure.storage }
        persisted = data
    }
`);
  const saveStart = fixtureStore.indexOf('    func save('), saveEnd = fixtureStore.indexOf('    func editor(', saveStart);
  if (saveStart < 0 || saveEnd < saveStart) throw new Error('Production save/editor fixture boundary changed');
  const saveBody = fixtureStore.slice(saveStart, saveEnd);
  if (saveBody.split('try commit(next)').length !== 2) throw new Error('Production save commit boundary changed');
  fixtureStore = fixtureStore.slice(0, saveStart) + saveBody.replace('try commit(next)', 'try commit(next); saved += 1') + fixtureStore.slice(saveEnd);
  if (/\b(?:SecItem\w*|kSec\w*)\b|import Security/.test(fixtureStore)) throw new Error('Synthetic fixture must contain no Keychain operations');
  await writeFile(path.join(temporary, 'StoreFixture.swift'), fixtureStore + '\n' + desktopContract);
  await writeFile(path.join(temporary, 'Check.swift'), `
import Foundation
import NativeShell
@main struct Check {
    @MainActor static func main() async throws {
        let app = NshAppView(), store = try ConnectionStore()
        let bridge = RuntimeBridge(app: app, store: store)
        bridge.setForeground(true)
        let origin = CommandLine.arguments[1]
        func call(_ name: String, _ args: [String: Any]) async throws -> Any? { try await app.handlers[name]!(args) }
        func require(_ value: Bool, _ label: String) throws { if !value { throw NativeFailure.message(label) } }
        func eventually(_ label: String, _ predicate: () -> Bool) async throws {
            let deadline = Date().addingTimeInterval(5)
            while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
            try require(predicate(), label)
        }
        func rejected(_ name: String, _ args: [String: Any]) async throws {
            do { _ = try await call(name, args) } catch { return }
            throw NativeFailure.message("Expected rejection: \\(args["path"] ?? name)")
        }
        _ = try await call("connection.connect", ["url": origin, "password": "fixture-password"])
        try require(store.saved == 1, "validated connection was not saved")
        let savedID = store.selected!.id
        func networkCount() async throws -> Int {
            let (data, response) = try await URLSession.shared.data(from: URL(string: origin + "/fixture-audit")!)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let count = body["requests"] as? Int else { throw NativeFailure.message("Invalid synthetic network audit") }
            return count
        }
        func editorRejected(_ code: ConnectionEditorFailure, _ method: String, _ args: [String: Any]) async throws {
            do { _ = try await call(method, args) }
            catch let failure as ConnectionEditorFailure { try require(failure == code, "Incorrect editor failure code"); return }
            throw NativeFailure.message("Expected editor rejection")
        }
        var editorInvalidations = 0
        bridge.onInvalidate = { editorInvalidations += 1 }
        let original = store.selected!, oldVersion = try store.editor(savedID)["version"] as! String
        let stillCurrent = try bridge.resourceTransport()
        let beforeMetadataNetwork = try await networkCount()
        _ = try await call("connection.rename", ["id": savedID, "version": oldVersion, "label": "Renamed offline"])
        let renamed = store.selected!, renamedVersion = try store.editor(savedID)["version"] as! String
        try require(renamed.label == "Renamed offline" && renamed.id == original.id && renamed.url == original.url && renamed.token == original.token && renamed.relay == original.relay && renamed.lastUsedAt == original.lastUsedAt, "Rename changed authorization, candidate, identity or recency")
        let afterRenameNetwork = try await networkCount()
        try require(afterRenameNetwork == beforeMetadataNetwork && editorInvalidations == 0 && stillCurrent.isCurrent(), "Rename made a network request or invalidated the runtime")
        _ = try await call("connection.edit", ["id": savedID, "version": renamedVersion, "label": "Edited offline", "url": origin])
        let editedVersion = try store.editor(savedID)["version"] as! String
        let edited = store.selected!, durableBeforeFailures = store.persisted
        let editorPublic = try store.editor(savedID)
        try require(editorPublic["token"] == nil && editorPublic["relay"] == nil, "Editor exposed credentials or trust anchors")
        try await editorRejected(.pairingRequired, "connection.edit", ["id": savedID, "version": editedVersion, "label": "Must not save", "url": "https://new-origin.example.invalid"])
        try await editorRejected(.stale, "connection.rename", ["id": savedID, "version": oldVersion, "label": "Stale name"])
        try await editorRejected(.stale, "connection.edit", ["id": savedID, "version": renamedVersion, "label": "Stale candidate", "url": origin])
        try await editorRejected(.stale, "connection.connect", ["id": savedID, "version": oldVersion, "label": "Stale authorization", "url": origin, "password": "fixture-password"])
        try await editorRejected(.pairingRequired, "connection.connect", ["id": savedID, "version": editedVersion, "label": "Unauthorized origin", "url": "https://new-origin.example.invalid"])
        let afterRejectNetwork = try await networkCount()
        try require(afterRejectNetwork == beforeMetadataNetwork && editorInvalidations == 0 && store.persisted == durableBeforeFailures && stillCurrent.isCurrent(), "Local edit/rejection contacted a server, invalidated the runtime or changed storage")
        store.failNextWrite = true
        try await editorRejected(.storage, "connection.connect", ["id": savedID, "version": editedVersion, "label": "Failed reauthorization", "url": origin, "password": "fixture-password"])
        let afterFailedReauthNetwork = try await networkCount()
        try require(afterFailedReauthNetwork == afterRejectNetwork + 2, "Reauthorization did not use independent sign-in and access validation exactly once")
        try require(store.persisted == durableBeforeFailures && store.selected?.id == savedID && store.selected?.label == edited.label && store.selected?.token == edited.token && store.selected?.url == edited.url && store.selected?.editorVersion == edited.editorVersion && editorInvalidations == 0 && stillCurrent.isCurrent(), "Failed replacement changed the old durable/in-memory credentials or live runtime")
        let replacement = try await call("connection.connect", ["id": savedID, "version": editedVersion, "label": "Reauthorized", "url": origin, "password": "fixture-password"]) as? [String: Any]
        try require(store.selected?.id == savedID && store.selected?.label == "Reauthorized" && store.selected?.lastUsedAt == original.lastUsedAt && store.selected?.editorVersion != edited.editorVersion && replacement?["runtimeInvalidated"] as? Bool == true && editorInvalidations == 1 && !stillCurrent.isCurrent(), "Successful replacement failed stable identity, selection, revision or single invalidation")
        let durableReplacement = try JSONDecoder().decode(ConnectionEditorRecords.self, from: store.persisted)
        try require(durableReplacement.selected == savedID && durableReplacement.connections.count == 1, "Replacement lost selected ID or changed record count")
        let snapshot = try JSONSerialization.data(withJSONObject: store.snapshot)
        try require(!String(decoding: snapshot, as: UTF8.self).contains("yuri_client"), "snapshot exposed credential")
        let legacy = try JSONDecoder().decode(SavedConnection.self, from: JSONEncoder().encode(store.selected!))
        try require(legacy.relay == nil, "legacy direct connection did not decode")
        let authorized = try await call("runtime.request", ["path": "/api/config/settings"]) as? [String: Any]
        try require((authorized?["body"] as? [String: Any])?["authorized"] as? Bool == true, "missing bearer")
        let file = try await call("runtime.request", ["path": "/api/fs/read?path=fixture"]) as? [String: Any]
        try require(file?["body"] as? String == "native fixture 文本", "file response was not text")
        let upload = try bridge.attachmentUploader()
        let attachment = try await upload(Data("attachment fixture".utf8), "附件 #.txt", "text/plain")
        try require((attachment["uri"] as? String)?.removingPercentEncoding == "file:///fixture/附件 #.txt", "invalid Host file URI")
        func verifyResources(_ label: String) async throws {
            let transport = try bridge.resourceTransport()
            let value = try await transport.read("/api/fs/serve/fixture/neutral.txt", 1024)
            try require(value.status == 200 && String(decoding: value.data, as: UTF8.self) == "neutral resource 文本", "resource bearer/body failed: \\(label)")
            let redirect = try await transport.read("/api/fs/serve/fixture/redirect", 1024)
            try require(redirect.status == 302, "resource followed redirect: \\(label)")
            for endpoint in ["/api/fs/serve/fixture/declared-large", "/api/fs/serve/fixture/chunked-large", "/api/config/settings", "/api/fs/serve/%2e%2e/auth/session"] {
                do { _ = try await transport.read(endpoint, 1024) } catch { continue }
                throw NativeFailure.message("resource failed to enforce path/byte bound: \\(label)")
            }
        }
        try await verifyResources("direct")
        let capturedResource = try bridge.resourceTransport()
        let staleResource = Task { try await capturedResource.read("/api/fs/serve/fixture/slow", 1024) }
        try await Task.sleep(nanoseconds: 30_000_000)
        var invalidations = 0
        bridge.onInvalidate = { invalidations += 1 }
        _ = try await call("connection.select", ["id": savedID])
        do { _ = try await staleResource.value; throw NativeFailure.message("Stale resource was accepted") } catch is CancellationError {} catch { try require(!capturedResource.isCurrent(), "Resource scope remained current") }
        try require(!capturedResource.isCurrent() && invalidations == 1, "Resource invalidation hook failed")
        for endpoint in ["/api/plain", "/api/redirect", "/api/fs/read?html", "/api/fs/read?oversized", "/api/client-auth/clients", "/api/auth/reset", "/api/%63lient-auth/clients", "/api/../auth/session", "/api/%2e%2e/auth/session", "/api/%252e%252e/auth/session", "//example.invalid/api/config/settings"] {
            try await rejected("runtime.request", ["path": endpoint])
        }
        let stale = Task { try await call("runtime.request", ["path": "/api/config/settings?slow"]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        _ = try await call("connection.select", ["id": savedID])
        do { _ = try await stale.value; throw NativeFailure.message("Stale request was accepted") } catch is CancellationError {}
        do { _ = try await upload(Data("stale".utf8), "stale.txt", "text/plain"); throw NativeFailure.message("Stale upload was accepted") } catch is CancellationError {}
        let pendingConnect = Task { try await call("connection.connect", ["url": origin, "password": "slow-fixture"]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        _ = try await call("connection.select", ["id": savedID])
        do { _ = try await pendingConnect.value; throw NativeFailure.message("Stale connect was accepted") } catch is CancellationError {}
        try require(store.saved == 1, "stale connect changed persistence")
        let directStreamScope = try RuntimeHostScope(bridge.snapshot["runtimeScope"])
        _ = try await call("runtime.stream", ["path": "/api/event?old", "key": "chat", "expectedHost": directStreamScope.publicValue])
        try await Task.sleep(nanoseconds: 30_000_000)
        _ = try await call("runtime.stream", ["path": "/api/event?new", "key": "chat", "expectedHost": directStreamScope.publicValue])
        try await eventually("replacement stream did not emit", { app.events.contains { $0.1["data"] as? String == "new" } })
        try require(!app.events.contains { $0.1["data"] as? String == "old" }, "replaced stream emitted stale data")
        try require(app.events.contains { $0.1["data"] as? String == "new" }, "replacement stream did not emit: \\(app.events)")
        bridge.stop()
        _ = try await call("connection.connect", ["pairingLink": CommandLine.arguments[2]])
        let relayID = store.selected!.id
        let preservedRecords = try JSONDecoder().decode(ConnectionEditorRecords.self, from: store.persisted)
        try require(preservedRecords.connections.count == 2 && preservedRecords.connections.contains { $0.id == savedID } && preservedRecords.selected == relayID, "Relay pairing discarded the saved direct connection")
        try require(store.selected?.relay?.serverId == "native_fixture", "relay metadata not persisted")
        try require(store.selected?.publicValue["transport"] as? String == "relay", "relay metadata missing transport")
        let persistedRelay = try JSONDecoder().decode(SavedConnection.self, from: JSONEncoder().encode(store.selected!))
        try require(persistedRelay.relay == store.selected?.relay, "relay trust anchor did not round-trip")
        let relayFile = try await call("runtime.request", ["path": "/api/fs/read?path=fixture"]) as? [String: Any]
        try require(relayFile?["body"] as? String == "native fixture 文本", "relay file text failed")
        let relayUpload = try bridge.attachmentUploader()
        _ = try await relayUpload(Data("relay attachment".utf8), "附件 #.txt", "text/plain")
        try await verifyResources("relay")
        app.events.removeAll()
        let relayStreamScope = try RuntimeHostScope(bridge.snapshot["runtimeScope"])
        _ = try await call("runtime.stream", ["path": "/api/event?unicode", "key": "chat", "expectedHost": relayStreamScope.publicValue])
        try await eventually("relay chunked UTF-8 SSE did not emit", { app.events.contains { $0.1["data"] as? String == "原生 Relay 😀" } })
        try require(app.events.contains { $0.1["data"] as? String == "原生 Relay 😀" }, "relay chunked UTF-8 SSE failed")
        _ = try await call("connection.select", ["id": relayID])
        let reconnected = try await call("runtime.request", ["path": "/api/config/settings"]) as? [String: Any]
        try require((reconnected?["body"] as? [String: Any])?["authorized"] as? Bool == true, "relay reconnect failed")
        bridge.stop()
        print("Native bridge passed: zero-network/zero-invalidation rename and metadata edit, cross-origin/version rejection, independently authorized atomic replacement with failed-write rollback; direct auth/security/stale scopes/attachments/SSE; bounded authenticated resources, redirects, declared/chunked byte limits and Host invalidation on direct + Relay; real JS Relay candidate fallback, one-time redemption, encrypted HTTP/upload, chunked UTF-8 SSE and reconnect")
    }
}
`);
  await run('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-I', temporary, '-L', temporary, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temporary, path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/VoiceRecognitionCore.swift'), path.join(root, 'ios/VoiceRecognitionRuntime.swift'), path.join(root, 'ios/RuntimeBridge.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'ios/GuiPluginPreviewBridge.swift'), path.join(root, 'ios/GuiPluginRuntime.swift'), path.join(root, 'ios/RelayTunnel.swift'), path.join(root, 'ios/TerminalBridge.swift'), path.join(root, 'ios/TerminalTransport.swift'), path.join(temporary, 'StoreFixture.swift'), path.join(temporary, 'Check.swift'), '-o', path.join(temporary, 'check')]);
  await run(path.join(temporary, 'check'), [`http://127.0.0.1:${server.address().port}`, relayLink]);
  if (!passwordIssued) throw new Error('Password endpoint did not receive required client-token issuance fields');
  if (!attachmentVerified) throw new Error('Attachment upload did not satisfy size/digest/MIME/name/bearer contract');
  if (redemptions !== 1) throw new Error(`Pairing must redeem once; observed ${redemptions}`);
} finally {
  wire.stop(true);
  for (const socket of sockets) socket.destroy();
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
