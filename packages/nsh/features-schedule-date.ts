import { cronFailure, type CronFailure, type CronPreview } from './features-cron';
import { parseWithDateZone, type RuntimeDateZone } from './features-cron-parser.js';
import { record } from './model';

type DateContextRequest = { hostID: string; timeZone: string; startMs: number; endMs: number };
type OffsetEntry = { atMs: number; offsetSeconds: number };
type DateContext = DateContextRequest & { transitions: OffsetEntry[] };
const day = 86_400_000;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

function dateContext(value: unknown, request: DateContextRequest): DateContext {
  const body = record(value);
  if (body.schemaVersion !== 1 || body.hostID !== request.hostID || body.timeZone !== request.timeZone
      || body.startMs !== request.startMs || body.endMs !== request.endMs || !Array.isArray(body.transitions)
      || body.transitions.length < 1 || body.transitions.length > 1024) throw new Error('schedule_date_invalid_context');
  const transitions: OffsetEntry[] = [];
  for (const value of body.transitions) {
    const entry = record(value);
    if (!integer(entry.atMs) || !integer(entry.offsetSeconds) || Math.abs(entry.offsetSeconds) > 86_400
        || entry.atMs < request.startMs || entry.atMs >= request.endMs
        || transitions.length > 0 && entry.atMs <= transitions[transitions.length - 1].atMs) throw new Error('schedule_date_invalid_transition');
    transitions.push({ atMs: entry.atMs, offsetSeconds: entry.offsetSeconds });
  }
  if (transitions[0].atMs !== request.startMs) throw new Error('schedule_date_missing_initial_offset');
  const anchor = record(body.anchor), shifted = new Date(request.startMs + transitions[0].offsetSeconds * 1000);
  if (anchor.timestampMs !== request.startMs || anchor.offsetSeconds !== transitions[0].offsetSeconds
      || anchor.era !== 1 || anchor.year !== shifted.getUTCFullYear() || anchor.month !== shifted.getUTCMonth() + 1
      || anchor.day !== shifted.getUTCDate() || anchor.hour !== shifted.getUTCHours() || anchor.minute !== shifted.getUTCMinutes()
      || anchor.second !== shifted.getUTCSeconds() || anchor.weekday !== shifted.getUTCDay() + 1) throw new Error('schedule_date_invalid_calendar_anchor');
  return { ...request, transitions };
}

class DateContextCoverage extends Error {
  constructor(readonly timestampMs: number) { super(`schedule_date_outside_context: ${timestampMs}`); this.name = 'DateContextCoverage'; }
}
function offsetSeconds(context: DateContext, timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) throw new Error('schedule_date_invalid_timestamp');
  if (timestampMs < context.startMs || timestampMs >= context.endMs) throw new DateContextCoverage(timestampMs);
  let low = 0, high = context.transitions.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (context.transitions[middle].atMs <= timestampMs) low = middle; else high = middle;
  }
  return context.transitions[low].offsetSeconds;
}
function fixedOffset(seconds: number): string {
  if (seconds % 60 !== 0) throw new Error('schedule_date_subminute_offset_requires_formatter');
  const minutes = Math.abs(seconds / 60);
  return `${seconds < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function runtimeZone(context: DateContext): RuntimeDateZone {
  return {
    type: 'foundation', name: context.timeZone, ianaName: context.timeZone, isUniversal: false, isValid: true,
    offset: timestampMs => offsetSeconds(context, timestampMs) / 60,
    offsetName: timestampMs => `UTC${fixedOffset(offsetSeconds(context, timestampMs))}`,
    formatOffset: (timestampMs, format) => {
      const offset = fixedOffset(offsetSeconds(context, timestampMs));
      return format === 'techie' ? offset.replace(':', '') : offset;
    },
    equals: other => other.type === 'foundation' && other.name === context.timeZone,
  };
}

/** Foundation supplies IANA transitions; the unchanged real parser owns all cron/DST iteration. */
export async function foundationCronPreview(options: {
  expression: string; timeZone: string; locale: string; hostID: string; currentDate: Date;
  previous?: CronFailure;
  read: (request: DateContextRequest) => Promise<unknown>;
}): Promise<CronPreview> {
  const now = options.currentDate.getTime();
  let startMs = now - 2 * day, endMs = now + 8 * 366 * day, stage = 'native-context';
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      stage = 'native-context';
      const request = { hostID: options.hostID, timeZone: options.timeZone, startMs, endMs };
      const context = dateContext(await options.read(request), request);
      try {
        stage = 'native-zone-parse';
        const iterator = parseWithDateZone(options.expression, options.currentDate, runtimeZone(context));
        const dates: Date[] = [];
        for (let index = 0; index < 4; index++) {
          stage = `native-zone-next[${index}]`;
          dates.push(iterator.next().toDate());
        }
        stage = 'native-zone-format';
        const formatted = dates.map(date => new Intl.DateTimeFormat(options.locale, {
          timeZone: fixedOffset(offsetSeconds(context, date.getTime())), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        }).format(date));
        return { ok: true, dates, formatted };
      } catch (error) {
        if (!(error instanceof DateContextCoverage)) throw error;
        // A covered interval is never guessed beyond its bounds. Extend authority
        // and restart from the same input time, or report the real range failure.
        startMs = Math.min(startMs, error.timestampMs - 2 * day);
        endMs = Math.max(endMs * 2 - startMs, error.timestampMs + 2 * day);
      }
    }
    throw new Error('schedule_date_coverage_retry_limit');
  } catch (error) {
    return { ok: false, error: { ...cronFailure(stage, error), ...(options.previous ? { previous: options.previous } : {}) } };
  }
}
