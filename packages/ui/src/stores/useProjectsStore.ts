import { create } from 'zustand';
import { toast } from 'sonner';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { createProjectIdFromPath } from '@/lib/projectId';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useSessionNavigationStore } from './useSessionNavigationStore';
import { ensureRemoteHostCatalog, getHostRuntimeRegistry, remoteProjectMetadata, removeRemoteProject, supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { projectOrderQueryOptions, saveHubProjectLayout } from '@/queries/projectOrderQueries';
import { parseHubProjectLayout, type HubProjectLayout } from '@/queries/hubProjectLayout';
import { queryClient } from '@/lib/queryRuntime';
import { parseRemoteProject, type RemoteProject } from '@/lib/remote-projects/types';
import {
  mayReadLegacyApiBaseUrlInstanceCache,
  readInstanceScopedItem,
  removeInstanceScopedItem,
  writeInstanceScopedItem,
} from '@/lib/instanceScopedStorage';

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface VSCodeWorkspaceFolderConfig {
  name?: string;
  path: string;
}

interface ProjectsStore {
  projects: Array<ProjectEntry & { hubId?: string }>;
  activeProjectId: string | null;
  manualProjectOrder: string[];
  hubProjectLayout: HubProjectLayout | null;

  addProject: (path: string, options?: { label?: string; id?: string }) => ProjectEntry | null;
  upsertRemoteProject: (project: RemoteProject, hubId: string) => void;
  reconcileRemoteProjects: (projects: RemoteProject[], hubId: string) => void;
  setProjectCollapsed: (id: string, collapsed: boolean) => void;
  removeProject: (id: string) => void | Promise<void>;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void | Promise<void>;
  updateProjectMeta: (id: string, meta: {
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
    defaultModel?: string | null;
  }) => void | Promise<void>;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  reorderProjectsById: (activeId: string, overId: string) => void;
  moveProjectToTop: (id: string) => void;
  resetForRuntimeSwitch: () => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  syncVSCodeWorkspaceFolders: (folders: VSCodeWorkspaceFolderConfig[], activePath?: string | null) => ProjectEntry | null;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getDeferredSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';
const MANUAL_ORDER_STORAGE_KEY = 'projects:manualOrder';

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeDefaultModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed;
};

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = readInstanceScopedItem('homeDirectory', { storage: safeStorage })
    || useDirectoryStore.getState().homeDirectory
    || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    if (candidate.hostId) {
      try {
        const remote = parseRemoteProject(candidate);
        const key = JSON.stringify([remote.hostId, remote.path]);
        if (seenIds.has(remote.id) || seenPaths.has(key)) continue;
        seenIds.add(remote.id);
        seenPaths.add(key);
        result.push({ ...remote, ...(typeof candidate.hubId === 'string' ? { hubId: candidate.hubId } : {}) });
      } catch { /* Invalid remote references must never fall through to local path conversion. */ }
      continue;
    }

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    const id = createProjectIdFromPath(normalizedPath);
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    const defaultModel = normalizeDefaultModel(candidate.defaultModel);
    if (defaultModel) {
      project.defaultModel = defaultModel;
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = readInstanceScopedItem(PROJECTS_STORAGE_KEY, { storage: safeStorage });
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readLegacyApiBaseUrlManualOrder = (): string | null => {
  if (!mayReadLegacyApiBaseUrlInstanceCache()) return null;
  const apiBaseUrl = getRuntimeApiBaseUrl().trim().replace(/\/+$/, '');
  if (!apiBaseUrl) return null;
  return safeStorage.getItem(`${PROJECTS_STORAGE_KEY}:${encodeURIComponent(apiBaseUrl)}:manualOrder`);
};

const readPersistedManualOrder = (): string[] => {
  try {
    const raw = readInstanceScopedItem(MANUAL_ORDER_STORAGE_KEY, { storage: safeStorage })
      || readLegacyApiBaseUrlManualOrder();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = readInstanceScopedItem(ACTIVE_PROJECT_STORAGE_KEY, { storage: safeStorage });
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    writeInstanceScopedItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects), { storage: safeStorage });
  } catch {
    // ignored
  }

  try {
    if (activeProjectId) {
      writeInstanceScopedItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId, { storage: safeStorage });
    } else {
      removeInstanceScopedItem(ACTIVE_PROJECT_STORAGE_KEY, { storage: safeStorage });
    }
  } catch {
    // ignored
  }
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null, manualOrder?: string[]) => {
  cacheProjects(projects, activeProjectId);
  if (manualOrder) {
    persistManualProjectOrder(manualOrder);
  }
  const localProjects = projects.filter((project) => !project.hostId);
  void updateDesktopSettings({ projects: localProjects, ...(activeProjectId && localProjects.some((project) => project.id === activeProjectId) ? { activeProjectId } : {}) });
};

