import type { App } from '../.nsh/types/nsh/test';

export type SettingsNavigationAudit = {
  writes: Array<{ path: string; directory: string; body: unknown }>;
  requests: Array<{ path: string; resource: string; method: string; body?: unknown; expectedHost?: { hostID: string; lease: string } }>;
  runtimeScope: { hostID: string; lease: string } | null;
  rejected: unknown[]; settingsReads: number;
  notification: { configurations: unknown[]; osAuthorization: string; scheduled: number };
};
type Check = (value: unknown) => { toBe: (value: unknown) => void; toEqual: (value: unknown) => void; toHaveLength: (value: number) => void; toContain: (value: unknown) => void };

/** NSH's public Keyboard.press models a hardware keyboard, including one attached to iOS. */
export async function verifyCommandPaletteToggle(app: Pick<App, 'waitFor' | 'value'> & { keyboard: Pick<App['keyboard'], 'press'> }, check: Check) {
  await app.keyboard.press('mod+p');
  await app.waitFor('id:projects-global-search');
  await app.keyboard.press('mod+p');
  await app.waitFor('id:projects-global-search', { state: 'gone' });
  await app.waitFor('id:composer');
  check(app.value('id:composer')).toBe('Unsaved actual worktree draft');
}

/** Headless texts expose content only, not NavPage's system navigation title. UIKit owns that title's visual acceptance. */
export function verifySettingsHomeContent(app: Pick<App, 'shows' | 'texts'>, check: Check) {
  check(app.shows('id:settings-search')).toBe(true);
  check(app.texts().filter(value => value === 'Settings')).toHaveLength(0);
}

/** The real reused ProjectsHome control and public Back prove the picker boundary; no native title text is assumed. */
export async function verifySessionSwitcherBack(app: Pick<App, 'waitFor' | 'value' | 'back' | 'shows'> & { keyboard: Pick<App['keyboard'], 'press'> }, check: Check) {
  await app.keyboard.press('mod+b');
  await app.waitFor('id:projects-open-search');
  check(app.shows('id:composer')).toBe(false);
  await app.back();
  await app.waitFor('id:projects-open-search', { state: 'gone' });
  await app.waitFor('id:composer');
  check(app.value('id:composer')).toBe('Unsaved actual worktree draft');
}

/** Public worktree disclosure -> actual session row. No route/state injection. */
export async function enterActualChat(app: App, check: Check) {
  await app.waitFor('text:Actual parent project');
  await app.waitFor('id:project-worktree-/fixture/second/.worktrees/topic');
  await app.press('id:project-worktree-/fixture/second/.worktrees/topic');
  await app.waitFor('id:project-session-ses_actual');
  await app.press('id:project-session-ses_actual');
  await app.waitFor('id:composer');
  await app.type('id:composer', 'Unsaved actual worktree draft');
  check(app.value('id:composer')).toBe('Unsaved actual worktree draft');
}

/** Keep ordinary character-stream typing; a keyboard-only suffix probes focus without targeting/focusing a replacement editor. */
export async function typeSettingsURL(app: Pick<App, 'clear' | 'type' | 'value'> & { keyboard: Pick<App['keyboard'], 'press'> }, check: Check) {
  const url = 'https://mcp.example.invalid/edited';
  await app.clear('id:settings-url');
  await app.type('id:settings-url', url);
  check(app.value('id:settings-url')).toBe(url);
  await app.keyboard.press('x');
  check(app.value('id:settings-url')).toBe(url + 'x');
  await app.keyboard.press('backspace');
  check(app.value('id:settings-url')).toBe(url);
}

/** File demand is explicit user input; local command selection is allowed to cancel its own pending debounce. */
export async function verifyActualFileSearch(app: Pick<App, 'type' | 'clear' | 'value' | 'waitFor' | 'shows'>, audit: () => SettingsNavigationAudit, check: Check) {
  await app.type('id:projects-global-search', 'worktree-scope-proof');
  check(app.value('id:projects-global-search')).toBe('worktree-scope-proof');
  await app.waitFor('id:projects-search-file:/fixture/second/.worktrees/topic:notes/worktree-scope-proof.txt');
  await app.waitFor('text:Loading...', { state: 'gone' });
  check(app.shows('id:projects-search-retry')).toBe(false);
  check(audit().requests.some(row => row.path === '/api/fs/find' && row.method === 'GET' && row.resource === '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&query=worktree-scope-proof&limit=40&type=file')).toBe(true);
  await app.clear('id:projects-global-search');
}

/** Chat's real native/headless header menu; no synthetic settings trigger. */
export async function chatMcpScenario(app: App, audit: () => SettingsNavigationAudit, check: Check) {
  await enterActualChat(app, check);
  await app.press('id:chat-header-root >> id:chat-header-options');
  await app.waitFor('id:chat-menu-mcp');
  await app.press('id:chat-menu-mcp');
  await app.waitFor('text:scope-mcp');
  await app.press('text:scope-mcp');
  await app.waitUntil(() => app.value('id:settings-url') === 'https://mcp.example.invalid/original');
  await typeSettingsURL(app, check);
  await app.waitUntil(() => app.enabled('text:Save'));
  await app.press('text:Save');
  await app.waitFor('text:Done');
  await app.press('text:Done');
  await app.back();
  await app.waitFor('id:composer');
  check(app.value('id:composer')).toBe('Unsaved actual worktree draft');
  const value = audit();
  check(value.writes).toEqual([{ path: '/api/config/mcp/scope-mcp', directory: '/fixture/second/.worktrees/topic', body: { url: 'https://mcp.example.invalid/edited', scope: 'project' } }]);
  check(value.rejected).toEqual([]);
  check(value.notification.osAuthorization).toBe('unknown');
  check(value.notification.scheduled).toBe(0);
}

