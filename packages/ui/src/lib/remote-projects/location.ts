import { normalizeDirectoryKey } from '@/lib/pathNormalization';

/** Identity is never a filesystem path. Keep directory unchanged at the API boundary. */
export interface HostLocation {
  hubId: string;
  hostId?: string;
  directory: string;
}

const REMOTE_LOCATION_PREFIX = 'yuri-remote-location:';
const REMOTE_SESSION_PREFIX = 'yuri-remote-session:';
export const REMOTE_NEW_SESSION_DRAFT_ID = 'remote-new-session';

const requireIdentity = (value: string, name: string): string => {
  if (!value || value !== value.trim() || Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

export const locationKey = (location: HostLocation): string => {
  const directory = normalizeDirectoryKey(location.directory);
  if (!directory) throw new Error('A Location requires a directory');
  if (!location.hostId) return directory;
  return REMOTE_LOCATION_PREFIX + JSON.stringify([
    requireIdentity(location.hubId, 'Hub identity'),
    requireIdentity(location.hostId, 'Host identity'),
    directory,
  ]);
};

/** Only explicit serialized identities are decoded; ordinary directory names stay local. */
export const parseLocationKey = (key: string, localHubId: string): HostLocation => {
  if (!key.startsWith(REMOTE_LOCATION_PREFIX)) return { hubId: localHubId, directory: key };
  const value: unknown = JSON.parse(key.slice(REMOTE_LOCATION_PREFIX.length));
  if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === 'string')) {
    throw new Error('Invalid remote Location key');
  }
  const [hubId, hostId, directory] = value as [string, string, string];
  requireIdentity(hubId, 'Hub identity');
  requireIdentity(hostId, 'Host identity');
  if (!normalizeDirectoryKey(directory)) throw new Error('Invalid Location directory');
  return { hubId, hostId, directory };
};

/** UI state accepts either a local physical directory or an already serialized Location. */
export const normalizeLocationStateKey = (value: string): string => locationKey(parseLocationKey(value, 'local'));

/** Retains existing local session-only persistence keys exactly. */
export const locationSessionKey = (location: HostLocation, sessionId: string): string => {
  requireIdentity(sessionId, 'Session identity');
  if (!location.hostId) return sessionId;
  return REMOTE_SESSION_PREFIX + JSON.stringify([locationKey(location), sessionId]);
};

export const hostApiPath = (hostId: string | undefined, path: string): string => {
  if (!hostId) return path;
  requireIdentity(hostId, 'Host identity');
  if (!(path === '/api' || path.startsWith('/api/') || path === '/health')) {
    throw new Error('Only runtime API paths can be routed to a Remote Host');
  }
  const pathname = path.split('?')[0];
  if (pathname === '/api/hosts' || pathname.startsWith('/api/hosts/')) {
    throw new Error('Nested Remote Host aggregation is not supported');
  }
  return `/api/hosts/${encodeURIComponent(hostId)}${path}`;
};

/** Durable identity excludes transport generation so LAN/Relay reconnects retain drafts. */
export const locationCachePartition = (location: HostLocation): string => (
  location.hostId
    ? JSON.stringify([location.hubId, location.hostId])
    : location.hubId
);