const persistManualProjectOrder = (manualOrder: string[]) => {
  try {
    writeInstanceScopedItem(MANUAL_ORDER_STORAGE_KEY, JSON.stringify(manualOrder), { storage: safeStorage });
  } catch {
    // ignored
  }
};

const projectIconRequest = async (id: string, suffix: string, options: Parameters<typeof runtimeFetch>[1]) => {
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === id);
  if (!project?.hostId) return runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon${suffix}`, options);
  const catalog = await ensureRemoteHostCatalog();
  if (project.hubId && project.hubId !== catalog.hubId) throw new Error('Project belongs to an inactive Hub');
  const registry = getHostRuntimeRegistry(catalog);
  return registry.resolve({ hubId: catalog.hubId, hostId: project.hostId, directory: project.path })
    .fetch(`/api/projects/${encodeURIComponent(project.remoteProjectId ?? '')}/icon${suffix}`, options);
};

const captureProjectRuntime = () => {
  const generation = getRuntimeGeneration();
  const runtime = getRuntimeKey();
  return () => {
    if (generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) throw new Error('Project operation belongs to an inactive Hub');
  };
};

const applyProjectIconSettings = async (id: string, settings: DesktopSettings) => {
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === id);
  if (!project?.hostId) { useProjectsStore.getState().synchronizeFromSettings(settings); return; }
  const remote = settings.projects?.find((entry) => entry.id === project.remoteProjectId);
  if (!remote) throw new Error('Remote icon response is missing the project');
  const catalog = await ensureRemoteHostCatalog();
  if (project.hubId && project.hubId !== catalog.hubId) throw new Error('Project belongs to an inactive Hub');
  const updated = await remoteProjectMetadata(getHostRuntimeRegistry(catalog), parseRemoteProject(project), { iconImage: remote.iconImage ?? null });
  useProjectsStore.getState().upsertRemoteProject(updated, catalog.hubId);
};

const initialProjects = readPersistedProjects();
const projectLayoutProjection = (projects: ProjectEntry[], layout: HubProjectLayout): ProjectEntry[] => {
  const remaining = new Map(projects.map((project) => [project.id, project]));
  const ordered: ProjectEntry[] = [];
  for (const id of layout.order) {
    const project = remaining.get(id);
    if (project) { ordered.push(project); remaining.delete(id); }
  }
  ordered.push(...remaining.values());
  const result = ordered.map((project) => Object.hasOwn(layout.collapsed, project.id)
    && project.sidebarCollapsed !== layout.collapsed[project.id] ? { ...project, sidebarCollapsed: layout.collapsed[project.id] } : project);
  return result.length === projects.length && result.every((project, index) => project === projects[index]) ? projects : result;
};

let layoutMutation = 0;
const persistHubLayout = (previous: ProjectEntry[], projects: ProjectEntry[], collapsed?: Record<string, boolean>): boolean => {
  const store = useProjectsStore.getState();
  const hubId = store.hubProjectLayout?.hubId ?? projects.find((project) => project.hostId && project.hubId)?.hubId;
  if (!hubId || !supportsRemoteProjects()) return false;
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const mutation = ++layoutMutation;
  const current = () => mutation === layoutMutation && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
  const fallback: HubProjectLayout = { hubId, order: previous.map((project) => project.id),
    collapsed: Object.fromEntries(previous.map((project) => [project.id, project.sidebarCollapsed === true])) };
  void saveHubProjectLayout({ hubId, order: collapsed ? [] : projects.map((project) => project.id), collapsed: collapsed ?? {} }, transport).then((snapshot) => {
    if (current()) useProjectsStore.getState().synchronizeFromSettings(snapshot);
  }).catch((error: unknown) => {
    if (!current()) return;
    const authority = queryClient.getQueryData<DesktopSettings>(projectOrderQueryOptions(transport).queryKey)?.hubProjectLayout;
    const layout = authority?.hubId === hubId ? authority : store.hubProjectLayout ?? fallback;
    const latest = useProjectsStore.getState();
    const restored = projectLayoutProjection(latest.projects, layout);
    const order = restored.map((project) => project.id);
    useProjectsStore.setState({ projects: restored, manualProjectOrder: order });
    cacheProjects(restored, latest.activeProjectId);
    persistManualProjectOrder(order);
    toast.error(error instanceof Error ? error.message : String(error));
  });
  cacheProjects(projects, store.activeProjectId);
  persistManualProjectOrder(projects.map((project) => project.id));
  return true;
};

export const reorderProjectEntriesById = (
  projects: ProjectEntry[],
  activeId: string,
  overId: string,
): ProjectEntry[] => {
  const fromIndex = projects.findIndex((project) => project.id === activeId);
  const toIndex = projects.findIndex((project) => project.id === overId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return projects;
  const next = [...projects];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
};
const normalizeVSCodeWorkspaceFolders = (folders: VSCodeWorkspaceFolderConfig[]): VSCodeWorkspaceFolderConfig[] => {
  const result: VSCodeWorkspaceFolderConfig[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const normalizedPath = normalizeProjectPath(folder.path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    result.push({
      name: folder.name?.trim(),
      path: normalizedPath,
    });
  }
  return result;
};

const createVSCodeWorkspaceProject = (
  folder: VSCodeWorkspaceFolderConfig,
  existing: ProjectEntry | null,
  now: number,
  activePath: string | null,
): ProjectEntry | null => {
  const normalizedPath = normalizeProjectPath(folder.path);
  if (!normalizedPath) {
    return null;
  }
  const id = createProjectIdFromPath(normalizedPath);
  const isActive = activePath === normalizedPath;
  return {
    ...existing,
    id,
    path: normalizedPath,
    label: deriveProjectLabel(normalizedPath),
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: isActive ? now : existing?.lastOpenedAt ?? now,
  };
};

const getVSCodeWorkspaceFolders = (): VSCodeWorkspaceFolderConfig[] | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApis = getRegisteredRuntimeAPIs();
  if (!runtimeApis?.runtime?.isVSCode) {
    return null;
  }

  const config = (window as unknown as {
    __VSCODE_CONFIG__?: {
      workspaceFolder?: unknown;
      workspaceFolders?: unknown;
    };
  }).__VSCODE_CONFIG__;
  const folders = Array.isArray(config?.workspaceFolders)
    ? config.workspaceFolders
        .map((entry) => {
          const candidate = entry as { name?: unknown; path?: unknown };
          const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
          if (!path) return null;
          const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
          return { name, path };
        })
        .filter((entry): entry is { name: string; path: string } => entry !== null)
    : [];

  if (folders.length > 0) {
    return normalizeVSCodeWorkspaceFolders(folders);
  }

  const workspaceFolder = config?.workspaceFolder;
  if (typeof workspaceFolder !== 'string' || workspaceFolder.trim().length === 0) {
    return null;
  }

  return normalizeVSCodeWorkspaceFolders([{ path: workspaceFolder }]);
};

const createVSCodeWorkspaceProjects = (
  folders: VSCodeWorkspaceFolderConfig[],
  existingProjects: ProjectEntry[],
  activePath?: string | null,
): { projects: ProjectEntry[]; activeProjectId: string | null; activeProject: ProjectEntry | null } | null => {
  const normalizedFolders = normalizeVSCodeWorkspaceFolders(folders);
  const normalizedActivePath = activePath ? normalizeProjectPath(activePath) : null;
  const effectiveFolders = normalizedFolders.length === 0 && normalizedActivePath
    ? [{ path: normalizedActivePath }]
    : normalizedActivePath && !normalizedFolders.some((folder) => folder.path === normalizedActivePath)
    ? [...normalizedFolders, { path: normalizedActivePath }]
    : normalizedFolders;
  if (effectiveFolders.length === 0) {
    return null;
  }
  const now = Date.now();
  const projects = effectiveFolders
    .map((folder) => createVSCodeWorkspaceProject(
      folder,
      existingProjects.find((project) => project.path === folder.path) ?? null,
      now,
      normalizedActivePath,
    ))
    .filter((project): project is ProjectEntry => project !== null);

  if (projects.length === 0) {
    return null;
  }

  const activeProject = normalizedActivePath
    ? projects.find((project) => project.path === normalizedActivePath) ?? null
    : projects[0] ?? null;
  const activeProjectId = activeProject?.id ?? projects[0]?.id ?? null;

  if (streamDebugEnabled()) {
    console.log('[Yuri][VSCode][projects] Using workspace projects', projects);
  }

  return { projects, activeProjectId, activeProject: activeProject ?? projects[0] ?? null };
};

const projectIconImagesEqual = (
  left: ProjectEntry['iconImage'],
  right: ProjectEntry['iconImage'],
): boolean => {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return left.mime === right.mime
    && left.updatedAt === right.updatedAt
    && left.source === right.source;
};

const vscodeWorkspaceProjectsEqual = (left: ProjectEntry[], right: ProjectEntry[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((leftProject, index) => {
    const rightProject = right[index];
    if (!rightProject) return false;
    return leftProject.id === rightProject.id
      && leftProject.path === rightProject.path
      && leftProject.label === rightProject.label
      && leftProject.icon === rightProject.icon
      && leftProject.color === rightProject.color
      && leftProject.iconBackground === rightProject.iconBackground
      && leftProject.defaultModel === rightProject.defaultModel
      && leftProject.addedAt === rightProject.addedAt
      && leftProject.lastOpenedAt === rightProject.lastOpenedAt
      && leftProject.sidebarCollapsed === rightProject.sidebarCollapsed
      && projectIconImagesEqual(leftProject.iconImage, rightProject.iconImage);
  });
};

const getVSCodeWorkspaceProject = (): { projects: ProjectEntry[]; activeProjectId: string | null } | null => {
  const folders = getVSCodeWorkspaceFolders();
  if (!folders) {
    return null;
  }
  const result = createVSCodeWorkspaceProjects(folders, []);
  if (!result) {
    return null;
  }
  return { projects: result.projects, activeProjectId: result.activeProjectId };
};

// VS Code runtime is scoped to the workspace folders opened in VS Code.
// Always prefer the VS Code workspace projects over any persisted multi-project registry.
const vscodeWorkspace = getVSCodeWorkspaceProject();
const isVSCodeProjectsRuntime = (() => {
  if (typeof window === 'undefined') return false;
  return Boolean(getRegisteredRuntimeAPIs()?.runtime?.isVSCode);
})();
const effectiveInitialProjects = vscodeWorkspace?.projects ?? (isVSCodeProjectsRuntime ? [] : initialProjects);
const persistedInitialActiveProjectId = vscodeWorkspace?.activeProjectId ?? (isVSCodeProjectsRuntime ? null : readPersistedActiveProjectId());
const initialActiveProjectId = effectiveInitialProjects.some((project) => project.id === persistedInitialActiveProjectId)
  ? persistedInitialActiveProjectId
  : effectiveInitialProjects[0]?.id ?? null;

if (vscodeWorkspace) {
  cacheProjects(effectiveInitialProjects, initialActiveProjectId);
}

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: effectiveInitialProjects,
    activeProjectId: initialActiveProjectId,
    manualProjectOrder: readPersistedManualOrder(),
    hubProjectLayout: null,

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: (path: string, options?: { label?: string; id?: string }) => {
      if (isVSCodeProjectsRuntime) {
        return null;
      }
      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;
      const existing = get().projects.find((project) => !project.hostId && project.path === normalizedPath);
      if (existing) {
        get().setActiveProject(existing.id);
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      const id = createProjectIdFromPath(normalizedPath);
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        label,
        addedAt: now,
        lastOpenedAt: now,
      };

      const { projects, manualProjectOrder } = get();
      const nextProjects = [entry, ...projects];
      const nextManualOrder = [entry.id, ...manualProjectOrder.filter((id) => id !== entry.id)];
      set({ projects: nextProjects, manualProjectOrder: nextManualOrder });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      get().setActiveProject(entry.id);
      void get().discoverProjectIcon(entry.id);
      return entry;
    },

    upsertRemoteProject: (project, hubId) => {
      const remote = { ...parseRemoteProject(project), hubId };
      const current = get();
      const previous = current.projects.find((entry) => entry.id === remote.id);
      if (previous && JSON.stringify(previous) === JSON.stringify({ ...previous, ...remote })) return;
      const projects = previous
        ? current.projects.map((entry) => entry.id === remote.id ? { ...entry, ...remote } : entry)
        : [...current.projects, remote];
      const projected = current.hubProjectLayout?.hubId === hubId ? projectLayoutProjection(projects, current.hubProjectLayout) : projects;
      set({ projects: projected });
      cacheProjects(projected, current.activeProjectId);
    },

    setProjectCollapsed: (id, sidebarCollapsed) => {
      const current = get();
      const projects = current.projects.map((project) => project.id === id ? { ...project, sidebarCollapsed } : project);
      set({ projects });
      if (!persistHubLayout(current.projects, projects, { [id]: sidebarCollapsed })) persistProjects(projects, current.activeProjectId, current.manualProjectOrder);
    },

    reconcileRemoteProjects: (remoteProjects, hubId) => {
      const current = get();
      const incoming = new Map(remoteProjects.map((project) => [project.id, { ...project, hubId }]));
      const projects = current.projects.flatMap((project) => {
        if (!project.hostId) return [project];
        const next = incoming.get(project.id);
        incoming.delete(project.id);
        if (!next) return [];
        const updated = { ...project, ...next, sidebarCollapsed: project.sidebarCollapsed };
        return [JSON.stringify(updated) === JSON.stringify(project) ? project : updated];
      });
      projects.push(...incoming.values());
      const projected = current.hubProjectLayout?.hubId === hubId ? projectLayoutProjection(projects, current.hubProjectLayout) : projects;
      if (JSON.stringify(projected) === JSON.stringify(current.projects)) return;
      const activeProjectId = projected.some((project) => project.id === current.activeProjectId) ? current.activeProjectId : projected[0]?.id ?? null;
      set({ projects: projected, activeProjectId, manualProjectOrder: projected.map((project) => project.id) });
      cacheProjects(projected, activeProjectId);
      const remoteSession = useSessionNavigationStore.getState().remoteSession;
      if (remoteSession && !projects.some((project) => project.id === remoteSession.projectId)) useSessionNavigationStore.getState().clearRemoteSession();
    },

    removeProject: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const current = get();
      const project = current.projects.find((p) => p.id === id);
      if (project?.hostId) {
        return ensureRemoteHostCatalog().then(async (catalog) => {
          if (project.hubId && project.hubId !== catalog.hubId) throw new Error('Project belongs to an inactive Hub');
          await removeRemoteProject(getHostRuntimeRegistry(catalog), parseRemoteProject(project));
          const latest = get();
          const projects = latest.projects.filter((entry) => entry.id !== id);
          const activeProjectId = latest.activeProjectId === id ? projects[0]?.id ?? null : latest.activeProjectId;
          set({ projects, activeProjectId, manualProjectOrder: latest.manualProjectOrder.filter((entry) => entry !== id) });
          cacheProjects(projects, activeProjectId);
          if (useSessionNavigationStore.getState().remoteSession?.projectId === id) useSessionNavigationStore.getState().clearRemoteSession();
        });
      }
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      const nextManualOrder = get().manualProjectOrder.filter((oid) => oid !== id);
      set({ projects: nextProjects, activeProjectId: nextActiveId, manualProjectOrder: nextManualOrder });
      persistProjects(nextProjects, nextActiveId, nextManualOrder);

      // Clean up worktree entries for the removed project
      if (project) {
        const normalizedPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        useSessionUIStore.setState((s) => {
          const next = new Map(s.availableWorktreesByProject);
          next.delete(normalizedPath);
          return { availableWorktreesByProject: next };
        });
      }

      if (nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive && !nextActive.hostId) {
          opencodeClient.setDirectory(nextActive.path);
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      set({ activeProjectId: id });
      persistProjects(projects, id, get().manualProjectOrder);

      if (target.hostId) {
        if (target.hubId) useSessionNavigationStore.getState().openRemoteSession(target, { hubId: target.hubId, hostId: target.hostId, directory: target.path }, null);
        return;
      }
      useSessionNavigationStore.getState().clearRemoteSession();
      opencodeClient.setDirectory(target.path);
      useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
    },

    setActiveProjectIdOnly: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      set({ activeProjectId: id });
      persistProjects(projects, id, get().manualProjectOrder);
      if (!target.hostId) useSessionNavigationStore.getState().clearRemoteSession();
    },

    renameProject: (id: string, label: string) => {
      if (get().projects.find((project) => project.id === id)?.hostId) return get().updateProjectMeta(id, { label });
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, label: trimmed } : project
      );
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    updateProjectMeta: (id: string, meta: {
      label?: string;
      icon?: string | null;
      color?: string | null;
      iconBackground?: string | null;
      defaultModel?: string | null;
    }) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      const remote = projects.find((project) => project.id === id && project.hostId);
      if (remote) {
        return ensureRemoteHostCatalog().then(async (catalog) => {
          if (remote.hubId && remote.hubId !== catalog.hubId) throw new Error('Project belongs to an inactive Hub');
          const updated = await remoteProjectMetadata(getHostRuntimeRegistry(catalog), parseRemoteProject(remote), meta);
          get().upsertRemoteProject(updated, catalog.hubId);
        });
      }
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        if (meta.defaultModel !== undefined) {
          const normalized = normalizeDefaultModel(meta.defaultModel);
          if (normalized) {
            updated.defaultModel = normalized;
          } else {
            delete updated.defaultModel;
          }
        }
        return updated;
      });
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    uploadProjectIcon: async (id: string, file: File) => {
      const assertCurrent = captureProjectRuntime();
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        assertCurrent();
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await projectIconRequest(id, '', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        assertCurrent();
        if (payload?.settings) {
          await applyProjectIconSettings(id, payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {
      const assertCurrent = captureProjectRuntime();
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await projectIconRequest(id, '', {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        assertCurrent();
        if (payload?.settings) {
          await applyProjectIconSettings(id, payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {
      const assertCurrent = captureProjectRuntime();
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await projectIconRequest(id, '/discover', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ force: options?.force === true }),
        });

        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          skipped?: boolean;
          reason?: string;
          settings?: DesktopSettings;
        } | null;
        assertCurrent();

        if (!response.ok) {
          return { ok: false, error: payload?.error || 'Failed to discover project icon' };
        }

        if (payload?.settings) {
          await applyProjectIconSettings(id, payload.settings);
        }

        return {
          ok: true,
          skipped: payload?.skipped === true,
          reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to discover project icon' };
      }
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      const newOrder = nextProjects.map((p) => p.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      if (!persistHubLayout(projects, nextProjects)) persistProjects(nextProjects, activeProjectId, newOrder);
    },

    reorderProjectsById: (activeId: string, overId: string) => {
      if (isVSCodeProjectsRuntime) return;
      const { projects, activeProjectId } = get();
      const nextProjects = reorderProjectEntriesById(projects, activeId, overId);
      if (nextProjects === projects) return;
      const newOrder = nextProjects.map((project) => project.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      if (!persistHubLayout(projects, nextProjects)) persistProjects(nextProjects, activeProjectId, newOrder);
    },

    moveProjectToTop: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId, manualProjectOrder } = get();
      const projectIndex = projects.findIndex((project) => project.id === id);
      if (projectIndex === -1) return;
      const manualIndex = manualProjectOrder.indexOf(id);
      // Activity promotion and manual drag are peers on the current order:
      // advance the registry always, and when a drag order exists promote on
      // that list too so manual sort mode still pins after a send.
      const registryNeedsMove = projectIndex > 0;
      const manualNeedsMove = manualProjectOrder.length > 0 && manualIndex !== 0;
      if (!registryNeedsMove && !manualNeedsMove) {
        return;
      }

      const nextProjects = registryNeedsMove
        ? (() => {
          const moved = [...projects];
          const [project] = moved.splice(projectIndex, 1);
          moved.unshift(project);
          return moved;
        })()
        : projects;
      const nextManualOrder = manualNeedsMove
        ? [id, ...manualProjectOrder.filter((projectId) => projectId !== id)]
        : manualProjectOrder;

      if (nextProjects === projects && nextManualOrder === manualProjectOrder) {
        return;
      }

      set({ projects: nextProjects, manualProjectOrder: nextManualOrder });
      if (!persistHubLayout(projects, nextProjects)) persistProjects(nextProjects, activeProjectId, nextManualOrder);
    },

    resetForRuntimeSwitch: () => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const projects = readPersistedProjects();
      const activeProjectId = readPersistedActiveProjectId();
      const nextActiveProjectId = projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : projects[0]?.id ?? null;
      const incomingIds = new Set(projects.map((project) => project.id));
      const manualProjectOrder = readPersistedManualOrder().filter((id) => incomingIds.has(id));
      layoutMutation += 1;
      set({ projects, activeProjectId: nextActiveProjectId, manualProjectOrder, hubProjectLayout: null });
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      if (!Array.isArray(settings.projects)) return;
      const locals = sanitizeProjects(settings.projects ?? []).filter((project) => !project.hostId);
      const pendingLocals = [...locals];
      const currentProjects = get().projects;
      const mergedProjects = currentProjects.some((project) => project.hostId)
        ? [...currentProjects.flatMap((project) => project.hostId ? [project] : pendingLocals.length ? [pendingLocals.shift()!] : []), ...pendingLocals]
        : locals;
      const parsedLayout = settings.hubProjectLayout === undefined ? get().hubProjectLayout : parseHubProjectLayout(settings.hubProjectLayout);
      const layout = parsedLayout && !currentProjects.some((project) => project.hostId && project.hubId && project.hubId !== parsedLayout.hubId)
        ? parsedLayout : null;
      const incomingProjects = layout ? projectLayoutProjection(mergedProjects, layout) : mergedProjects;
      const settingsActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const activeRemote = currentProjects.find((project) => project.id === get().activeProjectId && project.hostId);
      const incomingActive = activeRemote?.id ?? settingsActive;

      const current = get();

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;
      const serverOrder = incomingProjects.map((project) => project.id);
      const orderChanged = JSON.stringify(current.manualProjectOrder) !== JSON.stringify(serverOrder);

      const layoutChanged = JSON.stringify(current.hubProjectLayout) !== JSON.stringify(layout);
      if (!projectsChanged && !activeChanged && !orderChanged && !layoutChanged) {
        return;
      }

      // Local order is a startup cache; the host registry is shared authority.
      set({ projects: projectsChanged ? incomingProjects : current.projects, activeProjectId: incomingActive, manualProjectOrder: serverOrder, hubProjectLayout: layout });
      cacheProjects(incomingProjects, incomingActive);
      persistManualProjectOrder(serverOrder);

      if (incomingActive && activeChanged) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject && !activeProject.hostId) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }
    },

    syncVSCodeWorkspaceFolders: (folders, activePath) => {
      if (!isVSCodeProjectsRuntime) {
        return null;
      }

      const current = get();
      const currentActiveProject = current.activeProjectId
        ? current.projects.find((project) => project.id === current.activeProjectId) ?? null
        : null;
      const targetActivePath = activePath ?? currentActiveProject?.path ?? null;
      const result = createVSCodeWorkspaceProjects(folders, current.projects, targetActivePath);
      if (!result) {
        if (folders.length === 0 && !activePath && current.projects.length > 0) {
          set({ projects: [], activeProjectId: null });
          cacheProjects([], null);
        }
        return null;
      }

      const projectsChanged = !vscodeWorkspaceProjectsEqual(current.projects, result.projects);
      const activeChanged = current.activeProjectId !== result.activeProjectId;

      if (projectsChanged || activeChanged) {
        set({ projects: result.projects, activeProjectId: result.activeProjectId });
        cacheProjects(result.projects, result.activeProjectId);
      }

      if (result.activeProject) {
        opencodeClient.setDirectory(result.activeProject.path);
        useDirectoryStore.getState().setDirectory(result.activeProject.path, { showOverlay: false });
      }

      return result.activeProject;
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

if (typeof window !== 'undefined') {
  window.addEventListener('yuri:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });
}
