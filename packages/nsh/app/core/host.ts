import { host } from 'nsh';

export type Row = Record<string, unknown>;

export const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
export const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
export const unwrap = (value: unknown): unknown => record(value).data ?? value;

export type Connection = {
  id: string;
  label: string;
  url: string;
  transport?: string;
  lastUsedAt: number;
  authorizationID?: string;
  transportID?: string;
};

/** The native-issued authority every request carries (Swift `RuntimeHostScope`). */
export type RuntimeScope = { hostID: string; lease: string };

export type ConnectionSnapshot = {
  connections: Connection[];
  selected: string | null;
  runtimeScope: RuntimeScope | null;
};

export type RuntimeEvent = {
  key: 'global' | 'chat';
  type: string;
  body: Row;
  directory: string;
  id?: string;
};

let scope: RuntimeScope | null = null;
export const currentScope = (): RuntimeScope | null => scope;

// Dev entry seam: the device dev host has no page host (`nsh run/test --target`),
// so `app/dev/App.tsx` installs the in-process mock instead. Never set by the
// production entry.
type DevAdapter = { call(name: string, input?: unknown): Promise<unknown> | unknown };
let devAdapter: DevAdapter | null = null;
const devListeners = new Map<string, Set<(payload: unknown) => void>>();

export function installDevHost(adapter: DevAdapter): void {
  devAdapter = adapter;
}

/** The mock host pushes its events back through here. */
export function devHostEmit(event: string, payload: unknown): void {
  devListeners.get(event)?.forEach((handler) => handler(payload));
}

function onHostEvent(event: string, handler: (payload: unknown) => void): () => void {
  if (devAdapter) {
    let set = devListeners.get(event);
    if (!set) devListeners.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }
  return host.on(event, handler);
}

export async function native<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  if (devAdapter) return (await devAdapter.call(name, body)) as T;
  if (!host.available()) throw new Error('This build requires the Yuri native host');
  return (await host.call(name, body)) as T;
}

export const connectionSnapshotFrom = (value: unknown): ConnectionSnapshot => {
  const fields = record(value);
  if (!Array.isArray(fields.connections)) throw new Error('Invalid connection list');
  const connections = fields.connections.map((entry) => {
    const row = record(entry);
    if (!textOf(row.id) || !textOf(row.url)) throw new Error('Invalid connection');
    return {
      id: textOf(row.id),
      label: textOf(row.label) || textOf(row.url),
      url: textOf(row.url),
      transport: textOf(row.transport) || undefined,
      lastUsedAt: typeof row.lastUsedAt === 'number' ? row.lastUsedAt : 0,
      ...(textOf(row.authorizationID) ? { authorizationID: textOf(row.authorizationID) } : {}),
      ...(textOf(row.transportID) ? { transportID: textOf(row.transportID) } : {}),
    };
  });
  const selected = textOf(fields.selected) || null;
  if (selected && !connections.some((connection) => connection.id === selected)) throw new Error('Invalid connection selection');
  const raw = record(fields.runtimeScope);
  const runtimeScope =
    textOf(raw.hostID) && textOf(raw.lease) ? { hostID: textOf(raw.hostID), lease: textOf(raw.lease) } : null;
  return { connections, selected, runtimeScope };
};

export async function readConnections(): Promise<ConnectionSnapshot> {
  const snapshot = connectionSnapshotFrom(await native('connection.list'));
  scope = snapshot.runtimeScope;
  return snapshot;
}

export async function selectConnection(id: string): Promise<ConnectionSnapshot> {
  const snapshot = connectionSnapshotFrom(await native('connection.select', { id }));
  scope = snapshot.runtimeScope;
  return snapshot;
}

export async function removeConnection(id: string): Promise<ConnectionSnapshot> {
  const snapshot = connectionSnapshotFrom(await native('connection.remove', { id }));
  scope = snapshot.runtimeScope;
  return snapshot;
}

export type ConnectInput = {
  pairingLink?: string;
  url?: string;
  password?: string;
  token?: string;
  label?: string;
};

