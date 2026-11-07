import { parseModelIdentifier } from '../ui/src/lib/modelIdentifier';
import { mergeConfigDocuments } from '../ui/src/lib/opencode/v2-types';
import { list, record, text, unwrap, type Row } from './model';

export type BotDefaultSelection = { providerID: string; modelID: string; variant?: string };
export type BotDefaultContext = { directory?: string; selection?: BotDefaultSelection; agent?: string };

/** One projection of an actual composer choice; never a history/catalog guess. */
export function createBotCreationContext(generation: () => number) {
  let captured: { generation: number; context: BotDefaultContext } | undefined;
  return {
    update(directory: string, selection?: BotDefaultSelection, agent?: string) {
      if (!directory) { captured = undefined; return; }
      captured = { generation: generation(), context: { directory, ...(agent ? { agent } : {}),
        ...(selection?.providerID && selection.modelID ? { selection: { ...selection } } : {}) } };
    },
    snapshot(): BotDefaultContext | undefined {
      if (!captured || captured.generation !== generation()) return undefined;
      const { directory, selection, agent } = captured.context;
      return { directory, ...(agent ? { agent } : {}), ...(selection ? { selection: { ...selection } } : {}) };
    },
  };
}

/** Same precedence as AssistantsSettingsPage.resolveDefaultAssistantModel. */
export function resolveBotDefaultModel(input: {
  settings: Row; opencodeDefaultModel?: unknown; current?: BotDefaultSelection; providers: Row[];
}): BotDefaultSelection | null {
  const value = input.settings.defaultModel ?? (!input.current?.modelID ? input.opencodeDefaultModel : undefined);
  if (value) {
    const parsed = parseModelIdentifier(value);
    if (parsed) return { providerID: parsed.providerId, modelID: parsed.modelId,
      ...(parsed.variant !== undefined || typeof input.settings.defaultVariant === 'string'
        ? { variant: parsed.variant ?? text(input.settings.defaultVariant) } : {}) };
  }
  if (input.current?.providerID && input.current.modelID) return { ...input.current };
  // Web's ConfigStore provider models are arrays. Host's sanitized catalog is
  // an insertion-ordered dictionary; adapt that shape without sorting it.
  for (const provider of input.providers) {
    const models = Array.isArray(provider.models) ? provider.models : Object.values(record(provider.models));
    const first = record(models[0]);
    if (text(provider.id) && text(first.id)) return { providerID: text(provider.id), modelID: text(first.id) };
  }
  return null;
}

/** Reads only. Directory/selection must come from the real navigation owner. */
export async function readBotCreationDefaults(send: (path: string) => Promise<unknown>, context: {
  directory?: string; selection?: BotDefaultSelection;
} = {}) {
  const directory = context.directory;
  const [settingsValue, configValue, catalogValue, snapshotValue] = await Promise.all([
    send('/api/config/settings/bootstrap'),
    send(`/api/config${directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ''}`),
    send(`/api/config/catalog/providers${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`),
    send('/api/yuri/assistants/snapshot'),
  ]);
  const settings = { ...record(settingsValue) }, configEnvelope = record(configValue), entries = unwrap(configValue), catalog = record(catalogValue), snapshot = record(snapshotValue);
  if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue) || settings.schemaVersion !== 1 || settings.ok === false || settings.success === false || settings.failed === true ||
    configEnvelope.ok === false || configEnvelope.failed === true || configEnvelope.partial === true ||
    !Array.isArray(entries) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.providers) ||
    catalog.ok === false || catalog.failed === true || catalog.partial === true ||
    !Array.isArray(snapshot.assistants) || snapshot.ok === false || snapshot.failed === true || snapshot.partial === true || snapshot.assistants.some(item => !text(record(item).id)))
    throw new Error('Invalid assistant defaults');
  // The Web bootstrap parser trims these optional strings (512-char limit).
  // Only the two needed fields are consumed; no browser URL parser is loaded.
  for (const key of ['defaultModel', 'defaultVariant']) {
    if (settings[key] === undefined) continue;
    if (typeof settings[key] !== 'string' || settings[key].trim().length > 512) throw new Error('Invalid assistant defaults');
    settings[key] = settings[key].trim();
  }
  const config = mergeConfigDocuments(entries);
  return { name: snapshot.assistants.length === 0 ? 'Yuri' : '', model: resolveBotDefaultModel({
    settings, opencodeDefaultModel: config.model, current: context.selection, providers: list(catalog.providers),
  }) };
}
