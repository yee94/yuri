import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { mirrorOtaDistribution, verifyOtaDistribution } from '../scripts/ota-distribution.mjs';
import { onRequest as mobileCheck } from '../edge-functions/v1/mobile/update/check.js';
import { onRequest as capgoCheck } from '../edge-functions/v1/ota/check.js';

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (data) => createHash('sha256').update(data).digest('hex');

function fixture() {
  const assets = new Map();
  const bundle = (version, { encrypted = false } = {}) => {
    const bytes = Buffer.from(`ZIP ${version} ${encrypted ? 'encrypted' : 'plain'}`);
    const checksum = hash(bytes);
    const id = checksum.slice(0, 16);
    assets.set(`/ota/bundles/${id}.zip`, bytes);
    const desktopBytes = Buffer.from(`desktop ${version}`);
    const desktopHash = hash(desktopBytes);
    assets.set(`/ota/bundles/${desktopHash.slice(0, 16)}.zip`, desktopBytes);
    return {
      applicationId: 'com.yee94.yuri', bundleId: id, releaseVersion: version,
      url: `/ota/bundles/${id}.zip`, size: bytes.length,
      checksum: encrypted ? 'opaque-encrypted-checksum' : checksum,
      ...(encrypted ? { sessionKey: 'test-encrypted-session-key' } : {}),
      rolloutPercent: 100, rolloutSalt: 'test', minShellApiVersion: 2,
      platforms: { ios: { minNativeBuild: 1 }, android: { minNativeBuild: 1 } },
      desktop: { applicationId: 'dev.yuri.desktop', minShellApiVersion: 2,
        bundleId: desktopHash.slice(0, 16), url: `/ota/bundles/${desktopHash.slice(0, 16)}.zip`,
        size: desktopBytes.length, checksum: desktopHash, shellFingerprint: 'a'.repeat(64),
        minShellReleaseVersion: `${version.split('.')[0]}.0.0` },
    };
  };
  const lane = (channel, active, previous) => ({
    schemaVersion: 1, channel, generation: 3, activeBundle: active, nativeTargets: {},
    rollbackBundleIds: previous ? [previous.bundleId] : [],
    ...(previous ? { rollbackBundles: { [previous.bundleId]: previous } } : {}),
  });
  const old = bundle('1.1.0');
  const stable = bundle('1.2.0');
  const beta = bundle('1.3.0-beta.1', { encrypted: true });
  const secondMajor = bundle('2.0.0-beta.1');
  assets.set('/ota/channels/stable.json', Buffer.from(JSON.stringify(lane('stable', stable, old))));
  assets.set('/ota/channels/beta.json', Buffer.from(JSON.stringify({
    ...lane('beta', beta, old), majorReleases: { 2: lane('beta', secondMajor) },
  })));
  assets.set('/CHANGELOG.md', Buffer.from('## [1.3.0-beta.1]\n\n- Beta fix\n\n## [1.2.0]\n\n- Stable fix\n'));
  return assets;
}

function assetFetch(assets, { proxy = false, proxyChangelog = false, badRange = false, corruptRange = false, changedManifest = false } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ origin: url.origin, path: url.pathname, range: init.headers?.Range });
    const data = assets.get(url.pathname);
    if (!data) return new Response('missing', { status: 404 });
    if (changedManifest && url.pathname === '/ota/channels/beta.json'
      && calls.filter((call) => call.path === url.pathname).length > 1) {
      return new Response(JSON.stringify({ ...JSON.parse(data), generation: 4 }));
    }
    const headers = proxy || (proxyChangelog && url.pathname === '/CHANGELOG.md') ? { 'x-ota-proxy': 'edgeone' } : {};
    if (init.headers?.Range && !badRange) {
      const end = Number(init.headers.Range.match(/-(\d+)/)[1]);
      return new Response(corruptRange ? Buffer.alloc(end + 1) : data.subarray(0, end + 1), {
        status: 206, headers: { ...headers, 'content-range': `bytes 0-${end}/${data.length}` },
      });
    }
    if (!url.pathname.endsWith('.zip')) return new Response(data, { headers });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(data);
        controller.close();
        inFlight -= 1;
      },
    }), { headers });
  };
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

