// The adjacent real JS module re-exports this exact class from its pure entry.
// Use the installed package's canonical public types, not an invented module shim.
export { CronExpressionParser } from '../ui/node_modules/cron-parser';
import type { CronExpressionParser } from '../ui/node_modules/cron-parser';
export interface RuntimeDateZone {
  readonly type: string;
  readonly name: string;
  readonly ianaName: string;
  readonly isUniversal: boolean;
  readonly isValid: boolean;
  offset(timestampMs: number): number;
  offsetName(timestampMs: number, options: { format: string; locale: string }): string;
  formatOffset(timestampMs: number, format: string): string;
  equals(other: { type?: string; name?: string }): boolean;
}
export function parseWithDateZone(expression: string, currentDate: Date, zone: RuntimeDateZone): ReturnType<typeof CronExpressionParser.parse>;
