import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFilePreviewSmokeFixture } from '../../../../../scripts/remote-project-file-preview-smoke.mjs';
import { parseFilePreviewPath, readFilePreviewUrlAuthToken, replaceFilePreviewUrlAuthToken } from './file-preview-path.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('file preview pathname capability envelope', () => {
  const id = 'a'.repeat(32), preview = 'b'.repeat(32), urlAuth = `yuri_url_${'c'.repeat(32)}`;
  const base = `/api/hosts/remote/api/preview/proxy/${id}/_file/${preview}/${urlAuth}`;
  it('extracts only short URL auth and replaces it before the Remote Host boundary', () => {
    expect(readFilePreviewUrlAuthToken(`${base}/docs/index.html`)).toBe(urlAuth);
    expect(replaceFilePreviewUrlAuthToken(`${base}/docs/index.html`)).toBe(`${base.replace(urlAuth, '-')}/docs/index.html`);
    expect(readFilePreviewUrlAuthToken(`${base.replace(urlAuth, '-')}/docs/index.html`)).toBe('');
    expect(parseFilePreviewPath(`${base}/docs/index.html`)?.resourcePath).toBe('/docs/index.html');
  });
  it('rejects normalized-prefix escape, encoded separators and wrong token formats', () => {
    for (const suffix of ['/../api/session', '/%2e%2e/secret', '/%2fsecret', '/a%5cb', '/bad%00', '/%ff']) {
      expect(parseFilePreviewPath(`${base}${suffix}`)).toBeNull();
    }
    expect(readFilePreviewUrlAuthToken(base.replace(urlAuth, 'long-lived-bearer') + '/index.html')).toBe('');
    expect(readFilePreviewUrlAuthToken(`/api/fs/serve/${urlAuth}`)).toBe('');
  });
});

describe('production file target HTTP resource graph', () => {
  it('uses the real E2EE Relay transport for file graph descendants without forwarding Hub credentials', async () => {
    const fixture = await createFilePreviewSmokeFixture({ relay: true }); cleanups.push(fixture.stop);
    const base = `${fixture.hub.origin}${fixture.targets[0].route}`;
    for (const relative of ['index.html', '../assets/style.css', '../assets/extra.css', '../assets/main.mjs', '../assets/part.mjs', '../assets/dynamic.mjs', '../assets/data.json', '../assets/pixel.svg', 'nested/frame.html']) {
      const response = await fetch(new URL(relative, base));
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    expect(fixture.requests.filter((req) => req.leakedHubToken)).toEqual([]);
  }, 30_000);
  it('retains two Host scopes across every descendant and denies leaks, writes, symlinks and revocation', async () => {
    const fixture = await createFilePreviewSmokeFixture(); cleanups.push(fixture.stop);
    for (const [index, target] of fixture.targets.entries()) {
      const entry = new URL(target.route, fixture.hub.origin);
      const request = (relative) => fetch(new URL(relative, entry));
      const html = await request('index.html');
      expect(html.status).toBe(200);
      expect(html.headers.get('referrer-policy')).toBe('no-referrer');
      expect(html.headers.get('cache-control')).toContain('no-store');
      const text = await html.text();
      expect(text).toContain(index === 0 ? 'remote-a' : 'remote-b');
      expect((await request('../assets/style.css')).status).toBe(200);
      expect((await request('../assets/extra.css')).status).toBe(200);
      expect((await request('../assets/main.mjs')).headers.get('content-type')).toContain('javascript');
      expect(await (await request('../assets/part.mjs')).text()).toContain(index === 0 ? 'remote-a-module' : 'remote-b-module');
      expect((await request('../assets/dynamic.mjs')).status).toBe(200);
      expect(await (await request('../assets/data.json')).json()).toEqual({ host: index === 0 ? 'remote-a' : 'remote-b' });
      expect((await request('../assets/pixel.svg')).headers.get('content-type')).toContain('image/svg+xml');
      expect((await request('nested/frame.html')).status).toBe(200);
      expect((await request('../escape.txt')).status).toBe(403);
      expect((await fetch(entry, { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(entry.href.replace(target.previewToken, '0'.repeat(32)))).status).toBe(403);
    }
    expect(fixture.requests.filter((req) => req.leakedHubToken)).toEqual([]);
    const [a, b] = fixture.targets;
    expect((await fetch(`${fixture.hub.origin}${a.route.replace('/hosts/a/', '/hosts/b/')}`)).status).toBe(404);
    const revoke = await fixture.hub.call(`/api/hosts/a/api/preview/targets/${a.id}`, 'DELETE', { previewToken: a.previewToken });
    expect(revoke.status).toBe(204);
    expect((await fetch(`${fixture.hub.origin}${a.route}`)).status).toBe(404);
    expect((await fetch(`${fixture.hub.origin}${b.route}`)).status).toBe(200);
    const originalNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 61_000);
    expect((await fetch(`${fixture.hub.origin}${b.route}`)).status).toBe(401);
    clock.mockRestore();
    const fresh = await (await fixture.hub.call('/auth/url-token', 'POST')).json();
    const renewed = replaceFilePreviewUrlAuthToken(b.route, fresh.token);
    expect((await fetch(`${fixture.hub.origin}${renewed}`)).status).toBe(200);
    await fixture.hub.clients.revokeClient(fixture.hub.issued.client.id);
    expect((await fetch(`${fixture.hub.origin}${renewed}`)).status).toBe(401);
  }, 30_000);

  it('target expiry is authoritative even with valid bearer auth; revoke and client cancel terminate remote streams', async () => {
    const fixture = await createFilePreviewSmokeFixture(); cleanups.push(fixture.stop);
    const short = await (await fixture.first.call('/api/preview/targets', 'POST', {
      kind: 'file', directory: fixture.first.root, path: path.join(fixture.first.root, 'docs/index.html'), ttlMs: 15_000,
    })).json();
    const shortRoute = `${short.proxyBasePath}/_file/${short.previewToken}/-${short.entryPath}`;
    expect((await fixture.first.call(shortRoute)).status).toBe(200);
    for (const headers of [{}, { cookie: 'yuri_preview_token=arbitrary' }]) {
      expect((await fetch(`${fixture.first.origin}${shortRoute}?yuri_preview_token=arbitrary`, { headers })).status).toBe(401);
    }
    const actualNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(actualNow + 15_001);
    expect((await fixture.first.call(shortRoute)).status).toBe(404);
    clock.mockRestore();
    const file = await fs.open(path.join(fixture.first.root, 'large.bin'), 'w');
    await file.truncate(80 * 1024 * 1024); await file.close();
    const target = fixture.targets[0];
    const large = new URL('../large.bin', `${fixture.hub.origin}${target.route}`).href;
    const controller = new AbortController();
    const response = await fetch(large, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body.getReader(); await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.first.activePreviewResponses).toBe(0));
    const active = await fetch(large);
    const activeReader = active.body.getReader(); await activeReader.read();
    expect((await fixture.hub.call(`/api/hosts/a/api/preview/targets/${target.id}`, 'DELETE', { previewToken: target.previewToken })).status).toBe(204);
    await expect((async () => { while (!(await activeReader.read()).done) { /* Drain already-buffered transport chunks. */ } })()).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.first.activePreviewResponses).toBe(0));
    expect((await fetch(`${fixture.hub.origin}${fixture.targets[1].route}`)).status).toBe(200);
  }, 30_000);
});
