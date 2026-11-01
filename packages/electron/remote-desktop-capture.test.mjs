import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function captureFixture(width = 1920, height = 1080) {
  vi.useFakeTimers();
  let command, unload;
  const frame = vi.fn(), send = vi.fn();
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { videoWidth: width, videoHeight: height, play: vi.fn(async () => {}) };
  let encoded = new Uint8Array([255, 216, 1]).buffer;
  const canvas = { getContext: () => ({ drawImage: vi.fn() }), toBlob: resolve => resolve({ size: encoded.byteLength, arrayBuffer: async () => encoded }) };
  const params = { transactionId: 'keep-me', encodings: [{ rid: 'existing', active: true }] };
  const sender = { getParameters: () => structuredClone(params), setParameters: vi.fn(async () => {}) };
  let tick = 0;
  const peer = { connectionState: 'connected', close: vi.fn(), addTrack: () => sender, localDescription: { sdp: 'fixture' },
    createOffer: vi.fn(async () => ({})), setLocalDescription: vi.fn(async () => {}),
    getStats: vi.fn(async () => new Map([['outbound', { type: 'outbound-rtp', id: 'video', kind: 'video', timestamp: ++tick * 2000, bytesSent: tick * 1000, qualityLimitationReason: 'bandwidth' }]])),
  };
  vi.stubGlobal('window', { captureBridge: { loaded: vi.fn(), frame, send, onMessage: callback => { command = callback; } },
    addEventListener: (type, callback) => { if (type === 'unload') unload = callback; } });
  vi.stubGlobal('document', { querySelector: selector => selector === 'video' ? video : canvas });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  vi.stubGlobal('RTCPeerConnection', class { constructor() { return peer; } });
  await import('./remote-desktop-capture.mjs');
  return { command, unload, frame, send, peer, sender, canvas, track, setEncoded: bytes => { encoded = bytes; } };
}

it('preserves sender transaction/encoding identity, retries rejected tuning without failing video and stops on fallback', async () => {
  const fixture = await captureFixture();
  fixture.sender.setParameters.mockRejectedValueOnce(new Error('unsupported tuning'));
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  expect(fixture.send).toHaveBeenCalledWith({ type: 'offer', sdp: 'fixture' });
  expect(fixture.sender.setParameters.mock.calls[0][0]).toMatchObject({ transactionId: 'keep-me', degradationPreference: 'balanced', encodings: [
    { rid: 'existing', active: true, maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 1.5 },
  ] });
  await vi.advanceTimersByTimeAsync(4000);
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0].maxBitrate).toBe(750000);
  expect(fixture.send.mock.calls.some(([message]) => message.type === 'failure' || message.type === 'rtc-failed')).toBe(false);
  const statsCalls = fixture.peer.getStats.mock.calls.length;
  await fixture.command({ type: 'fallback' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(fixture.peer.getStats).toHaveBeenCalledTimes(statsCalls);
  fixture.unload();
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.track.stop).toHaveBeenCalledOnce();
});

it('does not overlap stats requests or apply late quality changes after fallback/unload', async () => {
  const fixture = await captureFixture();
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  let finish;
  fixture.peer.getStats.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(10000);
  expect(fixture.peer.getStats).toHaveBeenCalledOnce();
  await fixture.command({ type: 'fallback' });
  fixture.unload();
  finish(new Map());
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.sender.setParameters).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('a stats failure retains working video and retries without counting missing feedback as congestion', async () => {
  const fixture = await captureFixture();
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  fixture.peer.getStats.mockRejectedValueOnce(new Error('no stats'));
  await vi.advanceTimersByTimeAsync(4000);
  expect(fixture.sender.setParameters).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0].maxBitrate).toBe(750000);
  expect(fixture.send.mock.calls.some(([message]) => message.type === 'failure' || message.type === 'rtc-failed')).toBe(false);
  fixture.unload();
});

