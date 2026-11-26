import { createProjectIdFromPath } from './project-id.js';
import {
  createWorkspaceId,
  ensureBlankWorkspaceDirectory,
  getWorkspacePaths,
  isWorkspaceId,
} from './workspace.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const string = (value, field, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('validation_error', `${field} must be a nonempty string (maximum ${max} characters).`);
  }
  return value.trim();
};

const MAX_WORKSPACE_PATHS = 24;

// Registry mutations share the settings owner's exclusive read/modify/write path.
export const createProjectRegistry = ({
  persistSettings,
  validateDirectoryPath,
  yuriDataDir = '',
  ensureWorkspaceDir = null,
}) => {
  const provisionBlankDir = async (workspaceId) => {
    if (typeof ensureWorkspaceDir === 'function') {
      return ensureWorkspaceDir(workspaceId);
    }
    if (!yuriDataDir) {
      fail('validation_error', 'Blank workspaces require a configured Host data directory.');
    }
    return ensureBlankWorkspaceDirectory(yuriDataDir, workspaceId);
  };

  const validatePathsArray = async (rawPaths) => {
    if (!Array.isArray(rawPaths)) {
      fail('validation_error', 'paths must be an array of directory paths.');
    }
    if (rawPaths.length > MAX_WORKSPACE_PATHS) {
      fail('validation_error', `A workspace can attach at most ${MAX_WORKSPACE_PATHS} directories.`);
    }
    const validatedPaths = [];
    const seen = new Set();
    for (let index = 0; index < rawPaths.length; index += 1) {
      const candidate = string(rawPaths[index], `paths[${index}]`);
      const validated = await validateDirectoryPath(candidate);
      if (!validated.ok) {
        fail('validation_error', validated.error || `Directory is unavailable: ${candidate}`);
      }
      if (!seen.has(validated.directory)) {
        seen.add(validated.directory);
        validatedPaths.push(validated.directory);
      }
    }
    return validatedPaths;
  };

  const orderWithPrimary = (paths, primaryDirectory) => {
    if (!primaryDirectory) return paths;
    if (!paths.includes(primaryDirectory)) {
      fail('validation_error', 'primaryPath must be one of the workspace directories.');
    }
    return [primaryDirectory, ...paths.filter((entry) => entry !== primaryDirectory)];
  };

  const register = async (input = {}) => {
    const hasExplicitPaths = Array.isArray(input.paths);
    const label = input.label === undefined ? undefined : string(input.label, 'label', 80);

    // Multi-path or 0-path workspace creation
    if (hasExplicitPaths) {
      let validatedPaths = await validatePathsArray(input.paths);
      if (input.primaryPath !== undefined) {
        const validatedPrimary = await validateDirectoryPath(string(input.primaryPath, 'primaryPath'));
        if (!validatedPrimary.ok) {
          fail('validation_error', validatedPrimary.error || 'Primary directory is unavailable.');
        }
        validatedPaths = orderWithPrimary(validatedPaths, validatedPrimary.directory);
      }

      if (validatedPaths.length === 0 && !label) {
        fail('validation_error', 'label is required when creating a workspace with no directories.');
      }

      // Single-path explicit call without forceNew reuses legacy single-path registration when no ws_ requested
      if (validatedPaths.length === 1 && input.workspace !== true && input.createWorkspace !== true) {
        return register({ ...input, paths: undefined, path: validatedPaths[0] });
      }

      const id = createWorkspaceId();
      const primaryDirectory = validatedPaths.length > 0
        ? validatedPaths[0]
        : await provisionBlankDir(id);
      const now = Date.now();
      const project = {
        id,
        path: primaryDirectory,
        paths: validatedPaths,
        addedAt: now,
        lastOpenedAt: now,
        ...(label ? { label } : {}),
      };

      const settings = await persistSettings((current) => {
        const projects = Array.isArray(current.projects) ? current.projects : [];
        const hubLayout = current.hubProjectLayout;
        const prependedHubLayout = input.prepend === true && hubLayout && typeof hubLayout.hubId === 'string' && Array.isArray(hubLayout.order)
          ? {
              ...hubLayout,
              order: [project.id, ...hubLayout.order.filter((entryId) => entryId !== project.id)],
            }
          : undefined;
        return {
          projects: input.prepend === true ? [project, ...projects] : [...projects, project],
          ...(prependedHubLayout ? { hubProjectLayout: prependedHubLayout } : {}),
          ...(input.activate === true ? { activeProjectId: project.id, lastDirectory: primaryDirectory } : {}),
        };
      });
      const saved = settings.projects?.find((entry) => entry.id === project.id);
      if (!saved) fail('project_unavailable', 'Workspace could not be persisted.');
      return { project: saved, created: true, settings };
    }

    // Legacy single-path idempotent registration
    const validated = await validateDirectoryPath(string(input.path, 'path'));
    if (!validated.ok) fail('validation_error', validated.error || 'Project directory is unavailable.');
    const directory = validated.directory;
    let project;
    let created = false;
    const settings = await persistSettings((current) => {
      const projects = Array.isArray(current.projects) ? current.projects : [];
      const existing = projects.find((entry) => (
        !isWorkspaceId(entry.id)
        && (!Array.isArray(entry.paths) || entry.paths.length === 1)
        && entry.path === directory
      ));
      created = !existing;
      project = existing || {
        id: createProjectIdFromPath(directory),
        path: directory,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        ...(label ? { label } : {}),
      };
      return {
        projects: created ? [...projects, project] : projects,
        ...(input.activate === true ? { activeProjectId: project.id, lastDirectory: directory } : {}),
      };
    });
    const saved = settings.projects?.find((entry) => entry.id === project.id);
    if (!saved) fail('project_unavailable', 'The directory disappeared before the project could be registered. No session was opened.');
    return { project: saved, created, settings };
  };

  const update = async (input = {}) => {
    const id = string(input.projectId, 'projectId');
    const nextLabel = input.label === undefined
      ? undefined
      : (input.label === null || input.label === '' ? null : string(input.label, 'label', 80));

    let replacedPaths;
    if (input.paths !== undefined) {
      replacedPaths = await validatePathsArray(input.paths);
    }

    let addDirectory;
    if (input.addPath !== undefined) {
      const validated = await validateDirectoryPath(string(input.addPath, 'addPath'));
      if (!validated.ok) fail('validation_error', validated.error || 'Directory is unavailable.');
      addDirectory = validated.directory;
    }

    let removeDirectory;
    if (input.removePath !== undefined) {
      const rawRemove = string(input.removePath, 'removePath');
      const validated = await validateDirectoryPath(rawRemove);
      removeDirectory = validated.ok ? validated.directory : rawRemove.replace(/\\/g, '/').replace(/\/+$/, '');
    }

    let primaryDirectory;
    if (input.primaryPath !== undefined) {
      const validated = await validateDirectoryPath(string(input.primaryPath, 'primaryPath'));
      if (!validated.ok) fail('validation_error', validated.error || 'Primary directory is unavailable.');
      primaryDirectory = validated.directory;
    }

    // Pre-provision blank backing directory lazily only if the update results in 0 paths
    let preparedBlankDir = null;
    const ensureBlankFor = async () => {
      if (!preparedBlankDir) {
        preparedBlankDir = await provisionBlankDir(id);
      }
      return preparedBlankDir;
    };

    // Peek whether we might end up with 0 paths so we never run async fs inside persistSettings callback
    if (replacedPaths?.length === 0 || removeDirectory) {
      await ensureBlankFor().catch(() => { /* validated below if actually needed */ });
    }

    let updatedProject = null;
    const settings = await persistSettings((current) => {
      if (!Array.isArray(current.projects)) throw new Error('Invalid project settings');
      const index = current.projects.findIndex((entry) => entry.id === id);
      if (index < 0) fail('not_found', 'Project is not registered on this Host.');
      const existing = current.projects[index];
      let nextPaths = replacedPaths !== undefined ? [...replacedPaths] : getWorkspacePaths(existing);

      if (addDirectory && !nextPaths.includes(addDirectory)) {
        if (nextPaths.length >= MAX_WORKSPACE_PATHS) {
          fail('validation_error', `A workspace can attach at most ${MAX_WORKSPACE_PATHS} directories.`);
        }
        nextPaths = [...nextPaths, addDirectory];
      }
      if (removeDirectory) {
        const normalizedRemove = removeDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
        nextPaths = nextPaths.filter((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, '') !== normalizedRemove);
      }
      if (primaryDirectory) {
        nextPaths = orderWithPrimary(nextPaths, primaryDirectory);
      }

      const resolvedLabel = nextLabel === undefined
        ? existing.label
        : (nextLabel === null ? undefined : nextLabel);

      let nextPrimaryPath = existing.path;
      if (nextPaths.length > 0) {
        nextPrimaryPath = nextPaths[0];
      } else {
        if (!preparedBlankDir) {
          fail('validation_error', 'Blank workspaces require a configured Host data directory.');
        }
        nextPrimaryPath = preparedBlankDir;
      }

      const keepExplicitPathsField = isWorkspaceId(existing.id)
        || Array.isArray(existing.paths)
        || nextPaths.length !== 1;

      updatedProject = {
        ...existing,
        path: nextPrimaryPath,
        ...(keepExplicitPathsField ? { paths: nextPaths } : {}),
        ...(resolvedLabel ? { label: resolvedLabel } : {}),
      };
      if (!keepExplicitPathsField) {
        delete updatedProject.paths;
      }
      if (!resolvedLabel) {
        delete updatedProject.label;
      }

      const projects = current.projects.map((entry, idx) => (idx === index ? updatedProject : entry));
      return {
        projects,
        ...(current.activeProjectId === id ? { lastDirectory: nextPrimaryPath } : {}),
      };
    });

    const saved = settings.projects?.find((entry) => entry.id === id);
    if (!saved) fail('project_unavailable', 'Workspace update could not be persisted.');
    return { project: saved, settings };
  };

  const remove = async ({ projectId }) => {
    const id = string(projectId, 'projectId');
    const settings = await persistSettings((current) => {
      if (!Array.isArray(current.projects)) throw new Error('Invalid project settings');
      const projects = current.projects.filter((entry) => entry.id !== id);
      if (projects.length === current.projects.length) fail('not_found', 'Project is not registered on this Host.');
      return { projects };
    });
    return { settings };
  };

  return { register, update, remove };
};
