import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGitRepoStatusMap, useGitStore, useWorkspaceGitSummary, type WorkspaceGitSummary } from './useGitStore';

describe('useWorkspaceGitSummary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useGitStore.setState({ directories: new Map(), activeDirectory: null });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('merges file counts and +insertions/-deletions across multiple git repos while ignoring non-git paths', () => {
    const dirs = new Map();
    dirs.set('/code/yuri', {
      isGitRepo: true,
      status: {
        current: 'main',
        tracking: null,
        ahead: 0,
        behind: 0,
        files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }],
        isClean: false,
        diffStats: { 'a.ts': { insertions: 600, deletions: 200 } },
      },
      branches: null,
      branchesTransportIdentity: null,
      log: null,
      identity: null,
      diffCache: new Map(),
      isLoadingStatus: false,
      isLoadingLog: false,
      isLoadingBranches: false,
      isLoadingIdentity: false,
      lastStatusFetch: 0,
      lastBranchesFetch: 0,
      lastStatusChange: 0,
      statusRevision: null,
      logMaxCount: 50,
    });
    dirs.set('/code/agent-tracker', {
      isGitRepo: true,
      status: {
        current: 'feat/sync',
        tracking: null,
        ahead: 0,
        behind: 0,
        files: [
          { path: 'b.ts', index: ' ', working_dir: 'M' },
          { path: 'c.ts', index: '?', working_dir: '?' },
        ],
        isClean: false,
        diffStats: {
          'b.ts': { insertions: 350, deletions: 300 },
          'c.ts': { insertions: 50, deletions: 0 },
        },
      },
      branches: null,
      branchesTransportIdentity: null,
      log: null,
      identity: null,
      diffCache: new Map(),
      isLoadingStatus: false,
      isLoadingLog: false,
      isLoadingBranches: false,
      isLoadingIdentity: false,
      lastStatusFetch: 0,
      lastBranchesFetch: 0,
      lastStatusChange: 0,
      statusRevision: null,
      logMaxCount: 50,
    });
    dirs.set('/notes', {
      isGitRepo: false,
      status: null,
      branches: null,
      branchesTransportIdentity: null,
      log: null,
      identity: null,
      diffCache: new Map(),
      isLoadingStatus: false,
      isLoadingLog: false,
      isLoadingBranches: false,
      isLoadingIdentity: false,
      lastStatusFetch: 0,
      lastBranchesFetch: 0,
      lastStatusChange: 0,
      statusRevision: null,
      logMaxCount: 50,
    });
    useGitStore.setState({ directories: dirs });

    let latest: WorkspaceGitSummary | null = null;
    const Probe: React.FC<{ paths: string[] }> = ({ paths }) => {
      latest = useWorkspaceGitSummary(paths);
      return null;
    };

    const workspacePaths = ['/code/yuri', '/code/agent-tracker', '/notes'];
    act(() => {
      root.render(<Probe paths={workspacePaths} />);
    });

    expect(latest).not.toBeNull();
    expect(latest!.isAnyGitRepo).toBe(true);
    expect(latest!.gitRepoCount).toBe(2);
    expect(latest!.totalFiles).toBe(3);
    expect(latest!.insertions).toBe(1000);
    expect(latest!.deletions).toBe(500);
    expect(latest!.hasChanges).toBe(true);

    const firstRef = latest;
    act(() => {
      root.render(<Probe paths={['/code/yuri', '/code/agent-tracker', '/notes']} />);
    });
    expect(latest).toBe(firstRef);
  });

  it('useGitRepoStatusMap stays cached without looping when multiple projects share a primary path', () => {
    const dirs = new Map();
    dirs.set('/code/yuri', {
      isGitRepo: true,
      status: { current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
      branches: null,
      branchesTransportIdentity: null,
      log: null,
      identity: null,
      diffCache: new Map(),
      isLoadingStatus: false,
      isLoadingLog: false,
      isLoadingBranches: false,
      isLoadingIdentity: false,
      lastStatusFetch: 0,
      lastBranchesFetch: 0,
      lastStatusChange: 0,
      statusRevision: null,
      logMaxCount: 50,
    });
    useGitStore.setState({ directories: dirs });

    let renders = 0;
    let latestMap: Map<string, { isGitRepo: boolean | null; branch: string | null }> | null = null;
    const Probe: React.FC<{ paths: string[] }> = ({ paths }) => {
      renders += 1;
      latestMap = useGitRepoStatusMap(paths);
      return null;
    };

    act(() => {
      root.render(<Probe paths={['/code/yuri', '/code/yuri', '/code/other']} />);
    });

    expect(renders).toBe(1);
    expect(latestMap!.size).toBe(2);
    expect(latestMap!.get('/code/yuri')).toEqual({ isGitRepo: true, branch: 'main' });

    const firstMap = latestMap;
    act(() => {
      root.render(<Probe paths={['/code/yuri', '/code/yuri', '/code/other']} />);
    });
    expect(latestMap).toBe(firstMap);
  });
});
