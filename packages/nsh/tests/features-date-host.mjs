import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Generate an import-free headless host from an actual Foundation capture.
// No hand-coded DST rules, new cron algorithm, engine launch, or runtime writes.
const [capturePath, outputPath] = process.argv.slice(2);
if (!capturePath || !outputPath) throw new Error('Usage: features-date-host.mjs <Foundation-capture.json> <output-host.js>');
const captures = JSON.parse(readFileSync(capturePath, 'utf8'));
if (!Array.isArray(captures) || !captures.length || captures.some(item => item.schemaVersion !== 1 || !Array.isArray(item.transitions) || !item.transitions.length)) throw new Error('Invalid Foundation capture');
const base = readFileSync(fileURLToPath(new URL('./features-host.js', import.meta.url)), 'utf8').replace('export function createHost()', 'function createFeaturesHost()');
const source = `${base}\nconst foundationCaptures = ${JSON.stringify(captures)};
export function createHost() {
  const base = createFeaturesHost();
  return { call(name, input) {
    if (name !== 'schedule.dateContext') return base.call(name, input);
    if (!input || Object.keys(input).sort().join(',') !== 'endMs,hostID,startMs,timeZone'
        || input.hostID !== 'features-fixture' || !Number.isInteger(input.startMs) || !Number.isInteger(input.endMs)
        || input.startMs >= input.endMs) throw new Error('Invalid captured date context request');
    const capture = foundationCaptures.find(item => item.hostID === input.hostID && item.timeZone === input.timeZone
      && item.startMs <= input.startMs && item.endMs >= input.endMs);
    if (!capture) throw new Error('Date context request outside actual Foundation capture');
    const preceding = capture.transitions.filter(item => item.atMs <= input.startMs).at(-1);
    if (!preceding) throw new Error('Foundation capture missing initial offset');
    const transitions = [{ atMs: input.startMs, offsetSeconds: preceding.offsetSeconds },
      ...capture.transitions.filter(item => item.atMs > input.startMs && item.atMs < input.endMs)];
    // Calendar fields projected from the captured, authoritative offset at the exact instant.
    const date = new Date(input.startMs + preceding.offsetSeconds * 1000);
    return { schemaVersion: 1, ...input, transitions,
      anchor: { timestampMs: input.startMs, era: 1, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
        day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(),
        weekday: date.getUTCDay() + 1, offsetSeconds: preceding.offsetSeconds } };
  } };
}\n`;
writeFileSync(outputPath, source);
