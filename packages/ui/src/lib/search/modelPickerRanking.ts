import { buildModelSearchText, scoreModelSearch } from './modelSearch';

type ModelRef = { providerID: string; modelID: string };
type RememberedVariantEntry = ModelRef & { variant?: string };

const keyOf = (providerID: string, modelID: string) => `${providerID}:${modelID}`;

/** Moves the selected model's provider to the front, keeping the rest in order. */
export function liftSelectedProvider<T extends { id: string }>(providers: T[], selectedProviderID: string | undefined): T[] {
  if (!selectedProviderID) return providers;
  const selected = providers.find((provider) => provider.id === selectedProviderID);
  if (!selected || providers[0] === selected) return providers;
  return [selected, ...providers.filter((provider) => provider !== selected)];
}

export type RankableModelCandidate<E extends ModelRef> = {
  entry: E;
  providerName: string;
  modelName: string;
};

/**
 * Ranks search candidates by text match plus recent usage, favorites and the
 * selected model/provider. The current selection counts as the most recent use.
 * Non-matching candidates are dropped; remembered thinking variants from
 * recents/favorites are attached to the returned entries.
 */
export function rankModelSearchEntries<E extends ModelRef & { variant?: string }>(options: {
  candidates: ReadonlyArray<RankableModelCandidate<E>>;
  query: string;
  recencyOrder: ReadonlyArray<ModelRef>;
  recentModels: ReadonlyArray<RememberedVariantEntry>;
  favoriteModels: ReadonlyArray<RememberedVariantEntry>;
  selectedModel?: ModelRef | null;
}): E[] {
  const { candidates, query, recencyOrder, recentModels, favoriteModels, selectedModel } = options;
  const recencyRanks = new Map<string, number>();
  const usageOrder = selectedModel ? [selectedModel, ...recencyOrder] : recencyOrder;
  usageOrder.forEach(({ providerID, modelID }, index) => {
    const key = keyOf(providerID, modelID);
    if (!recencyRanks.has(key)) recencyRanks.set(key, index);
  });
  const favoriteKeys = new Set(favoriteModels.map(({ providerID, modelID }) => keyOf(providerID, modelID)));
  const rememberedVariants = new Map<string, string>();
  [...recentModels, ...favoriteModels].forEach(({ providerID, modelID, variant }) => {
    if (variant !== undefined) rememberedVariants.set(keyOf(providerID, modelID), variant);
  });

  const ranked: Array<{ entry: E; score: number }> = [];
  for (const { entry, providerName, modelName } of candidates) {
    const key = keyOf(entry.providerID, entry.modelID);
    const score = scoreModelSearch(modelName, providerName, query, {
      recencyRank: recencyRanks.get(key),
      favorite: favoriteKeys.has(key),
      selectedProvider: selectedModel?.providerID === entry.providerID,
      searchText: buildModelSearchText({ providerName, providerID: entry.providerID, modelName, modelID: entry.modelID }),
    });
    if (score <= 0) continue;
    const variant = rememberedVariants.get(key);
    ranked.push({ entry: variant === undefined ? entry : { ...entry, variant }, score });
  }
  return ranked.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}
