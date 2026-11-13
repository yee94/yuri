import { expect, it } from 'vitest';
import { gates } from './gates.mjs';
import { pairTraceAsync, analyzeBrowserPresentation } from './performance-owner-trace-paint.mjs';

const event = (ph, ts, overrides = {}) => ({ name: 'EventTiming', cat: 'devtools.timeline', id: '0x1', pid: 1, tid: 2, ph, ts, ...overrides });
const metadata = [{ ph: 'M', name: 'process_name', pid: 1, args: { name: 'Renderer' } },
  { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } }];
const begin = () => event('b', 100000, { args: { data: { type: 'input', timeStamp: 10, processingStart: 12,
  processingEnd: 14, duration: 20, nodeId: 5, frame: 'fixture-frame' } } });

it('pairs reused asynchronous IDs as separate sequential events instead of overwriting them', () => {
  const paired = pairTraceAsync([event('e', 10000), event('b', 0), event('b', 20000), event('e', 27000)], ['EventTiming']);
  expect(paired.pairs.map(pair => pair.durationMs)).toEqual([10, 7]); expect(paired.failures).toEqual([]);
});
it('keeps local ID process boundaries and all incomplete records explicit', () => {
  const paired = pairTraceAsync([event('b', 0), event('e', 100, { pid: 9 })], ['EventTiming']);
  expect(paired.pairs).toEqual([]); expect(paired.failures.map(failure => failure.reason).sort()).toEqual(['unmatched begin', 'unmatched end']);
});
it('reports actual browser timing and presentation records, never promoting rAF to paint', () => {
  const traceEvents = [...metadata, begin(), event('e', 120000),
    { name: 'FireAnimationFrame', ph: 'X', pid: 1, tid: 2, ts: 120000 }];
  const probe = [{ name: 'typing', samples: [{ event: 'input', start: 12.5, trusted: true }] }];
  const first = analyzeBrowserPresentation({ traceEvents }, probe);
  expect(first.scenarios.typing.matched[0]).toMatchObject({ browserReportedDurationMs: 20, processingMs: 2,
    inputDelayMs: 2, presentationDelayMs: 16, presentationRecordAtEndpoint: false });
  traceEvents.push({ name: 'AnimationFrame::Presentation', ph: 'n', pid: 1, tid: 2, ts: 120000 });
  expect(analyzeBrowserPresentation({ traceEvents }, probe).scenarios.typing.matched[0].presentationRecordAtEndpoint).toBe(true);
});
it('retains failed matches and never treats emulated IME as the system IME', () => {
  const result = analyzeBrowserPresentation({ traceEvents: [...metadata, begin(), event('e', 120000)] }, [
    { name: 'emulated-ime', samples: [{ event: 'input', start: 500, trusted: true }] }]);
  expect(result.scenarios['emulated-ime']).toMatchObject({ matchedCount: 0, realSystemIme: false });
  expect(result.scenarios['emulated-ime'].missing).toHaveLength(1);
});
it('uses recorded DOM event timestamp with declared precision rather than assuming callback sampling is exact', () => {
  const result = analyzeBrowserPresentation({ traceEvents: [...metadata, begin(), event('e', 120000)] }, [
    { name: 'typing', samples: [{ event: 'input', start: 50, eventTimeStamp: 10.01, trusted: true }] }]);
  expect(result.scenarios.typing.matchedCount).toBe(1);
});
it('rejects incomplete metadata and preserves inconsistent browser duration as invalid evidence', () => {
  expect(() => analyzeBrowserPresentation({ traceEvents: [] })).toThrow('metadata');
  const wrong = begin(); wrong.args.data.duration = 1;
  expect(analyzeBrowserPresentation({ traceEvents: [...metadata, wrong, event('e', 120000)] }).counts.invalidReadings).toBe(1);
});
it('uses spec decimal MB limits in both memory gates', () => {
  expect(gates.find(gate => gate.id === 18).requirement).toContain('10,000,000 bytes');
  expect(gates.find(gate => gate.id === 19).requirement).toContain('30,000,000 bytes');
  expect(gates.filter(gate => [18, 19].includes(gate.id)).every(gate => !gate.requirement.includes('MiB'))).toBe(true);
});
