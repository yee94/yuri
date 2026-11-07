import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { Row } from './model';
import { createSettingsLaneOwner, settingsObject, settingsRows, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';

export type ProjectSettingsRef = { id: string; path: string };
export type ProjectSettingsSection = 'actions' | 'setup';
// Wire keys and artwork mirror Web projectActions.ts; the parity test guards this native-only boundary.
export const projectSettingsActionIcons = [
  { key: 'play', Icon: 'play' }, { key: 'build', Icon: 'hammer' }, { key: 'lint', Icon: 'checkbox-circle' },
  { key: 'terminal', Icon: 'terminal-box' }, { key: 'tools', Icon: 'tools' }, { key: 'bug', Icon: 'bug' },
  { key: 'flask', Icon: 'flask' }, { key: 'rocket', Icon: 'rocket' }, { key: 'code', Icon: 'code' },
  { key: 'server', Icon: 'server' }, { key: 'branch', Icon: 'git-branch' }, { key: 'search', Icon: 'search' },
  { key: 'settings', Icon: 'settings-3' }, { key: 'brain', Icon: 'brain-ai-3' }, { key: 'stack', Icon: 'stack' },
  { key: 'robot', Icon: 'robot-2' }, { key: 'command', Icon: 'command' }, { key: 'file', Icon: 'file-text' },
] as const;
export type ProjectSettingsAction = Row & { id: string; name: string; command: string; icon?: string | null; autoOpenUrl?: boolean; openUrl?: string };
export type ProjectSettingsDraft = { actions: ProjectSettingsAction[]; commands: string[]; wait: boolean };
export type ProjectSettingsSnapshot = ProjectSettingsDraft & {
  /** Form-only identities parallel to commands; never derive row identity from editable text or persist it. */
  commandIDs: string[];
  ready: Record<ProjectSettingsSection, boolean>;
  errors: Record<ProjectSettingsSection, string>;
  busy: ProjectSettingsSection | 'load' | null;
  pending: ProjectSettingsSection | null;
  saved: ProjectSettingsSection | null;
};
export const emptyProjectSettings = (): ProjectSettingsSnapshot => ({ actions: [], commands: [''], commandIDs: ['setup-command-initial'], wait: false, ready: { actions: false, setup: false }, errors: { actions: '', setup: '' }, busy: null, pending: null, saved: null });
export const projectSettingsSetupEditable = (snapshot: ProjectSettingsSnapshot): boolean => snapshot.ready.setup && snapshot.busy !== 'load';
export const projectSettingsErrorKey = (section: ProjectSettingsSection): I18nKey => section === 'actions' ? 'settings.projects.actions.toast.saveFailed' : 'settings.yuri.worktrees.setup.toast.saveFailed';
const normalizeProjectSettingsPath = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '') || (path.trim() === '/' ? '/' : '');

/** Host sanitizeProjects omits cleared icon/color/model but preserves nullable iconBackground. */
export function projectSettingsIdentityMatches(actual: Row, expected: Row, keys: readonly string[]): boolean {
  return keys.every(key => (actual[key] ?? null) === (expected[key] ?? null));
}

/** Identity follows Web yuriConfig: the normalized root PATH, never the catalog ID or focused worktree. */
export function projectSettingsFile(home: string, project: ProjectSettingsRef): string {
  const root = normalizeProjectSettingsPath(project.path), base = normalizeProjectSettingsPath(home);
  const id = createProjectIdFromPath(root);
  if (!base || !root || !id) throw new Error('Invalid project configuration scope');
  return `${base === '/' ? '' : base}/.config/yuri/projects/${id}.json`;
}

export function parseProjectSettingsFile(raw: unknown): Row {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Invalid project configuration file');
  return settingsObject(JSON.parse(raw));
}

function projectSettingsActions(config: Row): ProjectSettingsAction[] {
  if (config.projectActions === undefined) return [];
  const seen = new Set<string>();
  return settingsRows(config.projectActions).map(row => {
    if (typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id.trim()) || typeof row.name !== 'string' || !row.name.trim() || typeof row.command !== 'string' || !row.command.trim()) throw new Error('Invalid project actions');
    if (row.icon !== undefined && row.icon !== null && typeof row.icon !== 'string' || row.openUrl !== undefined && typeof row.openUrl !== 'string' || row.autoOpenUrl !== undefined && typeof row.autoOpenUrl !== 'boolean') throw new Error('Invalid project action fields');
    seen.add(row.id.trim());
    return { ...row, id: row.id.trim(), name: row.name, command: row.command };
  });
}

