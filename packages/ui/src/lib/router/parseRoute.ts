import type { MainTab } from '@/stores/useUIStore';
import { parseAppPath } from '@/router/pathContract';
import { SCHEDULE_TAB_ID } from '@/router/primarySurface';
import type { RouteState } from './types';

export function parseRoute(searchParams?: URLSearchParams): RouteState {
  if (typeof window === 'undefined') {
    return emptyRoute();
  }

  const pathWithSearch =
    searchParams !== undefined
      ? `${window.location.pathname}?${searchParams.toString()}`
      : `${window.location.pathname}${window.location.search}`;

  return routeStateFromPath(pathWithSearch);
}

export function routeStateFromPath(pathWithSearch: string): RouteState {
  const parsed = parseAppPath(pathWithSearch);
  const query = new URL(pathWithSearch, 'https://router.invalid').searchParams;
  const remote = query.has('hostId') ? {
    hostId: query.get('hostId'), hubId: query.get('hubId'), directory: query.get('directory'), projectId: query.get('projectId'),
    ...(query.has('instanceId') ? { instanceId: query.get('instanceId') } : {}),
  } : {};

  switch (parsed.kind) {
    case 'plugin':
      return { ...emptyRoute(), tab: 'plugin', guiPageKey: JSON.stringify([parsed.pluginId, parsed.pageId]) };
    case 'new':
      return {
        ...emptyRoute(),
        ...remote,
        isNewSession: true,
        tab: 'chat',
      };
    case 'session': {
      const tab = parsed.tab as MainTab;
      return {
        sessionId: parsed.sessionId,
        ...remote,
        isNewSession: false,
        tab: tab === 'chat' ? null : tab,
        settingsPath: null,
        settingsEntityId: null,
        diffFile: parsed.file,
        diffScope: parsed.scope,
        scheduleView: null,
        scheduleProjectId: null,
        scheduleTaskId: null,
        assistantId: null,
        focusSessionId: null,
      };
    }
    case 'schedule':
      return {
        sessionId: null,
        isNewSession: false,
        tab: SCHEDULE_TAB_ID,
        settingsPath: null,
        settingsEntityId: null,
        diffFile: null,
        diffScope: null,
        scheduleView: parsed.scheduleView,
        scheduleProjectId: parsed.scheduleProjectId,
        scheduleTaskId: parsed.scheduleTaskId,
        assistantId: null,
        focusSessionId: parsed.focusSessionId,
      };
    case 'assistant':
      return {
        sessionId: null,
        isNewSession: false,
        tab: 'assistant',
        settingsPath: null,
        settingsEntityId: null,
        diffFile: null,
        diffScope: null,
        scheduleView: null,
        scheduleProjectId: null,
        scheduleTaskId: null,
        assistantId: parsed.assistantId,
        focusSessionId: parsed.focusSessionId,
      };
    case 'settings':
      return {
        sessionId: null,
        isNewSession: false,
        tab: null,
        settingsPath: parsed.slug,
        settingsEntityId: parsed.entityId,
        diffFile: null,
        diffScope: null,
        scheduleView: null,
        scheduleProjectId: null,
        scheduleTaskId: null,
        assistantId: null,
        focusSessionId: null,
      };
    case 'connect':
    case 'unknown':
    default:
      return emptyRoute();
  }
}

function emptyRoute(): RouteState {
  return {
    sessionId: null,
    isNewSession: false,
    tab: null,
    settingsPath: null,
    settingsEntityId: null,
    diffFile: null,
    diffScope: null,
    scheduleView: null,
    scheduleProjectId: null,
    scheduleTaskId: null,
    assistantId: null,
    focusSessionId: null,
  };
}

export function hasRouteParams(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const parsed = parseAppPath(`${window.location.pathname}${window.location.search}`);
    return (
      parsed.kind === 'session'
      || parsed.kind === 'new'
      || parsed.kind === 'schedule'
      || parsed.kind === 'assistant'
      || parsed.kind === 'plugin'
      || parsed.kind === 'settings'
      || parsed.kind === 'connect'
    );
  } catch {
    return false;
  }
}
