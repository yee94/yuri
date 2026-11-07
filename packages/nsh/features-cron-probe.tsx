import { mount, Scroll, Text } from 'nsh';
import { CronExpressionParser } from './features-cron-parser.js';
import { cronFailure, cronPreview } from './features-cron';

// Fixed inputs, no Host calls or user configuration. Main owns running this probe.
const currentDate = new Date('2026-03-07T15:00:00Z');
const expression = '0 9 * * MON-FRI';
const report: Record<string, unknown> = {};
function probe(name: string, run: () => unknown) {
  try { report[name] = { ok: true, value: run() }; }
  catch (error) { report[name] = { ok: false, error: cronFailure(name, error) }; }
}
probe('system.resolvedOptions', () => new Intl.DateTimeFormat('en-US').resolvedOptions());
for (const zone of ['UTC', '-05:00', 'America/New_York']) {
  probe(`intl.${zone}.parts`, () => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour12: false, timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', era: 'short',
    });
    return { resolved: formatter.resolvedOptions(), formatted: formatter.format(currentDate), parts: formatter.formatToParts(currentDate) };
  });
  probe(`parser.${zone}.parse`, () => {
    const iterator = CronExpressionParser.parse(expression, { currentDate, tz: zone });
    return iterator.fields.stringify();
  });
  probe(`parser.${zone}.next`, () => {
    const iterator = CronExpressionParser.parse(expression, { currentDate, tz: zone });
    return Array.from({ length: 4 }, () => iterator.next().toDate().toISOString());
  });
  report[`preview.${zone}`] = cronPreview(expression, zone, 'en-US', currentDate);
}
const output = JSON.stringify(report, null, 2);
mount(() => <Scroll class="flex-1" contentClass="p-3"><Text testID="features-cron-probe-report" class="text-foreground">{output}</Text></Scroll>);
