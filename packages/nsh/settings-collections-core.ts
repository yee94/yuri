import { catalogModelSelection, readStoredSystem } from '../ui/src/components/sections/agents/agentSaveConfig';
import { parseImportedMcpSnippet } from '../ui/src/components/sections/mcp/mcpImport';
import { toPermissionRuleset } from '../ui/src/sync/permission-rules';
import type { Row } from './model';
import { scopedSettingsPath, settingsObject, settingsRows, type SettingsRequest } from './settings-protocol';
import { collectionMarkdownDefinition, readCollectionDefinitionFile } from './settings-collection-source';
import { collectionJSONCEntry, type CollectionJSONCSource } from './settings-collection-jsonc';

/** Catalog identity is authoritative; the separate config owns editable prompt text. */
export async function nativeAgentEditor(send: SettingsRequest, item: Row, directory?: string): Promise<Row> {
  const detail = settingsObject(await send(scopedSettingsPath(`/api/config/agents/${encodeURIComponent(String(item.name))}/config`, directory)));
  const config = detail.config == null ? undefined : settingsObject(detail.config);
  const rawModel = item.model ?? config?.model;
  const selection = rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel) ? rawModel as Row : {};
  const optionalString = (value: unknown) => typeof value === 'string' ? value : undefined;
  const model = typeof rawModel === 'string' ? rawModel : catalogModelSelection({ model: { providerID: optionalString(selection.providerID), modelID: optionalString(selection.modelID), id: optionalString(selection.id), variant: optionalString(selection.variant) }, variant: optionalString(item.variant ?? config?.variant) });
  return { ...item, scope: detail.scope || item.scope || 'user', isBuiltIn: detail.source === 'none', model, system: readStoredSystem(config) ?? '', steps: item.steps ?? config?.steps, hidden: item.hidden ?? config?.hidden, permissions: toPermissionRuleset(item.permissions ?? item.permission ?? config?.permissions ?? config?.permission) };
}

/** Reverted edits disappear too; catalog-only fields are never a patch. */
export function nativeCollectionChanges(draft: Row, initial: Row, touched: Row): Row {
  return Object.fromEntries(Object.keys(touched).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(initial[key])).map(key => [key, draft[key]]));
}

export function nativeAgentPatch(changes: Row): Row {
  return Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, ['model', 'system', 'description'].includes(key) && typeof value === 'string' ? value.trim() || null : value]));
}

/** Capture stored definitions before opening a local copy/rename draft. No write occurs here. */
export async function nativeCollectionDraft(send: SettingsRequest, domain: 'agents' | 'commands' | 'skills.installed', item: Row, directory?: string): Promise<{ editor: Row; config: Row; jsonc?: CollectionJSONCSource }> {
  const name = String(item.name);
  if (domain === 'agents') {
    const detail = settingsObject(await send(scopedSettingsPath(`/api/config/agents/${encodeURIComponent(name)}/config`, directory)));
    const config = settingsObject(detail.config);
    const editor = await nativeAgentEditor(async () => detail, item, directory);
    return { editor: { ...editor, isBuiltIn: detail.source === 'none' }, config: { ...config } };
  }
  if (domain === 'commands') {
    const detail = settingsObject(await send(scopedSettingsPath(`/api/config/commands/${encodeURIComponent(name)}`, directory)));
    const sources = settingsObject(detail.sources), md = settingsObject(sources.md), json = settingsObject(sources.json);
    let config: Row = {};
    let jsonc: CollectionJSONCSource | undefined;
    if (json.exists === true && typeof json.path === 'string') {
      const raw = await readCollectionDefinitionFile(send, json.path, directory);
      const entry = collectionJSONCEntry(raw, 'command', name);
      config = entry.value;
      const snapshot = `{"command": {${entry.leading}${JSON.stringify(name)}: ${entry.raw}}}`;
      jsonc = { path: json.path, scope: String(json.scope), name, section: 'command', raw: snapshot, directory };
    }
    if (md.exists === true && typeof md.path === 'string') config = { ...config, ...collectionMarkdownDefinition(await readCollectionDefinitionFile(send, md.path, directory), 'template') };
    if (!md.exists && !json.exists) {
      const { name: _name, id: _id, source: _source, scope: _scope, ...catalog } = item;
      config = catalog;
    }
    return { editor: { ...item, ...config, scope: detail.scope || item.scope || 'user', isBuiltIn: detail.isBuiltIn === true }, config, jsonc };
  }
  const detail = settingsObject(await send(scopedSettingsPath(`/api/config/skills/${encodeURIComponent(name)}`, directory)));
  const source = settingsObject(settingsObject(detail.sources).md);
  const supportingFiles = await Promise.all(settingsRows(source.supportingFiles || []).map(async file => {
    const path = String(file.path);
    const body = settingsObject(await send(scopedSettingsPath(`/api/config/skills/${encodeURIComponent(name)}/files/${encodeURIComponent(path)}`, directory)));
    if (typeof body.content !== 'string') throw new Error('Invalid skill file');
    return { path, content: body.content };
  }));
  const definition = typeof source.path === 'string' && source.path !== '<built-in>'
    ? collectionMarkdownDefinition(await readCollectionDefinitionFile(send, source.path, directory), 'instructions')
    : { description: source.description ?? item.description, instructions: source.instructions };
  const config = { ...definition, source: item.source, supportingFiles };
  return { editor: { ...item, ...config }, config };
}

/** Same parser and transport clearing as Web; this function never performs I/O. */
export function nativeMcpImport(source: string, currentName: string, create: boolean): { ok: true; name: string; fields: Row } | { ok: false; error: string } {
  const parsed = parseImportedMcpSnippet(source, { fallbackName: currentName });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const remote = parsed.type === 'remote';
  const oauth = remote && parsed.oauthEnabled ? Object.fromEntries([
    ['clientId', parsed.oauthClientId], ['clientSecret', parsed.oauthClientSecret], ['scope', parsed.oauthScope], ['redirectUri', parsed.oauthRedirectUri],
  ].filter(([, value]) => value)) : false;
  return { ok: true, name: create && parsed.name ? parsed.name : currentName, fields: {
    type: parsed.type, command: remote ? [] : parsed.command, url: remote ? parsed.url : '',
    environment: Object.fromEntries(parsed.environment.map(pair => [pair.key, pair.value])),
    headers: remote ? Object.fromEntries(parsed.headers.map(pair => [pair.key, pair.value])) : {},
    oauth, timeout: remote && parsed.timeout ? Number(parsed.timeout) : null, enabled: parsed.enabled,
  } };
}
