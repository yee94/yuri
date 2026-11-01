import { expect, it } from 'vitest';
import { createJpegFrameFilter, createVideoQualityController } from './remote-desktop-quality.mjs';

function reports() {
  let tick = 0;
  return (outbound = {}, remote = {}, pair = {}) => new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: ++tick * 2000, bytesSent: tick * 1000,
      transportId: 'transport', remoteId: 'remote', qualityLimitationReason: 'none', ...outbound }],
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { id: 'selected', type: 'candidate-pair', currentRoundTripTime: 0.08, availableOutgoingBitrate: 5000000, ...pair }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', timestamp: tick * 2000, fractionLost: 0, roundTripTime: 0.08, ...remote }],
    ['unselected', { id: 'unselected', type: 'candidate-pair', currentRoundTripTime: 2, availableOutgoingBitrate: 10000 }],
  ]);
}

it('starts below full resolution/framerate and lowers all three ceilings after sustained bandwidth pressure', () => {
  const quality = createVideoQualityController(), next = reports();
  const initial = quality.current;
  expect(initial).toEqual({ maxBitrate: 1500000, maxFramerate: 20, scaleResolutionDownBy: 1.5 });
  expect(quality.sample(next({ qualityLimitationReason: 'bandwidth' }))).toBe(initial);
  const reduced = quality.sample(next({ qualityLimitationReason: 'bandwidth' }));
  expect(reduced.maxBitrate).toBeLessThan(initial.maxBitrate);
  expect(reduced.maxFramerate).toBeLessThan(initial.maxFramerate);
  expect(reduced.scaleResolutionDownBy).toBeGreaterThan(initial.scaleResolutionDownBy);
  for (let i = 0; i < 100; i++) quality.sample(next({ qualityLimitationReason: 'bandwidth' }));
  expect(quality.current).toEqual({ maxBitrate: 350000, maxFramerate: 8, scaleResolutionDownBy: 3 });
});

it.each([
  ['packet loss', {}, { fractionLost: 0.08 }, {}],
  ['high RTT', {}, {}, { currentRoundTripTime: 0.6 }],
  ['limited capacity', {}, {}, { availableOutgoingBitrate: 500000 }],
  ['encoder pressure', { qualityLimitationReason: 'cpu' }, {}, {}],
])('backs off on %s from the active video path', (_label, outbound, remote, pair) => {
  const quality = createVideoQualityController(), next = reports();
  quality.sample(next(outbound, remote, pair));
  expect(quality.sample(next(outbound, remote, pair)).maxBitrate).toBe(750000);
});

it('ignores a single spike and requires eight consecutive healthy samples to restore one level', () => {
  const quality = createVideoQualityController(), next = reports();
  quality.sample(next({}, { fractionLost: 0.1 }));
  quality.sample(next());
  expect(quality.current.maxBitrate).toBe(1500000);
  quality.sample(next({}, { fractionLost: 0.1 }));
  quality.sample(next({}, { fractionLost: 0.1 }));
  for (let i = 0; i < 7; i++) quality.sample(next());
  expect(quality.current.maxBitrate).toBe(750000);
  quality.sample(next());
  expect(quality.current.maxBitrate).toBe(1500000);
  for (let i = 0; i < 8; i++) quality.sample(next());
  expect(quality.current).toEqual({ maxBitrate: 3000000, maxFramerate: 30, scaleResolutionDownBy: 1 });
});

it('does not count missing, repeated or idle stats as recovery, or treat low traffic as congestion', () => {
  const quality = createVideoQualityController(), next = reports();
  const initial = quality.current;
  for (let i = 0; i < 100; i++) quality.sample(new Map());
  const repeated = next();
  for (let i = 0; i < 100; i++) quality.sample(repeated);
  for (let i = 0; i < 100; i++) quality.sample(next({ bytesSent: 1000 }));
  for (let i = 0; i < 100; i++) quality.sample(next({ qualityLimitationReason: undefined }, {}, { availableOutgoingBitrate: undefined, currentRoundTripTime: undefined }));
  expect(quality.current).toBe(initial);
});

it('does not reuse old RTCP loss as consecutive congestion or read unrelated candidate pairs', () => {
  const quality = createVideoQualityController(), next = reports();
  quality.sample(next({}, { timestamp: 1, fractionLost: 0.1 }));
  for (let i = 0; i < 6; i++) quality.sample(next({}, { timestamp: 1, fractionLost: 0.1 }));
  expect(quality.current.maxBitrate).toBe(1500000);
});

