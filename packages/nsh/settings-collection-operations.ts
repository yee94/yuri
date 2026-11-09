import type { Row } from './model';
import { createSettingsLaneOwner, scopedSettingsPath, settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';
import { nativeCollectionDraft } from './settings-collections-core';

export function collectionCopyName(name: string, rows: readonly Row[]) {
  const names = new Set(rows.map(row => row.name));
  let next = `${name}-copy`, index = 1;
  while (names.has(next)) next = `${name}-copy-${++index}`;
  return next;
}

export function mergeCollectionEnv(source: Row, input: string): Row {
  const result = { ...source };
  let count = 0;
  for (const line of input.split('\n')) {
    const trimmed = line.trim(), index = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) { Object.defineProperty(result, key, { value, configurable: true, enumerable: true, writable: true }); count++; }
  }
  if (!count) throw new Error('No KEY=VALUE pairs');
  return result;
}
export function renameCollectionKey(source: Row, key: string, nextKey: string): Row {
  const next = nextKey.trim();
  if (!next || (next !== key && Object.hasOwn(source, next))) throw new Error('Invalid or duplicate key');
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [name === key ? next : name, value]));
}

export type CollectionRenamePlan = Readonly<{
  domain: 'agents' | 'commands' | 'skills.installed'; name: string; nextName: string;
  scope: string; directory?: string; config: Row;
}>;
type Phase = 'draft' | 'create-unknown' | 'created' | 'delete-unknown' | 'done';
/** One captured operation. An uncertain response admits reads only on the next explicit action. */
export function createCollectionRename(plan: CollectionRenamePlan, send: SettingsRequest, current: () => boolean) {
  const transport = createSettingsLaneOwner(send, current);
  let phase: Phase = 'draft', busy = false;
  const domain = plan.domain === 'skills.installed' ? 'skills' : plan.domain;
  const path = (name: string) => scopedSettingsPath(`/api/config/${domain}/${encodeURIComponent(name)}`, plan.directory);
  const accepted = (value: unknown) => { if (value != null && value !== true) settingsObject(value); };
  const equal = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const a = Object.entries(left), b = Object.entries(right);
    return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key) && equal(value, (right as Row)[key]));
  };
  const exists = async (name: string, lane: SettingsRequestLane) => {
    const check = () => { if (!lane.current()) throw new Error('Runtime changed'); };
    try {
      const value = await lane.request(domain === 'agents' ? scopedSettingsPath(`/api/config/agents/${encodeURIComponent(name)}/config`, plan.directory) : path(name), 'GET');
      check(); const body = settingsObject(value);
      return body.source === 'none' || body.isBuiltIn === true ? null : body;
    }
    catch (error) { check(); if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; }
  };
  async function advance() {
    const lane = transport.capture();
    if (!lane) throw new Error('Runtime changed');
    const send = lane.request, check = () => { if (!lane.current()) throw new Error('Runtime changed'); };
    check(); if (busy) throw new Error('Rename pending');
    if (phase === 'done') return;
    busy = true;
    try {
      if (phase === 'create-unknown') {
        const found = domain === 'agents'
          ? settingsObject(await send(scopedSettingsPath(`/api/config/agents/${encodeURIComponent(plan.nextName)}/config`, plan.directory), 'GET'))
          : await exists(plan.nextName, lane);
        check();
        if (!found || found.source === 'none' || domain === 'agents' && found.scope !== plan.scope) throw new Error('Created definition is not confirmed');
        const config = domain === 'agents' ? settingsObject(found.config) : (await nativeCollectionDraft(send, plan.domain, { name: plan.nextName }, plan.directory)).config;
        check();
        const expected = domain === 'skills' ? { ...plan.config, name: plan.nextName } : plan.config;
        if (!equal(config, expected)) throw new Error('Created definition differs; inspect before continuing');
        phase = 'created'; return;
      }
      if (phase === 'delete-unknown') {
        const old = await exists(plan.name, lane);
        check(); phase = old ? 'created' : 'done'; return;
      }
      if (phase === 'draft') {
        if (!plan.nextName.trim() || plan.nextName === plan.name) throw new Error('New name required');
        phase = 'create-unknown';
        accepted(await send(path(plan.nextName), 'POST', { ...plan.config, ...(domain === 'skills' ? { name: plan.nextName } : {}), scope: plan.scope }));
        check(); phase = 'created';
      }
      const source = await nativeCollectionDraft(send, plan.domain, { name: plan.name }, plan.directory);
      check();
      if (!equal(source.config, plan.config)) throw new Error('Original definition changed; both definitions retained');
      check(); phase = 'delete-unknown';
      accepted(await send(path(plan.name), 'DELETE', domain === 'agents' ? { scope: plan.scope } : undefined));
      check(); phase = 'done';
    } finally { busy = false; }
  }
  return { advance, phase: () => phase, replaceLane: transport.replaceLane };
}
