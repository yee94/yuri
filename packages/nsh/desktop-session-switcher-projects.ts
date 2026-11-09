import { normalizePath } from '../ui/src/lib/pathNormalization';
import type { Project } from './model';
import type { createProjectsController } from './projects';
import type { DesktopSwitcherSource } from './desktop-session-switcher-core';

type ProjectsController = ReturnType<typeof createProjectsController>;
export type DesktopSwitcherProjectsReader = {
  [K in 'sessions' | 'hiddenSessionIDs' | 'worktrees' | 'pins' | 'loading' | 'error' | 'running' | 'attention']: () => ReturnType<ProjectsController[K]>;
} & { sidebar: Pick<ProjectsController['sidebar'], 'snapshot'>; refresh: () => Promise<unknown> };

/** Adapts an EXISTING shared controller. Callers own refresh/activation/disposal.
 * `ready` is explicit because loading=false after a failed initial read is not
 * an authoritative empty catalog. No reads occur until snapshot is requested. */
export function desktopSessionSwitcherProjectsSource(controller: DesktopSwitcherProjectsReader, projects: () => readonly Project[], ready: () => boolean): DesktopSwitcherSource {
  return {
    snapshot() {
      const sidebar = controller.sidebar.snapshot(), hidden = controller.hiddenSessionIDs();
      const branches = new Map<string, string>();
      for (const trees of Object.values(controller.worktrees())) for (const tree of trees) {
        const directory = normalizePath(tree.path); if (directory) branches.set(directory, tree.branch);
      }
      return { sessions: [...controller.sessions(), ...Object.values(sidebar.children).flatMap(page => page.rows)].filter(row => !hidden.has(row.id)),
        projects: projects(), pinnedSessionIDs: controller.pins(), branches,
        ready: ready(), loading: controller.loading(), error: controller.error(),
      };
    },
    status(session) {
      if (controller.running().includes(session.id)) return 'running';
      if (!session.parentID && (controller.attention().unseenBySession[session.id] ?? 0) > 0) return 'unread';
      return null;
    },
    retry: () => controller.refresh(),
  };
}
