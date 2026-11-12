// All 25 spec gates remain independent. Infrastructure tests never mark product gates passed.
const definitions = [
  ['local-zero-work', 'counter', 'New remote requests/subscriptions/timers/polls = 0 without Remote Projects'],
  ['local-startup', 'electron-ios', '>=20 cold starts; sidebar/transcript P50 and P95 regression <=5%'],
  ['existing-regressions', 'counter-browser', 'Existing sidebar/actions/SSE/closed-picker/avatar gates; no relaxed limits or skipped tests'],
  ['offline-startup', 'electron-ios', 'L all remote hosts offline; SQLite sidebar first frame <=110% local control'],
  ['bucket-isolation', 'counter', 'One host/project title/status event; unrelated selectors =0 and same references'],
  ['stream-structure', 'counter', '5 streams/3 hosts; structural recomputes <=real state transitions, not deltas'],
  ['host-row-isolation', 'counter', 'Connection state changes render only matching badge/rows, not project list'],
  ['input-budget', 'electron-ios', '>=50 inputs each local/remote × typing/IME/paste/undo; sync P95<=16ms; input tasks<50ms; paint trace'],
  ['closed-picker', 'counter', '300-entry catalogs; host selectors and directory enumerations =0 while typing'],
  ['picker-demand', 'counter-browser', 'Fetch/cache only when picker opens; text echo never waits for directory'],
  ['cached-transcript', 'electron-ios', 'Click to cached transcript visible <=100ms without connection wait'],
  ['authoritative-open', 'electron-ios', 'Warm LAN/Relay P95<=1s/2s; cold LAN/Relay/SSH<=1.5s/3s/5s'],
  ['proxy-delta', 'production-hub', 'P95 extra proxy delta delay over measured RTT <=50ms'],
  ['reconnect', 'electron-ios', 'Disconnect visible<=2s; recover+backfill<=5s; exact ordered messages'],
  ['weak-network-input', 'electron-ios', 'Real RTT300ms/1% packet loss; P2 input + transcript scroll budgets'],
  ['external-running', 'electron-ios', 'Other client starts session; sidebar busy<=2s on LAN and Relay'],
  ['zero-clients', 'production-hub', 'Observe 600s; all remote connections, requests and timers =0'],
  ['idle-resources', 'production-hub', '5 idle hosts 300s CPU<0.5%; 1 status stream/host; <=10MB (10,000,000 bytes)/stream; no full polls'],
  ['content-limit', 'production-hub', 'Default max8 configurable/shared; LRU only unobserved resources, no silent active-stream eviction; <=30MB (30,000,000 bytes)/content stream; status unaffected'],
  ['fault-isolation', 'production-hub', 'One upstream hangs30s; other hosts requests/refresh P95 regression<=10%'],
  ['refresh-budget', 'counter', 'Global in-flight <=2×existing single-runtime cap; per host <=cap'],
  ['no-hub-content', 'counter', 'Remote messages and parts including transcript-cache persistent rows =0'],
  ['mobile-socket', 'ios', 'One phone->Hub realtime connection independent of host count'],
  ['mobile-lifecycle', 'ios', 'Background releases content within existing grace; foreground latest<=2s warm Hub'],
  ['mobile-scroll', 'ios', 'L list scroll no>=50ms task and no regression vs same-size local control'],
];
export const gates = definitions.map(([key, kind, requirement], i) => ({ id: i + 1, key, kind, requirement }));

export function distribution(values) {
  if (!Array.isArray(values) || !values.length || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Expected nonempty finite nonnegative samples');
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}

export function validateEvidence(record) {
  const errors = [];
  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!['baseline', 'candidate'].includes(record.phase)) errors.push('phase required');
  for (const key of ['runtime', 'device', 'os', 'runtimeVersion', 'build', 'datasetHash', 'command', 'measurement']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) errors.push(`${key} required`);
  }
  if (!['counter', 'electron', 'ios', 'production-hub', 'browser-diagnostic'].includes(record.runtime)) errors.push('invalid runtime');
  if (record.production !== true && record.runtime !== 'counter') errors.push('Timing requires production build');
  if (!Number.isInteger(record.gate) || record.gate < 1 || record.gate > 25) errors.push('gate 1..25 required');
  if (!['measured', 'unverified', 'blocked'].includes(record.status)) errors.push('status invalid (pass is decided from full gate coverage, not supplied)');
  if (record.status === 'measured') {
    if (!Array.isArray(record.artifacts) || !record.artifacts.length) errors.push('raw artifacts required');
    if (!record.metrics || !Object.keys(record.metrics).length) errors.push('metrics required');
    for (const [name, metric] of Object.entries(record.metrics ?? {})) {
      if (!metric || typeof metric !== 'object') { errors.push(`${name}: metric object required`); continue; }
      try { distribution(metric.samples); } catch { errors.push(`${name}: raw finite samples required`); }
      if (!metric.unit) errors.push(`${name}: unit required`);
    }
  } else if (!record.reason) errors.push('unverified/blocked reason required');
  return errors;
}
