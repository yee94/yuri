import { describe, expect, it } from 'vitest';
import { routeStateFromPath } from './parseRoute';
import { serializeAppPath, updateBrowserURL, type AppRouteState } from './serializeRoute';

const state = (hostId: string): AppRouteState => ({
  sessionId: 'same/session', hostId, hubId: 'hub', directory: 'C:\\Raw Path\\',
  tab: 'files', diffFile: 'C:\\Raw Path\\file.ts', isSettingsOpen: false, settingsPath: 'home',
});

describe('remote session route identity', () => {
  it('round trips Host/Hub/session and raw physical directory without replacing local path identity', () => {
    const route = routeStateFromPath(serializeAppPath(state('host-a')));
    expect(route).toMatchObject({ hostId: 'host-a', hubId: 'hub', sessionId: 'same/session', directory: 'C:\\Raw Path\\' });
    const draft = routeStateFromPath(serializeAppPath({ ...state('host-a'), sessionId: null, isNewSession: true, tab: 'chat' }));
    expect(draft).toMatchObject({ isNewSession: true, sessionId: null, hostId: 'host-a', directory: 'C:\\Raw Path\\' });
    expect(routeStateFromPath('/session/same%2Fsession')).not.toHaveProperty('hostId');
    expect(routeStateFromPath(serializeAppPath({ ...state('host-a'), projectId: 'reference', directory: '/sibling-worktree' })))
      .toMatchObject({ projectId: 'reference', directory: '/sibling-worktree', hostId: 'host-a' });
  });

  it('updates the URL for a same-id cross-Host navigation and rejects incomplete writes', () => {
    window.history.replaceState({}, '', serializeAppPath(state('host-a')));
    updateBrowserURL(state('host-b'));
    expect(new URLSearchParams(window.location.search).get('hostId')).toBe('host-b');
    expect(() => serializeAppPath({ ...state('host-a'), hubId: null })).toThrow('Remote route requires Hub');
    window.history.replaceState({}, '', '/');
  });
});
