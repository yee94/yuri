import { describe, expect, it, vi } from 'vitest';
import { createSettingsArchiveRestore, createSettingsTransaction, integrationPayload, integrationSettingsPath, readSettingsCollection, scopedSettingsPath, settingsAuthorizationCode, settingsMutation, settingsObject, visibleArchivedSettingsSession } from './settings-protocol';

describe('native settings wire contracts', () => {
  it('keeps archived catalog ownership identical to mobile rather than promoting system sessions', () => {
    expect(visibleArchivedSettingsSession({ time: { archived: 0 } })).toBe(false);
    expect(visibleArchivedSettingsSession({ time: { archived: 1 }, parentID: 'parent' })).toBe(false);
    expect(visibleArchivedSettingsSession({ time: { archived: 1 }, metadata: { yuri: { assistant: { assistantID: 'bot' } } } })).toBe(false);
    expect(visibleArchivedSettingsSession({ time: { archived: 1 }, metadata: { yuri: { assigned: { from: 'contact' }, assistant: { assistantID: 'bot' } } } })).toBe(true);
    expect(visibleArchivedSettingsSession({ time: { archived: 1 }, title: '[Scheduled] hidden' })).toBe(false);
    expect(visibleArchivedSettingsSession({ time: { archived: 1 }, title: 'Real project session' })).toBe(true);
  });
  it('keeps the official integration response envelope and location query', () => {
    expect(integrationSettingsPath('mcp/team', '/connect/key', '/project a')).toBe('/api/integration/mcp%2Fteam/connect/key?location%5Bdirectory%5D=%2Fproject%20a');
    expect(integrationPayload({ data: { attemptID: 'attempt', mode: 'code' } })).toEqual({ attemptID: 'attempt', mode: 'code' });
    expect(() => integrationPayload({ mode: 'code' })).toThrow('Invalid settings response');
    expect(settingsAuthorizationCode('https://auth.example/callback?code=fixture%20code&state=fixture')).toBe('fixture code');
    expect(settingsAuthorizationCode(' raw-code ')).toBe('raw-code');
  });
  it('retains directory and encoded entity identity without an origin or credential', () => {
    expect(settingsMutation('agents', 'team/agent', { description: 'draft', scope: 'project', token: 'must-not-cross', id: 'catalog-only' }, false, '/project a')).toEqual({
      path: '/api/config/agents/team%2Fagent?directory=%2Fproject%20a', method: 'PATCH', body: { native: { description: 'draft' }, scope: 'project' },
    });
    expect(scopedSettingsPath('/api/config/skills?summary=true', '/workspace')).toBe('/api/config/skills?summary=true&directory=%2Fworkspace');
  });
  it('uses domain-specific bodies, not JSON snapshots of server entities', () => {
    expect(settingsMutation('commands', 'review', { template: 'review $ARGUMENTS', model: '', scope: 'user', document: { revision: 3 } }, false).body).toEqual({ template: 'review $ARGUMENTS', model: '' });
    expect(settingsMutation('mcp', 'server', { type: 'local', command: ['npx', '-y', 'a b'], enabled: false, scope: 'user', status: 'connected' }, true).body).toEqual({ type: 'local', command: ['npx', '-y', 'a b'], enabled: false, scope: 'user' });
    expect(settingsMutation('skills.installed', 'native', { description: 'help', instructions: 'body', supportingFiles: { 'ref.md': 'content' }, targetPath: '/chosen', name: 'ignored' }, false)).toMatchObject({ path: '/api/config/skills/native', method: 'PATCH', body: { description: 'help', instructions: 'body', supportingFiles: { 'ref.md': 'content' }, targetPath: '/chosen' } });
  });
  it('preserves plugin options including false and empty nested values', () => {
    expect(settingsMutation('plugins', 'user:1', { spec: 'example@1', options: { enabled: false, values: [] }, scope: 'user', file: true }, false)).toEqual({ path: '/api/config/plugins/entry/user%3A1', method: 'PATCH', body: { spec: 'example@1', options: { enabled: false, values: [] }, scope: 'user' } });
  });
  it('requires a versioned provider catalog rather than interpreting failed reads as empty', async () => {
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ providers: [] }), 'providers')).rejects.toThrow('Invalid provider catalog');
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ schemaVersion: 1, providers: [], ok: false, error: 'denied' }), 'providers')).rejects.toThrow('denied');
    await expect(readSettingsCollection(vi.fn().mockRejectedValue(new Error('network')), 'mcp')).rejects.toThrow('network');
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({}), 'mcp')).rejects.toThrow('Invalid settings collection');
  });
  it('distinguishes an authoritative empty collection from malformed data', async () => {
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ entries: [], files: [] }), 'plugins')).resolves.toEqual([]);
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ entries: [] }), 'plugins')).rejects.toThrow('Invalid settings collection');
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ skills: null }), 'skills.installed')).rejects.toThrow('Invalid settings collection');
    await expect(readSettingsCollection(vi.fn().mockResolvedValue({ skills: [] }), 'skills.installed')).resolves.toEqual([]);
  });
  it('merges authoritative agent metadata without dropping the actual request model', async () => {
    const send = vi.fn().mockResolvedValueOnce([{ id: 'agent1', name: 'review', model: { providerID: 'p', modelID: 'm' }, permissions: [] }]).mockResolvedValueOnce({ agents: { review: { scope: 'project', sources: { document: { revision: 5 } } } } });
    const result = await readSettingsCollection(send, 'agents', '/project');
    expect(send.mock.calls).toEqual([
      ['/api/agent?location%5Bdirectory%5D=%2Fproject'],
      ['/api/config/agents/metadata?directory=%2Fproject', 'POST', { names: ['review'] }],
    ]);
    expect(result[0]).toMatchObject({ scope: 'project', model: { providerID: 'p', modelID: 'm' }, document: { revision: 5 } });
  });
});

