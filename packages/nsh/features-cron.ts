import { CronExpressionParser } from './features-cron-parser.js';

/** Same parser and options as Web lib/cron.ts; only its Node-only barrel is avoided. */
export function isValidCronExpression(expression: string): { valid: boolean; error?: string } {
  if (!expression.trim()) return { valid: false, error: 'required' };
  try {
    CronExpressionParser.parse(expression);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getNextRuns(expression: string, timezone: string, count = 4): Date[] {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(), ...(timezone ? { tz: timezone } : {}),
  });
  return Array.from({ length: count }, () => interval.next().toDate());
}

export type CronFailure = { stage: string; name: string; message: string; stack: string; previous?: CronFailure };
export type CronPreview = { ok: true; dates: Date[]; formatted: string[] } | { ok: false; error: CronFailure };
export function cronFailure(stage: string, error: unknown): CronFailure {
  return error instanceof Error
    ? { stage, name: error.name, message: error.message, stack: error.stack || "" }
    : { stage, name: "Error", message: String(error), stack: "" };
}
export function cronFailureText(error: CronFailure): string {
  return [`${error.stage}: ${error.name}: ${error.message}`, error.stack, error.previous ? cronFailureText(error.previous) : ""].filter(Boolean).join("\n");
}

/** Failure is not an authoritative empty preview; retain the exact failing stage. */
export function cronPreview(expression: string, timezone: string, locale: string, currentDate = new Date()): CronPreview {
  let stage = "parse";
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate, ...(timezone ? { tz: timezone } : {}) });
    const dates: Date[] = [];
    for (let index = 0; index < 4; index++) {
      stage = `next[${index}]`;
      dates.push(interval.next().toDate());
    }
    stage = "format";
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    return { ok: true, dates, formatted: dates.map(date => formatter.format(date)) };
  } catch (error) {
    const failure = cronFailure(stage, error);
    if (stage === "parse") {
      // Luxon's isValidZone catches Intl's original RangeError. Preserve that
      // actual capability exception as well as CronDate's generic outer error.
      try { new Intl.DateTimeFormat(locale, { timeZone: timezone }).format(currentDate); }
      catch (cause) { return { ok: false, error: { ...cronFailure("intl-zone", cause), previous: failure } }; }
    }
    return { ok: false, error: failure };
  }
}

// Web's five examples, not a reduced custom cron dialect or a local scheduler.
export const CRON_EXAMPLES = [
  { expression: '*/5 * * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.every5min' },
  { expression: '0 * * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.everyHour' },
  { expression: '0 9 * * 1', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.monday9am' },
  { expression: '0 9,17 * * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.9am5pm' },
  { expression: '0 0 1 * *', labelKey: 'sessions.scheduledTasks.editor.cronExpression.examples.firstOfMonth' },
] as const;
