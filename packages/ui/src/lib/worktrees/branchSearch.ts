import { scoreTextAgainstQuery } from '@/lib/search/fuzzySearch';

export const DEFAULT_BRANCH_RENDER_LIMIT = 100;

const BOUNDARY_CHARS = new Set(['/', '-', '_', '.', ' ', ':', '\\']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface BranchRecencySource {
  lastUsedAt?: number;
}

export interface RankedBranchItem {
  label: string;
  value: string;
  source: 'local' | 'remote';
}

export interface RankedBranchGroups {
  matching: RankedBranchItem[];
  otherLocal: string[];
  otherRemote: string[];
}

const stripRemotePrefix = (branch: string): string => {
  const withoutRemotes = branch.replace(/^remotes\//, '');
  const slash = withoutRemotes.indexOf('/');
  return slash > 0 && slash < withoutRemotes.length - 1
    ? withoutRemotes.slice(slash + 1)
    : withoutRemotes;
};

const lookupRecency = (
  branch: string,
  source: 'local' | 'remote',
  branchRecency?: ReadonlyMap<string, number> | Record<string, BranchRecencySource> | null,
): number => {
  if (!branchRecency) return 0;
  const remotePrefixed = source === 'remote' ? `remotes/${branch}` : branch;
  const shortName = source === 'remote' ? stripRemotePrefix(branch) : branch;

  if (branchRecency instanceof Map) {
    return Math.max(
      branchRecency.get(remotePrefixed) ?? 0,
      branchRecency.get(branch) ?? 0,
      source === 'remote' ? (branchRecency.get(shortName) ?? 0) * 0.5 : 0,
    );
  }

  const record = branchRecency as Record<string, BranchRecencySource>;
  const direct = record[remotePrefixed]?.lastUsedAt ?? record[branch]?.lastUsedAt ?? 0;
  return Number.isFinite(direct) && direct > 0 ? direct : 0;
};

/**
 * Smooth monotonic recency bonus in [0, 0.38] subtracted from match score
 * (lower score is better). Never allows a weak subsequence match to outrank an
 * exact match, while lifting recently used branches above stale matches in the
 * same or neighboring relevance tier.
 */
const computeRecencyBoost = (timestampMs: number, nowMs: number): number => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 0;
  const ageMs = Math.max(0, nowMs - timestampMs);
  if (ageMs <= HOUR_MS) return 0.38;
  if (ageMs <= DAY_MS) return 0.32;
  if (ageMs <= 7 * DAY_MS) return 0.24;
  if (ageMs <= 30 * DAY_MS) return 0.16;
  if (ageMs <= 90 * DAY_MS) return 0.1;
  if (ageMs <= 365 * DAY_MS) return 0.05;
  return 0.01;
};

/**
 * Score a branch text against multi-token queries such as "feat sidebar" or
 * "origin/auth fix". Every token must appear in the target; tokens at segment
 * boundaries and in query order score better.
 */
const scoreMultiTokenMatch = (lowerText: string, tokens: readonly string[]): number | null => {
  if (tokens.length < 2) return null;
  let lastIndex = -1;
  let inOrder = true;
  let boundaryHits = 0;
  let totalIndex = 0;

  for (const token of tokens) {
    // Prefer an occurrence after the previous token to preserve reading order.
    let idx = lastIndex >= 0 ? lowerText.indexOf(token, lastIndex) : lowerText.indexOf(token);
    if (idx < 0) {
      idx = lowerText.indexOf(token);
      if (idx < 0) return null;
      inOrder = false;
    }
    if (idx === 0 || BOUNDARY_CHARS.has(lowerText[idx - 1] ?? '')) {
      boundaryHits += 1;
    }
    totalIndex += idx;
    lastIndex = idx + token.length;
  }

  const boundaryRatio = boundaryHits / tokens.length;
  const orderPenalty = inOrder ? 0 : 0.12;
  const boundaryBonus = (1 - boundaryRatio) * 0.15;
  return 0.65 + orderPenalty + boundaryBonus + Math.min(totalIndex / 2000, 0.08) + lowerText.length / 1e4;
};

/**
 * Fast O(N) ordered subsequence match (e.g. "fsw" -> "feat/sidebar-worktree").
 * Rewards consecutive characters and segment-boundary hits so abbreviations
 * stay responsive even across 10,000+ branches without Fuse overhead.
 */
const scoreSubsequenceMatch = (lowerText: string, compactQuery: string): number | null => {
  if (!compactQuery || compactQuery.length > lowerText.length) return null;

  let qIdx = 0;
  let firstMatch = -1;
  let prevMatch = -1;
  let consecutive = 0;
  let boundaryHits = 0;
  let gaps = 0;

  for (let i = 0; i < lowerText.length && qIdx < compactQuery.length; i++) {
    if (lowerText[i] !== compactQuery[qIdx]) continue;
    if (firstMatch < 0) firstMatch = i;
    if (prevMatch >= 0) {
      const gap = i - prevMatch - 1;
      if (gap === 0) consecutive += 1;
      else gaps += gap;
    }
    if (i === 0 || BOUNDARY_CHARS.has(lowerText[i - 1] ?? '')) {
      boundaryHits += 1;
    }
    prevMatch = i;
    qIdx += 1;
  }

  if (qIdx < compactQuery.length) return null;

  const span = prevMatch - firstMatch + 1;
  const density = compactQuery.length / Math.max(span, 1);
  const boundaryRatio = boundaryHits / compactQuery.length;
  const consecutiveRatio = compactQuery.length > 1 ? consecutive / (compactQuery.length - 1) : 1;

  // Reject extremely scattered random character coincidences on very long names
  // when neither boundaries nor consecutive runs match well.
  if (compactQuery.length >= 4 && boundaryRatio < 0.25 && consecutiveRatio < 0.25 && density < 0.22) {
    return null;
  }

  return (
    1.15
    + (1 - boundaryRatio) * 0.3
    + (1 - consecutiveRatio) * 0.25
    + Math.min(gaps / 200, 0.2)
    + lowerText.length / 1e4
  );
};

const scoreSingleBranchText = (
  text: string,
  queryLower: string,
  tokens: readonly string[],
  compactQuery: string,
): number | null => {
  if (!text) return null;
  const lower = text.toLowerCase();

  const substringScore = scoreTextAgainstQuery(lower, queryLower);
  if (substringScore !== null) {
    return substringScore;
  }

  const tokenScore = scoreMultiTokenMatch(lower, tokens);
  if (tokenScore !== null) {
    return tokenScore;
  }

  return scoreSubsequenceMatch(lower, compactQuery);
};

const scoreBranchMatch = (
  branch: string,
  source: 'local' | 'remote',
  queryLower: string,
  tokens: readonly string[],
  compactQuery: string,
): number | null => {
  const fullScore = scoreSingleBranchText(branch, queryLower, tokens, compactQuery);
  if (source !== 'remote') {
    return fullScore;
  }

  const shortName = stripRemotePrefix(branch);
  if (shortName === branch) {
    return fullScore;
  }

  const shortScore = scoreSingleBranchText(shortName, queryLower, tokens, compactQuery);
  if (shortScore === null) return fullScore;
  // Slightly prefer direct full-ref exact match over short-name match on ties.
  const adjustedShort = shortScore + 0.0005;
  if (fullScore === null) return adjustedShort;
  return Math.min(fullScore, adjustedShort);
};

export function sortBranchesByRecency(args: {
  branches: readonly string[];
  source?: 'local' | 'remote';
  currentBranch?: string | null;
  branchRecency?: ReadonlyMap<string, number> | Record<string, BranchRecencySource> | null;
}): string[] {
  const { branches, source = 'local', currentBranch, branchRecency } = args;
  const normalizedCurrent = currentBranch?.trim() || null;

  return [...branches].sort((a, b) => {
    if (source === 'local' && normalizedCurrent) {
      if (a === normalizedCurrent && b !== normalizedCurrent) return -1;
      if (b === normalizedCurrent && a !== normalizedCurrent) return 1;
    }

    const aTs = lookupRecency(a, source, branchRecency);
    const bTs = lookupRecency(b, source, branchRecency);
    if (aTs !== bTs) {
      return bTs - aTs;
    }

    return a.localeCompare(b, undefined, { sensitivity: 'accent' });
  });
}

export function rankBranchesForQuery(args: {
  localBranches: string[];
  remoteBranches: string[];
  query: string;
  currentBranch?: string | null;
  branchRecency?: ReadonlyMap<string, number> | Record<string, BranchRecencySource> | null;
  now?: number;
}): RankedBranchGroups {
  const { localBranches, remoteBranches, query, currentBranch, branchRecency } = args;
  const normalizedQuery = query.trim();

  const orderedLocal = branchRecency || currentBranch
    ? sortBranchesByRecency({ branches: localBranches, source: 'local', currentBranch, branchRecency })
    : localBranches;
  const orderedRemote = branchRecency
    ? sortBranchesByRecency({ branches: remoteBranches, source: 'remote', branchRecency })
    : remoteBranches;

  if (!normalizedQuery) {
    return {
      matching: [],
      otherLocal: orderedLocal,
      otherRemote: orderedRemote,
    };
  }

  const nowMs = args.now ?? Date.now();
  const queryLower = normalizedQuery.toLowerCase();
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  const compactQuery = queryLower.replace(/\s+/g, '');

  const localMatched = new Set<string>();
  const remoteMatched = new Set<string>();

  const scored: Array<{
    label: string;
    value: string;
    source: 'local' | 'remote';
    score: number;
    recency: number;
  }> = [];

  for (const branch of orderedLocal) {
    const textScore = scoreBranchMatch(branch, 'local', queryLower, tokens, compactQuery);
    if (textScore === null) continue;
    localMatched.add(branch);
    const recency = lookupRecency(branch, 'local', branchRecency);
    const currentBonus = currentBranch && branch === currentBranch ? 0.04 : 0;
    const score = textScore - computeRecencyBoost(recency, nowMs) - currentBonus;
    scored.push({
      label: branch,
      value: branch,
      source: 'local',
      score,
      recency,
    });
  }

  for (const branch of orderedRemote) {
    const textScore = scoreBranchMatch(branch, 'remote', queryLower, tokens, compactQuery);
    if (textScore === null) continue;
    remoteMatched.add(branch);
    const recency = lookupRecency(branch, 'remote', branchRecency);
    const score = textScore - computeRecencyBoost(recency, nowMs);
    scored.push({
      label: branch,
      value: `remotes/${branch}`,
      source: 'remote',
      score,
      recency,
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    if (a.recency !== b.recency) {
      return b.recency - a.recency;
    }
    // Prefer local branches when relevance & recency tie.
    if (a.source !== b.source) {
      return a.source === 'local' ? -1 : 1;
    }
    if (a.label.length !== b.label.length) {
      return a.label.length - b.label.length;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' });
  });

  return {
    matching: scored.map(({ label, value, source }) => ({ label, value, source })),
    otherLocal: orderedLocal.filter((branch) => !localMatched.has(branch)),
    otherRemote: orderedRemote.filter((branch) => !remoteMatched.has(branch)),
  };
}
