import { record, text, type Row } from './model';

export type IntegrationFormValue = string | number | boolean | string[];
export type IntegrationFormDraft = Record<string, IntegrationFormValue>;
export type IntegrationFormResult = { visible: Row[]; answer: IntegrationFormDraft; invalid: string[] };
const types = new Set(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** Matches @opencode/schema/form: earlier-field AND conditions; multi-select eq means inclusion.
 * `hidden` means use the default without an interactive prompt, not a password field.
 */
export function integrationForm(fields: Row[], draft: IntegrationFormDraft): IntegrationFormResult {
  const known = new Map<string, Row>(), active = new Set<string>();
  const answer: IntegrationFormDraft = Object.create(null);
  const visible: Row[] = [], invalid: string[] = [];
  for (const field of fields) {
    const key = text(field.key), type = text(field.type);
    if (!key || known.has(key) || !types.has(type)) throw new Error('Invalid integration form');
    const conditions = field.when === undefined ? [] : field.when;
    if (!Array.isArray(conditions)) throw new Error('Invalid integration form conditions');
    const enabled = conditions.every(raw => {
      const condition = record(raw), dependency = text(condition.key);
      if (!known.has(dependency) || !['eq', 'neq'].includes(text(condition.op)) || !scalar(condition.value)) throw new Error('Invalid integration form dependency');
      if (!active.has(dependency) || !owns(answer, dependency)) return false;
      const previous = answer[dependency];
      const equal = Array.isArray(previous) ? previous.includes(String(condition.value)) : previous === condition.value;
      return condition.op === 'eq' ? equal : !equal;
    });
    known.set(key, field);
    if (!enabled) continue;
    active.add(key);
    if (field.hidden !== true) visible.push(field);
    if (type === 'external') continue;
    const raw = owns(draft, key) ? draft[key] : field.default;
    if (raw === undefined || ((type === 'number' || type === 'integer') && raw === '')) {
      if (field.required === true) invalid.push(key);
      continue;
    }
    let value: IntegrationFormValue | undefined;
    let valid = true;
    if (type === 'number' || type === 'integer') {
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN;
      valid = Number.isFinite(number) && (type !== 'integer' || Number.isInteger(number)) && (field.minimum === undefined || number >= Number(field.minimum)) && (field.maximum === undefined || number <= Number(field.maximum));
      value = number;
    } else if (type === 'boolean') {
      valid = typeof raw === 'boolean';
      if (valid) value = raw as boolean;
    } else if (type === 'multiselect') {
      const options = Array.isArray(field.options) ? field.options.map(option => text(record(option).value)) : [];
      valid = Array.isArray(raw) && raw.every(item => typeof item === 'string' && (field.custom === true || options.includes(item))) && new Set(raw).size === raw.length && (field.required !== true || raw.length > 0) && (field.minItems === undefined || raw.length >= Number(field.minItems)) && (field.maxItems === undefined || raw.length <= Number(field.maxItems));
      if (valid) value = [...raw as string[]];
    } else {
      const options = Array.isArray(field.options) ? field.options.map(option => text(record(option).value)) : [];
      valid = typeof raw === 'string';
      if (valid) {
        value = raw as string;
        valid = (field.required !== true || !!value.trim()) && (field.minLength === undefined || value.length >= Number(field.minLength)) && (field.maxLength === undefined || value.length <= Number(field.maxLength)) && (!options.length || field.custom === true || !value || options.includes(value));
        if (valid && field.pattern !== undefined) valid = new RegExp(String(field.pattern)).test(value);
        if (valid && value && field.format === 'email') valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (valid && value && field.format === 'uri') { try { new URL(value); } catch { valid = false; } }
        if (valid && value && (field.format === 'date' || field.format === 'date-time')) valid = Number.isFinite(Date.parse(value));
      }
    }
    if (!valid || value === undefined) invalid.push(key);
    else answer[key] = value;
  }
  return { visible, answer, invalid };
}
