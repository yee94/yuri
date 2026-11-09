import { host } from 'nsh';
import { record, type Connection } from './model';
import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { beginDesktopWriterDispatch, desktopWriterNotDispatched, DesktopWriterError, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
export async function native<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!host.available()) throw new Error('This build requires the Yuri native host');
  return await host.call(name, body) as T;
}
/**
 * SDK gap: NSH cannot bundle the OpenCode SDK. This narrow native boundary keeps
 * the same official v2 shallow-proxy method/path/query/JSON wire as UI sync APIs.
 * Swift owns Keychain, Authorization, JSON headers and connection fencing; no
 * credential or endpoint is cached by the JS request layer.
 */
export type RawNativeResponse = { status: number; body: unknown };
/** Capture once at owner creation; every continuation keeps this same immutable lease. */
export function bindRawRequest(scope: RuntimeScope | null, writer?: () => VerifiedDesktopWriterGrant | null) {
  const expectedHost = runtimeScopeFrom(scope);
  return async (path: string, method = 'GET', body?: unknown): Promise<RawNativeResponse> => {
    const verb = method.toUpperCase();
    if (!/^[A-Z]+$/.test(verb)) throw new Error('invalid_http_method');
    if (verb !== 'GET' && !expectedHost) throw new Error('scope_required');
    const permit = beginDesktopWriterDispatch({ writer, expectedHost, path, method: verb, body });
    if (permit && !permit.current()) { permit.finish('not-dispatched'); throw new DesktopWriterError('stale', 'not-dispatched'); }
    try {
      const result = await native<RawNativeResponse>('runtime.request', { path, method: verb, ...(body === undefined ? {} : { body }), ...(expectedHost ? { expectedHost } : {}), ...(permit ? { writerGrant: permit.grantID } : {}) });
      if (permit && !permit.current()) throw new DesktopWriterError('stale', 'unknown');
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599 || !Object.prototype.hasOwnProperty.call(result, 'body') || permit && Object.keys(result).sort().join(',') !== 'body,status') throw new Error('Invalid native response');
      permit?.finish(result.status >= 200 && result.status < 300 ? 'confirmed' : 'unknown');
      return result;
    } catch (cause) { permit?.finish(desktopWriterNotDispatched(cause) ? 'not-dispatched' : 'unknown'); throw cause; }
  };
}
export function bindRequest(scope: RuntimeScope | null, writer?: () => VerifiedDesktopWriterGrant | null) {
  const raw = bindRawRequest(scope, writer);
  return async (path: string, method = 'GET', body?: unknown): Promise<unknown> => responseBody(await raw(path, method, body));
}
function responseBody(result: RawNativeResponse): unknown {
  if (result.status < 200 || result.status >= 300) {
    const error = new Error(`HTTP ${result.status}: ${String(record(result.body).message || record(result.body).error || '')}`) as Error & { status: number };
    error.status = result.status;
    throw error;
  }
  return result.body;
}
/** Legacy unbound reads only. Never infer current write authority here. */
export const request = bindRequest(null);
export type ConnectionSnapshot = { connections: Connection[]; selected: string | null; runtimeScope: RuntimeScope | null };
export function connectionSnapshotFrom(value: unknown): ConnectionSnapshot {
  const fields = record(value);
  if (!Array.isArray(fields.connections) || !(fields.selected === null || typeof fields.selected === 'string')) throw new Error('Invalid connection snapshot');
  const entries = fields.connections.map(entry => {
    const connection = record(entry);
    if (typeof connection.id !== 'string' || !connection.id || typeof connection.url !== 'string' || !connection.url) throw new Error('Invalid connection snapshot');
    if (connection.authorizationID !== undefined && (typeof connection.authorizationID !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(connection.authorizationID))) throw new Error('Invalid connection authorization');
    return connection as Connection;
  });
  if (fields.selected !== null && !entries.some(entry => entry.id === fields.selected)) throw new Error('Invalid connection selection');
  const runtimeScope = runtimeScopeFrom(fields.runtimeScope);
  if (runtimeScope && runtimeScope.hostID !== fields.selected) throw new Error('Invalid connection runtime scope');
  return { connections: entries, selected: fields.selected, runtimeScope };
}
export const connections = async (): Promise<ConnectionSnapshot> => connectionSnapshotFrom(await native('connection.list'));
export const query = (directory: string) => `directory=${encodeURIComponent(directory)}`;
export const sessionPath = (sessionID: string, suffix: string) => `/api/session/${encodeURIComponent(sessionID)}/${suffix}`;
export const assistantPath = (assistantID: string, suffix: string) => `/api/yuri/assistants/${encodeURIComponent(assistantID)}/${suffix}`;
