import { describe, expect, it, vi } from 'vitest';
import { resolveCustomProviderURL } from '../../../shared/custom-provider-protocol.js';
import { discoverCustomProviderModels } from './custom-provider-models.js';

const chat = '@opencode/ai/providers/openai-compatible';
const responses = `${chat}/responses`;
const anthropic = '@opencode/ai/providers/anthropic-compatible';
const google = '@opencode/ai/providers/google';
const listing = (pkg = chat) => ({ package: pkg, baseURL: 'https://api.example.com/v1', apiKey: 'fixture-key' });
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('Cherry-compatible URL completion with native OpenCode endpoints', () => {
  it.each([
    ['https://api.example.com', chat, 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/', chat, 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v2/', responses, 'https://api.example.com/v2/responses'],
    ['https://api.example.com/gateway#', chat, 'https://api.example.com/gateway/chat/completions'],
    ['https://api.example.com/custom/messages#', anthropic, 'https://api.example.com/custom/messages'],
    ['https://api.example.com/custom/responses#', responses, 'https://api.example.com/custom/responses'],
    ['https://api.example.com', anthropic, 'https://api.example.com/v1/messages'],
    ['https://api.example.com', google, 'https://api.example.com/v1beta/models/coder:streamGenerateContent?alt=sse'],
    ['https://api.example.com/v1beta/', google, 'https://api.example.com/v1beta/models/coder:streamGenerateContent?alt=sse'],
    ['https://api.example.com/v1/proxy', chat, 'https://api.example.com/v1/proxy/chat/completions'],
  ])('%s → %s uses exactly the displayed request path', (value, pkg, expected) => {
    const result = resolveCustomProviderURL(value, pkg, 'coder');
    expect(result?.requestURL).toBe(expected);
    expect(result?.modelsURL).toBe(`${result?.baseURL}/models`);
    expect(result?.baseURL).not.toContain('#');
  });
  it.each(['', 'wrong', 'file:///local', 'https://user:pass@example.com', 'https://api.example.com?key=hidden', 'https://api.example.com#fragment', 'https:\\example.com'])('rejects invalid/credential-bearing address %s', (value) => {
    expect(resolveCustomProviderURL(value, chat)).toBeNull();
  });
});

describe('draft model discovery', () => {
  it.each([chat, responses])('uses Bearer for %s and returns safe unique model IDs', async (pkg) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: 'coder', secret: 'never-return' }, { id: 'coder' }, { id: 'vendor/code', name: 'Code' }] }));
    expect(await discoverCustomProviderModels(listing(pkg), { fetchImpl })).toEqual({ models: [{ id: 'coder', name: 'coder' }, { id: 'vendor/code', name: 'Code' }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.toString()).toBe('https://api.example.com/v1/models');
    expect(options.headers.Authorization).toBe('Bearer fixture-key'); expect(options.redirect).toBe('error');
    expect(url.toString()).not.toContain('fixture-key');
  });
  it('paginates Anthropic with native authentication and does not accept an incomplete inventory', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: 'claude', display_name: 'Claude' }], has_more: true, last_id: 'claude' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-next' }], has_more: false }));
    const result = await discoverCustomProviderModels(listing(anthropic), { fetchImpl });
    expect(result.models.map((model) => model.id)).toEqual(['claude', 'claude-next']);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'fixture-key', 'anthropic-version': '2023-06-01' });
    expect(fetchImpl.mock.calls[1][0].searchParams.get('after_id')).toBe('claude');
  });
  it('paginates Gemini, strips models/ and keeps only content-generating models with supplied limits', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini', displayName: 'Gemini', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 32768, outputTokenLimit: 8192 }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'second' }))
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-next', supportedGenerationMethods: ['generateContent'] }] }));
    const request = { ...listing(google), baseURL: 'https://api.example.com/v1beta' };
    expect(await discoverCustomProviderModels(request, { fetchImpl })).toEqual({ models: [
      { id: 'gemini', name: 'Gemini', context: 32768, output: 8192 }, { id: 'gemini-next', name: 'models/gemini-next' },
    ] });
    expect(fetchImpl.mock.calls[0][1].headers['x-goog-api-key']).toBe('fixture-key');
    expect(fetchImpl.mock.calls[1][0].searchParams.get('pageToken')).toBe('second');
  });
  it('allows keyless local services without an authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }));
    expect(await discoverCustomProviderModels({ package: chat, baseURL: 'http://127.0.0.1:1234/v1' }, { fetchImpl })).toEqual({ models: [] });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it.each([new Response('fixture-key private body', { status: 401 }), json({ error: 'fixture-key' })])('rejects failed or malformed responses without exposing upstream text', async (response) => {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await expect(discoverCustomProviderModels(listing(), { fetchImpl })).rejects.toThrow('Unable to discover provider models');
  });
  it('rejects a failed second page instead of returning partial success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }));
    await expect(discoverCustomProviderModels(listing(anthropic), { fetchImpl })).rejects.toThrow();
  });
  it('rejects repeated pagination cursors', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ models: [{ name: 'models/coder' }], nextPageToken: 'repeated' }));
    await expect(discoverCustomProviderModels(listing(google), { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('propagates cancellation to the actual model endpoint', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      controller.abort(); expect(signal.aborted).toBe(true); throw new Error('aborted');
    });
    await expect(discoverCustomProviderModels(listing(), { signal: controller.signal, fetchImpl })).rejects.toThrow();
  });
});
