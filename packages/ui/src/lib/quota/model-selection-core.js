/** Shared wire semantics: an absent provider inherits defaults; an explicit [] selects no models. */
export function sanitizeUsageSelectedModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([provider, models]) => {
    if (!provider || !Array.isArray(models)) return [];
    const valid = models.filter(model => typeof model === 'string' && model.length > 0);
    return valid.length || models.length === 0 ? [[provider, valid]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function defaultUsageSelectedModels(selected, provider, defaults) {
  if (Object.prototype.hasOwnProperty.call(selected, provider) || defaults.length === 0) return null;
  return { usageSelectedModels: { ...selected, [provider]: [...defaults] } };
}

export function toggleUsageSelectedModel(selected, provider, model, enabled) {
  const previous = selected[provider] ?? [];
  return { usageSelectedModels: { ...selected, [provider]: enabled ? [...new Set([...previous, model])] : previous.filter(id => id !== model) } };
}
