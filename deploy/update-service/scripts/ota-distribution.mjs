import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseOtaManifest } from '../lib/ota-manifest.js';

const CHANNELS = ['beta', 'stable'];
const MAX_BUNDLE_BYTES = 25_165_824;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MARKER_PATH = '/ota-distribution.json';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function serviceSourceHash() {
  const files = ['edgeone.json', 'vercel.json', 'package.json'];
  const visit = async (directory) => {
    for (const entry of await readdir(path.join(PROJECT_ROOT, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  for (const directory of ['api', 'edge-functions', 'lib', 'scripts']) await visit(directory);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(PROJECT_ROOT, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function originUrl(value) {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('OTA distribution requires an HTTPS origin without credentials or a path');
  }
  return url.origin;
}

async function download(base, filePath, { fetchImpl = fetch, onChunk, maxBytes, requireLocal = false }) {
  const started = Date.now();
  const response = await fetchImpl(new URL(filePath, base), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`OTA distribution ${filePath}: HTTP ${response.status}`);
  }
  if (requireLocal && response.headers.has('x-ota-proxy')) {
    await response.body.cancel();
    throw new Error(`OTA distribution ${filePath} still uses the upstream proxy`);
  }
  const hash = createHash('sha256');
  let size = 0;
  const inspect = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new Error(`OTA distribution ${filePath} exceeds ${maxBytes} bytes`));
      hash.update(chunk);
      onChunk?.(chunk);
      done(null, chunk);
    },
  });
  return {
    response,
    async consume(destination) {
      await pipeline(Readable.fromWeb(response.body), inspect,
        destination ?? new Writable({ write(_chunk, _encoding, done) { done(); } }));
      return { path: filePath, size, sha256: hash.digest('hex'), elapsedMs: Date.now() - started };
    },
  };
}

async function metadata(base, filePath, options = {}) {
  const chunks = [];
  const transfer = await download(base, filePath, {
    ...options, maxBytes: MAX_METADATA_BYTES, onChunk: (chunk) => chunks.push(chunk),
  });
  const digest = await transfer.consume();
  return { text: Buffer.concat(chunks).toString('utf8'), digest };
}

function channelManifest(text, channel) {
  const raw = JSON.parse(text);
  const parsed = parseOtaManifest(raw);
  if (!parsed.ok || parsed.manifest.channel !== channel) {
    throw new Error(`Invalid ${channel} OTA distribution manifest: ${parsed.errors?.join('; ') ?? 'channel mismatch'}`);
  }
  return parsed.manifest;
}

function artifacts(manifests) {
  const files = new Map();
  const add = (bundle) => {
    const filePath = `/ota/bundles/${bundle.bundleId}.zip`;
    if (bundle.url !== undefined && bundle.url !== filePath) throw new Error(`Noncanonical OTA bundle path: ${bundle.bundleId}`);
    const existing = files.get(filePath) ?? {};
    const checksum = bundle.sessionKey ? undefined : bundle.checksum;
    if ((existing.size && bundle.size && existing.size !== bundle.size)
      || (existing.checksum && checksum && existing.checksum !== checksum)) {
      throw new Error(`Conflicting OTA artifact metadata: ${bundle.bundleId}`);
    }
    files.set(filePath, { ...existing, bundleId: bundle.bundleId,
      ...(bundle.size ? { size: bundle.size } : {}), ...(checksum ? { checksum } : {}) });
  };
  const visit = (manifest) => {
    for (const lane of Object.values(manifest.majorReleases ?? {})) visit(lane);
    for (const bundle of [manifest.activeBundle, ...Object.values(manifest.rollbackBundles ?? {})]) {
      if (!bundle) continue;
      add(bundle);
      if (bundle.desktop) add(bundle.desktop);
    }
    for (const bundleId of manifest.rollbackBundleIds) add({ bundleId });
  };
  for (const manifest of manifests) visit(manifest);
  return files;
}

function assertArtifact(digest, expected) {
  if (!digest.sha256.startsWith(expected.bundleId)
    || (expected.size !== undefined && digest.size !== expected.size)
    || (expected.checksum !== undefined && digest.sha256 !== expected.checksum)) {
    throw new Error(`OTA artifact integrity mismatch: ${digest.path}`);
  }
}

