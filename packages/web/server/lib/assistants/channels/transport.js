export const channelError = (code, ambiguous = false) => Object.assign(new Error(code), { code, ambiguous });

export function officialURL(value, { protocol = 'https:', hosts, path } = {}) {
  let url;
  try { url = new URL(value); } catch { throw channelError('invalid_response'); }
  if (url.protocol !== protocol || !hosts.includes(url.hostname) || url.port || url.username || url.password
    || url.hash || (path && url.pathname !== path)) throw channelError('invalid_response');
  return url.href;
}

export async function requestJSON(url, { body, headers, signal, fetchImpl = fetch, sending = false } = {}) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  requestSignal.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch { throw channelError(signal?.aborted ? 'cancelled' : 'network_error', sending); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw channelError([401, 403].includes(response.status) ? 'auth_expired' : 'network_error', sending && response.status >= 500);
  }
  if (!response.body) throw channelError('invalid_response', sending);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw channelError('invalid_response', sending);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error?.code === 'invalid_response' ? error : channelError('invalid_response', sending);
  } finally { reader.releaseLock(); }
}
