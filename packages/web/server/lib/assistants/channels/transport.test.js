import { describe, expect, it, vi } from 'vitest';
import { officialURL, requestJSON } from './transport.js';

describe('enterprise channel outbound boundaries', () => {
  it('accepts only explicitly allowed TLS hosts and paths', () => {
    const rules = { hosts: ['open.feishu.cn'], path: '/callback/ws/endpoint' };
    expect(officialURL('https://open.feishu.cn/callback/ws/endpoint', rules)).toContain('open.feishu.cn');
    for (const url of ['http://open.feishu.cn/callback/ws/endpoint', 'https://open.feishu.cn.evil.example/callback/ws/endpoint',
      'https://user:secret@open.feishu.cn/callback/ws/endpoint', 'https://open.feishu.cn:8443/callback/ws/endpoint',
      'https://open.feishu.cn/other', 'https://127.0.0.1/callback/ws/endpoint']) expect(() => officialURL(url, rules)).toThrow('invalid_response');
  });

  it('does not forward raw HTTP errors and bounds JSON bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response('private upstream secret', { status: 403 }));
    await expect(requestJSON('https://example.com', { fetchImpl })).rejects.toMatchObject({ code: 'auth_expired' });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    await expect(requestJSON('https://example.com', { sending: true, fetchImpl: async () => { throw new Error('private-token'); } }))
      .rejects.toMatchObject({ code: 'network_error', ambiguous: true });
    await expect(requestJSON('https://example.com', { fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

});