/** All entries and list->editor callbacks belong to the mounted production Settings owners. */
export async function scopedSettingsScenario(app: App, audit: () => SettingsNavigationAudit, check: Check, searchSelector = '', viaSwitcher = false) {
  await enterActualChat(app, check);
  await verifyCommandPaletteToggle(app, check);
  if (viaSwitcher) {
    await verifySessionSwitcherBack(app, check);
    await app.keyboard.press('mod+b');
    await app.waitFor('id:projects-open-search');
    await app.press('id:projects-open-search');
  } else if (searchSelector) {
    // Optional only for an actual existing visual entry; the default is the Web hardware shortcut.
    if (!app.shows(searchSelector) && searchSelector.startsWith('id:chat-menu-')) await app.press('id:chat-header-root >> id:chat-header-options');
    await app.waitFor(searchSelector);
    await app.press(searchSelector);
    if (app.shows('id:projects-open-search')) await app.press('id:projects-open-search');
  } else await app.keyboard.press('mod+p');
  await app.waitFor('id:projects-global-search');
  await verifyActualFileSearch(app, audit, check);
  await app.type('id:projects-global-search', 'Open Settings');
  await app.waitFor('id:projects-search-command:open-settings');
  await app.press('id:projects-search-command:open-settings');
  await app.waitFor('id:settings-search');
  verifySettingsHomeContent(app, check);

  await app.press('text:Agents');
  await app.waitFor('text:Actual worktree agent');
  await app.press('text:Actual worktree agent');
  await app.waitUntil(() => app.value('id:settings-description') === 'Actual worktree agent');
  await app.clear('id:settings-description');
  await app.type('id:settings-description', 'Saved in actual worktree');
  await app.waitUntil(() => app.enabled('text:Save'));
  await app.press('text:Save');
  await app.waitFor('text:Done');
  await app.press('text:Done');
  await app.back();
  await app.waitFor('id:settings-search');

  await app.press('text:Skills');
  await app.waitFor('text:scope-skill');
  await app.press('text:scope-skill');
  await app.waitUntil(() => app.value('id:settings-instructions') === 'Original worktree instructions');
  await app.clear('id:settings-instructions');
  await app.type('id:settings-instructions', 'Actual worktree instructions edited');
  await app.waitUntil(() => app.enabled('text:Save'));
  await app.press('text:Save');
  await app.waitFor('text:Done');
  await app.press('text:Done');
  await app.back();
  await app.waitFor('id:settings-search');

  await app.press('text:MCP');
  await app.waitFor('text:scope-mcp');
  await app.press('text:scope-mcp');
  await app.waitUntil(() => app.value('id:settings-url') === 'https://mcp.example.invalid/original');
  await typeSettingsURL(app, check);
  await app.waitUntil(() => app.enabled('text:Save'));
  await app.press('text:Save');
  await app.waitFor('text:Done');
  await app.press('text:Done');
  await app.back();
  await app.waitFor('id:settings-search');
  verifySettingsHomeContent(app, check);
  for (let step = 0; step < 3 && !app.shows('id:composer'); step++) await app.back();
  await app.waitFor('id:composer');
  check(app.value('id:composer')).toBe('Unsaved actual worktree draft');
  const value = audit();
  check(value.writes.map(row => [row.path, row.directory])).toEqual([
    ['/api/config/agents/build', '/fixture/second/.worktrees/topic'],
    ['/api/config/skills/scope-skill', '/fixture/second/.worktrees/topic'],
    ['/api/config/mcp/scope-mcp', '/fixture/second/.worktrees/topic'],
  ]);
  check(value.rejected).toEqual([]);
  check(value.requests.some(row => row.path === '/api/fs/find' && row.resource.includes('location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic'))).toBe(true);
  check(value.requests.filter(row => row.path === '/api/fs/find').every(row => row.method === 'GET' && row.resource.startsWith('/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&query=') && row.resource.endsWith('&limit=40&type=file'))).toBe(true);
}

/** Root Home is initially shown on the real Settings tab; no directory is passed to any callback. */
export async function globalSettingsScenario(app: App, audit: () => SettingsNavigationAudit, check: Check) {
  await app.waitFor('id:settings-search');
  await app.waitFor('text:Settings');
  const before = audit().requests.length;
  for (const [entry, row, field, expected] of [
    ['Agents', 'global-agent', 'settings-description', 'Unscoped user agent'],
    ['Skills', 'global-skill', 'settings-instructions', 'Global instructions'],
    ['MCP', 'global-mcp', 'settings-url', 'https://mcp.example.invalid/global'],
  ]) {
    await app.press('text:' + entry);
    await app.waitFor('text:' + row);
    await app.press('text:' + row);
    await app.waitUntil(() => app.value('id:' + field) === expected);
    await app.back();
    await app.back();
    await app.waitFor('id:settings-search');
  }
  const value = audit();
  const calls = value.requests.slice(before).filter(row => ['/api/agent', '/api/config/agents/metadata', '/api/config/agents/global-agent/config', '/api/config/skills', '/api/config/skills/global-skill', '/api/config/mcp', '/api/mcp'].includes(row.path));
  check(calls.length > 0).toBe(true);
  check(calls.every(row => !row.resource.includes('directory'))).toBe(true);
  check(value.requests.some(row => row.path === '/api/location' || row.path === '/api/permission/saved')).toBe(false);
  check(value.writes).toEqual([]);
  check(value.rejected).toEqual([]);
}
