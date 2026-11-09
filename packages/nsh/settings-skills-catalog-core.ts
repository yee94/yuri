import type { RawNativeResponse } from './runtime';
import { settingsObject, settingsRows, scopedSettingsPath } from './settings-protocol';
import { record, text, type Row } from './model';

export type NativeCatalogSource = { id: string; label: string; source: string; description?: string; defaultSubpath?: string; sourceType?: string };
export type NativeCatalogSkill = { sourceId: string; repoSource: string; skillDir: string; skillName: string; installable: boolean; repoSubpath?: string; gitIdentityId?: string; description?: string; frontmatterName?: string; warnings?: string[]; installed?: { isInstalled: boolean; scope?: string; source?: string }; clawdhub?: { slug: string; version: string; owner?: string; downloads?: number; stars?: number } };
export type NativeSkillConflict = { skillName: string; scope: 'user' | 'project'; source?: string };
export type NativeCatalogFailure = { kind: string; identities: { id: string; name: string }[]; conflicts: NativeSkillConflict[] };
export type NativeSkillInstall = { source: string; subpath?: string; gitIdentityId?: string; scope: 'user' | 'project'; targetSource: 'opencode' | 'agents'; selections: { skillDir: string; clawdhub?: { slug: string; version: string } }[]; conflictPolicy: 'prompt'; conflictDecisions?: Record<string, 'skip' | 'overwrite'> };

