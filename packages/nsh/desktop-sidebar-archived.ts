import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { sidebarSessionKey, type ProjectsSidebarSnapshot, type SidebarSession } from './projects-sidebar';

/** Explicit destructive admission only; pages remain owned by the existing Projects sidebar. */
export async function desktopSidebarReadAllArchived(input: {
  directories: readonly string[];
  current: () => boolean;
  snapshot: () => ProjectsSidebarSnapshot;
  load: (directory: string, more: boolean) => Promise<unknown>;
}): Promise<SidebarSession[] | null> {
  const paths = [...new Map(input.directories.map(directory => [normalizeDirectoryKey(directory), directory])).values()];
  const rows = new Map<string, SidebarSession>();
  for (const directory of paths) {
    const seen = new Set<string>();
    let more = false;
    do {
      if (!input.current()) return null;
      await input.load(directory, more);
      if (!input.current()) return null;
      const state = input.snapshot(), page = state.archived[directory];
      if (state.errors[`archived:${directory}`] || state.pending.includes(`archived:${directory}`) || !page?.loaded) return null;
      if (!page.cursor) {
        for (const row of page.rows) {
          if (!row.archived || row.parentID || normalizeDirectoryKey(row.directory) !== normalizeDirectoryKey(directory)) return null;
          rows.set(sidebarSessionKey(row), row);
        }
        break;
      }
      if (seen.has(page.cursor)) return null;
      seen.add(page.cursor); more = true;
    } while (true);
  }
  return input.current() ? [...rows.values()] : null;
}
