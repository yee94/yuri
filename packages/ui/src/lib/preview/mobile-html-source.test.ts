import { beforeEach, expect, it, vi } from 'vitest';
import { resolveMobileHtmlUrl } from './mobile-html-source';
const fixture = vi.hoisted(() => ({ fetch: vi.fn(), auth: vi.fn(), generation: 1 }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: fixture.fetch }));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: fixture.auth }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ authenticatedAsset: (route: string) => {
  const url = new URL(route, 'http://relay.invalid'); url.searchParams.set('yuri_url_token', 'scoped'); return url.href;
} }) }));
beforeEach(() => {
  fixture.generation = 1;
  fixture.fetch.mockReset().mockResolvedValue(Response.json({ proxyBasePath: '/api/preview/proxy/1234567890abcdef', previewToken: 'preview-scoped', expiresAt: Date.now() + 60_000 }));
  fixture.auth.mockReset().mockResolvedValue('scoped');
});
it.each(['localhost', '127.0.0.1', '[::1]'])('loads Host-local %s behind the Host proxy via the shared native gateway', async host => {
  const signal = new AbortController().signal;
  const target = `http://${host}:3000/app?q=1#top`;
  const result = new URL((await resolveMobileHtmlUrl(target, 'http://localhost:4000', signal)).src);
  expect(fixture.fetch).toHaveBeenCalledWith('/api/preview/targets', expect.objectContaining({ body: JSON.stringify({ url: target }), signal }));
  expect(result.origin).toBe('http://localhost:4000');
  expect(result.pathname).toBe('/api/preview/proxy/1234567890abcdef/app');
  expect(result.searchParams.get('q')).toBe('1');
  expect(result.searchParams.get('yuri_preview_token')).toBe('preview-scoped');
  expect(result.searchParams.get('yuri_url_token')).toBe('scoped');
  expect(result.hash).toBe('#top');
});
it('rejects an old Host or failed registration rather than falling back to the phone URL', async () => {
  await expect(resolveMobileHtmlUrl('http://localhost:3000', undefined, new AbortController().signal)).rejects.toThrow('unsupported_host');
  fixture.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
  await expect(resolveMobileHtmlUrl('http://localhost:3000', 'http://localhost:4000', new AbortController().signal)).rejects.toThrow('preview_unavailable');
});
it('does not add Yuri credentials to an external website', async () => {
  expect(await resolveMobileHtmlUrl('https://example.com/app', undefined, new AbortController().signal)).toEqual({ src: 'https://example.com/app' });
  expect(fixture.fetch).not.toHaveBeenCalled(); expect(fixture.auth).not.toHaveBeenCalled();
});

it.each(['/api/preview/proxy/id', '/api/preview/proxy/1234567890abcdef/../../session', 'https://elsewhere.example'])('rejects a malformed Host target %s', async proxyBasePath => {
  fixture.fetch.mockResolvedValueOnce(Response.json({ proxyBasePath, previewToken: 'scoped', expiresAt: Date.now() + 60_000 }));
  await expect(resolveMobileHtmlUrl('http://localhost:3000', 'http://localhost:4000', new AbortController().signal)).rejects.toThrow('invalid_preview');
  expect(fixture.auth).not.toHaveBeenCalled();
});

it.each(['abort', 'switch'])('does not mint or expose an old preview after %s during registration', async action => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = resolveMobileHtmlUrl('http://localhost:3000', 'http://localhost:4000', controller.signal);
  if (action === 'abort') controller.abort(); else fixture.generation++;
  finish(Response.json({ proxyBasePath: '/api/preview/proxy/1234567890abcdef', previewToken: 'scoped', expiresAt: Date.now() + 60_000 }));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.auth).not.toHaveBeenCalled();
});
