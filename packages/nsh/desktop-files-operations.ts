import { desktopPanelFilePath, desktopPanelScopeKey, type DesktopPanelScope } from './desktop-panel-model';
import { resourceParent, resourcePath, resourceResolve } from './resources-model';
import type { DesktopEditorOperation } from './desktop-files-editor-model';

export type DesktopFileCommand = { kind: 'file' | 'directory'; parent: string; name: string } | { kind: 'rename'; path: string; name: string } | { kind: 'delete' | 'reveal'; path: string };
export type DesktopFileOperationState = Readonly<{ phase: 'idle' | 'working' | 'unknown' | 'error'; detail: string; path: string }>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
export const desktopFileOperationKey = (scope: DesktopPanelScope) => desktopPanelScopeKey({ ...scope, sessionID: null });
export function desktopFileChild(root: string, parent: string, name: string) {
  if (!name.trim() || name !== name.trim() || name === '.' || name === '..' || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || /^[A-Z]:|^\/\//i.test(root) && /[<>:"|?*]|[. ]$/.test(name)) throw new Error('desktop_file_invalid_name');
  return desktopPanelFilePath(root, resourceResolve(parent, root).replace(/\/$/, '') + '/' + name);
}

/** Host filesystem mutations, not Git or native local files. Unknown POSTs are
 * retained by the window owner; inspect only reads and never replays a mutation.
 * Host has no exclusive-create/rename CAS or durable operation receipts. */
export function createDesktopFileOperations(scope: DesktopPanelScope, options: {
  guard: (path: string) => Promise<(() => boolean) | null>;
  begin?: (path: string) => (() => void) | null;
  restoreLock?: (path: string) => (() => void) | null;
  persistence?: { start: (command: DesktopFileCommand) => Promise<boolean>; settle: (phase: 'confirmed' | 'rejected') => Promise<boolean>; clear: () => Promise<boolean>; recover: () => Promise<boolean> };
  confirmed: (path: string) => void;
  notify?: () => void;
}) {
  const identity = desktopFileOperationKey(scope), root = resourcePath(scope.directory);
  let state: DesktopFileOperationState = { phase: 'idle', detail: '', path: '' };
  let held: (() => void) | undefined;
  let retained: DesktopFileCommand | undefined, outcome: 'confirmed' | 'rejected' | undefined;
  let outcomeApplied = false;
  const update = (next: DesktopFileOperationState) => { state = next; options.notify?.(); };
  const admitted = (operation: DesktopEditorOperation) => operation.current() && desktopFileOperationKey(operation.scope) === identity;
  const statRoute = (path: string) => `/api/fs/stat?directory=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  async function exists(operation: DesktopEditorOperation, path: string) {
    try {
      const result = object(await operation.request(statRoute(path)));
      if (typeof result.path !== 'string' || resourcePath(result.path) !== path || typeof result.isFile !== 'boolean' || typeof result.isDirectory !== 'boolean') throw new Error('desktop_file_invalid_stat');
      return true;
    } catch (cause) { if (Number(object(cause).status) === 404) return false; throw cause; }
  }
  return { state: () => state,
    protected: () => state.phase === 'working' || state.phase === 'unknown',
    async run(command: DesktopFileCommand, operation: DesktopEditorOperation) {
      if (!admitted(operation) || state.phase === 'working' || state.phase === 'unknown') return false;
      let posted = false, intent = false, target = '', changed = '';
      try {
        let action: string, body: Record<string, string>, check: (() => boolean) | null = () => true;
        if (command.kind === 'file' || command.kind === 'directory') {
          target = desktopFileChild(root, command.parent, command.name); changed = target;
          action = command.kind === 'file' ? 'write' : 'mkdir'; body = command.kind === 'file' ? { path: target, content: '' } : { path: target };
        } else if ('path' in command) {
          const path = command.kind === 'reveal' ? resourceResolve(command.path, root) : desktopPanelFilePath(root, command.path); changed = path;
          target = command.kind === 'rename' ? desktopFileChild(root, resourceParent(path, root)!, command.name) : path;
          if (target === path && command.kind === 'rename') throw new Error('desktop_file_same_name');
          action = command.kind; body = command.kind === 'rename' ? { oldPath: path, newPath: target } : { path };
        } else throw new Error('desktop_file_invalid_command');
        retained = { ...command }; outcome = undefined; outcomeApplied = false;
        update({ phase: 'working', detail: '', path: changed });
        if (command.kind !== 'reveal') {
          check = await options.guard(changed);
          if (!check) { update({ phase: 'idle', detail: '', path: changed }); return false; }
        }
        if (command.kind === 'delete' || command.kind === 'rename') {
          if (!await exists(operation, changed)) throw new Error('desktop_file_source_missing');
        }
        if (command.kind === 'file' || command.kind === 'directory' || command.kind === 'rename') {
          if (await exists(operation, target)) throw new Error('desktop_file_target_exists');
        }
        if (command.kind === 'rename') {
          const sourceCheck = check, targetCheck = await options.guard(target);
          if (!targetCheck) { update({ phase: 'idle', detail: '', path: changed }); return false; }
          check = () => sourceCheck!() && targetCheck();
        }
        if (!admitted(operation) || !check()) { update({ phase: 'idle', detail: '', path: changed }); return false; }
        if (command.kind !== 'reveal' && options.begin) {
          const release = options.begin(changed);
          if (!release) throw new Error('desktop_file_mutation_in_progress');
          held = release;
          if (command.kind === 'rename') {
            const releaseTarget = options.begin(target);
            if (!releaseTarget) throw new Error('desktop_file_mutation_in_progress');
            held = () => { releaseTarget(); release(); };
          }
        }
        if (command.kind !== 'reveal' && options.persistence) {
          intent = true;
          if (!await options.persistence.start(command)) throw new Error('desktop_file_operation_checkpoint_failed');
          if (!admitted(operation) || !check()) {
            outcome = 'rejected';
            if (!await options.persistence.settle(outcome) || !await options.persistence.clear()) throw new Error('desktop_file_operation_checkpoint_failed');
            intent = false; update({ phase: 'idle', detail: '', path: changed }); return false;
          }
        }
        // Checks are not atomic create/rename CAS. The Host accepts only these bodies.
        posted = command.kind !== 'reveal';
        let response: unknown;
        try { response = await operation.request(`/api/fs/${action}?directory=${encodeURIComponent(root)}`, 'POST', body); }
        catch (cause) { const status = Number(object(cause).status); if (status >= 400 && status < 500 && status !== 408) posted = false; throw cause; }
        const receipt = object(response);
        if (receipt.success !== true || typeof receipt.path !== 'string' || resourcePath(receipt.path) !== target) throw new Error('desktop_file_invalid_mutation_receipt');
        posted = false;
        outcome = 'confirmed';
        if (command.kind === 'rename' || command.kind === 'delete') options.confirmed(changed);
        if (command.kind === 'rename') options.confirmed(target);
        outcomeApplied = true;
        if (intent && options.persistence) {
          if (!await options.persistence.settle(outcome) || !await options.persistence.clear()) throw new Error('desktop_file_operation_checkpoint_failed');
          intent = false;
        }
        update({ phase: 'idle', detail: '', path: target }); return true;
      } catch (cause) {
        if (intent && !posted && !outcome && options.persistence) {
          outcome = 'rejected';
          if (await options.persistence.settle(outcome) && await options.persistence.clear()) intent = false;
        }
        update({ phase: posted || intent ? 'unknown' : 'error', detail: cause instanceof Error ? cause.message : String(cause), path: changed }); return false;
      } finally { if (!posted && !intent) { held?.(); held = undefined; } }
    },
    restore(command: DesktopFileCommand, phase: 'prepared' | 'confirmed' | 'rejected') {
      if (state.phase !== 'idle') return false;
      const changed = 'path' in command ? desktopPanelFilePath(root, command.path) : desktopFileChild(root, command.parent, command.name);
      const target = command.kind === 'rename' ? desktopFileChild(root, resourceParent(changed, root)!, command.name) : changed;
      const release = options.restoreLock?.(changed);
      if (options.restoreLock && !release) return false;
      held = release ?? undefined;
      if (command.kind === 'rename') {
        const targetRelease = options.restoreLock?.(target);
        if (options.restoreLock && !targetRelease) { held?.(); held = undefined; return false; }
        held = () => { targetRelease?.(); release?.(); };
      }
      retained = { ...command }; outcome = phase === 'prepared' ? undefined : phase; outcomeApplied = false;
      update({ phase: 'unknown', detail: 'desktop_file_operation_restored_read_only', path: changed });
      return true;
    },
    async inspect(operation: DesktopEditorOperation) {
      if (!admitted(operation) || state.phase !== 'unknown') return false;
      try {
        const present = await exists(operation, state.path);
        if (!admitted(operation)) return false;
        if (retained?.kind === 'rename') await exists(operation, desktopFileChild(root, resourceParent(state.path, root)!, retained.name));
        if (!admitted(operation)) return false;
        if (outcome && options.persistence) {
          if (!await options.persistence.recover() || !await options.persistence.settle(outcome) || !await options.persistence.clear()) return false;
          if (outcome === 'confirmed' && !outcomeApplied && retained && (retained.kind === 'rename' || retained.kind === 'delete')) {
            options.confirmed(state.path);
            if (retained.kind === 'rename') options.confirmed(desktopFileChild(root, resourceParent(state.path, root)!, retained.name));
          }
          outcomeApplied = true;
          held?.(); held = undefined; update({ phase: 'idle', detail: '', path: state.path }); return true;
        }
        update({ ...state, detail: present ? 'desktop_file_mutation_unconfirmed_path_present' : 'desktop_file_mutation_unconfirmed_path_absent' });
      } catch (cause) { if (admitted(operation)) update({ ...state, detail: cause instanceof Error ? cause.message : String(cause) }); }
      return false;
    },
  };
}
