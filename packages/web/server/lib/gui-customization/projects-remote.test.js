import { describe, expect, it, vi } from 'vitest';
import { configureServerOpenCodeFetchGate } from '../opencode/server-opencode-fetch.js';
import { runRemoteProjectOperation, validRemoteProjectInput, listRemoteTaskRows } from './projects-remote.js';

const target = { hubId: 'hub', hostId: 'host', instanceId: 'instance' };
const input = { target, directory: '/repo', sessionID: 'ses_one' };
const session = { id: 'ses_one', location: { directory: '/repo' }, title: 'Remote', time: { created: 1, updated: 1 } };
const fixture = () => {
  const request = vi.fn(async (route, init) => {
    if (route === '/api/session/ses_one') return Response.json({ data: session });
    const url = new URL(route, 'http://remote.invalid');
    if (url.pathname === '/api/session' && init.method === 'GET') return Response.json({ data: [session], cursor: { next: 'next' } });
    if (url.pathname === '/api/session' && init.method === 'POST') return Response.json({ data: session });
    return Response.json({ data: {} });
  });
  const release = vi.fn(), json = vi.fn(async () => ({ messages: [], complete: true }));
  const gateway = { supported: true, list: vi.fn(async () => ({ supported: true, hubId: 'hub', hosts: [{ id: 'host', name: 'Build machine', source: 'ssh' }], projects: [{ id: 'p', hostId: 'host', path: '/repo' }] })),
    registerProject: vi.fn(async () => ({ project: { id: 'ref', path: '/repo', hostId: 'host' }, created: true })),
    acquireTask: vi.fn(async () => ({ target, request, json, release })), assertProjectDirectory: vi.fn() };
  return { gateway, request, json, release };
};

