import type { ChatTarget } from './model';
import type { PageOperation } from './page-operations';
import type { createProjectsSidebar } from './projects-sidebar';
import type { SidebarLane } from './projects-sidebar';
import { sameRuntimeScope } from './runtime-scope';

export type NativeNewSessionFolderTarget = Readonly<{ scope: string; id: string }>;
export type NativeNewSessionFolderReceipt = NativeNewSessionFolderTarget & Readonly<{ status?: 'unknown' | 'acknowledged' }>;
type FolderOwner = Pick<ReturnType<typeof createProjectsSidebar>, 'snapshot' | 'loadFolders' | 'folders'>;
type RegisteredOwner = { owner: FolderOwner; capture: () => SidebarLane; current: () => boolean };
const owners = new Set<RegisteredOwner>();
/** Registers the original controller, not a second catalog or transport. */
export function registerNativeNewSessionFolderOwner(input: RegisteredOwner) {
  owners.add(input); return () => { owners.delete(input); };
}
export type NativeNewSessionFolderAdmission = (input: {
  folder: NativeNewSessionFolderReceipt; target: ChatTarget; operation: PageOperation;
  note: (status: 'unknown' | 'acknowledged') => Promise<void>;
}) => Promise<void>;

/** Reuses the mounted ProjectsSidebar's mutation lane. Never constructs another folder owner. */
export function createNativeNewSessionFolderAdmission(input: { owner: () => FolderOwner | null; current: () => boolean }): NativeNewSessionFolderAdmission {
  return async ({ folder, target, operation, note }) => {
    const owner = input.owner();
    const current = () => !!owner && input.current() && operation.current() && input.owner() === owner;
    const assert = () => { if (!current()) throw new Error('new-session-folder-scope-changed'); };
    assert();
    if (target.kind !== 'session' || !target.id || !target.directory || !folder.scope || !folder.id || folder.scope.startsWith('__archived__:')) throw new Error('new-session-folder-invalid');
    if (folder.status === 'acknowledged') return;
    // Legacy LWW GET is not a causal receipt. An observed membership (even exactly
    // matching) cannot turn an unknown POST into proof that our operation committed.
    if (folder.status === 'unknown') {
      await owner!.loadFolders(); assert();
      throw new Error('new-session-folder-outcome-unknown');
    }
    const folders = await owner!.loadFolders(); assert();
    if (!folders || !folders.foldersMap[folder.scope]?.some(row => row.id === folder.id)) throw new Error('new-session-folder-unavailable');
    if (owner!.snapshot().pending.includes('folders-write') || owner!.snapshot().unknown.includes('folders-write')) throw new Error('new-session-folder-owner-busy');
    let acknowledged = false;
    // The existing owner validates registered directory, root session identity,
    // archive state and its original preflight snapshot before the one POST.
    await owner!.folders(folder.scope, { kind: 'member', sessionId: target.id, folderId: folder.id, directory: target.directory }, {
      beforeSend: async () => { assert(); await note('unknown'); assert(); },
      acknowledged: async () => { await note('acknowledged'); acknowledged = true; },
    });
    assert();
    if (!acknowledged) throw new Error('new-session-folder-outcome-unknown');
  };
}

/** Resolves only an exact current mounted owner. Multiple owners are not guessed. */
export const admitNativeNewSessionFolder: NativeNewSessionFolderAdmission = async input => {
  const matches = [...owners].filter(entry => {
    if (!entry.current()) return false;
    try { const lane = entry.capture(); return lane.current() && lane.generation === input.operation.generation && !!lane.scope && sameRuntimeScope(lane.scope, input.operation.scope); }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error('new-session-folder-owner-unavailable');
  const entry = matches[0]!;
  return createNativeNewSessionFolderAdmission({ owner: () => owners.has(entry) ? entry.owner : null, current: entry.current })(input);
};

export function nativeNewSessionFolderFrom(value: unknown): NativeNewSessionFolderReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('new-session-invalid-folder');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['scope', 'id', 'status'].includes(key)) || typeof row.scope !== 'string' || !row.scope || row.scope.startsWith('__archived__:') || typeof row.id !== 'string' || !row.id || row.status !== undefined && row.status !== 'unknown' && row.status !== 'acknowledged') throw new Error('new-session-invalid-folder');
  return { scope: row.scope, id: row.id, ...(row.status ? { status: row.status } : {}) };
}
