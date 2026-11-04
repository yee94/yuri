import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createAssetZip } from '../../../packages/web/server/lib/zip-assets.js';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { selectOtaMajor } from '../lib/ota-manifest.js';
import { handleMobileUpdateCheck } from '../lib/ota-check.js';
import { promoteStableToBeta } from '../../../scripts/mobile-ota/channel-promotion.mjs';
import { parse as parseYaml } from 'yaml';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('every OTA publication requires complete local EdgeOne downloads, including same-version distribution repair', async () => {
  for (const [name, job] of [['release.yml', 'mobile-native-targets'], ['mobile-beta-ota.yml', 'deploy'], ['mobile-beta-rollout.yml', 'rollout']]) {
    const workflow = parseYaml(await readFile(path.join(root, '.github/workflows', name), 'utf8'));
    const steps = workflow.jobs[job].steps;
    const triggerIndex = steps.findIndex((step) => step.run?.includes('commit-edgeone-manifests.sh'));
    const verifyIndex = steps.findIndex((step) => step.run?.includes('verify-distribution.mjs'));
    assert.ok(triggerIndex >= 0 && verifyIndex > triggerIndex, `${name} must wait for complete EdgeOne distribution`);
    const verify = steps[verifyIndex].run;
    assert.match(verify, /--base "\$OTA_BASE_URL"/);
    assert.match(verify, /--base "\$OTA_MIRROR_URL" --require-local/);
    if (name === 'mobile-beta-rollout.yml') {
      assert.ok(workflow.on.workflow_dispatch.inputs.action.options.includes('refresh-distribution'));
      assert.match(steps[triggerIndex].env.EDGEONE_FORCE_DEPLOY, /refresh-distribution/);
      assert.ok(steps.some((step) => /--action snapshot --channel "\$CHANNEL"/.test(step.run ?? '')));
    }
  }
});

