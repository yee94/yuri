import { stringify } from 'yaml';
import type { Row } from './model';
import { createSettingsLaneOwner, scopedSettingsPath, settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';
import { collectionAgentMarkdown } from './settings-collection-source';
import { collectionJSONCEntry, collectionJSONCInsert, parseCollectionJSONC } from './settings-collection-jsonc';
import { collectionValuesEqual, collectionWriteRejected } from './settings-collection-value';

type Scope = 'user' | 'project';
export type AgentScopeMovePlan = { name: string; from: Scope; to: Scope; directory?: string; patch: Row };
type Source = { path: string; kind: 'md' | 'json'; raw: string; entry?: string; status: 'pending' | 'unknown' | 'confirmed' | 'absent' };
type Phase = 'draft' | 'write-unknown' | 'copied' | 'delete-unknown' | 'cleanup' | 'done';
type Journal = { target: string; raw: string; sources: Source[]; global?: boolean; config?: Row };
const missing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function patchField(config: Row, key: string, value: unknown) {
  if (key === 'model') delete config.variant;
  if (value === null || value === false && (key === 'hidden' || key === 'disabled')) { delete config[key]; return; }
  if (key === 'steps') {
    const steps = Number(value); if (!Number.isSafeInteger(steps) || steps < 1) throw new Error('Invalid Agent steps'); value = steps;
  }
  Object.defineProperty(config, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Existing fs.write creates the complete target; only the domain DELETE owns old-scope cleanup.
 * Neither endpoint offers CAS. Each explicit phase checks exact captured source/target identity. */
export function createNativeAgentScopeMove(input: AgentScopeMovePlan, send: SettingsRequest, current: () => boolean) {
  const plan = { ...input, patch: { ...input.patch } }, transport = createSettingsLaneOwner(send, current);
  let phase: Phase = 'draft', journal: Journal | undefined, busy = false;
  const endpoint = scopedSettingsPath(`/api/config/agents/${encodeURIComponent(plan.name)}`, plan.directory);
  const file = (path: string) => scopedSettingsPath(`/api/fs/read?path=${encodeURIComponent(path)}`, plan.directory);
  const check = (lane: SettingsRequestLane) => { if (!lane.current()) throw new Error('Runtime changed'); };
  const read = async (lane: SettingsRequestLane, path: string): Promise<string | null> => {
    try { const raw = await lane.request(file(path), 'GET'); check(lane); if (typeof raw !== 'string') throw new Error('Invalid Agent source'); return raw; }
    catch (error) { check(lane); if (missing(error)) return null; throw error; }
  };
  const verifyTarget = async (lane: SettingsRequestLane) => {
    if (!journal) throw new Error('Scope journal missing');
    if (journal.global) {
      const response = settingsObject(await lane.request('/api/config/global/opencode', 'GET')); check(lane);
      if (typeof response.content !== 'string' || !collectionValuesEqual(collectionJSONCEntry(response.content, 'agent', plan.name).value, journal.config)) throw new Error('Scope target differs; original definition retained');
    } else if (await read(lane, journal.target) !== journal.raw) throw new Error('Scope target differs; original definition retained');
  };
  const verifyCleanup = async (lane: SettingsRequestLane) => {
    const metadata = settingsObject(await lane.request(endpoint, 'GET')); check(lane);
    const sources = settingsObject(metadata.sources), old = object(sources[plan.from === 'project' ? 'projectMd' : 'userMd']), json = object(sources.json);
    if (old.exists === true || json.exists === true && json.scope === plan.from) throw new Error('An additional old-scope definition is present; target retained for review');
  };
  async function sourcePresent(lane: SettingsRequestLane, source: Source): Promise<boolean> {
    const raw = await read(lane, source.path);
    if (raw === null) return false;
    if (source.kind === 'md') {
      if (raw !== source.raw) throw new Error('Original Agent changed; both definitions retained');
      return true;
    }
    const section = object(parseCollectionJSONC(raw).agent);
    if (!Object.hasOwn(section, plan.name)) return false;
    if (collectionJSONCEntry(raw, 'agent', plan.name).raw !== source.entry) throw new Error('Original Agent changed; both definitions retained');
    return true;
  }
  async function capture(lane: SettingsRequestLane): Promise<Journal> {
    if (plan.from === plan.to || !plan.name.trim() || (plan.from === 'project' || plan.to === 'project') && !plan.directory?.trim()) throw new Error('Captured Agent scope required');
    const metadata = settingsObject(await lane.request(endpoint, 'GET')); check(lane);
    const sources = settingsObject(metadata.sources), target = settingsObject(sources[plan.to === 'project' ? 'projectMd' : 'userMd']);
    const old = settingsObject(sources[plan.from === 'project' ? 'projectMd' : 'userMd']), json = settingsObject(sources.json);
    if (typeof target.path !== 'string' || !target.path || target.exists !== false || json.exists === true && json.scope === plan.to) throw new Error('Target scope already contains this Agent');
    if (plan.to === 'project' && await read(lane, target.path) !== null) throw new Error('Target scope already contains this Agent');
    const captured: Source[] = [];
    let config: Row = {}, markdown: { frontmatter: Row; body: string } | undefined;
    if (json.exists === true && json.scope === plan.from) {
      if (typeof json.path !== 'string') throw new Error('Invalid JSON Agent source');
      const raw = await read(lane, json.path); if (raw === null) throw new Error('Agent source disappeared');
      const entry = collectionJSONCEntry(raw, 'agent', plan.name); config = entry.value;
      captured.push({ path: json.path, kind: 'json', raw: entry.raw, entry: entry.raw, status: 'pending' });
    }
    if (old.exists === true) {
      if (typeof old.path !== 'string') throw new Error('Invalid Markdown Agent source');
      const raw = await read(lane, old.path); if (raw === null) throw new Error('Agent source disappeared');
      markdown = collectionAgentMarkdown(raw);
      config = { ...config, ...markdown.frontmatter };
      captured.unshift({ path: old.path, kind: 'md', raw, status: 'pending' });
    }
    if (!captured.length) throw new Error('Original Agent scope is not present');
    if (plan.to === 'user') {
      const targetConfig = { ...config };
      if (markdown?.body) {
        if (Object.hasOwn(targetConfig, 'system') && targetConfig.system !== markdown.body && !Object.hasOwn(plan.patch, 'system')) throw new Error('Markdown body conflicts with its stored system field; no lossless JSON destination exists');
        targetConfig.system = markdown.body;
      }
      for (const [key, value] of Object.entries(plan.patch)) {
        if (['scope', 'name'].includes(key) || value === undefined) continue;
        if (key === 'system') delete targetConfig.prompt;
        patchField(targetConfig, key, value);
      }
      const response = settingsObject(await lane.request('/api/config/global/opencode', 'GET')); check(lane);
      if (typeof response.content !== 'string') throw new Error('Invalid global configuration source');
      const raw = collectionJSONCInsert(response.content, 'agent', plan.name, JSON.stringify(targetConfig));
      return { target: 'opencode', raw, global: true, config: targetConfig, sources: captured };
    }
    let raw: string;
    if (captured.length === 1 && captured[0].kind === 'md' && !Object.keys(plan.patch).filter(key => !['scope', 'name'].includes(key) && plan.patch[key] !== undefined).length) raw = captured[0].raw;
    else {
      let body = markdown?.body ?? (typeof config.system === 'string' ? config.system : '');
      if (!markdown && typeof config.system === 'string') delete config.system;
      for (const [key, value] of Object.entries(plan.patch)) {
        if (key === 'scope' || key === 'name' || value === undefined) continue;
        if (key === 'system') { body = value === null ? '' : String(value); delete config.system; delete config.prompt; }
        else patchField(config, key, value);
      }
      raw = `---\n${stringify(config)}---\n\n${body}`;
    }
    return { target: target.path, raw, sources: captured };
  }
  async function advance() {
    const lane = transport.capture(); if (!lane?.current()) throw new Error('Runtime changed');
    if (busy) throw new Error('Agent scope move pending'); if (phase === 'done') return;
    busy = true;
    const initialPhase = phase;
    try {
      if (phase === 'draft') {
        journal = await capture(lane); check(lane);
        phase = 'write-unknown';
        const content = journal.raw;
        if (journal.global) journal.raw = '';
        let result: unknown;
        try { result = await lane.request(journal.global ? '/api/config/global/opencode' : scopedSettingsPath('/api/fs/write', plan.directory), journal.global ? 'PUT' : 'POST', journal.global ? { content } : { path: journal.target, content }); }
        catch (error) { if (collectionWriteRejected(error)) { phase = 'draft'; journal = undefined; } throw error; }
        if (result != null && result !== true) settingsObject(result);
        phase = 'copied'; check(lane);
      }
      await verifyTarget(lane); check(lane);
      if (!journal) throw new Error('Scope journal missing');
      if (initialPhase === 'write-unknown') { phase = 'copied'; return; }
      if (initialPhase === 'delete-unknown') {
        const source = journal.sources.find(source => source.status === 'unknown');
        if (!source) throw new Error('Scope cleanup receipt missing');
        source.status = await sourcePresent(lane, source) ? 'pending' : 'absent';
        phase = 'cleanup';
        if (journal.sources.every(source => source.status === 'absent')) { await verifyCleanup(lane); phase = 'done'; }
        return;
      }
      phase = 'cleanup';
      for (const source of journal.sources) {
        check(lane); if (source.status === 'absent') continue;
        const exists = await sourcePresent(lane, source);
        if (!exists) { source.status = 'absent'; continue; }
        if (source.status === 'confirmed') throw new Error('Confirmed old-scope removal has not been observed');
        const metadata = settingsObject(await lane.request(endpoint, 'GET')); check(lane);
        const sources = settingsObject(metadata.sources);
        if (source.kind === 'json') {
          const oldMarkdown = object(sources[plan.from === 'project' ? 'projectMd' : 'userMd']), activeMarkdown = object(sources.md);
          if (oldMarkdown.exists !== false || activeMarkdown.exists === true && activeMarkdown.scope === plan.from) throw new Error('Original Agent source identity changed: old-scope Markdown is still present');
        }
        const descriptor = source.kind === 'md' ? object(sources[plan.from === 'project' ? 'projectMd' : 'userMd']) : object(sources.json);
        if (descriptor.exists !== true || descriptor.path !== source.path || source.kind === 'json' && descriptor.scope !== plan.from) throw new Error('Original Agent source identity changed');
        source.status = 'unknown'; phase = 'delete-unknown';
        const result = await lane.request(endpoint, 'DELETE', { scope: plan.from });
        if (result != null && result !== true) settingsObject(result);
        source.status = 'confirmed'; phase = 'cleanup'; check(lane);
        if (await sourcePresent(lane, source)) throw new Error('Confirmed old-scope removal has not been observed');
        source.status = 'absent';
      }
      await verifyCleanup(lane); phase = 'done';
    } finally { busy = false; }
  }
  return { advance, phase: () => phase, replaceLane: transport.replaceLane, snapshot: () => journal ? { target: journal.target, sources: journal.sources.map(source => ({ path: source.path, kind: source.kind, status: source.status })) } : null };
}