it('keeps JPEG ACK backpressure, suppresses idle sends, retries dropped duplicates and preserves small changes', async () => {
  const fixture = await captureFixture();
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  await fixture.command({ type: 'fallback' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.frame).toHaveBeenCalledOnce();
  await fixture.command({ type: 'ack' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.frame).toHaveBeenCalledOnce();
  fixture.setEncoded(new Uint8Array([255, 216, 2]).buffer);
  await vi.advanceTimersByTimeAsync(83);
  expect(fixture.frame).toHaveBeenCalledTimes(2);
  await fixture.command({ type: 'ack', dropped: true });
  await vi.advanceTimersByTimeAsync(83);
  expect(fixture.frame).toHaveBeenCalledTimes(3);
  fixture.unload();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.frame).toHaveBeenCalledTimes(3);
});

it('discards an in-flight JPEG completed after teardown', async () => {
  const fixture = await captureFixture();
  let finish;
  fixture.canvas.toBlob = callback => { finish = callback; };
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  await fixture.command({ type: 'fallback' });
  await vi.advanceTimersByTimeAsync(83);
  fixture.unload();
  finish(new Blob([new Uint8Array([255, 216, 1])]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frame).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('applies zoom detail immediately, preserves source resolution under pressure, and restores the current tier on Fit', async () => {
  const fixture = await captureFixture();
  await fixture.command({ type: 'start', sourceId: 'synthetic', zoomQuality: true });
  expect(fixture.send).toHaveBeenCalledWith({ type: 'ready', width: 1920, height: 1080, zoomQuality: true });
  await fixture.command({ type: 'view', zoomed: true });
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0]).toMatchObject({ degradationPreference: 'maintain-resolution',
    encodings: [{ scaleResolutionDownBy: 1, maxFramerate: 10, maxBitrate: 1500000 }] });
  await vi.advanceTimersByTimeAsync(4000);
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0]).toMatchObject({ scaleResolutionDownBy: 1, maxFramerate: 5, maxBitrate: 750000 });
  await fixture.command({ type: 'view', zoomed: false });
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0]).toMatchObject({ degradationPreference: 'balanced',
    encodings: [{ scaleResolutionDownBy: 2, maxFramerate: 12, maxBitrate: 750000 }] });
  fixture.unload();
});

it('serializes tuning and coalesces zoom changes that arrive during a native parameter update', async () => {
  const fixture = await captureFixture();
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  let finish;
  fixture.sender.setParameters.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = fixture.command({ type: 'view', zoomed: true });
  await fixture.command({ type: 'view', zoomed: false });
  expect(fixture.sender.setParameters).toHaveBeenCalledTimes(2);
  finish(); await pending;
  expect(fixture.sender.setParameters).toHaveBeenCalledTimes(3);
  expect(fixture.sender.setParameters.mock.calls.at(-1)[0]).toMatchObject({ degradationPreference: 'balanced', encodings: [{ scaleResolutionDownBy: 1.5 }] });
  fixture.unload();
});

it('raises zoomed JPEG resolution within the size cap, lowers its cadence and restores ordinary capture on Fit', async () => {
  const fixture = await captureFixture(2560, 1440);
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  await fixture.command({ type: 'view', zoomed: true });
  await fixture.command({ type: 'fallback' });
  fixture.canvas.toBlob = vi.fn((resolve, _type, quality) => resolve({ size: quality === 0.8 ? 600000 : 3,
    arrayBuffer: async () => new Uint8Array([255, 216, 1]).buffer }));
  await vi.advanceTimersByTimeAsync(83);
  expect(fixture.canvas).toMatchObject({ width: 2560, height: 1440 });
  expect(fixture.canvas.toBlob.mock.calls.map(call => call[2])).toEqual([0.8, 0.5]);
  expect(fixture.frame).toHaveBeenCalledOnce();
  await fixture.command({ type: 'ack' });
  await vi.advanceTimersByTimeAsync(166);
  expect(fixture.canvas.toBlob).toHaveBeenCalledTimes(2);
  await fixture.command({ type: 'view', zoomed: false });
  await vi.advanceTimersByTimeAsync(83);
  expect(fixture.canvas).toMatchObject({ width: 1440, height: 810 });
  expect(fixture.canvas.toBlob.mock.calls.at(-1)[2]).toBe(0.65);
  expect(fixture.frame).toHaveBeenCalledTimes(2);
  fixture.unload();
});

it.each([[2560, 1440, 2], [1920, 1080, 1.5], [1280, 720, 1]])(
  'preserves the 720p initial tier for a %i × %i source and uses available source detail only while zoomed',
  async (width, height, divisor) => {
    const fixture = await captureFixture(width, height);
    await fixture.command({ type: 'start', sourceId: 'synthetic', zoomQuality: true });
    expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0]).toMatchObject({ scaleResolutionDownBy: divisor, maxFramerate: 20, maxBitrate: 1500000 });
    expect(Math.round(height / divisor)).toBe(720);
    await fixture.command({ type: 'view', zoomed: true });
    expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0]).toMatchObject({ scaleResolutionDownBy: 1, maxFramerate: 10, maxBitrate: 1500000 });
    await fixture.command({ type: 'view', zoomed: false });
    expect(fixture.sender.setParameters.mock.calls.at(-1)[0].encodings[0].scaleResolutionDownBy).toBe(divisor);
    fixture.unload();
  },
);

it('discards a JPEG encoded for an obsolete zoom state without consuming the single-frame ACK slot', async () => {
  const fixture = await captureFixture();
  let finish;
  fixture.canvas.toBlob = callback => { finish = callback; };
  await fixture.command({ type: 'start', sourceId: 'synthetic' });
  await fixture.command({ type: 'fallback' });
  await vi.advanceTimersByTimeAsync(83);
  await fixture.command({ type: 'view', zoomed: true });
  finish(new Blob([new Uint8Array([255, 216, 1])]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frame).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(83);
  finish(new Blob([new Uint8Array([255, 216, 2])]));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frame).toHaveBeenCalledOnce();
  fixture.unload();
});