function projectSettingsSetup(config: Row): { commands: string[]; wait: boolean } {
  const raw = config['setup-worktree'];
  if (raw !== undefined && (!Array.isArray(raw) || raw.some(item => typeof item !== 'string'))) throw new Error('Invalid worktree setup commands');
  if (config['setup-worktree-wait'] !== undefined && typeof config['setup-worktree-wait'] !== 'boolean') throw new Error('Invalid worktree setup wait strategy');
  const commands = (raw ?? []) as string[];
  return { commands: commands.length ? [...commands] : [''], wait: config['setup-worktree-wait'] === true };
}

export function projectSettingsActionsValid(actions: readonly ProjectSettingsAction[]): boolean {
  return actions.every(action => !!action.id.trim() && !!action.name.trim() && !!action.command.trim()) && new Set(actions.map(action => action.id.trim())).size === actions.length;
}

const sectionKeys = (section: ProjectSettingsSection) => section === 'actions' ? ['projectActions', 'projectActionsPrimaryId'] : ['setup-worktree', 'setup-worktree-wait'];
const sectionValue = (config: Row, section: ProjectSettingsSection) => JSON.stringify(sectionKeys(section).map(key => config[key]));
const draftValue = (draft: ProjectSettingsDraft, section: ProjectSettingsSection) => JSON.stringify(section === 'actions' ? draft.actions : [draft.commands, draft.wait]);

/** Same persisted names/limits as Web; retain platform/desktop/unknown action metadata that mobile does not edit. */
export function projectSettingsUpdates(draft: ProjectSettingsDraft, section: ProjectSettingsSection): Row {
  if (section === 'setup') return { 'setup-worktree': draft.commands.filter(command => !!command.trim()), 'setup-worktree-wait': draft.wait };
  if (!projectSettingsActionsValid(draft.actions)) throw new Error('Incomplete project action');
  return { projectActions: draft.actions.map(action => {
    const next: Row = { ...action, id: action.id.trim(), name: action.name.trim().slice(0, 80), command: action.command.trim().slice(0, 4000), icon: typeof action.icon === 'string' ? action.icon.trim() || null : null };
    delete next.autoOpenUrl; delete next.openUrl;
    if (action.autoOpenUrl === true) next.autoOpenUrl = true;
    if (action.openUrl?.trim()) next.openUrl = action.openUrl.trim().slice(0, 2000);
    return next;
  }) };
}

