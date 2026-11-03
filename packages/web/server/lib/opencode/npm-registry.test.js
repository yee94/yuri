import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as npm from './npm-registry.js';

const mock = vi.fn;
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

let fetchMock;

function jsonResponse(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const originalCliLookup = npm.npmCli.lookup;

describe('npm registry client', () => {
  beforeEach(() => {
    npm.clearCache();
    execFileMock.mockReset();
    Date.now = originalDateNow;
    fetchMock = mock(() => jsonResponse({}));
    globalThis.fetch = fetchMock;
    npm.npmCli.lookup = async () => null;
  });

  afterEach(() => {
    npm.clearCache();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    npm.npmCli.lookup = originalCliLookup;
  });

  test('npm CLI answer wins and skips the direct request (scope registries/auth)', async () => {
    npm.npmCli.lookup = async () => ({ ok: true, latest: '2.0.0', versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } });

    const result = await npm.lookupNpmPackage('@private/pkg', { cwd: '/proj' });

    expect(result).toMatchObject({ ok: true, latest: '2.0.0' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('CLI 404 is definitive and not retried over HTTP', async () => {
    npm.npmCli.lookup = async () => ({ ok: false, status: 404, error: 'Package not found' });

    const result = await npm.lookupNpmPackage('@private/missing');

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('cache is separated by cwd because .npmrc differs per project', async () => {
    let calls = 0;
    npm.npmCli.lookup = async () => {
      calls += 1;
      return { ok: true, latest: '1.0.0', versions: ['1.0.0'], distTags: { latest: '1.0.0' } };
    };

    await npm.getNpmInfo('foo', { cwd: '/a' });
    await npm.getNpmInfo('foo', { cwd: '/b' });
    await npm.getNpmInfo('foo', { cwd: '/a' });

    expect(calls).toBe(2);
  });

  test('200 success returns latest versions and dist tags', async () => {
    fetchMock.mockImplementation(() => jsonResponse({
      'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.2.0': {} },
    }));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({
      ok: true,
      latest: '1.2.0',
      versions: ['1.0.0', '1.2.0'],
      distTags: { latest: '1.2.0' },
    });
  });

  test('200 success handles missing dist-tags and versions', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({ ok: true, latest: null, versions: [], distTags: {} });
  });

  test('404 returns package not found', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 404));

    const result = await npm.lookupNpmPackage('missing');

    expect(result).toEqual({ ok: false, status: 404, error: 'Package not found' });
  });

  test('500 returns registry error', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 500));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({ ok: false, status: 500, error: 'Registry returned 500' });
  });

  test('network error returns network status', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('socket closed')));

    const result = await npm.lookupNpmPackage('foo');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('network');
    expect(result.error).toBe('socket closed');
  });

  test('timeout plumbs AbortSignal to fetch', async () => {
    fetchMock.mockImplementation((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    const result = await npm.lookupNpmPackage('foo');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('network');
    expect(result.error).toContain('aborted');
  });

  test('cache hit reuses definitive success', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));

    const first = await npm.getNpmInfo('foo');
    const second = await npm.getNpmInfo('foo');

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('cache miss after ttl fetches again', async () => {
    let now = 1_000;
    Date.now = mock(() => now);
    fetchMock.mockImplementation(() => jsonResponse({ versions: {} }));

    await npm.getNpmInfo('foo');
    now += 3_600_001;
    await npm.getNpmInfo('foo');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('forceRefresh bypasses cache', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ versions: {} }));

    await npm.getNpmInfo('foo');
    await npm.getNpmInfo('foo', { forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('in-flight requests dedup by package name', async () => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await wait;
      return new Response(JSON.stringify({ versions: { '1.0.0': {} } }), { status: 200 });
    });

    const requests = Promise.all([
      npm.getNpmInfo('foo'),
      npm.getNpmInfo('foo'),
      npm.getNpmInfo('foo'),
    ]);
    release();
    const results = await requests;

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('network failure is not cached', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementationOnce(() => jsonResponse({ versions: {} }));

    const first = await npm.getNpmInfo('foo');
    const second = await npm.getNpmInfo('foo');

    expect(first.status).toBe('network');
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('404 is cached', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 404));

    await npm.getNpmInfo('missing');
    await npm.getNpmInfo('missing');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('scoped names encode slash in registry url', async () => {
    await npm.getNpmInfo('@scope/pkg');

    expect(fetchMock.mock.calls[0][0]).toBe('https://registry.npmjs.org/@scope%2Fpkg');
  });

  test('user-agent header is present', async () => {
    await npm.getNpmInfo('foo');

    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/^yuri-server\//);
  });
  test('npm CLI queries and sanitizes the top-level package icon', async () => {
    npm.npmCli.lookup = originalCliLookup;
    execFileMock.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({
      'dist-tags': { latest: '1.0.0' }, versions: ['1.0.0'],
      icon: '  https://cdn.example/a.png  ',
      magpie: { icon: 'https://cdn.example/legacy.png' },
    }), ''));

    const result = await npm.getNpmInfo('@scope/pkg', { cwd: '/proj' });

    expect(result.icon).toBe('https://cdn.example/a.png');
    expect(execFileMock).toHaveBeenCalledWith(expect.any(String), ['view', '@scope/pkg', 'dist-tags', 'versions', 'icon', '--json'],
      expect.objectContaining({ cwd: '/proj' }), expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('registry fallback reads the top-level icon from the latest release', async () => {
    fetchMock.mockImplementation(() => jsonResponse({
      'dist-tags': { latest: '1.0.0' },
      icon: 'https://cdn.example/packument.png',
      versions: {
        '0.9.0': { icon: 'https://cdn.example/old.png' },
        '1.0.0': { icon: 'data:image/svg+xml;base64,AAAA', magpie: { icon: 'https://cdn.example/legacy.png' } },
      },
    }));

    const result = await npm.lookupNpmPackage('foo');

    expect(result.icon).toBe('data:image/svg+xml;base64,AAAA');
  });

  test.each(['cli', 'http'])('%s never falls back to magpie.icon when icon is missing or invalid', async (source) => {
    for (const icon of [undefined, 'http://cdn.example/insecure.png', { url: 'https://cdn.example/a.png' }]) {
      const manifest = { icon, magpie: { icon: 'https://cdn.example/legacy.png' }, 'magpie.icon': 'https://cdn.example/legacy-flat.png' };
      if (source === 'cli') {
        npm.npmCli.lookup = originalCliLookup;
        execFileMock.mockImplementation((_command, _args, _options, callback) => callback(null,
          JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: ['1.0.0'], ...manifest }), ''));
      } else fetchMock.mockImplementation(() => jsonResponse({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': manifest } }));
      const result = await npm.lookupNpmPackage('foo');
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('icon');
    }
  });

  test('sanitizePluginIcon keeps only https and data:image, within the size cap', () => {
    expect(npm.sanitizePluginIcon('https://x/y.png')).toBe('https://x/y.png');
    expect(npm.sanitizePluginIcon('  data:image/png;base64,AA  ')).toBe('data:image/png;base64,AA');
    expect(npm.sanitizePluginIcon('http://x/y.png')).toBeUndefined();
    expect(npm.sanitizePluginIcon('javascript:alert(1)')).toBeUndefined();
    expect(npm.sanitizePluginIcon('data:text/html;base64,AA')).toBeUndefined();
    expect(npm.sanitizePluginIcon(42)).toBeUndefined();
    expect(npm.sanitizePluginIcon(`https://x/${'a'.repeat(3 << 19)}`)).toBeUndefined();
  });
});