async function bounded(items, visit) {
  let next = 0;
  // At most three streaming transfers, regardless of catalog/rollback size.
  const results = await Promise.allSettled(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (next < items.length) await visit(items[next++]);
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function record(digest) {
  return { path: digest.path, size: digest.size, sha256: digest.sha256 };
}

/** Materialize a complete, verified snapshot BEFORE EdgeOne activates this deployment. */
export async function mirrorOtaDistribution({ outputDirectory, upstreamOrigin, fetchImpl = fetch }) {
  const base = originUrl(upstreamOrigin);
  const channels = await Promise.all(CHANNELS.map(async (channel) => {
    const filePath = `/ota/channels/${channel}.json`;
    const asset = await metadata(base, filePath, { fetchImpl });
    return { ...asset, manifest: channelManifest(asset.text, channel) };
  }));
  const files = [];
  for (const channel of channels) {
    const dest = path.join(outputDirectory, channel.digest.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, channel.text);
    files.push(record(channel.digest));
  }
  await mkdir(path.join(outputDirectory, 'ota/bundles'), { recursive: true });
  await bounded([...artifacts(channels.map((item) => item.manifest))], async ([filePath, expected]) => {
    const transfer = await download(base, filePath, { fetchImpl, maxBytes: MAX_BUNDLE_BYTES });
    const digest = await transfer.consume(createWriteStream(path.join(outputDirectory, filePath)));
    assertArtifact(digest, expected);
    files.push(record(digest));
  });
  const changelog = await metadata(base, '/CHANGELOG.md', { fetchImpl });
  if (!changelog.text.trim()) throw new Error('OTA distribution CHANGELOG.md is empty');
  await writeFile(path.join(outputDirectory, 'CHANGELOG.md'), changelog.text);
  files.push(record(changelog.digest));

  // A concurrent origin publication must not produce a torn two-channel snapshot.
  for (const channel of channels) {
    const current = await metadata(base, channel.digest.path, { fetchImpl });
    if (current.digest.sha256 !== channel.digest.sha256) throw new Error('OTA manifests changed during EdgeOne build; retry the deployment');
  }
  const marker = { schemaVersion: 1, sourceSha256: await serviceSourceHash(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  await writeFile(path.join(outputDirectory, MARKER_PATH), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/** Verify actual full bodies and byte ranges, not merely a successful update check. */
export async function verifyOtaDistribution({ baseUrl, snapshotDirectory, requireLocal = false, requireCurrentCode = false, fetchImpl = fetch }) {
  if (requireCurrentCode && !requireLocal) throw new Error('Current-code verification requires a local EdgeOne distribution');
  const base = originUrl(baseUrl);
  const options = { fetchImpl, requireLocal };
  const manifests = [];
  const expectedDigests = new Map();
  for (const channel of CHANNELS) {
    const filePath = `/ota/channels/${channel}.json`;
    const expectedText = await readFile(path.join(snapshotDirectory, filePath), 'utf8');
    const expected = channelManifest(expectedText, channel);
    const actual = await metadata(base, filePath, options);
    if (JSON.stringify(channelManifest(actual.text, channel)) !== JSON.stringify(expected)) {
      throw new Error(`OTA distribution ${channel} manifest does not match the published snapshot`);
    }
    manifests.push(expected);
    expectedDigests.set(filePath, actual.digest);
  }
  let marker;
  if (requireLocal) {
    marker = JSON.parse((await metadata(base, MARKER_PATH, options)).text);
    if (marker.schemaVersion !== 1 || !Array.isArray(marker.files)) throw new Error('Missing complete EdgeOne OTA distribution marker');
    if (requireCurrentCode && marker.sourceSha256 !== await serviceSourceHash()) {
      throw new Error('EdgeOne is still serving a different update-service code revision');
    }
  }
  const timings = [];
  await bounded([...artifacts(manifests)], async ([filePath, expected]) => {
    const localHash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(snapshotDirectory, filePath))) localHash.update(chunk);
    const transfer = await download(base, filePath, { ...options, maxBytes: MAX_BUNDLE_BYTES });
    const digest = await transfer.consume();
    assertArtifact(digest, expected);
    if (digest.sha256 !== localHash.digest('hex')) throw new Error(`OTA distribution differs from snapshot: ${filePath}`);
    expectedDigests.set(filePath, digest);
    timings.push({ path: filePath, size: digest.size, elapsedMs: digest.elapsedMs });
    // A Range request must return exactly the requested prefix, not a full 200.
    const end = Math.min(digest.size - 1, 1023);
    const range = await fetchImpl(new URL(filePath, base), {
      headers: { Range: `bytes=0-${end}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (range.status !== 206 || range.headers.get('content-range') !== `bytes 0-${end}/${digest.size}`
      || (requireLocal && range.headers.has('x-ota-proxy'))) {
      await range.body?.cancel();
      throw new Error(`OTA distribution Range unsupported or proxied: ${filePath}`);
    }
    const rangeChunks = [];
    let rangeSize = 0;
    for await (const chunk of Readable.fromWeb(range.body)) {
      rangeSize += chunk.length;
      if (rangeSize > end + 1) throw new Error(`Oversized OTA Range body: ${filePath}`);
      rangeChunks.push(chunk);
    }
    const rangeBytes = Buffer.concat(rangeChunks);
    const local = createReadStream(path.join(snapshotDirectory, filePath), { start: 0, end });
    const chunks = [];
    for await (const chunk of local) chunks.push(chunk);
    if (!rangeBytes.equals(Buffer.concat(chunks))) throw new Error(`OTA distribution Range bytes mismatch: ${filePath}`);
  });
  const changelog = await metadata(base, '/CHANGELOG.md', options);
  if (!changelog.text.trim()) throw new Error('OTA distribution CHANGELOG.md is empty');
  expectedDigests.set('/CHANGELOG.md', changelog.digest);
  if (marker) {
    const expected = [...expectedDigests.values()].map(record).sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(marker.files) !== JSON.stringify(expected)) throw new Error('EdgeOne distribution marker does not match served files');
  }
  return timings.sort((a, b) => a.path.localeCompare(b.path));
}