test('complete EdgeOne snapshot retains both channels, majors, encrypted/mobile/desktop rollback artifacts once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ota-distribution-'));
  const assets = fixture();
  const source = assetFetch(assets);
  try {
    const marker = await mirrorOtaDistribution({ outputDirectory: dir, upstreamOrigin: 'https://origin.example.com', ...source });
    assert.equal(marker.files.length, assets.size);
    assert.doesNotMatch(JSON.stringify(marker), /sessionKey|opaque-encrypted-checksum/);
    for (const [filePath, bytes] of assets) assert.deepEqual(await readFile(path.join(dir, filePath)), bytes);
    assert.ok(source.maxInFlight() <= 3);
    const bundleCalls = source.calls.filter((call) => call.path.endsWith('.zip'));
    assert.equal(bundleCalls.length, new Set(bundleCalls.map((call) => call.path)).size);
    assets.set('/ota-distribution.json', await readFile(path.join(dir, 'ota-distribution.json')));
    const edge = assetFetch(assets);
    const verified = await verifyOtaDistribution({ baseUrl: 'https://edge.example.com', snapshotDirectory: dir, requireLocal: true, ...edge });
    assert.equal(verified.length, bundleCalls.length);
    assert.ok(edge.calls.every((call) => call.origin === 'https://edge.example.com'));
    assert.equal(edge.calls.filter((call) => call.range).length, verified.length);
    await verifyOtaDistribution({ baseUrl: 'https://edge.example.com', snapshotDirectory: dir,
      requireLocal: true, requireCurrentCode: true, ...assetFetch(assets) });
    assets.set('/ota-distribution.json', Buffer.from(JSON.stringify({ ...marker, sourceSha256: '0'.repeat(64) })));
    await assert.rejects(() => verifyOtaDistribution({ baseUrl: 'https://edge.example.com', snapshotDirectory: dir,
      requireLocal: true, requireCurrentCode: true, ...assetFetch(assets) }), /different update-service code revision/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt, missing, truncated or concurrently changed sources cannot produce a readiness marker', async () => {
  for (const failure of ['missing', 'corrupt', 'size', 'manifest', 'changelog', 'conflict', 'race']) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ota-distribution-fail-'));
    const assets = fixture();
    const beta = JSON.parse(assets.get('/ota/channels/beta.json'));
    if (failure === 'missing') assets.delete(beta.activeBundle.url);
    if (failure === 'corrupt') assets.set(beta.activeBundle.url, Buffer.from('corrupt encrypted bytes'));
    if (failure === 'size') beta.activeBundle.size += 1;
    if (failure === 'manifest') beta.channel = 'stable';
    if (failure === 'conflict') beta.rollbackBundles[beta.rollbackBundleIds[0]].size += 1;
    if (failure === 'changelog') assets.delete('/CHANGELOG.md');
    assets.set('/ota/channels/beta.json', Buffer.from(JSON.stringify(beta)));
    try {
      await assert.rejects(() => mirrorOtaDistribution({ outputDirectory: dir, upstreamOrigin: 'https://origin.example.com',
        ...assetFetch(assets, { changedManifest: failure === 'race' }) }));
      await assert.rejects(() => readFile(path.join(dir, 'ota-distribution.json')), /ENOENT/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('verification rejects the legacy proxy, broken Range, stale markers and missing retained bundles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ota-distribution-verify-'));
  const assets = fixture();
  try {
    await mirrorOtaDistribution({ outputDirectory: dir, upstreamOrigin: 'https://origin.example.com', ...assetFetch(assets) });
    assets.set('/ota-distribution.json', await readFile(path.join(dir, 'ota-distribution.json')));
    const verify = (options = {}) => verifyOtaDistribution({ baseUrl: 'https://edge.example.com', snapshotDirectory: dir,
      requireLocal: true, ...assetFetch(assets, options) });
    await assert.rejects(() => verify({ proxy: true }), /still uses the upstream proxy/);
    const changelogProxy = assetFetch(assets, { proxyChangelog: true });
    await assert.rejects(() => verifyOtaDistribution({ baseUrl: 'https://edge.example.com', snapshotDirectory: dir,
      requireLocal: true, ...changelogProxy }), /\/CHANGELOG\.md still uses the upstream proxy/);
    assert.equal(changelogProxy.calls.filter(call => call.path.endsWith('.zip')).length, 0,
      'readiness retries must reject proxied metadata before downloading retained bundles');
    await assert.rejects(() => verify({ badRange: true }), /Range unsupported/);
    await assert.rejects(() => verify({ corruptRange: true }), /Range bytes mismatch/);
    const marker = assets.get('/ota-distribution.json');
    const stale = JSON.parse(marker);
    stale.files[0].sha256 = '0'.repeat(64);
    assets.set('/ota-distribution.json', Buffer.from(JSON.stringify(stale)));
    await assert.rejects(() => verify(), /marker does not match/);
    assets.delete('/ota-distribution.json');
    await assert.rejects(() => verify(), /HTTP 404/);
    assets.set('/ota-distribution.json', marker);
    const filePath = [...assets.keys()].find((key) => key.endsWith('.zip'));
    assets.delete(filePath);
    await assert.rejects(() => verify(), /HTTP 404/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual build hydrates live origin instead of git seeds, and check/download work with origin offline', async () => {
  const assets = fixture();
  const dir = `.test-dist-full-${process.pid}-${Date.now()}`;
  const out = path.join(projectRoot, dir);
  let originRequests = 0;
  const server = createServer((req, res) => {
    originRequests += 1;
    const bytes = assets.get(req.url);
    res.writeHead(bytes ? 200 : 404).end(bytes ?? 'missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  let edgeServer;
  try {
    await exec(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot,
      env: { ...process.env, YURI_UPDATE_OUTPUT_DIR: dir, YURI_UPDATE_OTA_FULL_SNAPSHOT: '1',
        YURI_UPDATE_SKIP_CHANGELOG_COPY: '1', YURI_OTA_UPSTREAM_ORIGIN: `http://127.0.0.1:${server.address().port}` } });
    const assertNoExactFunctionCollision = async (directory, segments = []) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.includes('[')) continue;
        const route = [...segments, entry.name];
        if (entry.isDirectory()) {
          await assertNoExactFunctionCollision(path.join(directory, entry.name), route);
        } else if (/\.[jt]s$/.test(entry.name)) {
          const routePath = route.join('/').replace(/\.[jt]s$/, '').replace(/(^|\/)index$/, '');
          const asset = await stat(path.join(out, routePath)).catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          assert.ok(!asset?.isFile(), `Static /${routePath} conflicts with exact EdgeOne function ${route.join('/')}`);
        }
      }
    };
    await assertNoExactFunctionCollision(path.join(projectRoot, 'edge-functions'));
    await new Promise((resolve) => server.close(resolve));
    closed = true;
    const requestsAtActivation = originRequests;
    edgeServer = createServer(async (req, res) => {
      try {
        const requestUrl = `http://${req.headers.host}${req.url}`;
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const handler = req.url === '/v1/ota/check' ? capgoCheck : mobileCheck;
          const response = await handler({
            request: new Request(requestUrl, { method: 'POST', body: Buffer.concat(chunks) }),
            // The former runtime source really is offline, not a mocked success.
            env: { YURI_OTA_UPSTREAM_ORIGIN: 'http://127.0.0.1:1' },
          });
          res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
          return;
        }
        const bytes = await readFile(path.join(out, new URL(requestUrl).pathname));
        if (req.headers.range) {
          const end = Number(req.headers.range.match(/-(\d+)/)[1]);
          res.writeHead(206, { 'content-range': `bytes 0-${end}/${bytes.length}` }).end(bytes.subarray(0, end + 1));
        } else res.writeHead(200).end(bytes);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise((resolve) => edgeServer.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${edgeServer.address().port}`;
    const device = { applicationId: 'com.yee94.yuri', channel: 'beta', platform: 'ios', deviceId: 'ci',
      nativeVersion: '1.2.0', nativeBuild: 1, shellApiVersion: 2, currentBundleId: '1.2.0' };
    const result = await fetch(`${baseUrl}/v1/mobile/update/check`, {
      method: 'POST', body: JSON.stringify(device),
    });
    const decision = await result.json();
    assert.equal(decision.primaryAction, 'apply_ota');
    assert.match(decision.releaseNotes, /Beta fix/);
    assert.ok(decision.ota.bundle.url.startsWith(`${baseUrl}/ota/bundles/`));
    for (const platform of ['android', 'desktop']) {
      const check = await fetch(`${baseUrl}/v1/mobile/update/check`, {
        method: 'POST', body: JSON.stringify({ ...device, platform,
          applicationId: platform === 'desktop' ? 'dev.yuri.desktop' : device.applicationId }),
      });
      const body = await check.json();
      assert.equal(body.primaryAction, 'apply_ota');
      assert.match(body.releaseNotes, /Beta fix/);
      assert.ok(body.ota.bundle.url.startsWith(`${baseUrl}/ota/bundles/`));
      const downloaded = Buffer.from(await (await fetch(body.ota.bundle.url)).arrayBuffer());
      assert.deepEqual(downloaded, assets.get(new URL(body.ota.bundle.url).pathname));
    }
    const capgo = await fetch(`${baseUrl}/v1/ota/check`, {
      method: 'POST', body: JSON.stringify({ ...device, app_id: device.applicationId }),
    });
    assert.equal((await capgo.json()).url, decision.ota.bundle.url);
    await verifyOtaDistribution({ baseUrl, snapshotDirectory: out, requireLocal: true });
    await exec(process.execPath, ['scripts/mobile-ota/verify-distribution.mjs', '--snapshot', out,
      '--base', baseUrl, '--require-local'], { cwd: path.resolve(projectRoot, '../..'), timeout: 10_000 });
    assert.equal(originRequests, requestsAtActivation);
  } finally {
    if (edgeServer) await new Promise((resolve) => edgeServer.close(resolve));
    if (!closed) await new Promise((resolve) => server.close(resolve));
    await rm(out, { recursive: true, force: true });
  }
});
