import { record, text, type Project, type Row } from './model';

export type TaskCommandContext = { sessionID: string | null; hasMessages: boolean; hasNewDraft: boolean };
export type TaskEditorCreationContext = {
  projectID: string;
  directory: string;
  selection: { providerID: string; modelID: string; variant?: string; agent?: string };
  commandContext?: TaskCommandContext;
};

/** ScheduledTaskEditorDialog.toDraft copies the current four-tuple only for creation. */
export function taskEditorSelection(item: Row | undefined, context?: TaskEditorCreationContext) {
  const execution = item ? record(record(item.task).execution) : context?.selection ?? {};
  return { providerID: text(execution.providerID), modelID: text(execution.modelID), variant: text(execution.variant), agent: text(execution.agent) };
}
export function taskEditorProject(item: Row | undefined, context: TaskEditorCreationContext | undefined, projects: readonly Project[]): string {
  if (item) return text(item.projectId);
  if (!context?.directory) return '';
  return context.projectID || projects.find(project => project.path === context.directory)?.id || '';
}
/** Captured worktree belongs to the explicitly captured project, never the first registered one. */
export function taskEditorDirectory(projectID: string, context: TaskEditorCreationContext | undefined, projects: readonly Project[]): string {
  if (!projectID) return '';
  if (context?.projectID === projectID && context.directory) return context.directory;
  return projects.find(project => project.id === projectID)?.path || '';
}
