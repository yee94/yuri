import type { MainTab } from '@/stores/useUIStore';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import {
  buildAppLocation,
  buildNewSessionPath,
  buildSettingsPath,
  buildPluginPagePath,
  type DiffScope,
  type ScheduleView,
} from '@/router/pathContract';
import { SCHEDULE_TAB_ID } from '@/router/primarySurface';
import { routeStateFromPath } from './parseRoute';

export interface AppRouteState {
  sessionId: string | null;
  hostId?: string | null;
  hubId?: string | null;
  directory?: string | null;
  projectId?: string | null;
  /** Welcome / new-session draft surface → `/session/new` */
  isNewSession?: boolean;
  tab: MainTab;
  guiPageKey?: string | null;
  isSettingsOpen: boolean;
  settingsPath: string;
  settingsEntityId?: string | null;
  diffFile: string | null;
  diffScope?: DiffScope | null;
  scheduleView?: ScheduleView | null;
  scheduleProjectId?: string | null;
  scheduleTaskId?: string | null;
  assistantId?: string | null;
  focusSessionId?: string | null;
}

/**
 * Serialize UI state to history path.
 * Schedule / assistant are top-level primaries (no /session/$id prefix).
 * New-session draft is `/session/new` (not a real session id).
 */
export function serializeAppPath(state: AppRouteState): string {
  if (state.isSettingsOpen) {
    return buildSettingsPath({
      slug: state.settingsPath.trim().length > 0 ? state.settingsPath : 'home',
      entityId: state.settingsEntityId ?? null,
    });
  }

  if (state.tab === SCHEDULE_TAB_ID) {
    return buildAppLocation({
      tab: SCHEDULE_TAB_ID,
      scheduleView: state.scheduleView,
      scheduleProjectId: state.scheduleProjectId,
      scheduleTaskId: state.scheduleTaskId,
      focusSessionId: state.focusSessionId,
    });
  }

  if (state.tab === 'plugin') {
    try {
      const parts: unknown = JSON.parse(state.guiPageKey ?? 'null');
      if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === 'string' && part)) {
        return buildPluginPagePath(parts[0], parts[1]);
      }
    } catch { /* An invalid transient selection never becomes a session URL. */ }
    return '/';
  }

  if (state.tab === 'assistant') {
    return buildAppLocation({
      tab: 'assistant',
      assistantId: state.assistantId,
      focusSessionId: state.focusSessionId,
    });
  }

  const withHost = (path: string): string => {
    if (!state.hostId) return path;
    if (!state.hubId || !state.directory) throw new Error('Remote route requires Hub and raw directory');
    const url = new URL(path, 'https://router.invalid');
    url.searchParams.set('hostId', state.hostId);
    url.searchParams.set('hubId', state.hubId);
    url.searchParams.set('directory', state.directory);
    if (state.projectId) url.searchParams.set('projectId', state.projectId);
    return `${url.pathname}${url.search}`;
  };

  // Draft / welcome — must win over a lingering path session id
  if (state.isNewSession || (!state.sessionId && state.tab === 'chat')) {
    // Only force /session/new when explicitly in draft mode; bare chat without
    // session may be transitional — still prefer draft path when flagged.
    if (state.isNewSession) {
      return withHost(buildNewSessionPath());
    }
  }

  if (state.sessionId && state.sessionId.trim().length > 0 && state.sessionId !== 'new') {
    const fileTabs = new Set(['diff', 'files', 'diagram']);
    const file =
      fileTabs.has(state.tab) && state.diffFile
        ? state.diffFile
        : null;

    return withHost(buildAppLocation({
      sessionId: state.sessionId.trim(),
      tab: state.tab,
      file,
      scope: state.tab === 'diff' ? (state.diffScope ?? null) : null,
    }));
  }

  if (state.isNewSession) {
    return withHost(buildNewSessionPath());
  }

  return '/';
}

function routeMatchesURL(state: AppRouteState): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const current = `${window.location.pathname}${window.location.search}`;
    const next = serializeAppPath(state);
    return JSON.stringify(routeStateFromPath(current)) === JSON.stringify(routeStateFromPath(next));
  } catch {
    return true;
  }
}

export function updateBrowserURL(
  state: AppRouteState,
  options: { replace?: boolean; force?: boolean } = {},
): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeContext() || isEmbeddedSessionChat()) {
    return;
  }

  if (!options.force && routeMatchesURL(state)) {
    return;
  }

  try {
    const url = serializeAppPath(state);

    if (options.replace) {
      window.history.replaceState({ ...window.history.state, route: state }, '', url);
    } else {
      window.history.pushState({ route: state }, '', url);
    }
  } catch {
    // non-critical
  }
}

function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}
