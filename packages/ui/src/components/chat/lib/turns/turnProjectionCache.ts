import type { ChatMessageEntry, TurnProjectionResult } from './types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const TURN_PROJECTION_CACHE_MAX = 30;
const VSCODE_TURN_PROJECTION_CACHE_MAX = 4;
const MOBILE_TURN_PROJECTION_CACHE_MAX = 4;
const TURN_PROJECTION_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CONSTRAINED_TURN_PROJECTION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const projectionCache = new Map<string, TurnProjectionResult>();
const projectionCacheBytes = new Map<string, number>();
let projectionCacheByteSize = 0;
const objectVersionByRef = new WeakMap<object, number>();
let nextObjectVersion = 1;

const getProjectionCacheMax = () => {
  if (isVSCodeRuntime()) return VSCODE_TURN_PROJECTION_CACHE_MAX;
  if (isMobileSurfaceRuntime()) return MOBILE_TURN_PROJECTION_CACHE_MAX;
  return TURN_PROJECTION_CACHE_MAX;
};

const getProjectionCacheMaxBytes = (): number => (
  isVSCodeRuntime() || isMobileSurfaceRuntime()
    ? CONSTRAINED_TURN_PROJECTION_CACHE_MAX_BYTES
    : TURN_PROJECTION_CACHE_MAX_BYTES
);

const estimateProjectionBytes = (key: string, projection: TurnProjectionResult): number => {
  let bytes = key.length * 2 + 256;
  for (const turn of projection.turns) {
    bytes += 512;
    bytes += turn.messages.length * 160;
    bytes += turn.activityParts.length * 128;
    bytes += (turn.changedFiles?.length ?? 0) * 160;
    bytes += (turn.summaryText?.length ?? 0) * 2;
  }
  return bytes;
};

const deleteProjectionCacheEntry = (key: string): void => {
  projectionCache.delete(key);
  const bytes = projectionCacheBytes.get(key) ?? 0;
  projectionCacheBytes.delete(key);
  projectionCacheByteSize = Math.max(0, projectionCacheByteSize - bytes);
};

const getObjectVersion = (value: object): number => {
  const cached = objectVersionByRef.get(value);
  if (cached !== undefined) return cached;
  const next = nextObjectVersion;
  nextObjectVersion += 1;
  objectVersionByRef.set(value, next);
  return next;
};

const buildMessagesVersionSignature = (messages: ChatMessageEntry[]): string => {
  return messages.map((message) => {
    const infoVersion = getObjectVersion(message.info as object);
    const partsVersion = getObjectVersion(message.parts);
    const partVersions = message.parts.map((part) => getObjectVersion(part as object)).join(',');
    return `${infoVersion}:${partsVersion}:${partVersions}`;
  }).join(';');
};

export const buildProjectionCacheKey = (
  sessionKey: string,
  messages: ChatMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  workspaceDirectoriesKey = '',
): string => {
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastMessageId = lastMessage?.info?.id ?? '';
  const lastMessagePartCount = lastMessage?.parts?.length ?? 0;
  return [
    sessionKey,
    messages.length,
    lastMessageId,
    lastMessagePartCount,
    buildMessagesVersionSignature(messages),
    showTextJustificationActivity ? '1' : '0',
    showTurnChangedFiles ? '1' : '0',
    workspaceDirectoriesKey,
  ].join('|');
};

export const getCachedProjectionByKey = (key: string): TurnProjectionResult | undefined => {
  const cached = projectionCache.get(key);
  if (cached) {
    // LRU re-order: move hit to the end (most recent) so it survives
    // eviction longer than entries that haven't been read recently.
    projectionCache.delete(key);
    projectionCache.set(key, cached);
  }
  return cached;
};

export const setCachedProjection = (
  key: string,
  projection: TurnProjectionResult,
): void => {
  deleteProjectionCacheEntry(key);
  const max = getProjectionCacheMax();
  const maxBytes = getProjectionCacheMaxBytes();
  const bytes = estimateProjectionBytes(key, projection);
  if (bytes > maxBytes) {
    return;
  }
  while (projectionCache.size >= max || projectionCacheByteSize + bytes > maxBytes) {
    const oldest = projectionCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    deleteProjectionCacheEntry(oldest);
  }
  projectionCache.set(key, projection);
  projectionCacheBytes.set(key, bytes);
  projectionCacheByteSize += bytes;
};
