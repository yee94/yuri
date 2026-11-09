import type { SettingsPageID } from './settings';

export type SettingsNavigationOwner = {
  dirty: () => boolean;
  pending: () => boolean;
  nestedPickerOpen: () => boolean;
  requestLeave: () => Promise<boolean>;
  /** Stable draft/operation identities, read only when leave is requested. */
  stamp: () => readonly unknown[];
  scope: () => unknown;
};

/** Confirmation never clears input; the route/popup owner commits only after
 * the same live draft and scope have approved leaving. */
export function createSettingsNavigationOwner(options: Omit<SettingsNavigationOwner, 'requestLeave'> & {
  current: () => boolean;
  confirm: () => Promise<boolean>;
}): SettingsNavigationOwner {
  let confirming = false;
  return { ...options, async requestLeave() {
    if (confirming || !options.current() || options.pending() || options.nestedPickerOpen()) return false;
    const scope = options.scope(), stamp = options.stamp();
    if (!options.dirty()) return true;
    confirming = true;
    try {
      if (!await options.confirm() || !options.current() || options.pending() || options.nestedPickerOpen() || !Object.is(scope, options.scope())) return false;
      const next = options.stamp();
      return !options.dirty() || next.length === stamp.length && next.every((value, index) => Object.is(value, stamp[index]));
    } finally { confirming = false; }
  } };
}
export type DesktopSettingsContentNavigationState = {
  owner: object;
  page: SettingsPageID;
  status: 'ready' | 'unavailable' | 'inactive' | 'retired';
  blocked: boolean;
  pending: boolean | null;
  dirty: boolean | null;
  nestedPickerOpen: boolean | null;
  missing: readonly ('dirty-state' | 'pending-state' | 'picker-state')[];
  current: () => boolean;
  requestLeave: () => Promise<boolean>;
};

/** Actual page owners supply draft authority; shared lifetimes/choices supply
 * pending/picker state. Neither entity IDs nor rendered nodes imply a draft. */
export function createDesktopSettingsContentProtection(options: {
  page: SettingsPageID;
  active: () => boolean;
  changed: () => void;
  unavailable: () => Promise<void>;
}) {
  const owner = {}, drafts = new Set<SettingsNavigationOwner>(), pending = new Set<() => boolean>(), pickers = new Set<() => boolean>();
  let alive = true, flight = false, revision = 0;
  function register<T>(set: Set<T>, value: T) {
    if (!alive) return () => {};
    set.add(value); revision++; options.changed();
    return () => { if (set.delete(value)) { revision++; if (alive) options.changed(); } };
  }
  function snapshot(): DesktopSettingsContentNavigationState {
    const owners = [...drafts], busy = [...pending].some(read => read()) || owners.some(value => value.pending());
    const picker = [...pickers].some(read => read()) || owners.some(value => value.nestedPickerOpen());
    const dirty = owners.length ? owners.some(value => value.dirty()) : null;
    const missing: Array<'dirty-state' | 'pending-state' | 'picker-state'> = [];
    if (!owners.length) missing.push('dirty-state', 'picker-state');
    if (!pending.size && !owners.length) missing.push('pending-state');
    return {
      owner, page: options.page, status: !alive ? 'retired' : !options.active() ? 'inactive' : missing.length ? 'unavailable' : 'ready',
      pending: pending.size || owners.length ? busy : null, dirty,
      nestedPickerOpen: picker ? true : owners.length ? false : null, missing,
      blocked: !alive || !options.active() || missing.length > 0 || busy || picker || dirty === true,
      current: () => alive && options.active(), requestLeave,
    };
  }
  async function requestLeave(): Promise<boolean> {
    if (!alive || !options.active() || flight) return false;
    const before = snapshot();
    if (before.pending === true || before.nestedPickerOpen === true) return false;
    flight = true;
    try {
      if (before.missing.length) { await options.unavailable(); return false; }
      const captured = revision, owners = [...drafts], stamps = owners.map(value => value.stamp()), scopes = owners.map(value => value.scope());
      for (const value of owners) if (value.dirty() && !await value.requestLeave()) return false;
      if (!alive || !options.active() || captured !== revision) return false;
      const after = snapshot();
      if (after.pending || after.nestedPickerOpen || after.missing.length) return false;
      return owners.every((value, index) => {
        const next = value.stamp(), prior = stamps[index];
        if (!Object.is(value.scope(), scopes[index])) return false;
        // An approved owner's own cleanup may publish dirty→clean. New or
        // changed unsaved input must still retain the captured draft stamp.
        return !value.dirty() || next.length === prior.length && next.every((item, offset) => Object.is(item, prior[offset]));
      });
    } finally { flight = false; }
  }
  return { snapshot, requestLeave, registerOwner: (value: SettingsNavigationOwner) => register(drafts, value),
    registerPending: (read: () => boolean) => register(pending, read), registerPicker: (read: () => boolean) => register(pickers, read),
    dispose() { alive = false; revision++; drafts.clear(); pending.clear(); pickers.clear(); },
  };
}
export type SettingsNavigationPublisher = ReturnType<typeof createDesktopSettingsContentProtection>;

/** Commit after approval, never pop/reset a native stack before asking. */
export async function requestDesktopSettingsContentLeave(state: DesktopSettingsContentNavigationState | null, commit: () => void): Promise<boolean> {
  if (!state || !await state.requestLeave() || !state.current()) return false;
  commit(); return true;
}

/** Pages with real draft/pending owners. The desktop-only shortcuts slot is
 * opt-in: add that page to visiblePages only when supplying the real renderer. */
export const desktopSettingsIntegratedPages: readonly SettingsPageID[] = [
  'appearance', 'chat', 'notifications', 'projects', 'providers', 'agents', 'commands', 'mcp', 'plugins', 'skills.installed',
  'sessions', 'summary-ai', 'behavior', 'voice', 'instances', 'assistants', 'git', 'usage', 'about', 'archived-sessions', 'magic-prompts', 'global-config', 'remote-instances', 'skills.catalog',
];
