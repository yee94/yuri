type OpenCodeGoCredential = { workspaceId: string; authCookie: string };

const toWindow = (usedPercent: number, resetInSec: number | null) => ({
  usedPercent: Math.min(100, Math.max(0, usedPercent)),
  remainingPercent: 100 - Math.min(100, Math.max(0, usedPercent)),
  windowSeconds: null,
  resetAfterSeconds: resetInSec === null ? null : Math.max(0, resetInSec),
  resetAt: resetInSec === null ? null : Date.now() + Math.max(0, resetInSec) * 1000,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const createSessionId = () => {
  const stamp = (~(BigInt(Date.now()) * 0x1000n)) & 0xffffffffffffn;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `ses_${stamp.toString(16).padStart(12, '0')}${random}`;
};

export const fetchOpenCodeGoKeyUsage = async (apiKey: string) => {
  const sessionId = createSessionId();
  const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'x-opencode-session': sessionId, 'x-opencode-session-id': sessionId },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('OpenCode Go did not accept this API key');
  if (response.status === 403) throw new Error('This API key has no OpenCode Go subscription; Go belongs to the member who subscribed, so use a key that member created in that workspace');
  if (!response.ok) throw new Error(`OpenCode Go usage returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => null) as { usage?: Record<string, { percent?: unknown; resetsAt?: unknown }> } | null;
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
  for (const [key, field] of Object.entries({ '5h': 'rolling', weekly: 'weekly', monthly: 'monthly' })) {
    const entry = payload?.usage?.[field];
    if (typeof entry?.percent !== 'number' || !Number.isFinite(entry.percent)) continue;
    const resetAt = entry.percent > 0 ? Date.parse(String(entry.resetsAt)) : Number.NaN;
    windows[key] = toWindow(entry.percent, Number.isFinite(resetAt) ? (resetAt - Date.now()) / 1000 : null);
  }
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const fetchOpenCodeGoUsage = async (credential: OpenCodeGoCredential) => {
  const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(credential.workspaceId)}/go`, { headers: { Accept: 'text/html', Cookie: `auth=${credential.authCookie}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new Error('OpenCode Go authentication failed');
  if (!response.ok) throw new Error(`OpenCode Go dashboard returned HTTP ${response.status}`);
  const html = (await response.text()).replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('\\u0022', '"').replaceAll('\\"', '"');
  const windows: Record<string, ReturnType<typeof toWindow>> = {};
  for (const [key, field] of Object.entries({ '5h': 'rollingUsage', weekly: 'weeklyUsage', monthly: 'monthlyUsage' })) {
    const body = html.match(new RegExp(`["']?${field}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, 's'))?.[1];
    if (!body) continue;
    const used = Number(body.match(/usagePercent\s*:\s*["']?(-?\d+(?:\.\d+)?)/)?.[1]);
    const reset = Number(body.match(/resetInSec\s*:\s*["']?(-?\d+(?:\.\d+)?)/)?.[1]);
    if (Number.isFinite(used) && Number.isFinite(reset)) windows[key] = toWindow(used, reset);
  }
  if (!Object.keys(windows).length) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};
