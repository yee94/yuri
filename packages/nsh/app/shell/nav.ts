import { signal } from 'nsh';
import { createNavStack } from 'nsh/base';
import type { TabID } from './tabs';

export type RemoteSessionTarget = {
  hubId: string;
  hostId: string;
  instanceId?: string;
  projectId: string;
  remoteProjectId?: string;
};

export type ChatRoute = {
  kind: 'chat';
  /** `null` for a session that has not been created yet (a new chat draft). */
  sessionID: string | null;
  title: string;
  directory: string;
  draft: boolean;
  /** The machine this session lives on; omitted for local sessions. */
  remote?: RemoteSessionTarget;
};

export type Route =
  | { kind: 'home' }
  | ChatRoute
  | { kind: 'connect' }
  | { kind: 'search' }
  | AssistantRoute
  | AssistantSettingsRoute
  | SettingsRoute
  | ScheduledRunsRoute;

export type AssistantRoute = { kind: 'assistant'; assistantID: string; title: string };

export type AssistantSettingsRoute = { kind: 'assistantSettings'; assistantID: string };

/** Settings pages the phone's own surfaces render (Web `MOBILE_SETTINGS_PAGE_SLUGS`). */
export type SettingsSlug =
  | 'instances'
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'sessions'
  | 'archived-sessions'
  | 'summary-ai'
  | 'projects'
  | 'git'
  | 'providers'
  | 'agents'
  | 'assistants'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'magic-prompts'
  | 'skills.installed'
  | 'usage'
  | 'voice'
  | 'about';

export type SettingsRoute = { kind: 'settings'; slug: SettingsSlug };

export type ScheduledRunsRoute = { kind: 'scheduledRuns'; projectId: string; taskId: string; title: string };

/** The tab on screen; each tab keeps its own stack, as the Web phone shell does. */
export const tab = signal<TabID>('projects');

/** The system tab bar's height, reported by the bar itself (it owns the safe area). */
export const tabBarInset = signal(0);

const stacks: Record<TabID, ReturnType<typeof createNavStack<Route>>> = {
  projects: createNavStack<Route>([{ kind: 'home' }]),
  assistant: createNavStack<Route>([{ kind: 'home' }]),
  scheduled: createNavStack<Route>([{ kind: 'home' }]),
  settings: createNavStack<Route>([{ kind: 'home' }]),
};

export const stackFor = (id: TabID) => stacks[id];

export const activeStack = () => stacks[tab()];

export function selectTab(id: TabID) {
  if (tab() === id) {
    stackFor(id).popToRoot();
    return;
  }
  tab.set(id);
}

/** Opens a session on the tab in front, as the phone's navigation store does. */
export function openSession(input: {
  id: string;
  title: string;
  directory: string;
  remote?: RemoteSessionTarget;
}) {
  const stack = activeStack();
  const routes = stack.routes();
  const top = routes[routes.length - 1];
  if (top?.kind === 'chat') {
    stack.replace({
      kind: 'chat',
      sessionID: input.id,
      title: input.title,
      directory: input.directory,
      draft: false,
      ...(input.remote ? { remote: input.remote } : {}),
    });
    return;
  }
  stack.push({
    kind: 'chat',
    sessionID: input.id,
    title: input.title,
    directory: input.directory,
    draft: false,
    ...(input.remote ? { remote: input.remote } : {}),
  });
}

export function openNewSession(directory: string, remote?: RemoteSessionTarget) {
  activeStack().push({
    kind: 'chat',
    sessionID: null,
    title: '',
    directory,
    draft: true,
    ...(remote ? { remote } : {}),
  });
}

/** Web `GlobalSearchButton` / `MobileGlobalSearchHost`: an independent search page. */
export function openSearch() {
  const stack = activeStack();
  const routes = stack.routes();
  if (routes[routes.length - 1]?.kind === 'search') return;
  stack.push({ kind: 'search' });
}

export function openConnect() {
  const stack = activeStack();
  const routes = stack.routes();
  if (routes[routes.length - 1]?.kind === 'connect') return;
  stack.push({ kind: 'connect' });
}

/** A bot's conversation: its bound session shown on the shared chat page. */
export function openAssistant(input: { assistantID: string; title: string }) {
  const stack = activeStack();
  const routes = stack.routes();
  const top = routes[routes.length - 1];
  if (top?.kind === 'assistant' && top.assistantID === input.assistantID) return;
  stack.push({ kind: 'assistant', assistantID: input.assistantID, title: input.title });
}

export function openAssistantSettings(assistantID: string) {
  const stack = activeStack();
  const routes = stack.routes();
  const top = routes[routes.length - 1];
  if (top?.kind === 'assistantSettings' && top.assistantID === assistantID) return;
  stack.push({ kind: 'assistantSettings', assistantID });
}

/** Enters one Settings page on the settings tab, as the Web phone's settings stack does. */
export function openSettingsPage(slug: SettingsSlug) {
  const stack = stackFor('settings');
  const routes = stack.routes();
  const top = routes[routes.length - 1];
  if (tab() === 'settings' && top?.kind === 'settings' && top.slug === slug) return;
  tab.set('settings');
  if (top?.kind === 'settings' && top.slug === slug) return;
  stack.push({ kind: 'settings', slug });
}

/** One scheduled task's run history, pushed from the schedule tab or a bot's settings. */
export function openScheduledRuns(input: { projectId: string; taskId: string; title: string }) {
  const stack = activeStack();
  const routes = stack.routes();
  const top = routes[routes.length - 1];
  if (top?.kind === 'scheduledRuns' && top.taskId === input.taskId && top.projectId === input.projectId) return;
  stack.push({ kind: 'scheduledRuns', projectId: input.projectId, taskId: input.taskId, title: input.title });
}
