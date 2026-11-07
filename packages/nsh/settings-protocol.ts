import type { Row } from './model';

export type SettingsRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type SettingsRequestLane = Readonly<{ request: SettingsRequest; current: () => boolean }>;
/** Retained controllers replace authority explicitly and capture it per operation. */
export function createSettingsLaneOwner(send: SettingsRequest, current: () => boolean) {
  let assigned: SettingsRequestLane | null = null;
  function replaceLane(next: SettingsRequestLane | null) {
    assigned = null;
    if (!next) return;
    const valid = () => assigned === lane && next.current();
    const request: SettingsRequest = async (...args) => {
      if (!valid()) throw new Error('Runtime changed');
      const value = await next.request(...args);
      if (!valid()) throw new Error('Runtime changed');
      return value;
    };
    const lane: SettingsRequestLane = Object.freeze({ request, current: valid });
    assigned = lane;
  }
  replaceLane({ request: send, current });
  return { capture: () => assigned, replaceLane };
}
export const scopedSettingsPath = (path: string, directory?: string) => directory ? `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}` : path;
export const integrationSettingsPath = (integrationID: string, suffix = '', directory?: string) => `/api/integration/${encodeURIComponent(integrationID)}${suffix}${directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ''}`;
export const integrationPayload = (value: unknown) => settingsObject(settingsObject(value).data);
export function settingsAuthorizationCode(value: string): string {
  const trimmed = value.trim();
  try { return new URL(trimmed).searchParams.get('code')?.trim() || trimmed; }
  catch { return trimmed; }
}
export function visibleArchivedSettingsSession(value: Row): boolean {
  const nested = (candidate: unknown): Row => candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Row : {};
  if (!(Number(nested(value.time).archived) > 0) || value.parentID) return false;
  const title = typeof value.title === 'string' ? value.title : '';
  if (title === 'smartfetch-secondary' || /^\[(?:Scheduled|Assistant|yuri-llm)\]/.test(title)) return false;
  const yuri = nested(nested(value.metadata).yuri);
  if (nested(yuri.assigned).from === 'contact') return true;
  return ![['assistant', 'assistantID'], ['scheduledTask', 'taskID'], ['smallModel', 'purpose'], ['llm', 'purpose']].some(([owner, key]) => typeof nested(yuri[owner])[key] === 'string' && String(nested(yuri[owner])[key]).length > 0);
}
export function createSettingsArchiveRestore(send: SettingsRequest, current: () => boolean) {
  const transport = createSettingsLaneOwner(send, current);
  const pending = new Set<string>(), flights = new Map<string, object>();
  const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
  const directoryOf = (session: Row) => object(session.location).directory || session.directory;
  const restore = async (session: Row): Promise<void> => {
    const lane = transport.capture();
    if (!lane) throw new Error('Runtime changed');
    const { request: send, current } = lane;
    if (!current()) throw new Error('Runtime changed');
    const id = session.id, directory = directoryOf(session);
    if (typeof id !== 'string' || !id.trim() || typeof directory !== 'string' || !directory.trim()) throw new Error('Invalid archived session identity');
    const key = JSON.stringify([id, directory]);
    if (flights.has(key)) throw new Error('Archive restore already pending');
    const flight = {}; flights.set(key, flight);
    const verify = (value: unknown) => {
      const result = settingsObject(value);
      if (result.id !== id || directoryOf(result) !== directory || !result.time || typeof result.time !== 'object' || Array.isArray(result.time)) throw new Error('Invalid restored session identity');
      const archived = object(result.time).archived;
      if (archived !== undefined && archived !== null && (typeof archived !== 'number' || !Number.isFinite(archived) || archived < 0)) throw new Error('Invalid restored archive state');
      return !(typeof archived === 'number' && archived > 0);
    };
    try {
      if (!pending.has(key)) {
        pending.add(key);
        const response = await send(`/api/yuri/sessions/${encodeURIComponent(id)}/archive`, 'PUT', { archivedAt: 0, directory });
        if (!current()) throw new Error('Runtime changed');
        const value = object(response).session;
        if (value !== undefined && verify(value)) { pending.delete(key); return; }
      }
      // A confirmed or uncertain write is reconciled, never blindly replayed after a failed read.
      const response = settingsObject(await send(scopedSettingsPath(`/api/session/${encodeURIComponent(id)}`, directory)));
      if (!current()) throw new Error('Runtime changed');
      const restored = verify(response.data ?? response);
      pending.delete(key);
      if (!restored) throw new Error('Session is still archived');
    } finally { if (flights.get(key) === flight) flights.delete(key); }
  };
  return Object.assign(restore, { replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); flights.clear(); } });
}
export function settingsObject(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings response');
  const body = value as Row;
  if (body.ok === false || body.success === false) throw new Error(typeof body.error === 'string' ? body.error : 'Settings request failed');
  return body;
}
export function settingsRows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('Invalid settings collection');
  return value as Row[];
}
export type SettingsDomain = 'agents' | 'commands' | 'mcp' | 'plugins' | 'skills.installed' | 'providers';
export function settingsSkillReadOnly(value: Row): boolean {
  return value.path === '<built-in>' || value.targetPath === '<built-in>';
}
/** Same Host hiddenModels preference consumed by the native and Web model pickers. */
export function settingsProviderModelsPatch(snapshot: unknown, providerID: string, modelIDs: readonly string[], added: boolean): { hiddenModels: Row[] } {
  const settings = settingsObject(snapshot);
  const hidden = settings.hiddenModels === undefined ? [] : settingsRows(settings.hiddenModels);
  if (hidden.some(item => typeof item.providerID !== 'string' || typeof item.modelID !== 'string')) throw new Error('Invalid hidden model preference');
  const ids = new Set(modelIDs);
  const retained = hidden.filter(item => item.providerID !== providerID || !ids.has(String(item.modelID)));
  return { hiddenModels: added ? retained : [...retained, ...[...ids].map(modelID => ({ providerID, modelID }))] };
}
export async function readSettingsCollection(send: SettingsRequest, domain: SettingsDomain, directory?: string): Promise<Row[]> {
  const path = (value: string) => scopedSettingsPath(value, directory);
  if (domain === 'providers') {
    const data = settingsObject(await send(path('/api/config/catalog/providers')));
    if (data.schemaVersion !== 1) throw new Error('Invalid provider catalog');
    return settingsRows(data.providers);
  }
  if (domain === 'mcp') return settingsRows(await send(path('/api/config/mcp')));
  if (domain === 'plugins') {
    const data = settingsObject(await send(path('/api/config/plugins')));
    return [...settingsRows(data.entries), ...settingsRows(data.files).map(item => ({ ...item, file: true }))];
  }
  if (domain === 'skills.installed') return settingsRows(settingsObject(await send(path('/api/config/skills?summary=true'))).skills);
  const raw = await send(`/api/${domain === 'agents' ? 'agent' : 'command'}${directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ''}`);
  const rows = settingsRows(Array.isArray(raw) ? raw : settingsObject(raw).data);
  if (domain !== 'agents') return rows;
  const metadata = settingsObject(await send(path('/api/config/agents/metadata'), 'POST', { names: rows.map(item => item.name) }));
  const agents = settingsObject(metadata.agents);
  const mapped = rows.map(item => {
    const details = agents[String(item.name)];
    const source = details && typeof details === 'object' ? details as Row : {};
    const sources = source.sources && typeof source.sources === 'object' ? source.sources as Row : {};
    const md = sources.md && typeof sources.md === 'object' ? sources.md as Row : {};
    const json = sources.json && typeof sources.json === 'object' ? sources.json as Row : {};
    return { ...item, scope: source.scope || md.scope || json.scope, document: sources.document };
  });
  const names = new Set(rows.map(item => item.name));
  const disabled = metadata.disabled === undefined ? [] : settingsRows(metadata.disabled);
  return [...mapped, ...disabled.filter(item => typeof item.name === 'string' && !names.has(item.name)).map(item => ({ ...item, disabled: true, mode: item.mode || 'primary' }))];
}

