import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizePluginIcon } from './plugin-icon.js';

export { sanitizePluginIcon } from './plugin-icon.js';

const NPM_CACHE_TTL_MS = 3_600_000;
const NPM_FETCH_TIMEOUT_MS = 5_000;
const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * @typedef {Object} NpmPackagePayload
 * @property {true} ok
 * @property {string|null} latest
 * @property {string[]} versions
 * @property {Record<string, string>} distTags
 * @property {string} [icon] sanitized top-level package.json `icon` of the latest release
 *
 * @typedef {Object} NpmLookupError
 * @property {false} ok
 * @property {number|'network'} status
 * @property {string} error
 *
 * @typedef {NpmPackagePayload | NpmLookupError} NpmLookupResult
 * @typedef {{ forceRefresh?: boolean }} NpmInfoOptions
 * @typedef {{ fetchedAt: number, payload: NpmLookupResult }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/** @type {Map<string, Promise<NpmLookupResult>>} */
const _inFlight = new Map();

/** @type {string | null} */
let _userAgent = null;

function _getPackageJsonPath() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'package.json');
}

function _getUserAgent() {
  if (_userAgent) return _userAgent;

  try {
    const pkg = JSON.parse(fs.readFileSync(_getPackageJsonPath(), 'utf8'));
    _userAgent = `yuri-server/${typeof pkg.version === 'string' ? pkg.version : '0.0.0'}`;
  } catch {
    _userAgent = 'yuri-server/dev';
  }

  return _userAgent;
}

function encodeName(name) {
  return encodeURIComponent(name).replace(/^%40/, '@');
}

function parseDistTags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[1] === 'string'),
  );
}

function parseVersions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value);
}

function cacheResult(name, payload) {
  if (payload.ok || payload.status === 404) {
    _cache.set(name, { fetchedAt: Date.now(), payload });
  }
}

const VALID_NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_CLI_TIMEOUT_MS = 15_000;

/**
 * Ask the user's own npm CLI. It resolves `.npmrc` (per-scope `@scope:registry`,
 * auth tokens, mirrors, proxies) exactly as `npm install` would, which a bare
 * request to registry.npmjs.org cannot do for private or mirrored scopes.
 *
 * Resolves to `null` when the CLI is unavailable or fails for a reason other than
 * the package being absent, so the caller can fall back to a direct request.
 *
 * @param {string} name npm package name
 * @param {string | undefined} cwd directory whose `.npmrc` applies
 * @returns {Promise<NpmLookupResult | null>}
 */
function lookupViaNpmCli(name, cwd) {
  if (!VALID_NPM_NAME.test(name)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', name, 'dist-tags', 'versions', 'icon', '--json'],
      {
        cwd: cwd || undefined,
        timeout: NPM_CLI_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === 'win32',
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = `${stdout}\n${stderr}`;
          if (/\bE404\b|404 Not Found/i.test(output)) {
            resolve({ ok: false, status: 404, error: 'Package not found' });
            return;
          }
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const distTags = parseDistTags(data?.['dist-tags']);
          const versions = Array.isArray(data?.versions)
            ? data.versions.filter((version) => typeof version === 'string')
            : typeof data?.versions === 'string' ? [data.versions] : [];
          const icon = sanitizePluginIcon(data?.icon);
          resolve({ ok: true, latest: distTags.latest ?? null, versions, distTags, ...(icon ? { icon } : {}) });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Seam so tests can isolate the direct-request path from the developer's npm. */
export const npmCli = { lookup: lookupViaNpmCli };

/**
 * Fetch package metadata: the npm CLI first (honours scope registries and auth),
 * then a direct request to the public registry when the CLI cannot answer.
 *
 * @param {string} name npm package name
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<NpmLookupResult>}
 */
export async function lookupNpmPackage(name, options = {}) {
  const viaCli = await npmCli.lookup(name, options.cwd);
  if (viaCli) return viaCli;
  return lookupNpmPackageOverHttp(name);
}

/**
 * Fetch package metadata directly from the public npm registry.
 *
 * @param {string} name npm package name
 * @returns {Promise<NpmLookupResult>}
 */
async function lookupNpmPackageOverHttp(name) {
  try {
    const response = await fetch(`${NPM_REGISTRY_BASE}/${encodeName(name)}`, {
      headers: {
        'User-Agent': _getUserAgent(),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      const data = await response.json();
      const distTags = parseDistTags(data?.['dist-tags']);
      const latest = distTags.latest ?? null;
      const icon = sanitizePluginIcon(latest ? data?.versions?.[latest]?.icon : undefined);
      return {
        ok: true,
        latest,
        versions: parseVersions(data?.versions),
        distTags,
        ...(icon ? { icon } : {}),
      };
    }

    if (response.status === 404) {
      return { ok: false, status: 404, error: 'Package not found' };
    }

    return { ok: false, status: response.status, error: `Registry returned ${response.status}` };
  } catch (error) {
    return { ok: false, status: 'network', error: String(error?.message ?? error) };
  }
}

/**
 * Fetch package metadata with TTL cache and in-flight request deduplication.
 *
 * @param {string} name npm package name
 * @param {NpmInfoOptions} [options]
 * @returns {Promise<NpmLookupResult>}
 */
export async function getNpmInfo(name, options = {}) {
  const { forceRefresh = false, cwd } = options;
  // The cwd selects which `.npmrc` applies, so it is part of the cache identity.
  const cacheKey = cwd ? `${cwd}\0${name}` : name;
  const cached = _cache.get(cacheKey);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < NPM_CACHE_TTL_MS) {
    return cached.payload;
  }

  const existing = _inFlight.get(cacheKey);
  if (existing && !forceRefresh) {
    return existing;
  }

  const lookup = (async () => {
    const result = await lookupNpmPackage(name, { cwd });
    cacheResult(cacheKey, result);
    return result;
  })();

  _inFlight.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    if (_inFlight.get(cacheKey) === lookup) {
      _inFlight.delete(cacheKey);
    }
  }
}

export function clearCache() {
  _cache.clear();
  _inFlight.clear();
}
