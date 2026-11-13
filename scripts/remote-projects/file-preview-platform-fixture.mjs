import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// Keep the handed-off factory and its production imports; expose only its
// existing in-memory descriptors to the platform harness, never to public logs.
export async function createPlatformFileFixture({ snapshot, evidence, root }) {
  const original = path.join(snapshot.repo, 'scripts/remote-project-file-preview-smoke.mjs');
  const source = fs.readFileSync(original, 'utf8');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const expected = snapshot.files.find(entry => entry.file === 'scripts/remote-project-file-preview-smoke.mjs')?.sha256;
  if (!expected || digest(source) !== expected) throw new Error('Frozen preview factory input mismatch');
  const seam = 'return { directory, hub, first, second, targets, requests, stop, manifest,';
  if (source.split(seam).length !== 2) throw new Error('Preview handoff descriptor seam changed');
  const base = pathToFileURL(snapshot.repo + path.sep).href;
  const adjunct = source
    .replaceAll("from '../packages/", `from '${base}packages/`)
    .replace("new URL('../packages/web/package.json', import.meta.url)", `new URL(${JSON.stringify(base + 'packages/web/package.json')})`)
    .replace('new URL(`../${file}`, import.meta.url)', `new URL(file, ${JSON.stringify(base)})`)
    .replace(seam, seam + ' privateDescriptors: descriptors,');
  const modulePath = path.join(root, 'preview-factory-platform-adjunct.mjs');
  fs.writeFileSync(modulePath, adjunct, { flag: 'wx' });
  fs.writeFileSync(path.join(evidence, 'preview-factory-lineage.json'), JSON.stringify({ productSourceHash: snapshot.sourceHash, originalFactorySha256: expected, adjunctSha256: digest(adjunct), changes: ['Resolve the unchanged production imports and manifest reads against the existing frozen 2f tree', 'Expose existing private descriptors in memory only'], newProductBuild: false }, null, 2));
  const { createFilePreviewSmokeFixture } = await import(pathToFileURL(modulePath).href);
  const fixture = await createFilePreviewSmokeFixture({ relay: true });
  const load = file => import(pathToFileURL(path.join(snapshot.repo, file)).href);
  const { registerFsRoutes } = await load('packages/web/server/lib/fs/routes.js');
  const { createTerminalRuntime } = await load('packages/web/server/lib/terminal/runtime.js');
  const { createSettingsNormalizationRuntime } = await load('packages/web/server/lib/opencode/settings-normalization-runtime.js');
  const { registerSessionFoldersRoutes } = await load('packages/web/server/lib/session-folders/routes.js');
  const { createSessionUnreadRuntime } = await load('packages/web/server/lib/notifications/session-unread-runtime.js');
  const { createSessionUnreadStore } = await load('packages/web/server/lib/notifications/session-unread-store.js');
  const require = createRequire(path.join(snapshot.repo, 'packages/web/package.json'));
  const express = require('express');
  const terminals = [];
  const unreadRuntimes = [];
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process, realpathSync: fs.realpathSync });
  const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { return null; } };
  try {
    for (const remote of [fixture.first, fixture.second]) {
      const app = remote.server.listeners('request')[0];
      if (typeof app?.get !== 'function') throw new Error('Handed-off fixture is not an extendable Express host');
      registerFsRoutes(app, { os, path, fsPromises: fs.promises, spawn, crypto,
        normalizeDirectoryPath: normalization.normalizeDirectoryPath, yuriDataDir: path.dirname(remote.root) });
      registerSessionFoldersRoutes(app, { fsPromises: fs.promises, path, yuriDataDir: path.dirname(remote.root), broadcastYuriEvent() {} });
      const unread = createSessionUnreadRuntime({ store: createSessionUnreadStore({ dbPath: path.join(path.dirname(remote.root), 'session-unread.sqlite') }),
        loadSession: async () => null });
      unread.registerRoutes(app); unreadRuntimes.push(unread);
      const registered = await remote.call('/api/projects', 'POST', { path: fs.realpathSync(remote.root) });
      if (!registered.ok) throw new Error(`Owning remote project registry rejected fixture root: ${registered.status}`);
      terminals.push(createTerminalRuntime({ app, server: remote.server, express, fs, path, uiAuthController: remote.auth,
        buildAugmentedPath: () => process.env.PATH,
        searchPathFor: name => process.env.PATH.split(path.delimiter).map(dir => executable(path.join(dir, name))).find(Boolean),
        isExecutable: executable,
        isRequestOriginAllowed: req => !req.headers.origin || req.headers.origin === remote.origin,
        rejectWebSocketUpgrade: (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`),
        TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 20000, TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 10000,
        TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 5 }));
    }
    const descriptors = fixture.privateDescriptors.map(host => ({ ...host,
      label: host.id === 'a' ? 'Preview A Relay-only' : 'Preview B Direct',
      url: host.relay ? `relay://${host.relay.serverId}` : host.apiUrl }));
    const privateFile = path.join(root, 'platform-hosts-private.json');
    fs.writeFileSync(privateFile, JSON.stringify({ hosts: descriptors }), { mode: 0o600, flag: 'wx' });
    return { ...fixture, privateFile, stop: async () => { for (const terminal of terminals) await terminal.shutdown(); for (const unread of unreadRuntimes) await unread.close(); await fixture.stop(); } };
  } catch (error) { for (const terminal of terminals) await terminal.shutdown(); for (const unread of unreadRuntimes) await unread.close(); await fixture.stop(); throw error; }
}
