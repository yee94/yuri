import { list, record, text, type Row } from './model';
import { getModelDisplayName } from '../ui/src/lib/modelDisplay';
import { matchesModelSearch } from '../ui/src/lib/search/modelSearch';

export type ModelRef = { providerID: string; modelID: string; variant?: string };
export type PickerModel = ModelRef & { provider: Row; model: Row };
/** NSH Sheet includes the home-indicator region; Web's 72dvh uses app content. */
export const pickerSheetHeight = (windowHeight: number, insets: { top: number; bottom: number }, expanded = false) => Math.max(0, windowHeight - insets.top - insets.bottom) * (expanded ? 0.98 : 0.72) + insets.bottom;
export function pickerPreferences(value: unknown): Row | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = record(value);
  if (row.ok === false || row.success === false) return undefined;
  if (['favoriteModels', 'recentModels', 'hiddenModels', 'providerOrder'].some(key => row[key] !== undefined && !Array.isArray(row[key]))) return undefined;
  return row;
}
export function modelRefs(value: unknown): ModelRef[] {
  return list(value).filter(row => text(row.providerID) && text(row.modelID)).map(row => ({ providerID: text(row.providerID), modelID: text(row.modelID), ...(text(row.variant) ? { variant: text(row.variant) } : {}) }));
}
export const sameModel = (a: ModelRef, b: ModelRef) => a.providerID === b.providerID && a.modelID === b.modelID;
export const modelKey = (entry: ModelRef) => JSON.stringify([entry.providerID, entry.modelID]);
export const modelLabel = (entry: PickerModel) => getModelDisplayName(entry.model, entry.modelID, { maxLength: 40 });
export const modelMatches = (entry: PickerModel, query: string) => matchesModelSearch(`${text(entry.provider.name)} ${modelLabel(entry)}`, query) || matchesModelSearch(`${entry.providerID} ${entry.modelID}`, query);
export function pickerModels(providers: Row[], preferences: Row): PickerModel[] {
  const hidden = modelRefs(preferences.hiddenModels);
  const order = Array.isArray(preferences.providerOrder) ? preferences.providerOrder : [];
  return [...providers].sort((a, b) => {
    const rank = (provider: Row) => { const index = order.indexOf(provider.id); return index < 0 ? order.length : index; };
    return rank(a) - rank(b);
  }).flatMap(provider => Object.values(record(provider.models)).map(record)
    .filter(model => text(model.id) && model.hidden !== true && !hidden.some(ref => sameModel(ref, { providerID: text(provider.id), modelID: text(model.id) })))
    .map(model => ({ provider, model, providerID: text(provider.id), modelID: text(model.id) })));
}
export function pickerLists(entries: PickerModel[], preferences: Row, selected: ModelRef) {
  const resolve = (refs: ModelRef[]) => refs.flatMap(ref => {
    const entry = entries.find(item => sameModel(item, ref));
    return entry ? [{ ...entry, ...ref }] : [];
  });
  const favorites = resolve(modelRefs(preferences.favoriteModels));
  const recents = resolve(modelRefs(preferences.recentModels)).filter(entry => !favorites.some(fav => sameModel(fav, entry)));
  if (!favorites.some(entry => sameModel(entry, selected))) {
    const current = recents.find(entry => sameModel(entry, selected)) || entries.find(entry => sameModel(entry, selected));
    if (current) return { favorites, recents: [current, ...recents.filter(entry => !sameModel(entry, selected))] };
  }
  return { favorites, recents };
}
export const modelVariants = (entry: PickerModel) => Object.keys(record(entry.model.variants));
export function resolvedVariant(entry: PickerModel, selected: ModelRef, preferences: Row, preferRemembered = false, fallback?: string): string | undefined {
  const valid = (value: string | undefined) => value && modelVariants(entry).includes(value) ? value : undefined;
  const remembered = valid(entry.variant) || valid(modelRefs(preferences.favoriteModels).find(ref => sameModel(ref, entry))?.variant) || valid(modelRefs(preferences.recentModels).find(ref => sameModel(ref, entry))?.variant);
  if (preferRemembered && remembered) return remembered;
  return sameModel(entry, selected) ? valid(selected.variant) : valid(fallback);
}
export const inlineModelVariants = (entry: PickerModel) => ['', ...modelVariants(entry)].slice(0, 8);
export const variantLabel = (variant: string | undefined, defaultLabel: string) => variant?.trim() ? variant.trim().charAt(0).toUpperCase() + variant.trim().slice(1) : defaultLabel;
export function preferenceUpdate(preferences: Row, action: 'favorite' | 'recent', entry: ModelRef): Row {
  if (action === 'favorite') {
    const favorites = modelRefs(preferences.favoriteModels);
    return { favoriteModels: favorites.some(ref => sameModel(ref, entry)) ? favorites.filter(ref => !sameModel(ref, entry)) : [entry, ...favorites].slice(0, 64) };
  }
  const recentModels = [entry, ...modelRefs(preferences.recentModels).filter(ref => !sameModel(ref, entry))].slice(0, 5);
  const favorites = modelRefs(preferences.favoriteModels);
  const favoriteIndex = favorites.findIndex(ref => sameModel(ref, entry));
  if (favoriteIndex < 0 || favorites[favoriteIndex].variant === entry.variant) return { recentModels };
  return { recentModels, favoriteModels: favorites.map((ref, index) => index === favoriteIndex ? entry : ref) };
}
export function modelCapabilities(model: Row): { icon: 'tools' | 'brain-ai-3' | 'text' | 'file-image' | 'file-pdf' | 'file-video' | 'file-music'; label: 'capability.toolCalling' | 'capability.reasoning' | 'modality.text' | 'modality.image' | 'modality.pdf' | 'modality.video' | 'modality.audio' }[] {
  const capabilities = record(model.capabilities), input = record(capabilities.input), output = record(capabilities.output);
  const result: ReturnType<typeof modelCapabilities> = [];
  if (capabilities.toolcall === true) result.push({ icon: 'tools', label: 'capability.toolCalling' });
  if (capabilities.reasoning === true) result.push({ icon: 'brain-ai-3', label: 'capability.reasoning' });
  for (const [modality, icon] of [['text', 'text'], ['image', 'file-image'], ['video', 'file-video'], ['audio', 'file-music'], ['pdf', 'file-pdf']] as const) {
    if (input[modality] === true || output[modality] === true) result.push({ icon, label: `modality.${modality}` });
  }
  return result;
}
export function contextLabel(model: Row, language = 'en'): string {
  const context = record(model.limit).context;
  if (typeof context !== 'number' || !Number.isFinite(context) || context <= 0) return '';
  if (/^zh/.test(language)) {
    const traditional = /TW|HK|Hant/.test(language);
    return `${context >= 100_000_000 ? `${Math.round(context / 10_000_000) / 10}${traditional ? '億' : '亿'}` : context >= 10_000 ? `${Math.round(context / 1000) / 10}${traditional ? '萬' : '万'}` : context} ctx`;
  }
  return `${context >= 1_000_000 ? `${Math.round(context / 100_000) / 10}M` : context >= 1000 ? `${Math.round(context / 100) / 10}k` : context} ctx`;
}
