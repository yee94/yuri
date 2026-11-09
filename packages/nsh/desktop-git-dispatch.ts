import type { DesktopPanelScope } from './desktop-panel-model';
import type { CompiledSubmission, Connection, Submission } from './model';

export type DesktopGitAgentRequest = {
  scope: DesktopPanelScope; directory: string; target: 'current' | 'new';
  kind: 'conflict' | 'integration' | 'pr' | 'checks' | 'comments';
  visibleText: string; instructionsText: string; payload: unknown;
};
export type DesktopGitContext = Readonly<{ kind: DesktopGitAgentRequest['kind']; instructionsText: string; payloadText: string }>;
export type ContextSubmission = Submission & { context?: DesktopGitContext };
export type DesktopGitContextInput = Readonly<{
  hostID: string; lease: string; authorityKey: string; directory: string; sessionID: string | null;
  visibleText: string; context: DesktopGitContext;
}>;
export type DesktopGitStageConfirmation = Readonly<{ key: string; owner: number; revision: number }>;
export type DesktopGitStageResult =
  | { status: 'staged' }
  | { status: 'requires-confirmation'; confirmation: DesktopGitStageConfirmation }
  | { status: 'blocked' | 'stale' };

/** Matches the shell's stable identity; transport leases deliberately do not partition drafts. */
export const desktopGitDraftAuthority = (connection: Pick<Connection, 'id' | 'url' | 'authorizationID'>) => JSON.stringify([connection.id, connection.url, connection.authorizationID]);
export const sameDesktopGitContext = (left: DesktopGitContext | undefined, right: DesktopGitContext | undefined) => left === right || !!left && !!right && left.kind === right.kind && left.instructionsText === right.instructionsText && left.payloadText === right.payloadText;

export function desktopGitContextFrom(value: unknown): DesktopGitContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('git-context-invalid');
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== 'string' || !['conflict', 'integration', 'pr', 'checks', 'comments'].includes(row.kind) || typeof row.instructionsText !== 'string' || typeof row.payloadText !== 'string') throw new Error('git-context-invalid');
  if (row.instructionsText.length + row.payloadText.length > 750_000) throw new Error('git-context-too-large');
  return Object.freeze({ kind: row.kind as DesktopGitContext['kind'], instructionsText: row.instructionsText, payloadText: row.payloadText });
}

/** Capture unknown JSON once at the click boundary, never by rereading Git during retry. */
export function desktopGitContextInput(request: DesktopGitAgentRequest): DesktopGitContextInput {
  if (request.kind !== 'integration' && request.scope.directory !== request.directory) throw new Error('git-context-directory-mismatch');
  const json = JSON.stringify(request.payload, (key, value: unknown) => {
    if (/^(authorization|password|clientToken|accessToken|apiKey|secret|bearerToken)$/i.test(key)) throw new Error('git-context-credentials-forbidden');
    return value;
  }, 2);
  if (json === undefined) throw new Error('git-context-invalid-payload');
  const labels = { conflict: 'Git conflict context (JSON)', integration: 'Cherry-pick conflict context (JSON)', pr: 'GitHub PR context (JSON)', checks: 'GitHub PR failed checks (JSON)', comments: 'GitHub PR comments (JSON)' };
  // Integration's temp worktree is a new-draft override, not a relocation of an existing Chat.
  return Object.freeze({ hostID: request.scope.host.hostID, lease: request.scope.host.lease, authorityKey: request.scope.authorityKey, directory: request.target === 'new' ? request.directory : request.scope.directory,
    sessionID: request.target === 'new' ? null : request.scope.sessionID, visibleText: request.visibleText,
    context: desktopGitContextFrom({ kind: request.kind, instructionsText: request.instructionsText, payloadText: `${labels[request.kind]}\n${json}` }) });
}

/** OpenCode 2 flattens authored + synthetic text parts, while preserving all compiled sidecars. */
export function compileDesktopGitContext(compiled: CompiledSubmission, context: DesktopGitContext): CompiledSubmission {
  return { ...compiled, text: [compiled.text, context.instructionsText, context.payloadText].join('\n') };
}
