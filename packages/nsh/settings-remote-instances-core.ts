import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingEndpointCandidate } from '../ui/src/lib/connectionPayload';
import { settingsObject, settingsRows } from './settings-protocol';
import { text } from './model';

export type NativeRemoteClient = { id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; connected?: boolean; expiresAt?: string | null; pairingId?: string | null; usesRelay?: boolean; lastTransport?: 'relay' | 'direct' | null; deviceName?: string | null; devicePlatform?: string | null };
export type NativePendingPairing = { id: string; label?: string; fingerprint?: string | null; expiresAt?: string; usesRelay?: boolean };
export type NativePairingTransports = { serverName?: string; local: string | null; lan: string | null; relayAvailable: boolean; relayUrl?: string; relayUrls?: string[]; relayUrlLocked?: boolean };
export type NativePairingDraft = { label: string; transport: 'local' | 'lan' | 'relay'; fallback: boolean; relayUrl: string };
const required = (value: unknown) => { if (typeof value !== 'string' || !value) throw new Error('Invalid remote identity'); return value; };
const nullable = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== 'string') throw new Error('Invalid remote timestamp'); return value; };

export function nativeRemoteClients(value: unknown): { clients: NativeRemoteClient[]; currentClientId: string | null } {
  const data = settingsObject(value);
  const clients = settingsRows(data.clients).map(row => {
    const client: NativeRemoteClient = { id: required(row.id), label: typeof row.label === 'string' ? row.label : required(row.label), createdAt: required(row.createdAt), lastUsedAt: nullable(row.lastUsedAt), revokedAt: nullable(row.revokedAt) };
    if (row.connected !== undefined) { if (typeof row.connected !== 'boolean') throw new Error('Invalid live presence'); client.connected = row.connected; }
    if (row.expiresAt !== undefined) client.expiresAt = nullable(row.expiresAt);
    for (const key of ['pairingId', 'deviceName', 'devicePlatform'] as const) if (row[key] !== undefined) client[key] = nullable(row[key]);
    if (row.usesRelay !== undefined) { if (typeof row.usesRelay !== 'boolean') throw new Error('Invalid transport'); client.usesRelay = row.usesRelay; }
    if (row.lastTransport !== undefined) { if (row.lastTransport !== 'relay' && row.lastTransport !== 'direct' && row.lastTransport !== null) throw new Error('Invalid last transport'); client.lastTransport = row.lastTransport; }
    return client;
  });
  return { clients, currentClientId: data.currentClientId === undefined || data.currentClientId === null ? null : required(data.currentClientId) };
}
export function nativePendingPairings(value: unknown): NativePendingPairing[] {
  return settingsRows(settingsObject(value).pending).map(row => {
    const pending: NativePendingPairing = { id: required(row.id) };
    if (typeof row.label === 'string') pending.label = row.label;
    if (row.fingerprint !== undefined) pending.fingerprint = nullable(row.fingerprint);
    if (typeof row.expiresAt === 'string') pending.expiresAt = row.expiresAt;
    if (typeof row.usesRelay === 'boolean') pending.usesRelay = row.usesRelay;
    return pending;
  });
}
function endpoint(value: unknown, protocols: readonly string[]): string {
  const url = new URL(required(value).trim());
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error('Invalid pairing transport');
  url.search = ''; url.hash = ''; return url.toString().replace(/\/$/, '');
}
export function nativePairingTransports(value: unknown): NativePairingTransports {
  const data = settingsObject(value);
  if (typeof data.relayAvailable !== 'boolean' || data.local !== null && typeof data.local !== 'string' || data.lan !== null && typeof data.lan !== 'string') throw new Error('Invalid pairing transports');
  const result: NativePairingTransports = { local: data.local === null ? null : endpoint(data.local, ['http:', 'https:']), lan: data.lan === null ? null : endpoint(data.lan, ['http:', 'https:']), relayAvailable: data.relayAvailable };
  if (typeof data.serverName === 'string') result.serverName = data.serverName;
  if (data.relayUrl !== undefined && data.relayUrl !== null) result.relayUrl = endpoint(data.relayUrl, ['ws:', 'wss:']);
  if (data.relayUrls !== undefined) { if (!Array.isArray(data.relayUrls)) throw new Error('Invalid relay endpoints'); result.relayUrls = data.relayUrls.map(value => endpoint(value, ['ws:', 'wss:'])); }
  if (typeof data.relayUrlLocked === 'boolean') result.relayUrlLocked = data.relayUrlLocked;
  return result;
}
export function nativePairingRequest(draft: NativePairingDraft, transports: NativePairingTransports) {
  let serverUrl: string | undefined, includeRelay = false, includeDirect = true;
  if (draft.transport === 'local') { if (!transports.local) throw new Error('Local transport unavailable'); serverUrl = transports.local; }
  else if (draft.transport === 'lan') { if (!transports.lan) throw new Error('LAN transport unavailable'); serverUrl = transports.lan; includeRelay = transports.relayAvailable && draft.fallback; }
  else if (draft.transport === 'relay') { if (!transports.relayAvailable) throw new Error('Relay unavailable'); includeRelay = true; if (draft.fallback && transports.lan) serverUrl = transports.lan; else includeDirect = false; }
  else throw new Error('Invalid transport selection');
  const relayUrl = includeRelay ? endpoint(transports.relayUrlLocked ? transports.relayUrl : draft.relayUrl, ['ws:', 'wss:']) : undefined;
  return { ...(draft.label.trim() ? { label: draft.label.trim() } : {}), allowedClientKinds: ['mobile', 'desktop'], ...(serverUrl ? { serverUrl } : {}), includeRelay, includeDirect, ...(relayUrl ? { relayUrl } : {}) };
}
/** One-time secret stays only in the live pairing result, never in a list or Storage. */
export function nativePairingLink(value: unknown, label: string): { id: string; url: string; expiresAt?: string } {
  const result = settingsObject(value), pairing = settingsObject(result.pairing), server = settingsObject(result.server);
  const input: Parameters<typeof buildPairingConnectionPayload>[0] = { pairingId: required(pairing.id), secret: required(pairing.secret), label: label.trim() || text(server.label), ...(typeof pairing.fingerprint === 'string' ? { fingerprint: pairing.fingerprint } : {}), ...(typeof pairing.expiresAt === 'string' ? { expiresAt: pairing.expiresAt } : {}), candidates: [] };
  const candidates = settingsRows(server.candidates).map((row): PairingEndpointCandidate => {
    if (row.type === 'lan' || row.type === 'tunnel') return { type: row.type, url: endpoint(row.url, ['http:', 'https:']), ...(typeof row.priority === 'number' ? { priority: row.priority } : {}) };
    if (row.type !== 'relay') throw new Error('Unknown pairing candidate');
    const key = settingsObject(row.hostEncPubJwk);
    if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.d !== undefined) throw new Error('Invalid relay trust anchor');
    return { type: 'relay' as const, relayUrl: endpoint(row.relayUrl, ['ws:', 'wss:']), serverId: required(row.serverId), hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, ...(typeof row.grant === 'string' ? { grant: row.grant } : {}), ...(typeof row.priority === 'number' ? { priority: row.priority } : {}) };
  });
  const payload = buildPairingConnectionPayload({ ...input, candidates });
  return { id: payload.pairingId, url: encodePairingConnectionPayload(payload), ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) };
}
