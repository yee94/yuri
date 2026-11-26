import { describe, expect, test } from 'vitest';
import type { ProjectEntry } from '@/lib/api/types';
import { resolveNewSessionWorkspaceId } from './session-ui-store';

const single = { id: 'path_tap', path: '/code/tap' } as ProjectEntry;
const multi = { id: 'ws_combo', path: '/code/app', paths: ['/code/app', '/code/api'] } as ProjectEntry;

describe('resolveNewSessionWorkspaceId', () => {
  test('records single-path projects, not only multi-path workspaces', () => {
    expect(resolveNewSessionWorkspaceId(single, '/code/tap/src', false)).toBe('path_tap');
    expect(resolveNewSessionWorkspaceId(multi, '/elsewhere', false)).toBe('ws_combo');
  });

  test('does not attach a fallback project that does not contain the directory', () => {
    expect(resolveNewSessionWorkspaceId(single, '/code/tapper', false)).toBeUndefined();
    expect(resolveNewSessionWorkspaceId(single, '/wt/feature', true)).toBe('path_tap');
  });

  test('never records remote projects', () => {
    expect(resolveNewSessionWorkspaceId({ ...single, hostId: 'host' } as ProjectEntry, '/code/tap', true)).toBeUndefined();
    expect(resolveNewSessionWorkspaceId(null, '/code/tap', true)).toBeUndefined();
  });
});