export async function connect(input: ConnectInput): Promise<ConnectionSnapshot> {
  const value = record(await native('connection.connect', { ...input }));
  const snapshot = connectionSnapshotFrom(value);
  scope = snapshot.runtimeScope;
  return snapshot;
}

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The official OpenCode/Yuri wire through Swift (`runtime.request`). */
export async function request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const verb = method.toUpperCase();
  const expected = scope;
  if (verb !== 'GET' && !expected) throw new RequestError(0, 'Connection is not ready');
  const result = record(
    await native('runtime.request', {
      path,
      method: verb,
      ...(body === undefined ? {} : { body }),
      ...(expected ? { expectedHost: expected } : {}),
    }),
  );
  const status = typeof result.status === 'number' ? result.status : 0;
  if (status < 200 || status >= 300) {
    const payload = record(result.body);
    throw new RequestError(status, textOf(payload.message) || textOf(payload.error) || `HTTP ${status}`);
  }
  return result.body as T;
}

export function runtimeEventFrom(payload: unknown): RuntimeEvent | null {
  const value = record(payload);
  if (value.key !== 'global' && value.key !== 'chat') return null;
  if (value.type === 'reconnected') return { key: value.key, type: 'reconnected', body: {}, directory: '' };
  if (typeof value.data !== 'string') return null;
  try {
    const envelope = record(JSON.parse(value.data));
    const event = envelope.payload ? record(envelope.payload) : envelope;
    const type = textOf(event.type);
    if (!type) return null;
    const body = record(event.data && typeof event.data === 'object' ? event.data : event.properties ?? event);
    return {
      key: value.key,
      type: type.replace(/\.\d+$/, ''),
      body,
      directory:
        textOf(envelope.directory) ||
        textOf(body.directory) ||
        textOf(record(event.location).directory) ||
        textOf(record(event.location).path),
      id: textOf(event.id) || undefined,
    };
  } catch {
    return null;
  }
}

/** One more consumer of the host event channel; opens no stream of its own, so a
    remote transcript can read the Hub's `yuri:host-event` frames the global
    stream already receives (Web `registry.subscribeEvents`). */
export function onHostRuntimeEvent(handler: (payload: unknown) => void): () => void {
  return onHostEvent('runtime.event', handler);
}

/** Global event stream (`/api/yuri/events`), scoped to the current connection. */
export function startStream(options: {
  path: string;
  onEvent: (event: RuntimeEvent) => void;
  onStatus: (status: 'live' | 'disconnected') => void;
}): () => void {
  const expected = scope;
  const offEvent = onHostEvent('runtime.event', (payload) => {
    const event = runtimeEventFrom(payload);
    if (event) options.onEvent(event);
  });
  const offDisconnected = onHostEvent('runtime.disconnected', () => options.onStatus('disconnected'));
  void native('runtime.stream', { path: options.path, key: 'global', ...(expected ? { expectedHost: expected } : {}) })
    .then(() => options.onStatus('live'))
    .catch(() => options.onStatus('disconnected'));
  return () => {
    offEvent();
    offDisconnected();
    void native('runtime.stop', { key: 'global', ...(expected ? { expectedHost: expected } : {}) }).catch(() => {});
  };
}

export const query = (directory: string) => `directory=${encodeURIComponent(directory)}`;
export const sessionPath = (sessionID: string, suffix: string) =>
  `/api/session/${encodeURIComponent(sessionID)}/${suffix}`;

/** One session's event stream (`/api/event`), the live transcript channel. */
export function startChatStream(options: {
  directory: string;
  ownerID: string;
  onEvent: (event: RuntimeEvent) => void;
  onStatus: (status: 'live' | 'disconnected') => void;
}): () => void {
  const expected = scope;
  const offEvent = onHostEvent('runtime.event', (payload) => {
    const envelope = record(payload);
    if (envelope.key !== 'chat') return;
    const ownerID = textOf(envelope.ownerID);
    if (ownerID && ownerID !== options.ownerID) return;
    const event = runtimeEventFrom({ ...envelope, key: 'chat' });
    if (event) options.onEvent(event);
  });
  const offDisconnected = onHostEvent('runtime.disconnected', () => options.onStatus('disconnected'));
  void native('runtime.stream', {
    path: `/api/event?${query(options.directory)}`,
    key: 'chat',
    mode: 'auto',
    ownerID: options.ownerID,
    ...(expected ? { expectedHost: expected } : {}),
  })
    .then(() => options.onStatus('live'))
    .catch(() => options.onStatus('disconnected'));
  return () => {
    offEvent();
    offDisconnected();
    void native('runtime.stop', {
      key: 'chat',
      ownerID: options.ownerID,
      ...(expected ? { expectedHost: expected } : {}),
    }).catch(() => {});
  };
}