/** Pure injected-transport editor. No engine, filesystem, Host selection, command execution, or timers. */
export function createProjectSettingsEditor(send: SettingsRequest, current: () => boolean, reference: ProjectSettingsRef, changed: (snapshot: ProjectSettingsSnapshot) => void) {
  const project = { ...reference, path: normalizeProjectSettingsPath(reference.path) };
  let snapshot = emptyProjectSettings();
  const transport = createSettingsLaneOwner(send, current);
  const autoSaveSections = new Set<ProjectSettingsSection>();
  const baseline: Partial<Record<ProjectSettingsSection, Row>> = {};
  const pristine: Partial<Record<ProjectSettingsSection, string>> = {};
  let commandSequence = 0, setupRevision = 0;
  const nextCommandID = () => `setup-command-${++commandSequence}`;
  let pending: { section: ProjectSettingsSection; file: string; expected: Row; acknowledged: boolean; before: Row; setup?: { commands: string[]; commandIDs: string[]; wait: boolean; revision: number } } | null = null;
  const publish = (patch: Partial<ProjectSettingsSnapshot>, lane = transport.capture()) => { if (lane?.current()) { snapshot = { ...snapshot, ...patch }; changed(snapshot); } };
  const dirty = (section: ProjectSettingsSection) => snapshot.ready[section] && draftValue(snapshot, section) !== pristine[section];
  const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
  async function readOptional(path: string, lane: SettingsRequestLane): Promise<Row | null> {
    try { return parseProjectSettingsFile(await lane.request(`/api/fs/read?path=${encodeURIComponent(path)}&directory=${encodeURIComponent(project.path)}`)); }
    catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; }
  }
  async function read(lane: SettingsRequestLane) {
    const home = settingsObject(await lane.request('/api/fs/home')).home;
    if (typeof home !== 'string') throw new Error('Invalid Host home directory');
    const file = projectSettingsFile(home, project);
    const canonical = await readOptional(file, lane);
    // Legacy is read-only here: opening settings must not mutate or delete a repository file.
    const config = canonical ?? await readOptional(`${project.path === '/' ? '' : project.path}/.yuri/yuri.json`, lane) ?? {};
    if (!lane.current()) throw new Error('Project configuration scope changed');
    return { file, config };
  }
  function adopt(config: Row, section: ProjectSettingsSection) {
    const setup = section === 'setup' ? projectSettingsSetup(config) : null;
    const patch = setup ? { ...setup, commandIDs: setup.commands.map(nextCommandID) } : { actions: projectSettingsActions(config) };
    if (section === 'setup') setupRevision++;
    baseline[section] = config;
    pristine[section] = draftValue({ ...snapshot, ...patch }, section);
    publish({ ...patch, ready: { ...snapshot.ready, [section]: true }, errors: { ...snapshot.errors, [section]: '' } });
  }
  async function reconcile(lane: SettingsRequestLane) {
    if (!pending) return;
    const captured = pending;
    const actual = await readOptional(captured.file, lane);
    if (!lane.current()) throw new Error('Project configuration scope changed');
    if (actual && sectionValue(actual, captured.section) === sectionValue(captured.expected, captured.section)) {
      // Blank command rows are local form affordances, not persisted commands. Web keeps them after auto-save too.
      if (captured.section === 'setup') {
        const submitted = captured.setup;
        if (!submitted) throw new Error('Missing submitted setup draft');
        const setup = projectSettingsSetup(actual);
        baseline.setup = actual;
        pristine.setup = draftValue({ actions: [], commands: submitted.commands, wait: submitted.wait }, 'setup');
        // The read confirms this submission, not text entered while any of its requests were in flight.
        publish({ ...(setupRevision === submitted.revision ? { commands: submitted.commands, commandIDs: submitted.commandIDs, wait: setup.wait } : {}), errors: { ...snapshot.errors, setup: '' } });
      } else adopt(actual, captured.section);
      pending = null;
      publish({ pending: null, saved: dirty(captured.section) ? null : captured.section });
      return;
    }
    // An unacknowledged request may have failed before writing; require an explicit retry after this read.
    if (!captured.acknowledged && sectionValue(actual ?? {}, captured.section) === sectionValue(captured.before, captured.section)) {
      pending = null; publish({ pending: null });
    }
    throw new Error('Project configuration read-back does not match the saved draft');
  }
  async function operation(busy: ProjectSettingsSnapshot['busy'], section: ProjectSettingsSection | null, work: (lane: SettingsRequestLane) => Promise<void>) {
    const lane = transport.capture();
    if (snapshot.busy || !lane?.current()) return;
    publish({ busy, saved: null, ...(section ? { errors: { ...snapshot.errors, [section]: '' } } : {}) }, lane);
    try { await work(lane); }
    catch (error) {
      const errors = { ...snapshot.errors };
      if (section) errors[section] = detail(error); else errors.actions = errors.setup = detail(error);
      publish({ errors }, lane);
    } finally { publish({ busy: null }, lane); }
  }
  function editSetup(patch: Partial<ProjectSettingsDraft>, identities?: string[]) {
    if (!projectSettingsSetupEditable(snapshot) || !transport.capture()?.current()) return;
    const commands = patch.commands ? patch.commands.length ? [...patch.commands] : [''] : snapshot.commands;
    const commandIDs = identities ?? (commands.length === snapshot.commands.length ? snapshot.commandIDs : commands.map((_, index) => snapshot.commandIDs[index] ?? nextCommandID()));
    const wait = patch.wait ?? snapshot.wait;
    if (wait === snapshot.wait && commands.length === snapshot.commands.length && commands.every((value, index) => value === snapshot.commands[index]) && commandIDs.every((id, index) => id === snapshot.commandIDs[index])) return;
    setupRevision++;
    autoSaveSections.add('setup');
    publish({ commands, commandIDs, wait, saved: null, errors: { ...snapshot.errors, setup: snapshot.pending ? snapshot.errors.setup : '' } });
  }
  return {
    snapshot: () => snapshot,
    replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); autoSaveSections.clear(); snapshot = { ...snapshot, busy: null }; changed(snapshot); },
    autoSaveAllowed: (section: ProjectSettingsSection) => autoSaveSections.has(section),
    async resume() {
      await operation('load', null, async lane => {
        if (pending) { await reconcile(lane); return; }
        if (dirty('actions') || dirty('setup')) return;
        const { config } = await read(lane);
        if (!lane.current()) return;
        for (const section of ['actions', 'setup'] as const) adopt(config, section);
      });
    },
    dirty,
    edit(section: ProjectSettingsSection, patch: Partial<ProjectSettingsDraft>) {
      if (section === 'setup') { editSetup(patch); return; }
      if (!snapshot.ready[section] || snapshot.busy || snapshot.pending || !transport.capture()?.current()) return;
      autoSaveSections.add(section);
      publish({ actions: patch.actions ?? snapshot.actions, saved: null, errors: { ...snapshot.errors, [section]: '' } });
    },
    updateCommand(id: string, value: string) {
      const index = snapshot.commandIDs.indexOf(id);
      if (index < 0) return;
      editSetup({ commands: snapshot.commands.map((command, position) => position === index ? value : command) });
    },
    appendCommand() {
      editSetup({ commands: [...snapshot.commands, ''] }, [...snapshot.commandIDs, nextCommandID()]);
    },
    removeCommand(id: string) {
      const index = snapshot.commandIDs.indexOf(id);
      if (index < 0) return;
      const commands = snapshot.commands.filter((_, position) => position !== index), commandIDs = snapshot.commandIDs.filter((_, position) => position !== index);
      editSetup({ commands: commands.length ? commands : [''] }, commands.length ? commandIDs : [nextCommandID()]);
    },
    async load() {
      if (snapshot.pending || dirty('actions') || dirty('setup')) return;
      await operation('load', null, async lane => {
        const { config } = await read(lane);
        if (!lane.current()) return;
        for (const section of ['actions', 'setup'] as const) {
          try { adopt(config, section); }
          catch (error) { publish({ errors: { ...snapshot.errors, [section]: detail(error) } }); }
        }
      });
    },
    async reload(section: ProjectSettingsSection) {
      if (snapshot.pending && snapshot.pending !== section) return;
      await operation('load', section, async lane => {
        const { config } = await read(lane);
        if (!lane.current()) return;
        adopt(config, section);
        if (pending?.section === section) { pending = null; publish({ pending: null }); }
      });
    },
    async save(section: ProjectSettingsSection) {
      if (!snapshot.ready[section] || snapshot.pending && snapshot.pending !== section) return;
      if (!snapshot.pending && !dirty(section)) return;
      await operation(section, section, async lane => {
        if (pending) { await reconcile(lane); return; }
        const submittedSetup = section === 'setup' ? { commands: [...snapshot.commands], commandIDs: snapshot.commandIDs, wait: snapshot.wait, revision: setupRevision } : undefined;
        const updates = projectSettingsUpdates(snapshot, section);
        const fresh = await read(lane);
        if (!lane.current()) return;
        if (sectionValue(fresh.config, section) !== sectionValue(baseline[section] ?? {}, section)) throw new Error('Project configuration changed since loading; keep this draft and reload before replacing it');
        const expected: Row = { ...fresh.config, ...updates, projectPath: project.path };
        if (section === 'actions') delete expected.projectActionsPrimaryId;
        pending = { section, file: fresh.file, expected, acknowledged: false, before: fresh.config, setup: submittedSetup };
        publish({ pending: section });
        try {
          const response = settingsObject(await lane.request(`/api/fs/write?directory=${encodeURIComponent(project.path)}`, 'POST', { path: fresh.file, content: JSON.stringify(expected, null, 2) }));
          if (!lane.current()) return;
          if (response.success !== true) { pending = null; publish({ pending: null }); throw new Error('Project configuration write was rejected'); }
          pending.acknowledged = true;
        } catch (error) {
          if (lane.current() && error && typeof error === 'object' && 'status' in error) { pending = null; publish({ pending: null }, lane); }
          throw error;
        }
        await reconcile(lane);
      });
    },
  };
}