it('still backs off when sending stalls with an explicit bandwidth limitation instead of treating it as an idle desktop', () => {
  const quality = createVideoQualityController(), next = reports();
  quality.sample(next({ bytesSent: 1000 }));
  quality.sample(next({ bytesSent: 1000, qualityLimitationReason: 'bandwidth' }));
  expect(quality.sample(next({ bytesSent: 1000, qualityLimitationReason: 'bandwidth' })).maxBitrate).toBe(750000);
});

it('detects RTT growth relative to the session baseline before the absolute high-RTT threshold', () => {
  const quality = createVideoQualityController(), next = reports();
  quality.sample(next());
  quality.sample(next({}, {}, { currentRoundTripTime: 0.32 }));
  expect(quality.sample(next({}, {}, { currentRoundTripTime: 0.32 })).maxBitrate).toBe(750000);
});

it('requires network headroom to recover and does not oscillate at a constrained ceiling', () => {
  const quality = createVideoQualityController(), next = reports();
  for (let i = 0; i < 100; i++) quality.sample(next({}, {}, { availableOutgoingBitrate: 1500000 }));
  expect(quality.current.maxBitrate).toBe(1500000);
});

it('can recover using fresh RTCP feedback without capacity estimates, but an unknown gap resets the healthy streak', () => {
  const quality = createVideoQualityController(), next = reports();
  for (let i = 0; i < 7; i++) quality.sample(next({}, {}, { availableOutgoingBitrate: undefined }));
  quality.sample(new Map());
  expect(quality.sample(next({}, {}, { availableOutgoingBitrate: undefined })).maxBitrate).toBe(1500000);
  for (let i = 0; i < 7; i++) quality.sample(next({}, {}, { availableOutgoingBitrate: undefined }));
  expect(quality.current.maxBitrate).toBe(3000000);
});

it('skips identical JPEGs, including a thousand idle frames, but preserves even a one-byte change', () => {
  const frames = createJpegFrameFilter();
  const jpeg = new Uint8Array(512 * 1024).fill(127);
  expect(frames.shouldSend(jpeg.buffer)).toBe(true);
  for (let i = 0; i < 1000; i++) expect(frames.shouldSend(jpeg.slice().buffer)).toBe(false);
  const changed = jpeg.slice(); changed[changed.length - 1]++;
  expect(frames.shouldSend(changed.buffer)).toBe(true);
  expect(frames.shouldSend(changed.slice().buffer)).toBe(false);
  expect(frames.shouldSend(changed.slice(0, -1).buffer)).toBe(true);
});

it('invalidates duplicate history after a dropped send or session teardown and bounds retained bytes', () => {
  const frames = createJpegFrameFilter(), jpeg = new Uint8Array([255, 216, 1]);
  expect(frames.shouldSend(jpeg.buffer)).toBe(true);
  expect(frames.shouldSend(jpeg.buffer)).toBe(false);
  frames.clear();
  expect(frames.shouldSend(jpeg.buffer)).toBe(true);
  expect(frames.shouldSend(new ArrayBuffer(512 * 1024 + 1))).toBe(false);
  expect(frames.shouldSend(new ArrayBuffer(0))).toBe(false);
  expect(frames.shouldSend(jpeg.buffer)).toBe(false);
});

it('immediately favors source resolution when zoomed, keeps adaptive bitrate, and restores the ordinary tier on Fit', () => {
  const quality = createVideoQualityController(), next = reports();
  const initial = quality.current;
  expect(quality.setZoomed(true)).toEqual({ maxBitrate: 1500000, maxFramerate: 10, scaleResolutionDownBy: 1,
    degradationPreference: 'maintain-resolution' });
  quality.sample(next({ qualityLimitationReason: 'bandwidth' }));
  const constrained = quality.sample(next({ qualityLimitationReason: 'bandwidth' }));
  expect(constrained).toMatchObject({ maxBitrate: 750000, maxFramerate: 5, scaleResolutionDownBy: 1 });
  expect(quality.setZoomed(true)).toBe(constrained);
  expect(quality.setZoomed(false)).toEqual({ maxBitrate: 750000, maxFramerate: 12, scaleResolutionDownBy: 2 });
  expect(quality.current).not.toBe(initial);
  quality.setZoomed(true);
  for (let i = 0; i < 100; i++) quality.sample(next({ qualityLimitationReason: 'bandwidth' }));
  expect(quality.current).toMatchObject({ maxBitrate: 350000, maxFramerate: 2, scaleResolutionDownBy: 1 });
});
