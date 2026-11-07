import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

// Main owns all engine/device QA. This file is inert unless explicitly opted in;
// mock bridge results test only production JSX admission/lifetimes, never playback.
const enabled = process.env.NSH_RESOURCE_MEDIA_UI_TESTS === '1';
const root = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], omitUnsupportedPreview = false) {
  const temporary = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'resource-media-ui-'));
  const fixture = path.join(temporary, 'host.js');
  writeFileSync(fixture, `export function createHost(player) {
    let serial = 0, generation = 0, failNext = false, cancelled = 0, previewCalls = 0, closeCalls = 0, releaseCalls = 0;
    const leases = new Map(), pending = new Map();
    const counters = () => ({ synthetic: true, generation, pending: pending.size, cancelled, previewCalls, closeCalls, releaseCalls, leases: leases.size, failNextServe: failNext });
    const publish = () => player.hostEvent('fixture.media.counters', counters());
    return { async call(name, args) {
      if (name === 'fixture.media.control') {
        if (args.action === 'fail-next-serve') failNext = true;
        else if (args.action === 'invalidate') {
          generation++; leases.clear();
          for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Synthetic Host changed')); }
          pending.clear(); player.hostEvent('fixture.media.scope', { generation });
        } else if (args.action !== 'inspect') throw new Error('Headless does not model native timers/player');
        publish(); return counters();
      }
      if (name === 'resources.read') {
        if (args.expectedHost?.hostID !== 'synthetic-media' || args.expectedHost?.lease !== '00000000-0000-4000-8000-' + String(generation + 1).padStart(12, '0')) throw new Error('Synthetic resource scope rejected');
        if (!['/fixture/media/silent.wav','/fixture/media/neutral.mp4','/fixture/media/slow.mp4','/fixture/media/unsupported.mp4'].includes(args.path) || typeof args.requestId !== 'string') throw new Error('Invalid synthetic read');
        if (failNext) { failNext = false; throw new Error('Neutral media refresh failed; previous lease retained'); }
        const scope = generation;
        return await new Promise((resolve, reject) => {
          const entry = { reject, timer: setTimeout(() => {
            pending.delete(args.requestId);
            if (scope !== generation) return reject(new Error('Synthetic Host changed'));
            const lease = 'media-' + (++serial), audio = args.path.endsWith('.wav'), unsupported = args.path.endsWith('unsupported.mp4');
            const result = { kind: audio ? 'audio' : 'video', lease, size: 256,
              ...(unsupported && ${omitUnsupportedPreview} ? {} : { preview: unsupported ? 'unsupported' : 'avkit' }) };
            leases.set(lease, { ...result, scope }); publish(); resolve(result);
          }, args.path.endsWith('slow.mp4') ? 8000 : 30) };
          pending.set(args.requestId, entry); publish();
        });
      }
      if (name === 'resources.cancel') {
        const entry = pending.get(args.requestId);
        if (entry) { clearTimeout(entry.timer); pending.delete(args.requestId); cancelled++; entry.reject(new Error('Synthetic read cancelled')); }
        publish(); return true;
      }
      if (name === 'resources.close') { closeCalls++; publish(); return true; }
      if (name === 'resources.release') { releaseCalls++; leases.delete(args.lease); publish(); return true; }
      if (name === 'resources.present') {
        const lease = leases.get(args.lease);
        if (!lease || lease.scope !== generation) throw new Error('Stale synthetic lease');
        if (args.action === 'preview' && lease.preview !== 'avkit') throw new Error('No synthetic decoder capability');
        if (args.action === 'preview') previewCalls++;
        publish(); return { completed: false };
      }
      throw new Error('Unexpected media fixture call ' + name);
    } };
  }`);
  // Isolate generated NSH steps/config as well as Host mock from main's engine work.
  writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Resource media gate test', id: 'example.yuri.resource-media-headless',
    version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['resources.read', 'resources.present', 'resources.cancel', 'resources.close', 'resources.release', 'fixture.media.control'] } }));
  writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'tests/resource-media/fixture.tsx'))};\n`);
  try {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], {
      cwd: temporary, encoding: 'utf8', timeout: 60_000,
      input: [
        'await app.waitFor("id:media-open-video");',
        'const js = () => JSON.parse(app.texts().find(value => value.startsWith("{\\"reads\\":")) || "{}");',
        ...steps,
        'expect(app.shows("id:media-fixture-error")).toBe(false);',
      ].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test.skipIf(!enabled)('production media button requires native decoder capability and forwards the exact lease', () => {
  run([
    'await app.press("id:media-open-video");',
    'await app.waitFor("id:resource-media-preview");',
    'expect(app.enabled("id:resource-media-preview")).toBe(true);',
    'const videoLease = js().lease;',
    'await app.press("id:resource-media-preview");',
    'await app.waitUntil(() => js().previewCalls === 1);',
    'expect(js().lastPreviewLease).toBe(videoLease);',
    'await app.press("id:media-open-unsupported");',
    'await app.waitFor("id:resource-preview-unavailable");',
    'expect(app.shows("id:resource-media-preview")).toBe(false);',
    'expect(js().previewCalls).toBe(1);',
    'expect(app.enabled("text:Save")).toBe(true);',
    'await app.press("id:media-open-audio");',
    'await app.waitFor("id:resource-media-preview");',
    'expect(js().kind).toBe("audio");',
  ]);
}, 75_000);

test.skipIf(!enabled)('undecoded video with no preview field never gets a fake native playback button', () => {
  run([
    'await app.press("id:media-open-unsupported");',
    'await app.waitUntil(() => js().successes === 1);',
    'await app.waitUntil(() => app.enabled("text:Save"));',
    'expect(js().preview).toBe("missing");',
    'expect(app.shows("id:resource-media-preview")).toBe(false);',
    'expect(js().previewCalls).toBe(0);',
    'expect(app.enabled("text:Save")).toBe(true);',
  ], true);
}, 75_000);

test.skipIf(!enabled)('failed refresh retains the old media lease until successful replacement or back cleanup', () => {
  run([
    'await app.press("id:media-open-video");',
    'await app.waitFor("id:resource-media-preview");',
    'const retained = js().lease;',
    'await app.press("id:media-fail-refresh");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"failNextServe\\":true")));',
    'await app.press("text:Refresh files");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("Neutral media refresh failed; previous lease retained")));',
    'expect(js().lease).toBe(retained);',
    'expect(js().currentLeaseReleased).toBe(false);',
    'expect(app.shows("id:resource-media-preview")).toBe(true);',
    'await app.press("id:resource-media-preview");',
    'await app.waitUntil(() => js().lastPreviewLease === retained);',
    'await app.press("text:Refresh files");',
    'await app.waitUntil(() => js().successes === 2 && js().releaseCalls >= 1);',
    'expect(js().lease).not.toBe(retained);',
    'expect(js().currentLeaseReleased).toBe(false);',
    'await app.press("text:Close");',
    'await app.waitFor("id:media-source-closed");',
    'await app.waitUntil(() => js().currentLeaseReleased === true && js().closeCalls >= 2);',
  ]);
}, 75_000);

test.skipIf(!enabled)('back cancels pending reads; hide closes without releasing and Host fence reloads', () => {
  run([
    'await app.press("id:media-open-slow");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"pending\\":1")));',
    'await app.press("text:Close");',
    'await app.waitFor("id:media-source-closed");',
    'await app.press("id:media-inspect");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"cancelled\\":1")));',
    'expect(app.shows("id:resource-media-preview")).toBe(false);',
    'await app.press("id:media-open-video");',
    'await app.waitFor("id:resource-media-preview");',
    'const hiddenLease = js().lease;',
    'await app.press("id:media-hide");',
    'await app.waitUntil(() => js().closeCalls >= 1);',
    'expect(js().currentLeaseReleased).toBe(false);',
    'await app.press("id:media-show");',
    'expect(js().lease).toBe(hiddenLease);',
    'await app.press("id:media-host");',
    'await app.waitUntil(() => js().scope === 1 && js().successes === 2);',
    'expect(js().lease).not.toBe(hiddenLease);',
    'expect(js().currentLeaseReleased).toBe(false);',
  ]);
}, 75_000);
