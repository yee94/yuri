import type { AssistantSnapshot } from '@/queries/assistantQueries';

// Only external catalog/navigation/plugin state is replaced. The hint, header,
// Button, avatar renderer, animation runtime and production CSS remain real.
const navigation = {
  activeTab: 'scheduled', secondary: null,
  openAssistant: (id: string) => { document.body.dataset.openedAssistant = id; },
};
export const useMobileNavigationStore = Object.assign(
  <T>(select: (state: typeof navigation) => T) => select(navigation),
  { getState: () => navigation },
);
export const GuiPluginTitlebarItems = () => null;
export function useAssistantSnapshotQuery<T>(select: (snapshot: AssistantSnapshot) => T) {
  return { data: select({ revision: 1, enabled: true, assistants: [{
    id: 'schedule-visual-bot', name: 'Visual Bot', pinnedAt: 1, revision: 1, enabled: true,
    avatarSeed: 'yuri-avatar:v1:round:capsule:blue:neutral:1:schedule',
    defaultPrompt: '', workspacePath: null, effectiveWorkspacePath: '/workspace', managedWorkspacePath: null,
    providerID: 'fixture', modelID: 'fixture', agent: null, variant: null, mode: 'continuous',
    sessionID: null, sessionGeneration: 0, historySessionIDs: [], historySessionCount: 0,
    assignedSessionIDs: [], working: false, activeContactTurn: null,
    createdAt: 1, updatedAt: 1, tombstoneAt: null,
  }] }) };
}
