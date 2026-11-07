// Static runtime entry: the package barrel also imports CronFileParser and fs.
// Reuse the already installed UI dependency without pulling that Node-only edge.
import { CronExpressionParser } from '../ui/node_modules/cron-parser/dist/CronExpressionParser.js';
export { CronExpressionParser };

// CronDate passes tz to Luxon's public ZoneLike boundary. Its runtime accepts
// an offset-bearing Zone object; cron-parser's string-only types omit that path.
// The actual 5.5.0 dependency path is regression-tested, never cast in TS.
export function parseWithDateZone(expression, currentDate, zone) {
  return CronExpressionParser.parse(expression, { currentDate, tz: zone });
}
