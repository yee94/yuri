import { describe, expect, it } from 'vitest';
import { bindResourceWebPreview, presentResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { resourceWebPreviewFixture } from './tests/resource-web-preview-fixture';

describe('native resource web preview intent', () => {
  it('keeps the isolated HTML/CSS/JS fixture and unsupported execution gap explicit', () => {
    expect(resourceWebPreviewFixture.html.supported).toBe(true);
    expect(resourceWebPreviewFixture.loopback.supported).toBe(true);
    expect(resourceWebPreviewFixture.eficy).toEqual({ supported: false, reason: 'format-runtime-required' });
    expect(Object.keys(resourceWebPreviewFixture.files)).toHaveLength(3);
  });
  it('offers only HTML documents within the originating directory', () => {
    expect(resourceWebPreviewIntent({ directory: '/work', path: '/work/报告 #.html' })).toEqual({ supported: true, intent: { kind: 'html', directory: '/work', path: '/work/报告 #.html' } });
    expect(resourceWebPreviewIntent({ directory: '/', path: '/work/index.htm' }).supported).toBe(true);
    for (const path of ['/work2/index.html', '/other/index.html']) expect(resourceWebPreviewIntent({ directory: '/work', path })).toEqual({ supported: false, reason: 'outside-directory' });
    for (const path of ['/work/../index.html', '/work//index.html', '/work/./index.html', '/work\\index.html', '/work/index.html\0']) expect(resourceWebPreviewIntent({ directory: '/work', path })).toEqual({ supported: false, reason: 'invalid' });
  });
  it('does not pretend CJS/TSX/Eficy or other formats have a page runtime', () => {
    for (const path of ['/work/a.eficy', '/work/gui-experimental.cjs', '/work/report.tsx', '/work/readme.md']) expect(resourceWebPreviewIntent({ directory: '/work', path })).toEqual({ supported: false, reason: 'format-runtime-required' });
  });
  it('keeps Host loopback as an intent, never as a phone request', () => {
    for (const href of ['http://localhost:3000/', 'https://127.0.0.1:443/report?q=one#two', 'http://[::1]:8000/', 'http://0.0.0.0:3000/']) expect(resourceWebPreviewIntent({ directory: '/work', href })).toEqual({ supported: true, intent: { kind: 'loopback', url: href } });
    for (const href of ['http://localhost:0/', 'http://localhost:65536/', 'http://localhost/%00', 'http://localhost/%5c', 'http://localhost/?yuri_url_token=x', 'http://localhost/?yuri_preview_token=x', 'http://localhost/?%79uri_client_token=x', 'http://localhost/?token=x', 'http://localhost/%zz', ' http://localhost/']) expect(resourceWebPreviewIntent({ directory: '/work', href }).supported).toBe(false);
    for (const href of ['https://example.invalid/', 'http://localhost.example.invalid/', '//localhost:3000/', 'file:///work/index.html', 'http://user@localhost/', 'javascript:alert(1)', 'http://2130706433/', 'http://127.1/', 'http://localhost\\@example.invalid/']) expect(resourceWebPreviewIntent({ directory: '/work', href }).supported).toBe(false);
  });
  it('calls only the narrow native method and propagates failure', async () => {
    const authority = { expectedHost: { hostID: 'A', lease: '00000000-0000-4000-8000-000000000001' }, owner: 'fixture-owner' };
    const calls: unknown[] = [];
    const call = async (name: string, body: Record<string, unknown>) => { calls.push([name, body]); return { closed: true }; };
    expect(await presentResourceWebPreview(call, { directory: '/work', href: 'http://localhost:3000/' }, authority)).toEqual({ closed: true });
    expect(calls).toEqual([['resources.web.present', { kind: 'loopback', url: 'http://localhost:3000/', ...authority }]]);
    await expect(presentResourceWebPreview(call, { directory: '/work', path: '/work/a.eficy' }, authority)).rejects.toThrow('format-runtime-required');
    expect(calls).toHaveLength(1);
    await expect(presentResourceWebPreview(async () => { throw new Error('unsupported'); }, { directory: '/work', path: '/work/a.html' }, authority)).rejects.toThrow('unsupported');
    await expect(presentResourceWebPreview(async () => ({ success: true }), { directory: '/work', path: '/work/a.html' }, authority)).rejects.toThrow('Invalid');
  });
  it('binds a copied receipt for HTML and loopback; late close never names a new presentation', async () => {
    const original = { hostID: 'A', lease: '00000000-0000-4000-8000-000000000001' }, expected = { ...original };
    const calls: Array<[string, Record<string, unknown>]> = [], resolvers: Array<(value: unknown) => void> = [];
    const call = (name: string, body: Record<string, unknown>): Promise<unknown> => {
      calls.push([name, body]); return name.endsWith('.present') ? new Promise(resolve => resolvers.push(resolve)) : Promise.resolve(true);
    };
    let serial = 0;
    const old = bindResourceWebPreview(original, call, () => `old-${++serial}`);
    original.hostID = 'B'; original.lease = '00000000-0000-4000-8000-000000000002';
    const html = old.present({ directory: '/work', path: '/work/a.html' });
    await old.close();
    original.hostID = 'A'; original.lease = '00000000-0000-4000-8000-000000000003';
    const newer = bindResourceWebPreview(original, call, () => 'new-owner');
    const loopback = newer.present({ directory: '/work', href: 'http://localhost:3000/' });
    resolvers[0]({ closed: true }); await html; await old.close();
    expect(calls[0]).toEqual(['resources.web.present', { kind: 'html', directory: '/work', path: '/work/a.html', expectedHost: expected, owner: 'old-1' }]);
    expect(calls.filter(([name]) => name.endsWith('.close'))).toEqual([['resources.web.close', { expectedHost: expected, owner: 'old-1' }]]);
    expect(calls[2][1]).toEqual({ kind: 'loopback', url: 'http://localhost:3000/', expectedHost: original, owner: 'new-owner' });
    resolvers[1]({ closed: true }); await loopback;
  });
  it('null stays closed and rejected native answers trigger exact cleanup', async () => {
    const calls: unknown[] = [];
    const call = async (name: string, body: Record<string, unknown>) => { calls.push([name, body]); if (name.endsWith('.present')) throw new Error('ETIMEDOUT'); return true; };
    await expect(bindResourceWebPreview(null, call, () => 'none').present({ directory: '/work', path: '/work/a.html' })).rejects.toThrow('scope_required');
    expect(calls).toEqual([]);
    const expectedHost = { hostID: 'A', lease: '00000000-0000-4000-8000-000000000001' };
    await expect(bindResourceWebPreview(expectedHost, call, () => 'timed-out').present({ directory: '/work', path: '/work/a.html' })).rejects.toThrow('ETIMEDOUT');
    expect(calls[1]).toEqual(['resources.web.close', { expectedHost, owner: 'timed-out' }]);
  });
  it('retains failed close for retry and coalesces concurrent exact closes', async () => {
    const expectedHost = { hostID: 'A', lease: '00000000-0000-4000-8000-000000000001' };
    let end!: (value: unknown) => void, finishClose!: (value: unknown) => void, closes = 0;
    const call = (name: string): Promise<unknown> => {
      if (name.endsWith('.present')) return new Promise(resolve => { end = resolve; });
      closes++;
      if (closes === 1) return Promise.reject(new Error('not delivered'));
      return new Promise(resolve => { finishClose = resolve; });
    };
    const owner = bindResourceWebPreview(expectedHost, call, () => 'retry-owner');
    const work = owner.present({ directory: '/work', path: '/work/a.html' });
    await expect(owner.close()).rejects.toThrow('not delivered');
    const retry = owner.close(), concurrent = owner.close();
    await Promise.resolve(); expect(closes).toBe(2);
    end({ closed: true }); await Promise.resolve();
    finishClose(true);
    await Promise.all([retry, concurrent, work]);
    await owner.close(); expect(closes).toBe(2);
  });
});
