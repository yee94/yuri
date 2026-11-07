import { record, text, type Row } from './model';
import { pickerModels, modelVariants, type PickerModel } from './chat-models-helpers';
import { settingsObject, settingsRows, type SettingsRequest, readSettingsCollection } from './settings-protocol';

/** Product prompt snapshots; tests compare these with the Web owner, never import its React runtime. */
export const settingsSummaryDefaults = {
  summaryCommitPrompt: 'You are generating a Conventional Commits subject line from the diffs of the selected files.',
  summarySessionTitlePrompt: [
    'You are a title generator. Output ONLY a thread title.',
    'Name the main subject of the work.',
    'Keep that subject across follow-ups, polish, commit, push, tidy, and review.',
    'Switch only when the user clearly starts a different topic.',
    'One line, no explanation.',
    'Hard limit: never exceed 6 CJK characters (or 6 words for English). No modifiers. No verbs.',
    'Use the language of the user messages.',
    'Keep technical terms, numbers, filenames, and HTTP codes exact.',
    'Never include tool names, summarizing, or generating.',
    'Always output a meaningful title.',
  ].join('\n'),
};
export function settingsSummaryPrompts(value: Row): typeof settingsSummaryDefaults {
  return {
    summaryCommitPrompt: typeof value.summaryCommitPrompt === 'string' ? value.summaryCommitPrompt : settingsSummaryDefaults.summaryCommitPrompt,
    summarySessionTitlePrompt: typeof value.summarySessionTitlePrompt === 'string' ? value.summarySessionTitlePrompt : settingsSummaryDefaults.summarySessionTitlePrompt,
  };
}
export const settingsModelValue = (entry: PickerModel) => `${entry.providerID}/${entry.modelID}`;
export function settingsCatalogModels(providers: Row[], preferences: Row): PickerModel[] {
  if (preferences.hiddenModels !== undefined && settingsRows(preferences.hiddenModels).some(item => !text(item.providerID) || !text(item.modelID))) throw new Error('Invalid hidden model preference');
  if (preferences.providerOrder !== undefined && (!Array.isArray(preferences.providerOrder) || preferences.providerOrder.some(item => typeof item !== 'string'))) throw new Error('Invalid provider order');
  const normalized = providers.map(provider => {
    if (!text(provider.id)) throw new Error('Invalid provider identity');
    return { ...provider, models: Object.fromEntries(
      Object.entries(settingsObject(provider.models)).map(([id, value]) => {
        const model = settingsObject(value);
        return [id, { ...model, id: text(model.id) || id }];
      }),
    ) };
  });
  return pickerModels(normalized, preferences);
}
export function settingsDefaultModelPatch(value: string, models: PickerModel[], summary = false): Row {
  const selected = models.find(model => settingsModelValue(model) === value);
  if (value && !selected) throw new Error('Selected model is not in the authoritative catalog');
  return summary
    ? { summaryModelMode: 'provider', summaryProviderID: selected?.providerID || '', summaryModelID: selected?.modelID || '' }
    : { defaultModel: value, defaultVariant: '' };
}
export function settingsDefaultVariantPatch(model: string, variant: string, models: PickerModel[]): Row {
  const entry = models.find(item => settingsModelValue(item) === model);
  if (variant && (!entry || !modelVariants(entry).includes(variant))) throw new Error('Selected variant is not supported by this model');
  return { defaultVariant: variant };
}
/** Same visibility contract as Web filterVisibleAgents, including visible subagents. */
export function settingsVisibleAgents(value: unknown): Row[] {
  const rows = settingsRows(Array.isArray(value) ? value : settingsObject(value).data);
  return rows.filter(agent => text(agent.name) && agent.hidden !== true && record(agent.options).hidden !== true);
}
export async function readSettingsModels(send: SettingsRequest, preferences: Row, directory?: string) {
  return settingsCatalogModels(await readSettingsCollection(send, 'providers', directory), preferences);
}
