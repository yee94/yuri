const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export function releaseParts(version) {
  const match = typeof version === 'string' && version.match(VERSION);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : null;
}

export function compareVersions(a, b) {
  const left = releaseParts(a);
  const right = releaseParts(b);
  if (!left || !right) throw new Error('Invalid release version');
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

const releaseBase = () => process.env.YURI_RELEASE_BASE_URL || 'https://github.com/yee94/yuri/releases';

/** Self-contained Linux archives are published beside the npm package under the same tag. */
export async function fetchPortableChecksum(version, arch = process.arch, fetchImpl = fetch) {
  const base = releaseBase();
  if (!base.startsWith('https://')) throw new Error('Release downloads require HTTPS');
  const name = `yuri-${version}-linux-${arch}.tar.gz`;
  const response = await fetchImpl(`${base}/download/v${version}/${name}.sha256`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Unable to read the self-contained release checksum');
  const digest = (await response.text()).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid release checksum');
  return digest;
}

async function selectRegistryRelease(channel, currentVersion, fetchImpl) {
  const response = await fetchImpl('https://registry.npmjs.org/@yuriai/web', {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Unable to check the Yuri package registry');
  const registry = await response.json();
  const tags = registry['dist-tags'] ?? {};
  const candidates = (channel === 'beta' ? [tags.latest, tags.beta] : [tags.latest])
    .filter((v) => releaseParts(v) && (channel === 'beta' || !v.includes('-')))
    .sort(compareVersions);
  const version = candidates.at(-1);
  const metadata = registry.versions?.[version];
  if (!version || metadata?.version !== version || !metadata.dist?.integrity) throw new Error('No installable release in this channel');
  const rollback = channel === 'stable' && currentVersion.includes('-') && compareVersions(version, currentVersion) < 0;
  if (!rollback && compareVersions(version, currentVersion) <= 0) return null;
  return { version, metadata, rollback };
}

export async function discoverPortableRelease(channel, currentVersion, fetchImpl = fetch, arch = process.arch) {
  const selected = await selectRegistryRelease(channel, currentVersion, fetchImpl);
  if (!selected) return null;
  const integrity = await fetchPortableChecksum(selected.version, arch, fetchImpl);
  return releaseWithNotes(selected.version, selected.rollback, integrity, fetchImpl);
}

export async function discoverCliRelease(channel, currentVersion, fetchImpl = fetch) {
  const selected = await selectRegistryRelease(channel, currentVersion, fetchImpl);
  if (!selected) return null;
  return releaseWithNotes(selected.version, selected.rollback, selected.metadata.dist.integrity, fetchImpl);
}

async function releaseWithNotes(version, rollback, integrity, fetchImpl) {
  let releaseNotes = null;
  try {
    const notes = await fetchImpl(`https://api.github.com/repos/yee94/yuri/releases/tags/v${version}`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000),
    });
    if (notes.ok) {
      const body = (await notes.json()).body;
      releaseNotes = typeof body === 'string' ? body : null;
    }
  } catch { /* Release notes are optional; registry failure is not. */ }
  return { version, kind: 'cli-package', releaseNotes, rollback, integrity, restartRequired: true };
}
