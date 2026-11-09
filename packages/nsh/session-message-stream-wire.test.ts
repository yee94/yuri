import { expect, test, vi } from 'vitest';
import { createTunnelHost } from '../web/server/lib/relay/tunnel-host.js';
import { decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame, TunnelFrameType } from '../web/server/lib/relay/tunnel-codec.js';

test('real Relay Host dispatcher preserves the mint Date header and expiry body (synthetic fetch, no socket)', async () => {
  const date = 'Wed, 01 Jan 2020 00:00:00 GMT';
  const body = { token: 'synthetic-url-token', expiresAt: 1_577_836_860_000 };
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { Date: date, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
  vi.stubGlobal('fetch', fetch);
  const frames: ReturnType<typeof decodeTunnelFrame>[] = [];
  const host = createTunnelHost({ authorizeRequest: async () => true, connectionId: 'session-mint-fixture', getLocalPort: () => 9,
    sendFrame: (frame: Uint8Array) => { frames.push(decodeTunnelFrame(frame)); }, getBufferedAmount: () => 0 });
  try {
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/auth/url-token', query: '', headers: { authorization: 'Bearer synthetic-client' } })));
    for (let index = 0; index < 200 && !frames.some(frame => frame.frameType === TunnelFrameType.StreamEnd); index++) await Promise.resolve();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9/auth/url-token', expect.objectContaining({ method: 'POST', redirect: 'manual' }));
    const head = frames.find(frame => frame.frameType === TunnelFrameType.HttpResponse)!;
    expect(JSON.parse(new TextDecoder().decode(head.payload))).toMatchObject({ status: 200, headers: { date, 'cache-control': 'no-store' } });
    const text = frames.filter(frame => frame.frameType === TunnelFrameType.HttpBody).map(frame => new TextDecoder().decode(frame.payload)).join('');
    expect(JSON.parse(text)).toEqual(body);
    expect(frames.some(frame => frame.frameType === TunnelFrameType.StreamEnd)).toBe(true);
  } finally { host.close(); vi.unstubAllGlobals(); }
});
