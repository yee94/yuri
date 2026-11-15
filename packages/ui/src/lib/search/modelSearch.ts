/**
 * Normalize a model/provider search string for separator-tolerant matching.
 * Strips punctuation so "GLM 5.2" and "GLM-5.2" share the same compact form.
 */
export function normalizeModelSearchValue(value: string): {
  lower: string;
  compact: string;
  tokens: string[];
} {
  const lower = value.toLowerCase().trim();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return { lower, compact, tokens };
}

/**
 * Match a model/provider candidate against a free-typed query.
 * Prefers exact substring, then compact alphanumerics (ignores spaces/hyphens/dots),
 * then per-token prefix/includes so continuous typing still finds the model.
 */
export function matchesModelSearch(candidate: string, query: string): boolean {
  if (matchesWholeQuery(candidate, query)) return true;
  // Space-separated terms may each hit a different part of the candidate
  // (e.g. "vpsus sonnet" = provider "VPS US" + model "Sonnet"), in any order.
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((term) => matchesWholeQuery(candidate, term));
}

function matchesWholeQuery(candidate: string, query: string): boolean {
  const normalizedQuery = normalizeModelSearchValue(query);
  if (!normalizedQuery.lower) {
    return true;
  }

  const normalizedCandidate = normalizeModelSearchValue(candidate);
  if (normalizedCandidate.lower.includes(normalizedQuery.lower)) {
    return true;
  }

  if (normalizedQuery.compact.length >= 2 && normalizedCandidate.compact.includes(normalizedQuery.compact)) {
    return true;
  }

  if (normalizedQuery.tokens.length === 0) {
    return false;
  }

  return normalizedQuery.tokens.every((queryToken) =>
    normalizedCandidate.tokens.some((candidateToken) =>
      candidateToken.startsWith(queryToken) || candidateToken.includes(queryToken)
    )
  );
}

const MODEL_SEARCH_RECENCY_BOOST_MAX = 40;
const MODEL_SEARCH_RECENCY_BOOST_STEP = 8;
const MODEL_SEARCH_FAVORITE_BOOST = 8;
const MODEL_SEARCH_SELECTED_PROVIDER_BOOST = 6;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Searchable text for a model: display names plus provider/model IDs, so users can
 * find a model by an ID fragment such as "vps-us/claude" even when the IDs are
 * URL-encoded.
 */
export function buildModelSearchText(parts: {
  providerName: string;
  providerID: string;
  modelName: string;
  modelID: string;
}): string {
  const decodedProviderID = safeDecode(parts.providerID);
  return [
    parts.providerName,
    parts.providerID,
    decodedProviderID === parts.providerID ? '' : decodedProviderID,
    parts.modelName,
    parts.modelID,
  ].filter(Boolean).join(' ');
}

export type ModelSearchSignals = {
  /** Extra searchable text (see `buildModelSearchText`) consulted after the model name. */
  searchText?: string;
  /** Position in the most-recent-first usage order; omit or pass a negative value when never used. */
  recencyRank?: number;
  favorite?: boolean;
  /** The model belongs to the provider of the currently selected model. */
  selectedProvider?: boolean;
};

/**
 * Rank a model for a free-typed query. Returns 0 when the model does not match,
 * otherwise a text-match tier (exact 100, prefix 80, token prefix 65, substring 50,
 * provider/loose 20) plus recency and favorite boosts, so a recently used model can
 * outrank a better textual hit without ever outranking an exact name match.
 */
export function scoreModelSearch(
  modelName: string,
  providerName: string,
  query: string,
  signals: ModelSearchSignals = {},
): number {
  const normalizedQuery = normalizeModelSearchValue(query);
  const name = normalizeModelSearchValue(modelName);
  const useCompact = normalizedQuery.compact.length >= 2;

  let base: number;
  if (!normalizedQuery.lower) {
    base = 1;
  } else if (name.compact !== '' && name.compact === normalizedQuery.compact) {
    base = 100;
  } else if (name.lower.startsWith(normalizedQuery.lower) || (useCompact && name.compact.startsWith(normalizedQuery.compact))) {
    base = 80;
  } else if (
    normalizedQuery.tokens.length > 0
    && normalizedQuery.tokens.every((queryToken) => name.tokens.some((nameToken) => nameToken.startsWith(queryToken)))
  ) {
    base = 65;
  } else if (name.lower.includes(normalizedQuery.lower) || (useCompact && name.compact.includes(normalizedQuery.compact))) {
    base = 50;
  } else if (matchesModelSearch(signals.searchText ?? `${providerName} ${modelName}`, query)) {
    base = 20;
  } else {
    return 0;
  }

  const rank = signals.recencyRank;
  const recencyBoost = rank === undefined || rank < 0
    ? 0
    : Math.max(0, MODEL_SEARCH_RECENCY_BOOST_MAX - rank * MODEL_SEARCH_RECENCY_BOOST_STEP);
  return base + recencyBoost + (signals.favorite ? MODEL_SEARCH_FAVORITE_BOOST : 0)
    + (signals.selectedProvider ? MODEL_SEARCH_SELECTED_PROVIDER_BOOST : 0);
}