test('service changes automatically refresh both origins without publishing a new App or recursively deploying manifests', async () => {
  const workflow = parseYaml(await readFile(path.join(root, '.github/workflows/update-service.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(workflow.on.push.paths.includes('deploy/update-service/**'));
  assert.ok(workflow.on.push.paths.includes('!deploy/update-service/ota/channels/**'));
  assert.ok(workflow.on.push.paths.includes('!deploy/update-service/release-manifest.json'));
  assert.equal(workflow.jobs.deploy.needs, 'verify');
  assert.equal(workflow.jobs.deploy.uses, './.github/workflows/mobile-beta-rollout.yml');
  assert.equal(workflow.jobs.deploy.with.action, 'refresh-distribution');
  assert.equal(workflow.jobs.deploy.with.verify_current_code, true);
  const rollout = parseYaml(await readFile(path.join(root, '.github/workflows/mobile-beta-rollout.yml'), 'utf8'));
  assert.equal(rollout.on.workflow_call.inputs.action.type, 'string');
  assert.equal(rollout.concurrency.group, 'mobile-ota-production');
  assert.equal(rollout.concurrency['cancel-in-progress'], false);
});

test('stable release service deployment preserves live OTA before replacing static output', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const finalize = workflow.slice(workflow.indexOf('\n  finalize-release:'));
  assert.match(finalize, /concurrency:\s+group: mobile-ota-production\s+cancel-in-progress: false/);
  const deploy = finalize.slice(finalize.indexOf('      - name: Deploy update service to Vercel'));
  assert.match(deploy, /node scripts\/mobile-ota\/rollout\.mjs --action snapshot --out/);
  assert.match(deploy, /cp -R "\$SNAPSHOT_DIR\/ota\/\." "\$STATIC_DIR\/ota\/"/);
  assert.ok(deploy.indexOf('--action snapshot') < deploy.indexOf('deploy --prebuilt --prod'));
  const ota = workflow.slice(workflow.indexOf('  mobile-native-targets:'), workflow.indexOf('  publish-relay-docker-manual:'));
  assert.match(ota, /git show FETCH_HEAD:deploy\/update-service\/release-manifest\.json > deploy\/update-service\/release-manifest\.json/);
});

test('stable release installs pinned Bun before Vercel bundles Node functions', async () => {
  const workflow = parseYaml(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  const steps = workflow.jobs['finalize-release'].steps;
  const deployIndex = steps.findIndex(step => step.name === 'Deploy update service to Vercel');
  const bunIndex = steps.findIndex(step => step.uses?.startsWith('oven-sh/setup-bun@'));
  assert.ok(bunIndex >= 0 && bunIndex < deployIndex, 'Vercel function bundling requires Bun on PATH');
  assert.equal(steps[bunIndex].with['bun-version'], '1.3.14');
});

test('publishing and rollout retain both majors, channels and referenced bundles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ota-major-'));
  const channels = new Map();
  const bundles = new Map();
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/mobile/update/check') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await handleMobileUpdateCheck(new Request(`http://${req.headers.host}${req.url}`, {
          method: 'POST', body: Buffer.concat(chunks),
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    const channel = req.url.match(/^\/ota\/channels\/(beta|stable)\.json$/)?.[1];
    const bundle = req.url.match(/^\/ota\/bundles\/([a-f0-9]+)\.zip$/)?.[1];
    const data = channel ? channels.get(channel) : bundles.get(bundle);
    res.statusCode = data ? 200 : 404;
    res.end(data ?? 'missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, OTA_BASE_URL: `http://127.0.0.1:${server.address().port}`, MIN_SHELL_RELEASE_VERSION: '' };
  let sequence = 0;
  const publish = async (version, channel = 'beta', { metadata = {}, otaOnly = false } = {}) => {
    const zip = path.join(dir, `input-${++sequence}.zip`);
    const bytes = Buffer.from(`bundle ${version}`);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await writeFile(zip, bytes);
    const desktopDir = path.join(dir, `desktop-${sequence}`);
    await mkdir(desktopDir);
    await writeFile(path.join(desktopDir, 'desktop-ota.json'), JSON.stringify({
      applicationId: 'dev.yuri.desktop', shellApiVersion: 2,
      releaseVersion: version, shellFingerprint: 'a'.repeat(64), ...metadata,
    }));
    await writeFile(path.join(desktopDir, 'index.html'), '<html>Desktop</html>');
    const desktopZip = `${desktopDir}.zip`;
    createAssetZip(desktopDir, desktopZip);
    const out = path.join(dir, `snapshot-${sequence}`);
    await exec(process.execPath, ['scripts/mobile-ota/assemble-snapshot.mjs', '--zip', zip,
      '--desktop-zip', desktopZip, '--version', version, '--channel', channel, '--checksum', checksum, '--out', out,
      ...(otaOnly ? ['--desktop-ota-only'] : [])], { cwd: root, env });
    for (const name of ['beta', 'stable']) {
      channels.set(name, await readFile(path.join(out, 'ota/channels', `${name}.json`)));
    }
    bundles.set(checksum.slice(0, 16), bytes);
    const desktopBytes = await readFile(desktopZip);
    bundles.set(createHash('sha256').update(desktopBytes).digest('hex').slice(0, 16), desktopBytes);
    for (const [id, contents] of bundles) {
      assert.deepEqual(await readFile(path.join(out, 'ota/bundles', `${id}.zip`)), contents);
    }
    return JSON.parse(channels.get(channel));
  };
  try {
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'snapshot',
      '--out', path.join(dir, 'empty-service-refresh')], { cwd: root, env });
    await publish('1.19.0', 'stable');
    assert.equal(JSON.parse(channels.get('beta')).activeBundle.releaseVersion, '1.19.0');
    const originalChannels = new Map(channels);
    for (const [name, contents] of channels) {
      const legacy = JSON.parse(contents);
      delete legacy.activeBundle.desktop.applicationId;
      delete legacy.activeBundle.desktop.minShellApiVersion;
      channels.set(name, JSON.stringify(legacy));
    }
    await assert.rejects(() => publish('1.20.0-beta.1', 'beta', { otaOnly: true }), /shell\/backend changed/);
    for (const [name, contents] of originalChannels) channels.set(name, contents);
    for (const metadata of [{ applicationId: undefined }, { applicationId: 'com.yee94.yuri' },
      { applicationId: 'dev.yuri.desktop.preview' }, { shellApiVersion: undefined }, { shellApiVersion: 1 }]) {
      await assert.rejects(() => publish('1.20.0-beta.1', 'beta', { metadata }), /dev.yuri.desktop native identity and shellApiVersion 2/);
    }
    await assert.rejects(() => publish('1.20.0-beta.1', 'beta', {
      metadata: { shellFingerprint: 'b'.repeat(64) }, otaOnly: true,
    }), /shell\/backend changed/);
    const one = await publish('1.20.0-beta.1');
    assert.equal(one.activeBundle.applicationId, 'com.yee94.yuri');
    assert.equal(one.activeBundle.minShellApiVersion, 3);
    assert.equal(one.activeBundle.desktop.applicationId, 'dev.yuri.desktop');
    assert.equal(one.activeBundle.desktop.minShellApiVersion, 2);
    const two = await publish('2.0.0-beta.24');
    assert.deepEqual(selectOtaMajor(two, 1), one);
    const oneAgain = await publish('1.20.0-beta.2');
    assert.equal(oneAgain.activeBundle.releaseVersion, '1.20.0-beta.2');
    assert.deepEqual(selectOtaMajor(oneAgain, 2), selectOtaMajor(two, 2));
    assert.equal(oneAgain.rollbackBundleIds[0], one.activeBundle.bundleId);
    await exec(process.execPath, ['scripts/mobile-ota/verify-detectability.mjs',
      '--channel', 'beta', '--version', '2.0.0-beta.24', '--base', env.OTA_BASE_URL], { cwd: root, env, timeout: 10_000 });
    const out = path.join(dir, 'paused');
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'pause', '--major', '2', '--out', out], { cwd: root, env });
    const paused = JSON.parse(await readFile(path.join(out, 'ota/channels/beta.json'), 'utf8'));
    assert.equal(selectOtaMajor(paused, 2).activeBundle.rolloutPercent, 0);
    assert.deepEqual(selectOtaMajor(paused, 1), selectOtaMajor(oneAgain, 1));
    for (const id of bundles.keys()) await readFile(path.join(out, 'ota/bundles', `${id}.zip`));
    const snapshotOut = path.join(dir, 'service-refresh');
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'snapshot', '--out', snapshotOut], { cwd: root, env });
    for (const [channel, contents] of channels) {
      assert.deepEqual(JSON.parse(await readFile(path.join(snapshotOut, 'ota/channels', `${channel}.json`), 'utf8')), JSON.parse(contents));
    }
    for (const [id, contents] of bundles) {
      assert.deepEqual(await readFile(path.join(snapshotOut, 'ota/bundles', `${id}.zip`)), contents);
    }
    const missingDesktop = one.activeBundle.desktop.bundleId;
    const missingDesktopBytes = bundles.get(missingDesktop);
    bundles.delete(missingDesktop);
    await assert.rejects(() => exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'snapshot',
      '--out', path.join(dir, 'missing-bundle')], { cwd: root, env }), /Failed to download bundle.*HTTP 404/);
    bundles.set(missingDesktop, missingDesktopBytes);
    const rollbackOut = path.join(dir, 'rollback');
    await exec(process.execPath, ['scripts/mobile-ota/rollout.mjs', '--action', 'rollback', '--major', '1', '--out', rollbackOut], { cwd: root, env });
    const rolledBack = selectOtaMajor(JSON.parse(await readFile(path.join(rollbackOut, 'ota/channels/beta.json'), 'utf8')), 1);
    assert.equal(rolledBack.activeBundle.releaseVersion, one.activeBundle.releaseVersion);
    assert.deepEqual(rolledBack.activeBundle.desktop, one.activeBundle.desktop);
    assert.equal(rolledBack.activeBundle.checksum, one.activeBundle.checksum);
    for (const id of bundles.keys()) await readFile(path.join(rollbackOut, 'ota/bundles', `${id}.zip`));
    const stable = await publish('1.20.0', 'stable');
    const promoted = JSON.parse(channels.get('beta'));
    assert.equal(promoted.channel, 'beta');
    assert.deepEqual(promoted.activeBundle, stable.activeBundle);
    assert.equal(promoted.generation, oneAgain.generation + 1);
    assert.deepEqual(promoted.rollbackBundleIds, [oneAgain.activeBundle.bundleId, one.activeBundle.bundleId]);
    assert.deepEqual(promoted.rollbackBundles[oneAgain.activeBundle.bundleId], oneAgain.activeBundle);
    assert.deepEqual(selectOtaMajor(promoted, 2), selectOtaMajor(two, 2));
    for (const channel of ['beta', 'stable']) {
      await exec(process.execPath, ['scripts/mobile-ota/verify-detectability.mjs',
        '--channel', channel, '--version', '1.20.0', '--base', env.OTA_BASE_URL], { cwd: root, env, timeout: 10_000 });
    }
    const nativeTargets = { android: { version: '1.20.0', build: 30, installUrl: 'https://example.com/download' } };
    const finalized = promoteStableToBeta({ ...stable, nativeTargets }, promoted);
    assert.deepEqual(finalized.nativeTargets, nativeTargets);
    assert.equal(finalized.generation, promoted.generation);
    assert.deepEqual(finalized.rollbackBundles, promoted.rollbackBundles);
    const newerBeta = structuredClone(promoted);
    newerBeta.activeBundle.releaseVersion = '1.21.0-beta.1';
    assert.deepEqual(promoteStableToBeta(stable, newerBeta), newerBeta);
    assert.throws(() => promoteStableToBeta(one, promoted), /active stable release/);
    await assert.rejects(() => publish('1.19.0-beta.1'), /older than active/);
    const corrupt = JSON.parse(channels.get('beta'));
    corrupt.majorReleases['2'].activeBundle.releaseVersion = '3.0.0';
    channels.set('beta', JSON.stringify(corrupt));
    await assert.rejects(() => publish('1.20.1-beta.1'), /manifest invalid/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
