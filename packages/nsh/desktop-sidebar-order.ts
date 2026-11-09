export type DesktopSidebarOrderIntent = { kind: 'session' | 'worktree' | 'project' | 'folder'; scope: string; active: string; over: string; targetKind?: 'session' | 'worktree' | 'project' | 'folder' };
export type DesktopSidebarOrderFailure = { intent: DesktopSidebarOrderIntent; error: string; before?: readonly string[]; expected?: readonly string[] };
export type DesktopSidebarOrderState = { pending: boolean; failure: DesktopSidebarOrderFailure | null };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Presentation transaction journal over controller APIs, never an HTTP/ranking protocol.
 * No optimistic list write. Lost ACK retries read first: a committed order is not moved twice.
 * A concurrent different rank requires a new drag instead of replaying an obsolete move. */
export function createDesktopSidebarOrder(input: {
  current: () => boolean; generation: () => string;
  read: (intent: DesktopSidebarOrderIntent) => Promise<readonly string[]>;
  commit: (intent: DesktopSidebarOrderIntent) => Promise<void>;
  snapshot: (intent: DesktopSidebarOrderIntent) => readonly string[];
  changed: (state: DesktopSidebarOrderState) => void;
  conflict: () => string;
}) {
  let serial = 0, pending = false, failure: DesktopSidebarOrderFailure | null = null;
  let operation: DesktopSidebarOrderFailure | null = null;
  const publish = () => input.changed({ pending, failure });
  async function execute(intent: DesktopSidebarOrderIntent, previous?: DesktopSidebarOrderFailure) {
    if (pending || !input.current()) return false;
    const revision = ++serial, generation = input.generation();
    const valid = () => revision === serial && input.current() && generation === input.generation();
    pending = true; failure = null; publish();
    let before = previous?.before, expected = previous?.expected;
    operation = { intent, before, expected, error: input.conflict() };
    try {
      const authority = [...await input.read(intent)];
      if (!valid()) return false;
      if (expected && same(authority, expected)) return true;
      if (before && !same(authority, before)) throw new Error(input.conflict());
      before = authority;
      const from = before.indexOf(intent.active), to = before.indexOf(intent.over);
      if (from < 0 || to < 0 || from === to) throw new Error(input.conflict());
      const next = [...before]; next.splice(from, 1); next.splice(to, 0, intent.active); expected = next;
      operation = { intent, before, expected, error: input.conflict() };
      await input.commit(intent);
      if (!valid()) return false;
      if (!same(input.snapshot(intent), expected)) throw new Error(input.conflict());
      return true;
    } catch (error) {
      if (valid()) failure = { intent, before, expected, error: error instanceof Error ? error.message : String(error) };
      return false;
    } finally { if (valid()) { pending = false; operation = null; publish(); } }
  }
  return { run: (intent: DesktopSidebarOrderIntent) => execute(intent),
    retry: () => failure ? execute(failure.intent, failure) : Promise.resolve(false),
    pause() { serial++; if (pending && operation) failure = operation; pending = false; operation = null; publish(); },
    cancel() { serial++; pending = false; operation = null; failure = null; publish(); },
  };
}
