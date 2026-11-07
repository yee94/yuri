import type { Row } from './model';
import { settingsObject, settingsRows } from './settings-protocol';

// Wire identifiers from ui/src/lib/projectMeta.ts; no React/DOM renderer enters NSH.
export const settingsProjectIcons = {
  code: 'code-box', terminal: 'terminal-box', rocket: 'rocket', flask: 'flask',
  gamepad: 'gamepad', briefcase: 'briefcase', home: 'home', globe: 'global',
  leaf: 'leaf', shield: 'shield', palette: 'palette', server: 'server',
  phone: 'smartphone', database: 'database-2', lightbulb: 'lightbulb',
  music: 'music', camera: 'camera', book: 'book-open', heart: 'heart',
} as const;
export const settingsProjectColors = ['keyword', 'string', 'number', 'type', 'constant', 'comment', 'error', 'primary', 'success'] as const;

/** Merge into a fresh settings read; untouched projects and metadata stay byte-for-byte values. */
export function settingsProjectPatch(snapshot: unknown, projectID: string, changes: Row): { projects: Row[] } {
  const projects = settingsRows(settingsObject(snapshot).projects);
  if (!projects.some(project => project.id === projectID)) throw new Error('Project no longer exists');
  const allowed = ['label', 'icon', 'color', 'iconBackground', 'defaultModel'];
  const patch = Object.fromEntries(allowed.filter(key => key in changes).map(key => [key, changes[key]]));
  if ('label' in patch) {
    if (typeof patch.label !== 'string' || !patch.label.trim()) throw new Error('Invalid project label');
    patch.label = patch.label.trim();
  }
  if ('icon' in patch && patch.icon !== null && !Object.hasOwn(settingsProjectIcons, String(patch.icon))) throw new Error('Invalid project icon');
  if ('color' in patch && patch.color !== null && !settingsProjectColors.some(color => color === patch.color)) throw new Error('Invalid project color');
  if ('iconBackground' in patch && patch.iconBackground !== null) {
    if (typeof patch.iconBackground !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(patch.iconBackground.trim())) throw new Error('Invalid project icon background');
    patch.iconBackground = patch.iconBackground.trim().toLowerCase();
  }
  if ('defaultModel' in patch && patch.defaultModel !== null && (typeof patch.defaultModel !== 'string' || !/^[^/\s]+\/\S+$/.test(patch.defaultModel))) throw new Error('Invalid project model');
  return { projects: projects.map(project => {
    if (project.id !== projectID) return project;
    const next = { ...project, ...patch };
    if (patch.defaultModel === null) delete next.defaultModel;
    return next;
  }) };
}