function required(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid catalog identity'); return value; }
export function nativeCatalogSources(value: unknown): NativeCatalogSource[] {
  const data = settingsObject(value);
  return settingsRows(data.sources).map(row => ({ id: required(row.id), label: required(row.label), source: required(row.source), ...(typeof row.description === 'string' ? { description: row.description } : {}), ...(typeof row.defaultSubpath === 'string' ? { defaultSubpath: row.defaultSubpath } : {}), ...(typeof row.sourceType === 'string' ? { sourceType: row.sourceType } : {}) }));
}
export function nativeCatalogPage(value: unknown, sourceId: string): { items: NativeCatalogSkill[]; cursor: string | null } {
  const data = settingsObject(value);
  if (data.nextCursor !== undefined && data.nextCursor !== null && typeof data.nextCursor !== 'string') throw new Error('Invalid catalog cursor');
  const items = settingsRows(data.items).map(row => {
    if (row.sourceId !== sourceId || typeof row.installable !== 'boolean') throw new Error('Invalid catalog source');
    if (row.warnings !== undefined && (!Array.isArray(row.warnings) || row.warnings.some(item => typeof item !== 'string'))) throw new Error('Invalid catalog warnings');
    const item: NativeCatalogSkill = { sourceId, repoSource: required(row.repoSource), skillDir: typeof row.skillDir === 'string' ? row.skillDir : required(row.skillDir), skillName: required(row.skillName), installable: row.installable };
    for (const key of ['repoSubpath', 'gitIdentityId', 'description', 'frontmatterName'] as const) if (typeof row[key] === 'string') item[key] = row[key];
    if (row.warnings) item.warnings = row.warnings as string[];
    if (row.installed !== undefined) {
      const badge = settingsObject(row.installed); if (typeof badge.isInstalled !== 'boolean') throw new Error('Invalid installed state');
      item.installed = { isInstalled: badge.isInstalled, ...(typeof badge.scope === 'string' ? { scope: badge.scope } : {}), ...(typeof badge.source === 'string' ? { source: badge.source } : {}) };
    }
    if (row.clawdhub !== undefined) {
      const metadata = settingsObject(row.clawdhub);
      item.clawdhub = { slug: required(metadata.slug), version: required(metadata.version), ...(typeof metadata.owner === 'string' ? { owner: metadata.owner } : {}), ...(typeof metadata.downloads === 'number' ? { downloads: metadata.downloads } : {}), ...(typeof metadata.stars === 'number' ? { stars: metadata.stars } : {}) };
    }
    return item;
  });
  return { items, cursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null };
}
export function mergeNativeCatalogItems(prior: readonly NativeCatalogSkill[], next: readonly NativeCatalogSkill[]): NativeCatalogSkill[] {
  const items = [...prior], positions = new Map(items.map((item, index) => [JSON.stringify([item.sourceId, item.skillDir]), index]));
  for (const item of next) { const key = JSON.stringify([item.sourceId, item.skillDir]), index = positions.get(key); if (index === undefined) { positions.set(key, items.length); items.push(item); } else items[index] = item; }
  return items;
}
export function nativeCatalogSourcePath(id: string, directory?: string, options: { refresh?: boolean; cursor?: string | null } = {}) {
  return scopedSettingsPath(`/api/config/skills/catalog/source?sourceId=${encodeURIComponent(id)}${options.refresh ? '&refresh=true' : ''}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''}`, directory);
}
export function nativeSkillInstall(item: NativeCatalogSkill, location: string, directory?: string, decisions?: Record<string, 'skip' | 'overwrite'>): { path: string; body: NativeSkillInstall } {
  if (!item.installable || !['user-opencode', 'project-opencode', 'user-agents', 'project-agents'].includes(location)) throw new Error('Invalid skill destination');
  const scope = location.startsWith('project-') ? 'project' : 'user';
  if (scope === 'project' && !directory?.trim()) throw new Error('Missing project directory');
  return { path: scopedSettingsPath('/api/config/skills/install', scope === 'project' ? directory : undefined), body: {
    source: item.repoSource, ...(item.repoSubpath ? { subpath: item.repoSubpath } : {}), ...(item.gitIdentityId ? { gitIdentityId: item.gitIdentityId } : {}), scope, targetSource: location.endsWith('-agents') ? 'agents' : 'opencode',
    selections: [{ skillDir: item.skillDir, ...(item.clawdhub ? { clawdhub: { slug: item.clawdhub.slug, version: item.clawdhub.version } } : {}) }], conflictPolicy: 'prompt', ...(decisions ? { conflictDecisions: decisions } : {}),
  } };
}
export function nativeCatalogFailure(response: RawNativeResponse): NativeCatalogFailure | null {
  const data = record(response.body);
  if (response.status >= 200 && response.status < 300 && data.ok === true) return null;
  const failure = record(data.error), identities = failure.identities === undefined ? [] : settingsRows(failure.identities).map(row => ({ id: required(row.id), name: required(row.name) }));
  const conflicts = failure.conflicts === undefined ? [] : settingsRows(failure.conflicts).map((row): NativeSkillConflict => {
    if (row.scope !== 'user' && row.scope !== 'project') throw new Error('Invalid conflict scope');
    return { skillName: required(row.skillName), scope: row.scope, ...(typeof row.source === 'string' ? { source: row.source } : {}) };
  });
  return { kind: text(failure.kind) || 'unknown', identities, conflicts };
}
export function nativeSkillCatalogPatch(snapshot: unknown, change: { add: Row } | { remove: string }): { skillCatalogs: Row[] } {
  const data = settingsObject(snapshot), catalogs = data.skillCatalogs === undefined ? [] : settingsRows(data.skillCatalogs);
  if ('remove' in change) {
    if (!change.remove.startsWith('custom:')) throw new Error('Cannot remove curated source');
    return { skillCatalogs: catalogs.filter(row => row.id !== change.remove) };
  }
  const next = change.add;
  if (!required(next.id).startsWith('custom:') || !text(next.label).trim() || !text(next.source).trim()) throw new Error('Invalid catalog');
  const same = catalogs.find(row => row.id === next.id);
  if (same) {
    if (same.source !== next.source || same.label !== next.label || text(same.subpath) !== text(next.subpath) || text(same.gitIdentityId) !== text(next.gitIdentityId)) throw new Error('Catalog identity changed');
    return { skillCatalogs: catalogs };
  }
  if (catalogs.some(row => text(row.source).trim() === text(next.source).trim() && text(row.subpath).trim() === text(next.subpath).trim())) throw new Error('Duplicate catalog');
  return { skillCatalogs: [...catalogs, next] };
}
