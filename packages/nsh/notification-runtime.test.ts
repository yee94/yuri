import { beforeEach, expect, it, vi } from 'vitest';
import { bindNativeNotificationRoot, nativeNotificationAuthorization, nativeNotificationScope, nativeNotificationSettings, notificationScopedRequest } from './notification-runtime';

const state = vi.hoisted(() => ({ hostID: 'host-a', generation: 1, runtime: { hostID: 'host-a', lease: 'native-a' } as { hostID: string; lease: string } | null,
  captures: 0, auth: 'authorization-a', calls: [] as [string, Record<string, unknown>][], pending: null as (() => Promise<void>) | null }));
vi.mock('nsh', () => ({ locale: () => 'en', host: { available: () => true, call: async (name: string, body: Record<string, unknown>) => {
  state.calls.push([name, body]);
  if (name === 'runtime.request') {
    const expected = body.expectedHost as { hostID: string; lease: string } | undefined;
    if (state.pending) await state.pending();
    if (!expected || expected.hostID !== state.runtime?.hostID || expected.lease !== state.runtime?.lease) throw new Error('scope_stale');
    return { status: 200, body: body.method === 'GET' ? { nativeNotificationsEnabled: true } : { ok: true } };
  }
  if (name === 'notification.configure') return { lease: 'notification-lease' };
  throw new Error('unexpected call');
} } }));
vi.mock('./i18n', () => ({ language: () => 'en' }));
vi.mock('./state', async () => {
  const { bindRequest } = await import('./runtime');
  return { app: { connection: () => ({ id: state.hostID, authorizationID: state.auth }), runtimeScope: () => state.runtime }, epoch: () => state.generation,
    isCurrentHostScope: (generation: number, hostID: string) => generation === state.generation && hostID === state.hostID,
    captureHostRequest: () => { state.captures++; return bindRequest(state.runtime); } };
});
beforeEach(() => { state.hostID = 'host-a'; state.generation++; state.runtime = { hostID: 'host-a', lease: 'native-a' }; state.auth = 'authorization-a'; state.calls = []; state.pending = null; state.captures = 0; nativeNotificationSettings.invalidate(); });

it('uses the fixed runtime.bindRequest API and recaptures the root settings/Basic sender only at Host/generation replacement', async () => {
  const unbind = bindNativeNotificationRoot({ scope: nativeNotificationScope });
  try {
    await nativeNotificationSettings.refresh(); await nativeNotificationSettings.write({ notifyOnGoals: false });
    expect(state.captures).toBe(1);
    for (const [, body] of state.calls.filter(([name]) => name === 'runtime.request')) expect(body.expectedHost).toEqual({ hostID: 'host-a', lease: 'native-a' });
    const old = notificationScopedRequest();
    state.hostID = 'host-b'; state.generation++; state.runtime = { hostID: 'host-b', lease: 'native-b' };
    const before = state.calls.length; await expect(old('/api/config/settings', 'PUT', {})).rejects.toThrow('notification_stale'); expect(state.calls).toHaveLength(before);
    await nativeNotificationSettings.refresh(); expect(state.captures).toBe(2);
    expect(state.calls.findLast(([name]) => name === 'runtime.request')?.[1].expectedHost).toEqual({ hostID: 'host-b', lease: 'native-b' });
  } finally { unbind(); }
});

it('never turns a missing native request binding into an unbound latest-Host settings read/write', async () => {
  const unbind = bindNativeNotificationRoot({ scope: () => ({ hostID: state.hostID, generation: state.generation }) });
  try {
    state.runtime = null; expect(nativeNotificationScope()).toBeNull();
    await expect(nativeNotificationSettings.read()).rejects.toThrow('notification_unsupported');
    await expect(nativeNotificationSettings.write({ nativeNotificationsEnabled: false })).rejects.toThrow('notification_unsupported');
    expect(state.calls).toEqual([]);
    state.auth = 'legacy'; expect(nativeNotificationAuthorization()).toBeNull();
  } finally { unbind(); }
});

it('drops a late settings response after scope replacement without configuring a new Host or recapturing inside the continuation', async () => {
  const unbind = bindNativeNotificationRoot({ scope: nativeNotificationScope });
  try {
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; }); state.pending = () => gate;
    const work = nativeNotificationSettings.refresh();
    state.hostID = 'host-b'; state.generation++; state.runtime = { hostID: 'host-b', lease: 'native-b' }; finish();
    await expect(work).rejects.toThrow(); expect(state.captures).toBe(1);
    expect(state.calls.map(([name]) => name)).toEqual(['runtime.request']);
  } finally { unbind(); }
});
