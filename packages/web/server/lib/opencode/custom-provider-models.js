import { customProviderProtocols } from '../../../shared/custom-provider-protocol.js';

const fail = () => Object.assign(new Error('Unable to discover provider models'), { status: 502 });
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Draft discovery has no persistence and never returns upstream bodies or credentials. */
export async function discoverCustomProviderModels(input, { signal, fetchImpl = fetch } = {}) {
  if (!input || !customProviderProtocols.some((protocol) => protocol.package === input.package)
    || typeof input.baseURL !== 'string' || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw fail();
  let base;
  try {
    base = new URL(input.baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || input.baseURL.includes('\\')) throw fail();
  } catch { throw fail(); }
  const google = input.package === '@opencode/ai/providers/google';
  const anthropic = input.package === '@opencode/ai/providers/anthropic-compatible';
  const headers = { Accept: 'application/json' };
  const key = input.apiKey?.trim();
  if (google && key) headers['x-goog-api-key'] = key;
  else if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) headers.Authorization = `Bearer ${key}`;
  const deadline = AbortSignal.timeout(15000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const models = new Map();
  const cursors = new Set();
  let cursor;
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${input.baseURL.replace(/\/+$/, '')}/models`);
      if (google) { url.searchParams.set('pageSize', '1000'); if (cursor) url.searchParams.set('pageToken', cursor); }
      if (anthropic) { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor); }
      const response = await fetchImpl(url, { headers, signal: abort, redirect: 'error', cache: 'no-store' });
      if (!response.ok) { await response.body?.cancel(); throw fail(); }
      const reader = response.body?.getReader();
      if (!reader) throw fail();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw fail();
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const entries = google ? payload.models : payload.data;
      if (!Array.isArray(entries)) throw fail();
      for (const item of entries) {
        if (!item || typeof item !== 'object') continue;
        if (google && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent')) continue;
        const id = google && typeof item.name === 'string' ? item.name.replace(/^models\//, '') : item.id;
        if (typeof id !== 'string' || !id.trim() || /[\s#]/.test(id)) continue;
        const name = item.displayName || item.display_name || item.name;
        models.set(id, { id, name: typeof name === 'string' ? name : id,
          ...(positive(item.inputTokenLimit) ? { context: item.inputTokenLimit } : {}),
          ...(positive(item.outputTokenLimit) ? { output: item.outputTokenLimit } : {}) });
        if (models.size > 5000) throw fail();
      }
      cursor = google ? payload.nextPageToken : anthropic && payload.has_more ? payload.last_id : undefined;
      if (anthropic && payload.has_more && !cursor) throw fail();
      if (!cursor) return { models: [...models.values()] };
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw fail();
      cursors.add(cursor);
    }
    throw fail();
  } catch { throw fail(); }
}
