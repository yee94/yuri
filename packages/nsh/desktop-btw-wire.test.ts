import { expect, test } from 'vitest';
import { OpenCode } from '@opencode/client';

test('installed official model/Agent methods use SDK ModelRef id/variant, 204 and original AbortSignal', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [], controller = new AbortController();
  const client = OpenCode.make({ baseUrl: 'https://synthetic.invalid', fetch: async (url, init) => {
    requests.push({ url: String(url), init }); return new Response(null, { status: 204 });
  } });
  const model = { providerID: 'provider', id: 'model', variant: 'high' };
  await client.session.switchModel({ sessionID: 'session/a b', model }, { signal: controller.signal });
  await client.session.switchAgent({ sessionID: 'session/a b', agent: 'agent' }, { signal: controller.signal });
  expect(requests.map(row => row.url)).toEqual(['model', 'agent'].map(phase => `https://synthetic.invalid/api/session/session%2Fa%20b/${phase}`));
  expect(requests.map(row => JSON.parse(String(row.init?.body)))).toEqual([{ model }, { agent: 'agent' }]);
  for (const row of requests) { expect(row.init?.method).toBe('POST'); expect(row.init?.signal).toBe(controller.signal); }
});

test('installed official client generate wire: exact encoded route, prompt-only JSON, envelope and AbortSignal', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const controller = new AbortController();
  const client = OpenCode.make({ baseUrl: 'https://synthetic.invalid', fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { text: 'answer' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  expect(await client.session.generate({ sessionID: 'session/a b', prompt: 'question' }, { signal: controller.signal })).toEqual({ text: 'answer' });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://synthetic.invalid/api/session/session%2Fa%20b/generate');
  expect(requests[0].init?.method).toBe('POST');
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({ prompt: 'question' });
  expect(new Headers(requests[0].init?.headers).get('content-type')).toBe('application/json');
  expect(requests[0].init?.signal).toBe(controller.signal);
});

test('official client passes cancellation to its fetch, not a second session abort request', async () => {
  const controller = new AbortController(); let calls = 0, received: AbortSignal | null | undefined;
  const client = OpenCode.make({ baseUrl: 'https://synthetic.invalid', fetch: async (_url, init) => {
    calls++; received = init?.signal;
    return new Promise((_resolve, reject) => received?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  } });
  const flight = client.session.generate({ sessionID: 'session', prompt: 'question' }, { signal: controller.signal });
  controller.abort(); await expect(flight).rejects.toBeDefined();
  expect(received?.aborted).toBe(true); expect(calls).toBe(1);
});
