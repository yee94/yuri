export type ModelFavorite = { providerID: string; modelID: string; variant?: string };

const sameModel = (entry: ModelFavorite, providerID: string, modelID: string): boolean =>
  entry.providerID === providerID && entry.modelID === modelID;

/** Removes an existing favorite, otherwise adds it first; an unset variant is omitted from the entry. */
export const toggleModelFavorite = <T extends ModelFavorite>(
  favorites: ReadonlyArray<T>,
  providerID: string,
  modelID: string,
  variant?: string,
): T[] => {
  if (favorites.some((entry) => sameModel(entry, providerID, modelID))) {
    return favorites.filter((entry) => !sameModel(entry, providerID, modelID));
  }
  const entry = (variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }) as T;
  return [entry, ...favorites];
};

/** Moves `active` onto `over`'s position; returns the same array when nothing would move. */
export const reorderModelFavorite = <T extends ModelFavorite>(
  favorites: ReadonlyArray<T>,
  activeProviderID: string,
  activeModelID: string,
  overProviderID: string,
  overModelID: string,
): ReadonlyArray<T> => {
  const oldIndex = favorites.findIndex((entry) => sameModel(entry, activeProviderID, activeModelID));
  const newIndex = favorites.findIndex((entry) => sameModel(entry, overProviderID, overModelID));
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return favorites;
  const next = favorites.slice();
  const [moved] = next.splice(oldIndex, 1);
  if (!moved) return favorites;
  next.splice(newIndex, 0, moved);
  return next;
};
