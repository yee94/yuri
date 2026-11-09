import type { ChatTarget, Connection } from './model';

const storageLanes = new Map<string, Promise<unknown>>();

/** Serialize physical receipt reads/writes across retired and remounted owners. */
export function inNativeSessionActionStorageLane<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (storageLanes.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  storageLanes.set(key, next);
  const release = () => { if (storageLanes.get(key) === next) storageLanes.delete(key); };
  void next.then(release, release);
  return next;
}

/** Stable across leases/remounts, isolated across Host edits and session scopes. */
export function nativeSessionActionStorageKey(connection: Pick<Connection, 'id' | 'url' | 'authorizationID'> | null, target: ChatTarget) {
  if (!connection?.id || !connection.url) throw new Error('Session action storage scope unavailable');
  return encodeURIComponent(JSON.stringify([connection.id, connection.url, connection.authorizationID ?? null, target.kind, target.directory, target.id]));
}
