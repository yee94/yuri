import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { distribution } from './gates.mjs';

const key = event => JSON.stringify([event.cat, event.name,
  event.id2?.global !== undefined ? 'global' : event.pid, event.scope ?? event.s ?? '',
  event.id2?.global ?? event.id2?.local ?? event.id]);

export function pairTraceAsync(events, names) {
  const open = new Map(); const pairs = []; const failures = [];
  const selected = events.filter(event => names.includes(event.name) && ['b', 'e'].includes(event.ph))
    .map((event, index) => ({ ...event, originalIndex: index })).sort((a, b) => a.ts - b.ts || a.originalIndex - b.originalIndex);
  for (const event of selected) {
    if (!Number.isFinite(event.ts) || (event.id === undefined && event.id2?.local === undefined && event.id2?.global === undefined)) {
      failures.push({ reason: 'missing timestamp or async ID', event }); continue;
    }
    const id = key(event); const stack = open.get(id) ?? [];
    if (event.ph === 'b') { stack.push(event); open.set(id, stack); continue; }
    const begin = stack.pop();
    if (!begin) failures.push({ reason: 'unmatched end', event });
    else pairs.push({ begin, end: event, durationMs: (event.ts - begin.ts) / 1000 });
  }
  for (const stack of open.values()) for (const event of stack) failures.push({ reason: 'unmatched begin', event });
  return { pairs, failures };
}

export function analyzeBrowserPresentation(trace, probes = []) {
  if (!Array.isArray(trace.traceEvents)) throw new Error('Chromium JSON trace required, not empty success for another trace format');
  const events = trace.traceEvents;
  const rendererPids = new Set(events.filter(event => event.ph === 'M' && event.name === 'process_name' && event.args?.name === 'Renderer').map(event => event.pid));
  const threads = new Set(events.filter(event => rendererPids.has(event.pid) && event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`));
  if (!threads.size) throw new Error('No renderer main-thread metadata');
  const presentationRecords = new Set(events.filter(event => event.name === 'AnimationFrame::Presentation')
    .map(event => `${event.pid}:${event.tid}:${event.ts}`));
  const paired = pairTraceAsync(events, ['EventTiming']);
  const readings = []; const invalid = [];
  for (const pair of paired.pairs) {
    const { begin, end, durationMs } = pair; const data = begin.args?.data;
    if (!threads.has(`${begin.pid}:${begin.tid}`)) continue;
    if (!data || !['timeStamp', 'processingStart', 'processingEnd', 'duration'].every(field => Number.isFinite(data[field]))
      || data.processingEnd < data.processingStart || data.processingStart < data.timeStamp
      || Math.abs(durationMs - data.duration) > 0.01 || data.duration < data.processingEnd - data.timeStamp) {
      invalid.push({ reason: 'incomplete/inconsistent browser event timing', begin, end }); continue;
    }
    readings.push({ event: data.type, pid: begin.pid, tid: begin.tid, nodeId: data.nodeId, frame: data.frame,
      eventStartMs: data.timeStamp, processingStartMs: data.processingStart, processingEndMs: data.processingEnd,
      traceStartUs: begin.ts, traceEndUs: end.ts, browserReportedDurationMs: durationMs,
      processingMs: data.processingEnd - data.processingStart,
      inputDelayMs: data.processingStart - data.timeStamp,
      presentationDelayMs: durationMs - (data.processingEnd - data.timeStamp),
      presentationRecordAtEndpoint: presentationRecords.has(`${end.pid}:${end.tid}:${end.ts}`) });
  }
  const scenarios = {};
  for (const probe of probes) {
    const matched = []; const missing = []; const ambiguous = [];
    for (const [index, sample] of probe.samples.entries()) {
      const candidates = readings.filter(reading => reading.event === sample.event && (Number.isFinite(sample.eventTimeStamp)
        ? Math.abs(reading.eventStartMs - sample.eventTimeStamp) <= 0.1
        : sample.start >= reading.processingStartMs && sample.start <= reading.processingEndMs));
      if (!candidates.length) missing.push({ index, event: sample.event, startMs: sample.start });
      else if (candidates.length !== 1) ambiguous.push({ index, candidateCount: candidates.length });
      else matched.push({ probeIndex: index, trusted: sample.trusted, ...candidates[0] });
    }
    scenarios[probe.name] = { sourceEventCount: probe.samples.length, matchedCount: matched.length,
      matching: probe.samples.some(sample => Number.isFinite(sample.eventTimeStamp)) ? 'DOM Event.timeStamp to EventTiming.timeStamp within explicit 0.1ms clock precision; ambiguities retained' : 'legacy capture callback within browser processing interval; missing precision matches retained',
      missing, ambiguous, realSystemIme: !probe.name.includes('emulated'),
      eventTypes: Object.fromEntries([...new Set(matched.map(reading => reading.event))].map(type => {
        const values = matched.filter(reading => reading.event === type);
        return [type, { count: values.length, withPresentationRecord: values.filter(reading => reading.presentationRecordAtEndpoint).length,
          browserReportedDurationMs: distribution(values.map(reading => reading.browserReportedDurationMs)),
          mainThreadHandlingMs: distribution(values.map(reading => reading.processingMs)) }];
      })), matched };
  }
  return { classification: 'offline archived browser EventTiming/presentation analysis; never a new platform or budget pass',
    counts: { rendererMainThreads: threads.size, eventTimingPairs: paired.pairs.length,
      validReadings: readings.length, invalidReadings: invalid.length, unmatchedAsync: paired.failures.length,
      animationFramePresentation: presentationRecords.size,
      compositorPresentationStages: events.filter(event => event.name === 'SwapEndToPresentationCompositorFrame').length },
    scenarios, invalid, unmatchedAsync: paired.failures,
    caveats: ['Browser EventTiming endpoints are browser-reported interaction latency, not rAF or DOM timestamps.',
      'A presentation record at the same endpoint corroborates a browser presentation phase; it does not prove first sidebar/transcript content visibility or native UITextView presentation.',
      'Missing/ambiguous events remain explicit; traces must extend beyond the last input until browser presentation records are delivered.',
      'No 16ms budget is applied to total interaction latency: the spec 16ms gate is synchronous input handling, with separate complete renderer-task and paint evidence.',
      'Trace numeric IDs beyond Number.MAX_SAFE_INTEGER are not used for correlation. Async IDs may be reused by sequential events.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = path.resolve(process.argv[2]); const output = path.resolve(process.argv[3]);
  const compressed = fs.readFileSync(input); const bytes = input.endsWith('.gz') ? gunzipSync(compressed) : compressed;
  const directory = path.dirname(input);
  const probes = fs.readdirSync(directory).filter(name => /^input-(typing|deletion|undo|paste|emulated-ime)\.json$/.test(name))
    .map(name => ({ name: name.slice(6, -5), ...JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
  const report = { source: { trace: input, rawSha256: createHash('sha256').update(bytes).digest('hex'), rawBytes: bytes.length },
    ...analyzeBrowserPresentation(JSON.parse(bytes), probes) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ counts: report.counts, scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([name, value]) => [name, {
    sourceEventCount: value.sourceEventCount, matchedCount: value.matchedCount, missing: value.missing.length,
    ambiguous: value.ambiguous.length, eventTypes: value.eventTypes }])) }, null, 2));
}