describe('settings write lifecycle', () => {
  it('restores through the Host archive authority with directory and validates the returned session', async () => {
    const send = vi.fn().mockResolvedValue({ session: { id: 'session/a', directory: '/work tree', time: { created: 1 }, metadata: { yuri: { archive: { archivedAt: 0 } } } } });
    await createSettingsArchiveRestore(send, () => true)({ id: 'session/a', directory: '/work tree' });
    expect(send.mock.calls).toEqual([['/api/yuri/sessions/session%2Fa/archive', 'PUT', { archivedAt: 0, directory: '/work tree' }]]);
  });
  it('does not report a wrong identity or still archived response as restored', async () => {
    const send = vi.fn().mockResolvedValue({ session: { id: 'other', directory: '/work', time: { archived: 1 } } });
    await expect(createSettingsArchiveRestore(send, () => true)({ id: 'session', directory: '/work' })).rejects.toThrow();
  });
  it('after acknowledged malformed response retries only the authoritative read, never the accepted PUT', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { id: 'session', location: { directory: '/work' }, time: { created: 1 } } });
    const restore = createSettingsArchiveRestore(send, () => true);
    await expect(restore({ id: 'session', location: { directory: '/work' } })).rejects.toThrow('offline');
    await restore({ id: 'session', location: { directory: '/work' } });
    expect(send.mock.calls).toEqual([
      ['/api/yuri/sessions/session/archive', 'PUT', { archivedAt: 0, directory: '/work' }],
      ['/api/session/session?directory=%2Fwork'],
      ['/api/session/session?directory=%2Fwork'],
    ]);
  });
  it('reconciles a lost write response without sending a second restore', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ id: 'session', directory: '/work', time: { archived: 0 } });
    const restore = createSettingsArchiveRestore(send, () => true);
    await expect(restore({ id: 'session', directory: '/work' })).rejects.toThrow('response lost');
    await restore({ id: 'session', directory: '/work' });
    expect(send.mock.calls).toEqual([
      ['/api/yuri/sessions/session/archive', 'PUT', { archivedAt: 0, directory: '/work' }],
      ['/api/session/session?directory=%2Fwork'],
    ]);
  });
  it('allows an explicit retry only after a read authoritatively confirms the session remains archived', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ id: 'session', directory: '/work', time: { archived: 99 } })
      .mockResolvedValueOnce({ session: { id: 'session', directory: '/work', time: { archived: 0 } } });
    const restore = createSettingsArchiveRestore(send, () => true), session = { id: 'session', directory: '/work' };
    await expect(restore(session)).rejects.toThrow('response lost');
    await expect(restore(session)).rejects.toThrow('still archived');
    await restore(session);
    expect(send.mock.calls.map(call => call[1] ?? 'GET')).toEqual(['PUT', 'GET', 'PUT']);
  });
  it.each([
    { id: 'session', directory: '/another', time: { archived: 0 } },
    { id: 'session', directory: '/work', time: { archived: '0' } },
    { id: 'session', directory: '/work', time: { archived: -1 } },
  ])('rejects inconsistent restored authority %j', async response => {
    await expect(createSettingsArchiveRestore(vi.fn().mockResolvedValue({ session: response }), () => true)({ id: 'session', directory: '/work' })).rejects.toThrow();
  });
  it('does not start restore without identity and directory authority', async () => {
    const send = vi.fn(), restore = createSettingsArchiveRestore(send, () => true);
    await expect(restore({ id: 'session' })).rejects.toThrow('identity');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects concurrent restore and a late response after Host retirement', async () => {
    let current = true, resolve!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(done => { resolve = done; }));
    const restore = createSettingsArchiveRestore(send, () => current), session = { id: 'session', directory: '/work' };
    const flight = restore(session);
    await expect(restore(session)).rejects.toThrow('pending');
    current = false; resolve({ session: { ...session, time: { archived: 0 } } });
    await expect(flight).rejects.toThrow('Runtime changed');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not clear or mutate a failed draft, then allows an explicit retry', async () => {
    const draft = { expectedRevision: 7, options: { enabled: true } };
    const send = vi.fn().mockRejectedValueOnce(new Error('HTTP 409')).mockResolvedValueOnce({ revision: 8 });
    const write = createSettingsTransaction(send, () => true);
    await expect(write('/settings', 'PATCH', draft)).rejects.toThrow('HTTP 409');
    expect(draft).toEqual({ expectedRevision: 7, options: { enabled: true } });
    await expect(write('/settings', 'PATCH', draft)).resolves.toEqual({ revision: 8 });
    expect(send).toHaveBeenNthCalledWith(2, '/settings', 'PATCH', draft);
  });
  it('rejects writes after the Host identity changes before sending', async () => {
    const send = vi.fn();
    await expect(createSettingsTransaction(send, () => false)('/settings', 'PUT', {})).rejects.toThrow('Runtime changed');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects stale responses after a Host switch and never issues an automatic retry', async () => {
    let current = true;
    let resolve!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(done => { resolve = done; }));
    const write = createSettingsTransaction(send, () => current);
    const pending = write('/settings', 'PUT', { value: 1 });
    current = false; resolve({ revision: 2 });
    await expect(pending).rejects.toThrow('Runtime changed');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('serializes a page mutation by rejecting a second click while pending', async () => {
    let resolve!: (value: unknown) => void;
    const send = vi.fn(() => new Promise(done => { resolve = done; }));
    const write = createSettingsTransaction(send, () => true);
    const first = write('/settings', 'PUT', {});
    await expect(write('/settings', 'PUT', {})).rejects.toThrow('already pending');
    resolve({ reloadFailed: true });
    await expect(first).resolves.toEqual({ reloadFailed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves manual restart and reload warnings as successful disk commits', async () => {
    const write = createSettingsTransaction(vi.fn().mockResolvedValue({ ok: true, requiresManualRestart: true, warning: 'pending' }), () => true);
    await expect(write('/settings', 'PATCH', {})).resolves.toMatchObject({ requiresManualRestart: true, warning: 'pending' });
    expect(() => settingsObject({ success: false })).toThrow('Settings request failed');
  });
});
