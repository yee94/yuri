import { catalogModelSelection, readStoredSystem } from '../ui/src/components/sections/agents/agentSaveConfig';
import { parseImportedMcpSnippet } from '../ui/src/components/sections/mcp/mcpImport';
import { toPermissionRuleset } from '../ui/src/sync/permission-rules';
import type { Row } from './model';
import { scopedSettingsPath, settingsObject, type SettingsRequest } from './settings-protocol';

/** Catalog identity is authoritative; the separate config owns editable prompt text. */
export async function nativeAgentEditor(send: SettingsRequest, item: Row, directory?: string): Promise<Row> {
  const detail = settingsObject(await send(scopedSettingsPath(`/api/config/agents/${encodeURIComponent(String(item.name))}/config`, directory)));
  const config = detail.config == null ? undefined : settingsObject(detail.config);
  const rawModel = item.model ?? config?.model;
  const selection = rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel) ? rawModel as Row : {};
  const optionalString = (value: unknown) => typeof value === 'string' ? value : undefined;
  const model = typeof rawModel === 'string' ? rawModel : catalogModelSelection({ model: { providerID: optionalString(selection.providerID), modelID: optionalString(selection.modelID), id: optionalString(selection.id), variant: optionalString(selection.variant) }, variant: optionalString(item.variant ?? config?.variant) });
  return { ...item, scope: item.scope || 'user', model, system: readStoredSystem(config) ?? '', steps: item.steps ?? config?.steps, hidden: item.hidden ?? config?.hidden, permissions: toPermissionRuleset(item.permissions ?? item.permission ?? config?.permissions ?? config?.permission) };
}

/** Reverted edits disappear too; catalog-only fields are never a patch. */
export function nativeCollectionChanges(draft: Row, initial: Row, touched: Row): Row {
  return Object.fromEntries(Object.keys(touched).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(initial[key])).map(key => [key, draft[key]]));
}

export function nativeAgentPatch(changes: Row): Row {
  return Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, ['model', 'system', 'description'].includes(key) && typeof value === 'string' ? value.trim() || null : value]));
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
