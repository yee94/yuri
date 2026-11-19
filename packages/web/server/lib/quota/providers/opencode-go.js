import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readOpenCodeGoCredential } from '../opencode-go-credentials.js';
import { buildResult, getAuthEntry, normalizeAuthEntry, toUsageWindow } from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go'];

const patterns = {
  '5h': 'rollingUsage',
  weekly: 'weeklyUsage',
  monthly: 'monthlyUsage',
};

const captureNumber = (name, body) => {
  const match = body.match(new RegExp(`["']?${name}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) ? value : null;
};

export const parseOpenCodeGoUsage = (html, now = Date.now()) => {
  if (typeof html !== 'string') return {};
  const normalized = html.replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('\\u0022', '"').replaceAll('\\"', '"');
  const windows = {};
  for (const [key, field] of Object.entries(patterns)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = normalized.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, 's'));
    if (!match) continue;
    const usedPercent = captureNumber('usagePercent', match[1]);
    const resetInSec = captureNumber('resetInSec', match[1]);
    if (usedPercent === null || resetInSec === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetAt: now + Math.max(0, resetInSec) * 1000,
      windowSeconds: null,
    });
  }
  return windows;
};

export const fetchOpenCodeGoUsage = async (credential, fetchImpl = fetch) => {
  const response = await fetchImpl(`https://opencode.ai/workspace/${encodeURIComponent(credential.workspaceId)}/go`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: `auth=${credential.authCookie}`,
      'User-Agent': 'Yuri quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go dashboard returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const keyWindows = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
};

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Go's gateway answers a request that names no session with 400, so a stateless
// usage read carries a fresh OpenCode-shaped session id.
export const createOpenCodeSessionId = (now = Date.now()) => {
  const stamp = (~(BigInt(now) * 0x1000n)) & 0xffffffffffffn;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `ses_${stamp.toString(16).padStart(12, '0')}${random}`;
};

export const parseOpenCodeGoKeyUsage = (payload) => {
  const usage = payload && typeof payload === 'object' ? payload.usage : null;
  const windows = {};
  if (!usage || typeof usage !== 'object') return windows;
  for (const [key, field] of Object.entries(keyWindows)) {
    const entry = usage[field];
    const percent = typeof entry?.percent === 'number' && Number.isFinite(entry.percent) ? entry.percent : null;
    if (percent === null) continue;
    // A window at 0% reports now plus its length as resetsAt, a time nothing happens at.
    const resetAt = percent > 0 ? Date.parse(entry.resetsAt) : Number.NaN;
    windows[key] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      windowSeconds: null,
    });
  }
  return windows;
};

export const fetchOpenCodeGoKeyUsage = async (apiKey, fetchImpl = fetch) => {
  const sessionId = createOpenCodeSessionId();
  const response = await fetchImpl('https://opencode.ai/zen/go/v1/usage', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': sessionId,
      'x-opencode-session-id': sessionId,
      'User-Agent': 'Yuri quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('OpenCode Go did not accept this API key');
  if (response.status === 403) {
    throw new Error('This API key has no OpenCode Go subscription; Go belongs to the member who subscribed, so use a key that member created in that workspace');
  }
  if (!response.ok) throw new Error(`OpenCode Go usage returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoKeyUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const readApiKey = async () => {
  const entry = normalizeAuthEntry(getAuthEntry(await readOpenCodeCredentials(), aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = async () => Boolean(readOpenCodeGoCredential()) || Boolean(await readApiKey());

export const fetchQuota = async () => {
  const credential = readOpenCodeGoCredential();
  let apiKey = null;
  try {
    apiKey = await readApiKey();
  } catch (error) {
    if (!credential) throw error;
  }
  if (!apiKey && !credential) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });

  let failure = null;
  if (apiKey) {
    try {
      return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: await fetchOpenCodeGoKeyUsage(apiKey) } });
    } catch (error) {
      failure = error;
    }
  }
  if (credential) {
    try {
      return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: await fetchOpenCodeGoUsage(credential) } });
    } catch (error) {
      failure = error;
    }
  }
  return buildResult({ providerId, providerName, ok: false, configured: true, error: failure instanceof Error ? failure.message : 'Request failed' });
};
