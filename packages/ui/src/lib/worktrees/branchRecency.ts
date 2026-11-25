import { readInstanceScopedItem, writeInstanceScopedItem } from '@/lib/instanceScopedStorage';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const STORAGE_KEY = 'git:recentBranches:v1';
const MAX_DIRECTORIES = 64;
const MAX_BRANCHES_PER_DIRECTORY = 50;

type PersistedDirectoryRecency = {
  updatedAt: number;
  branches: Record<string, number>;
};

type PersistedBranchRecencyMap = Record<string, PersistedDirectoryRecency>;

const normalizeBranchKey = (branch: string): string => branch.trim().replace(/^remotes\//, '');

const readStore = (): PersistedBranchRecencyMap => {
  try {
    const raw = readInstanceScopedItem(STORAGE_KEY, { storage: getDeferredSafeStorage() });
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PersistedBranchRecencyMap;
  } catch {
    return {};
  }
};

const writeStore = (store: PersistedBranchRecencyMap): void => {
  try {
    writeInstanceScopedItem(STORAGE_KEY, JSON.stringify(store), { storage: getDeferredSafeStorage() });
  } catch {
    // Ignore storage quota or privacy-mode failures; recency is best-effort.
  }
};

export const recordRecentBranchUsage = (
  directory: string | null | undefined,
  branch: string | null | undefined,
  at: number = Date.now(),
): void => {
  const dir = normalizePath(directory ?? null);
  const key = typeof branch === 'string' ? normalizeBranchKey(branch) : '';
  if (!dir || !key || !Number.isFinite(at) || at <= 0) return;

  const store = readStore();
  const existing = store[dir]?.branches ?? {};
  const nextBranches: Record<string, number> = {
    ...existing,
    [key]: Math.max(existing[key] ?? 0, Math.trunc(at)),
  };

  const trimmedBranchEntries = Object.entries(nextBranches)
    .filter(([, ts]) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_BRANCHES_PER_DIRECTORY);

  store[dir] = {
    updatedAt: Math.trunc(at),
    branches: Object.fromEntries(trimmedBranchEntries),
  };

  const trimmedDirEntries = Object.entries(store)
    .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
    .slice(0, MAX_DIRECTORIES);

  writeStore(Object.fromEntries(trimmedDirEntries));
};

export const getRecentBranchUsage = (
  directory: string | null | undefined,
): ReadonlyMap<string, number> => {
  const dir = normalizePath(directory ?? null);
  if (!dir) return new Map();
  const entry = readStore()[dir];
  if (!entry?.branches || typeof entry.branches !== 'object') return new Map();
  const map = new Map<string, number>();
  for (const [name, ts] of Object.entries(entry.branches)) {
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
      map.set(name, ts);
    }
  }
  return map;
};

export const resolveBranchRecencyMap = (args: {
  directory?: string | null;
  branchInfo?: Record<string, { lastUsedAt?: number }> | null;
  recentUsage?: ReadonlyMap<string, number> | null;
}): ReadonlyMap<string, number> => {
  const merged = new Map<string, number>();

  if (args.branchInfo) {
    for (const [rawName, info] of Object.entries(args.branchInfo)) {
      const ts = info?.lastUsedAt;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      const normalized = normalizeBranchKey(rawName);
      if (rawName) merged.set(rawName, Math.max(merged.get(rawName) ?? 0, ts));
      if (normalized) merged.set(normalized, Math.max(merged.get(normalized) ?? 0, ts));
    }
  }

  const clientUsage = args.recentUsage ?? (args.directory ? getRecentBranchUsage(args.directory) : null);
  if (clientUsage) {
    for (const [rawName, ts] of clientUsage) {
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const normalized = normalizeBranchKey(rawName);
      if (rawName) merged.set(rawName, Math.max(merged.get(rawName) ?? 0, ts));
      if (normalized) merged.set(normalized, Math.max(merged.get(normalized) ?? 0, ts));
    }
  }

  return merged;
};
