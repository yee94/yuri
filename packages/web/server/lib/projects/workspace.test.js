import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectRegistry } from './registry.js';
import {
  buildWorkspaceSystemInstruction,
  getWorkspacePaths,
  installWorkspaceSessionInstruction,
  isBlankWorkspace,
  isMultiPathWorkspace,
  isWorkspaceId,
  WORKSPACE_INSTRUCTION_KEY,
} from './workspace.js';

const tempDirs = [];
const makeTempDir = async (prefix = 'yuri-workspace-test-') => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpath(dir);
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('multi-path & blank workspace registry', () => {
  const setupRegistry = async () => {
    const root = await makeTempDir();
    const yuriDataDir = path.join(root, 'data');
    const dirA = path.join(root, 'yuri');
    const dirB = path.join(root, 'agent-tracker');
    const dirC = path.join(root, 'shared');
    await Promise.all([
      fs.mkdir(yuriDataDir, { recursive: true }),
      fs.mkdir(dirA, { recursive: true }),
      fs.mkdir(dirB, { recursive: true }),
      fs.mkdir(dirC, { recursive: true }),
    ]);

    let state = { projects: [] };
    const persistSettings = async (updater) => {
      const patch = updater(state);
      state = { ...state, ...patch };
      return state;
    };
    const validateDirectoryPath = async (candidate) => {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) return { ok: false, error: 'Not a directory' };
        return { ok: true, directory: await fs.realpath(candidate) };
      } catch {
        return { ok: false, error: 'Directory not found' };
      }
    };

    const registry = createProjectRegistry({ persistSettings, validateDirectoryPath, yuriDataDir });
    return { registry, dirA, dirB, dirC, yuriDataDir, getState: () => state };
  };

  it('creates a 0-path blank workspace with a managed backing directory', async () => {
    const { registry, yuriDataDir } = await setupRegistry();
    const { project, created } = await registry.register({ paths: [], label: 'Scratchpad' });

    expect(created).toBe(true);
    expect(isWorkspaceId(project.id)).toBe(true);
    expect(isBlankWorkspace(project)).toBe(true);
    expect(getWorkspacePaths(project)).toEqual([]);
    expect(project.label).toBe('Scratchpad');
    expect(project.path.startsWith(path.join(yuriDataDir, 'workspaces'))).toBe(true);
    const stat = await fs.stat(project.path);
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates a multi-path workspace alongside a single-path project sharing the same directory', async () => {
    const { registry, dirA, dirB, getState } = await setupRegistry();
    const single = await registry.register({ path: dirA, label: 'yuri' });
    const multi = await registry.register({
      paths: [dirA, dirB],
      primaryPath: dirB,
      label: 'yuri-runmark',
    });

    expect(single.created).toBe(true);
    expect(multi.created).toBe(true);
    expect(multi.project.id).not.toBe(single.project.id);
    expect(isWorkspaceId(multi.project.id)).toBe(true);
    expect(isMultiPathWorkspace(multi.project)).toBe(true);
    expect(multi.project.path).toBe(dirB);
    expect(multi.project.paths).toEqual([dirB, dirA]);
    expect(getState().projects).toHaveLength(2);
  });

  it('updates workspace paths, primary directory, and transitions cleanly to 0 paths while preserving id', async () => {
    const { registry, dirA, dirB, dirC } = await setupRegistry();
    const { project: single } = await registry.register({ path: dirA });
    const originalId = single.id;

    // Promote legacy single-path project to multi-path while preserving id
    const added = await registry.update({ projectId: originalId, addPath: dirB });
    expect(added.project.id).toBe(originalId);
    expect(added.project.paths).toEqual([dirA, dirB]);
    expect(added.project.path).toBe(dirA);

    // Switch primary path
    const switched = await registry.update({ projectId: originalId, primaryPath: dirB, label: 'Combined' });
    expect(switched.project.id).toBe(originalId);
    expect(switched.project.path).toBe(dirB);
    expect(switched.project.paths).toEqual([dirB, dirA]);
    expect(switched.project.label).toBe('Combined');

    // Add third path then replace with 0 paths
    await registry.update({ projectId: originalId, addPath: dirC });
    const blanked = await registry.update({ projectId: originalId, paths: [] });
    expect(blanked.project.id).toBe(originalId);
    expect(isBlankWorkspace(blanked.project)).toBe(true);
    expect(blanked.project.paths).toEqual([]);
  });

  it('installs yuri.workspace system instruction only for multi-path or 0-path workspaces', async () => {
    const put = vi.fn(async () => undefined);
    const client = { session: { instructions: { entry: { put } } } };
    const projects = [
      { id: 'path_single', path: '/code/yuri' },
      { id: 'ws_multi', path: '/code/yuri', paths: ['/code/yuri', '/code/agent-tracker'], label: 'yuri-runmark' },
      { id: 'ws_blank', path: '/data/workspaces/ws_blank', paths: [], label: 'Notes' },
    ];
    const readSettings = async () => ({ projects });
    const sanitizeProjects = (list) => list;

    // Single-path project skips injection
    const singleInstalled = await installWorkspaceSessionInstruction({
      client,
      sessionID: 'ses_1',
      workspaceId: 'path_single',
      directory: '/code/yuri',
      readSettings,
      sanitizeProjects,
    });
    expect(singleInstalled).toBe(false);
    expect(put).not.toHaveBeenCalled();

    // Multi-path workspace injects explicit directory list & guidelines
    const multiInstalled = await installWorkspaceSessionInstruction({
      client,
      sessionID: 'ses_2',
      workspaceId: 'ws_multi',
      directory: '/code/yuri',
      readSettings,
      sanitizeProjects,
    });
    expect(multiInstalled).toBe(true);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_2',
      key: WORKSPACE_INSTRUCTION_KEY,
      value: expect.stringContaining('/code/agent-tracker'),
    }));

    // 0-path blank workspace injects non-repo guidance
    const blankInstruction = buildWorkspaceSystemInstruction(projects[2]);
    expect(blankInstruction).toContain('no attached project directories');
  });
});
