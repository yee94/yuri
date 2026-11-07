import { BUILTIN_STARTERS, DEFAULT_GLOBAL_STARTERS, getBuiltInStarter, normalizeStarterLabel, sanitizeStarterRefs, starterKey, type DraftStarterRef } from '../ui/src/lib/draftStarters';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { resolveAgentModelSelection } from '../ui/src/components/chat/mobileControlsUtils';
import { list, record, text, type Row } from './model';
import type { NativeNewSessionSelection } from './new-session';
import { modelRefs, preferenceUpdate, sameModel, type ModelRef } from './chat-models-helpers';

export { BUILTIN_STARTERS, DEFAULT_GLOBAL_STARTERS, getBuiltInStarter, normalizeStarterLabel, sanitizeStarterRefs, starterKey };
export type { DraftStarterRef };

export type StarterGroup = 'global' | 'project';
export type StarterItem = { ref: DraftStarterRef; group: StarterGroup; id: string; label: string; icon: typeof BUILTIN_STARTERS[number]['icon'] | 'terminal-box' | 'book-open'; submitText: string };
export type StarterOption = { ref: DraftStarterRef; group: StarterGroup; label: string; section: 'built-in' | 'command' | 'skill' };
export const starterID = (group: StarterGroup, ref: DraftStarterRef) => `${group}:${starterKey(ref)}`;
export function globalStarterRefs(settings: Row): DraftStarterRef[] {
  return sanitizeStarterRefs(Array.isArray(settings.draftStarters) ? settings.draftStarters : DEFAULT_GLOBAL_STARTERS);
}
export function resolveStarters(refs: DraftStarterRef[], group: StarterGroup, commands: Row[], skills: Row[], label: (key: typeof BUILTIN_STARTERS[number]['labelKey']) => string): StarterItem[] {
  return refs.flatMap(ref => {
    const builtin = ref.type === 'command' ? getBuiltInStarter(ref.name) : undefined;
    if (!builtin && !(ref.type === 'command' ? commands : skills).some(row => row.name === ref.name)) return [];
    return [{ ref, group, id: starterID(group, ref), label: builtin ? label(builtin.labelKey) : normalizeStarterLabel(ref.name), icon: builtin?.icon ?? (ref.type === 'command' ? 'terminal-box' : 'book-open'), submitText: builtin?.command ?? `${ref.type === 'command' ? '/' : '@'}${ref.name}` }];
  });
}
export function starterOptions(global: DraftStarterRef[], project: DraftStarterRef[], commands: Row[], skills: Row[], label: (key: typeof BUILTIN_STARTERS[number]['labelKey']) => string): StarterOption[] {
  const pinned = new Set([...global, ...project].map(starterKey));
  const options: StarterOption[] = BUILTIN_STARTERS.map(item => ({ ref: { type: 'command', name: item.name }, group: 'global', label: label(item.labelKey), section: 'built-in' }));
  for (const command of commands) {
    const name = text(command.name);
    if (!name || command.isBuiltIn || command.source === 'skill' || getBuiltInStarter(name)) continue;
    options.push({ ref: { type: 'command', name }, group: command.scope === 'project' ? 'project' : 'global', label: normalizeStarterLabel(name), section: 'command' });
  }
  for (const skill of skills) {
    const name = text(skill.name);
    if (name) options.push({ ref: { type: 'skill', name }, group: skill.scope === 'project' ? 'project' : 'global', label: normalizeStarterLabel(name), section: 'skill' });
  }
  return options.filter(item => !pinned.has(starterKey(item.ref)));
}
export function moveStarter(refs: DraftStarterRef[], group: StarterGroup, fromID: string, toID: string): DraftStarterRef[] {
  const from = refs.findIndex(ref => starterID(group, ref) === fromID), to = refs.findIndex(ref => starterID(group, ref) === toID);
  if (from < 0 || to < 0 || from === to) return refs;
  const next = [...refs], [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export const STARTER_TRASH = '__draft-starter-trash__';
export type StarterRect = { id: string; x: number; y: number; width: number; height: number };
export function closestStarter(rects: StarterRect[], active: StarterRect, dx: number, dy: number): string | null {
  const x = active.x + active.width / 2 + dx, y = active.y + active.height / 2 + dy;
  let nearest: string | null = null, distance = Infinity;
  for (const rect of rects) {
    const next = Math.hypot(x - rect.x - rect.width / 2, y - rect.y - rect.height / 2);
    if (next < distance) { nearest = rect.id; distance = next; }
  }
  return nearest;
}
/** Translation-only rect sorting, within the source group; never live-write ordering. */
export function starterShifts(activeID: string, overID: string | null, rects: StarterRect[]): Map<string, { x: number; y: number }> {
  const shifts = new Map<string, { x: number; y: number }>();
  if (!overID || overID === STARTER_TRASH || activeID === overID) return shifts;
  const group = activeID.split(':')[0], members = rects.filter(rect => rect.id.startsWith(`${group}:`));
  const from = members.findIndex(rect => rect.id === activeID), to = members.findIndex(rect => rect.id === overID);
  if (from < 0 || to < 0) return shifts;
  for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
    if (index === from) continue;
    const own = members[index], target = members[from < to ? index - 1 : index + 1];
    shifts.set(own.id, { x: target.x - own.x, y: target.y - own.y });
  }
  return shifts;
}
export function starterTranslation(id: string, activeID: string, overID: string | null, rects: StarterRect[]): { x: number; y: number } {
  return starterShifts(activeID, overID, rects).get(id) ?? { x: 0, y: 0 };
}
export function projectStarterLocation(home: string, projectPath: string) {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = normalize(projectPath), directory = `${normalize(home)}/.config/yuri/projects`;
  if (!home.trim() || !root) throw new Error('new-session-invalid-project-scope');
  return { directory, path: `${directory}/${createProjectIdFromPath(root)}.json`, legacy: `${root}/.yuri/yuri.json`, root };
}
export function projectStarterConfig(raw: unknown): Row {
  if (typeof raw !== 'string') throw new Error('new-session-invalid-project-config');
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('new-session-invalid-project-config');
  return record(value);
}
export function agentDraftSelection(selection: NativeNewSessionSelection, agent: string, agents: Row[], providers: Row[], dropChangedVariant = false): NativeNewSessionSelection {
  const next = resolveAgentModelSelection({ providerID: selection.model?.providerID ?? '', modelID: selection.model?.id ?? '', agent: selection.agent ?? null }, agent,
    agents.map(row => ({ name: text(row.name), model: { providerID: text(record(row.model).providerID), modelID: text(record(row.model).modelID) } })),
    providers.map(provider => ({ id: text(provider.id), models: (Array.isArray(provider.models) ? list(provider.models) : Object.values(record(provider.models)).map(record)).map(model => ({ id: text(model.id) })) })));
  const changed = next.providerID !== selection.model?.providerID || next.modelID !== selection.model?.id;
  return { agent, ...(next.providerID && next.modelID ? { model: { providerID: next.providerID, id: next.modelID, ...(!dropChangedVariant || !changed ? selection.model?.variant !== undefined ? { variant: selection.model.variant } : {} : {}) } } : {}) };
}

export function favoriteDraftPatch(settings: Row, entry: ModelRef, selection: NativeNewSessionSelection): Row {
  const selected = { providerID: selection.model?.providerID ?? '', modelID: selection.model?.id ?? '' };
  const variant = sameModel(entry, selected) ? selection.model?.variant : modelRefs(settings.favoriteModels).find(ref => sameModel(ref, entry))?.variant ?? modelRefs(settings.recentModels).find(ref => sameModel(ref, entry))?.variant;
  return preferenceUpdate(settings, 'favorite', { providerID: entry.providerID, modelID: entry.modelID, ...(variant !== undefined ? { variant } : {}) });
}

/** Button release after a long press must never also cycle. Ports keep this testable without NSH. */
export function createAgentPress(port: { enabled: () => boolean; cycle: () => void; open: () => void; schedule: (work: () => void) => unknown; cancelTimer: (timer: unknown) => void }) {
  let timer: unknown, suppressed = false;
  const up = () => { if (timer !== undefined) port.cancelTimer(timer); timer = undefined; };
  return {
    down() { up(); suppressed = false; if (port.enabled()) timer = port.schedule(() => { timer = undefined; if (port.enabled()) { suppressed = true; port.open(); } }); },
    up,
    press() { up(); if (!suppressed && port.enabled()) port.cycle(); suppressed = true; },
    cancel() { up(); suppressed = true; },
  };
}