describe('bound remote project sessions', () => {
  it('validates the complete target and operation allowlists', () => {
    expect(validRemoteProjectInput('read-session', input)).toBe(true);
    for (const value of [{ ...input, target: null }, { ...input, target: { ...target, instanceId: '' } }, { ...input, target: { hostId: 'host' } }, { ...input, hostOrigin: 'http://other' }]) {
      expect(validRemoteProjectInput('read-session', value)).toBe(false);
    }
    expect(validRemoteProjectInput('prompt-session', { ...input, messageID: 'm', text: 'continue' })).toBe(true);
    expect(validRemoteProjectInput('create-session', { target, directory: '/repo' })).toBe(false);
    for (const path of ['/repo/new', 'C:\\Work\\项目 & 100%', '\\\\server\\share\\repo']) expect(validRemoteProjectInput('add-remote', { target, path, label: 'Project' })).toBe(true);
    for (const value of [{ target, path: 'relative' }, { target, path: '/repo', label: '' }, { target, path: '/repo', label: 'x'.repeat(81) },
      { target, path: '/repo\n' }, { target, path: '/repo', activate: true }, { target: { ...target, instanceId: '' }, path: '/repo' }]) expect(validRemoteProjectInput('add-remote', value)).toBe(false);
    expect(validRemoteProjectInput('remote-hosts', {})).toBe(true);
    expect(validRemoteProjectInput('remote-hosts', { target })).toBe(false);
  });

  it('discovers authorized machines even without projects and preserves per-machine failures without credentials', async () => {
    const f = fixture();
    f.gateway.list.mockResolvedValue({ supported: true, hubId: 'hub', hosts: [
      { id: 'host', name: 'Build machine', source: 'ssh', apiUrl: 'private-url', clientToken: 'private-token' },
      { id: 'offline', name: 'Offline', available: false }, { id: 'denied', name: 'Denied' },
    ], projects: [] });
    f.gateway.acquireTask.mockImplementation(async (id) => {
      if (id === 'denied') throw new Error('private failure');
      return { target, release: f.release };
    });
    const first = await runRemoteProjectOperation(f.gateway, 'remote-hosts', {});
    expect(first).toMatchObject({ hosts: [{ name: 'Build machine', target }], failed: [{ hostId: 'offline' }, { hostId: 'denied' }], complete: false });
    expect(JSON.stringify(first)).not.toMatch(/private/);
    expect(f.release).toHaveBeenCalledOnce();
    f.gateway.acquireTask.mockClear(); f.release.mockClear();
    f.gateway.list.mockResolvedValue({ supported: true, hubId: 'hub', hosts: [{ id: 'host', name: 'Build machine', source: 'ssh' }], projects: [] });
    expect(await runRemoteProjectOperation(f.gateway, 'remote-hosts', {})).toEqual({ hosts: [{ name: 'Build machine', source: 'ssh', target }], failed: [], complete: true });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('registers against the captured instance through the shared gateway without local or session mutations', async () => {
    const f = fixture(); const signal = new AbortController().signal;
    expect(await runRemoteProjectOperation(f.gateway, 'add-remote', { target, path: '/repo', label: 'Remote' }, signal)).toEqual({ project: { id: 'ref', path: '/repo', hostId: 'host' }, created: true, target });
    expect(f.gateway.registerProject).toHaveBeenCalledExactlyOnceWith('host', { path: '/repo', label: 'Remote' }, { instanceId: 'instance', signal });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.gateway.assertProjectDirectory).not.toHaveBeenCalled();
    await expect(runRemoteProjectOperation(f.gateway, 'add-remote', { target: { ...target, hubId: 'other' }, path: '/repo' })).rejects.toMatchObject({ code: 'remote_target_mismatch' });
    expect(f.gateway.registerProject).toHaveBeenCalledOnce();
    f.gateway.registerProject.mockRejectedValueOnce(new Error('offline'));
    await expect(runRemoteProjectOperation(f.gateway, 'add-remote', { target, path: '/repo' })).rejects.toThrow('offline');
    expect(f.gateway.registerProject).toHaveBeenCalledTimes(2);
  });

  it('stops discovery on cancellation instead of returning a false complete catalog', async () => {
    const f = fixture(); const controller = new AbortController();
    f.gateway.acquireTask.mockImplementationOnce(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(runRemoteProjectOperation(f.gateway, 'remote-hosts', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('discovers authenticated targets, releases leases and preserves partial failures', async () => {
    const f = fixture();
    expect(await runRemoteProjectOperation(f.gateway, 'remote-projects', {})).toEqual({ projects: [{ id: 'p', path: '/repo', directories: ['/repo'], target }], failed: [], complete: true });
    f.gateway.projectDirectories = vi.fn(() => ['/repo', '/wt/feature']);
    expect((await runRemoteProjectOperation(f.gateway, 'remote-projects', {})).projects[0].directories).toEqual(['/repo', '/wt/feature']);
    expect(f.gateway.projectDirectories).toHaveBeenCalledWith('host', '/repo');
    f.release.mockClear(); f.release();
    f.gateway.projectDirectories = undefined;
    expect(f.release).toHaveBeenCalledTimes(1);
    f.gateway.acquireTask.mockRejectedValueOnce(new Error('private transport details'));
    expect(await runRemoteProjectOperation(f.gateway, 'remote-projects', {})).toEqual({ projects: [], failed: [{ hostId: 'host', code: 'remote_unavailable' }], complete: false });
  });

  it('rejects wrong Hub, retarget and wrong session directory before message access', async () => {
    const f = fixture();
    await expect(runRemoteProjectOperation(f.gateway, 'read-session', { ...input, target: { ...target, hubId: 'other' } })).rejects.toMatchObject({ code: 'remote_target_mismatch' });
    expect(f.gateway.acquireTask).not.toHaveBeenCalled();
    f.gateway.acquireTask.mockResolvedValueOnce({ target: { ...target, instanceId: 'replacement' }, release: f.release });
    await expect(runRemoteProjectOperation(f.gateway, 'read-session', input)).rejects.toMatchObject({ code: 'remote_target_mismatch' });
    await expect(runRemoteProjectOperation(f.gateway, 'read-session', { ...input, directory: '/other' })).rejects.toMatchObject({ code: 'remote_target_mismatch' });
    expect(f.json).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it('uses lease-backed generated SDK requests and only bounded transient message pages', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const listed = await runRemoteProjectOperation(f.gateway, 'sessions', { target, directory: '/repo' }, signal);
    expect(listed).toMatchObject({ sessions: [{ sessionID: 'ses_one', directory: '/repo', target }], nextCursor: 'next' });
    const [route] = f.request.mock.calls[0];
    expect(new URL(route, 'http://remote.invalid').searchParams.get('directory')).toBe('/repo');
    const read = await runRemoteProjectOperation(f.gateway, 'read-session', input, signal);
    expect(read).toMatchObject({ session: { target }, messages: { complete: true } });
    expect(f.json).toHaveBeenCalledWith('/api/yuri/sessions/ses_one/messages?directory=%2Frepo&turns=3', { signal });
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it('preserves caller-owned write IDs and never retries a failed prompt', async () => {
    configureServerOpenCodeFetchGate(() => ({ executionAllowed: false }));
    try {
      const f = fixture();
      expect(await runRemoteProjectOperation(f.gateway, 'create-session', input)).toMatchObject({ session: { sessionID: 'ses_one', target } });
      const created = JSON.parse(Buffer.from(f.request.mock.calls[0][1].body).toString());
      expect(created).toMatchObject({ id: 'ses_one' });
      f.request.mockClear();
      expect(await runRemoteProjectOperation(f.gateway, 'prompt-session', { ...input, messageID: 'msg_one', text: 'continue' })).toMatchObject({ admitted: true, messageID: 'msg_one' });
      const call = f.request.mock.calls.find(([, init]) => init.method === 'POST');
      expect(JSON.parse(Buffer.from(call[1].body).toString())).toMatchObject({ id: 'msg_one', text: 'continue', delivery: 'steer' });
      f.request.mockRejectedValue(new Error('network'));
      await expect(runRemoteProjectOperation(f.gateway, 'prompt-session', { ...input, messageID: 'msg_one', text: 'continue' })).rejects.toThrow();
      expect(f.release).toHaveBeenCalledTimes(3);
    } finally { configureServerOpenCodeFetchGate(null); }
  });

  it('lists remote task rows from the Hub index across worktree directories, with targets and partial failures', async () => {
    const f = fixture();
    const row = (id, extra = {}) => ({ id, title: id, time: {}, metadata: { yuri: { titleRefresh: { activityUpdatedAt: 5 }, sessionStatus: { type: 'busy' } } }, ...extra });
    f.gateway.list.mockResolvedValue({ supported: true, hubId: 'hub', hosts: [{ id: 'host', name: 'Build machine' }, { id: 'gone', name: 'Gone' }],
      projects: [{ id: 'p', hostId: 'host', path: '/repo' }, { id: 'q', hostId: 'gone', path: '/x' }] });
    f.gateway.store = { instanceFor: () => 'instance' };
    f.gateway.summaries = vi.fn((id) => {
      if (id === 'gone') throw new Error('private');
      return { stale: false, pinnedSessionIds: ['ses_pin'], directories: [
        { directory: '/repo', sessions: [row('ses_root'), row('ses_child', { parentID: 'ses_root' })] },
        { directory: '/wt/feature', sessions: [row('ses_pin'), row('ses_done', { time: { archived: 9 } })] }] };
    });
    const result = await listRemoteTaskRows(f.gateway);
    expect(result.rows.map((r) => [r.sessionID, r.directory, r.settled, r.pinned])).toEqual([
      ['ses_root', '/repo', false, false], ['ses_pin', '/wt/feature', false, true], ['ses_done', '/wt/feature', true, false]]);
    expect(result.rows[0]).toMatchObject({ status: 'busy', remote: { host: 'Build machine', target } });
    expect(result).toMatchObject({ complete: false, failed: [{ hostId: 'gone', code: 'remote_unavailable' }] });
    expect(JSON.stringify(result)).not.toMatch(/private/);
    f.gateway.summaries.mockReturnValue({ stale: true, directories: [{ directory: '/repo', sessions: [row('ses_root')] }] });
    const stale = await listRemoteTaskRows(f.gateway);
    expect(stale.rows[0].status).toBe('unknown');
    expect(stale.failed).toContainEqual({ hostId: 'host', code: 'remote_stale' });
  });

  it('archives and restores a remote session on the exact target only after verifying its directory', async () => {
    const f = fixture(); const signal = new AbortController().signal;
    f.json.mockImplementation(async (route, init) => ({ session: { id: 'ses_one' }, index: { ok: true }, route, init }));
    expect(validRemoteProjectInput('archive-remote-session', input)).toBe(true);
    expect(validRemoteProjectInput('archive-remote-session', { ...input, sessionID: undefined })).toBe(false);
    expect(validRemoteProjectInput('unarchive-remote-session', { ...input, archivedAt: 1 })).toBe(false);
    const archived = await runRemoteProjectOperation(f.gateway, 'archive-remote-session', input, signal);
    expect(archived).toMatchObject({ session: { sessionID: 'ses_one', directory: '/repo', target }, archived: true, index: { ok: true } });
    expect(archived.archivedAt).toBeGreaterThan(0);
    const [route, init] = f.json.mock.calls[0];
    expect(route).toBe('/api/yuri/sessions/ses_one/archive');
    expect(init).toMatchObject({ method: 'PUT', signal });
    expect(JSON.parse(init.body)).toEqual({ directory: '/repo', archivedAt: archived.archivedAt });
    const restored = await runRemoteProjectOperation(f.gateway, 'unarchive-remote-session', input, signal);
    expect(restored).toMatchObject({ archived: false, archivedAt: 0 });
    expect(JSON.parse(f.json.mock.calls[1][1].body)).toEqual({ directory: '/repo', archivedAt: 0 });
    expect(f.release).toHaveBeenCalledTimes(2);

    f.json.mockClear();
    await expect(runRemoteProjectOperation(f.gateway, 'archive-remote-session', { ...input, directory: '/other' })).rejects.toMatchObject({ code: 'remote_target_mismatch' });
    f.json.mockResolvedValueOnce({ session: { id: 'ses_other' } });
    await expect(runRemoteProjectOperation(f.gateway, 'archive-remote-session', input)).rejects.toMatchObject({ code: 'remote_response_invalid' });
    f.json.mockResolvedValueOnce({ session: { id: 'ses_one' }, index: { ok: false } });
    expect(await runRemoteProjectOperation(f.gateway, 'archive-remote-session', input)).toMatchObject({ index: { ok: false, retryable: true } });
  });
});
