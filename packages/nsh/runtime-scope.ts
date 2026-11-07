/** Native-issued authority, not a JS epoch or a connection identifier alone. */
export type RuntimeScope = Readonly<{ hostID: string; lease: string }>;

export function runtimeScopeFrom(value: unknown): RuntimeScope | null {
  // Missing on old native builds: read-only compatibility, never write authority.
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_runtime_scope');
  const fields = value as Record<string, unknown>;
  const valid = (field: unknown): field is string => typeof field === 'string' && field.length > 0 && field.trim() === field;
  if (!Object.prototype.hasOwnProperty.call(fields, 'hostID') || !Object.prototype.hasOwnProperty.call(fields, 'lease') || !valid(fields.hostID) || !valid(fields.lease) || Object.keys(fields).some(key => key !== 'hostID' && key !== 'lease')) throw new Error('invalid_runtime_scope');
  return Object.freeze({ hostID: fields.hostID, lease: fields.lease });
}

export function sameRuntimeScope(left: RuntimeScope | null, right: RuntimeScope | null): boolean {
  return left === null || right === null ? left === right : left.hostID === right.hostID && left.lease === right.lease;
}