/** Only documented domain fields cross the wire; never serialize a whole catalog row. */
export function settingsMutation(domain: SettingsDomain, name: string, draft: Row, create: boolean, directory?: string) {
  if (domain === 'skills.installed' && settingsSkillReadOnly(draft)) throw new Error('Built-in skills are read-only');
  const pick = (keys: string[]) => Object.fromEntries(keys.filter(key => draft[key] !== undefined).map(key => [key, draft[key]]));
  let path = `/api/config/${domain === 'skills.installed' ? 'skills' : domain}/${encodeURIComponent(name)}`;
  let body: Row;
  if (domain === 'agents') body = { native: pick(['description', 'mode', 'model', 'system', 'steps', 'hidden', 'disabled', 'color', 'permissions']), scope: draft.scope || 'user' };
  else if (domain === 'commands') body = pick(create ? ['description', 'template', 'agent', 'model', 'scope'] : ['description', 'template', 'agent', 'model']);
  else if (domain === 'mcp') body = pick(['type', 'command', 'url', 'environment', 'headers', 'oauth', 'timeout', 'enabled', 'scope']);
  else if (domain === 'skills.installed') body = pick(create ? ['name', 'description', 'instructions', 'scope', 'source', 'supportingFiles'] : ['description', 'instructions', 'supportingFiles', 'targetPath']);
  else if (domain === 'plugins') {
    path = `/api/config/plugins/entry${create ? '' : `/${encodeURIComponent(name)}`}`;
    body = pick(['spec', 'options', 'scope']);
  } else throw new Error('Provider models use their dedicated mutation');
  return { path: scopedSettingsPath(path, directory), method: create ? 'POST' : 'PATCH', body };
}

/** A failed write keeps the draft and loaded revision. A successful write is not repeated after refresh failure. */
export function createSettingsTransaction(send: SettingsRequest, current: () => boolean) {
  let pending = false;
  return async (path: string, method: string, body?: unknown): Promise<Row> => {
    if (pending) throw new Error('Settings write already pending');
    if (!current()) throw new Error('Runtime changed');
    pending = true;
    try {
      const result = await send(path, method, body);
      if (!current()) throw new Error('Runtime changed');
      return result === null || result === undefined || result === true ? {} : settingsObject(result);
    } finally { pending = false; }
  };
}
