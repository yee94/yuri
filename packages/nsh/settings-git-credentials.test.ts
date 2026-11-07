import { expect, it, vi } from 'vitest';
import { createSettingsGitCredentials, discoveredGitCredentials, unimportedGitCredentials } from './settings-git-credentials-core';

it('imports only profile metadata from the captured host/username, with the Web prefill and required email', async () => {
  const writes: unknown[] = [];
  const request = vi.fn(async (path, method, body) => {
    if (method === 'POST') { writes.push(body); return body; }
    return path.endsWith('/discover-credentials') ? [{ host: 'git.example/team/repo', username: 'synthetic' }] : [];
  });
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-profile' });
  await c.setActive(true); c.begin(c.state().credentials.value![0]);
  expect(c.state().draft).toMatchObject({ host: 'git.example/team/repo', userName: 'synthetic', name: 'repo', userEmail: '', authType: 'token', color: 'string', icon: 'code' });
  await c.save(); expect(writes).toEqual([]); expect(c.state().issue).toBe('required');
  c.edit('userEmail', 'synthetic@example.invalid'); await c.save();
  expect(writes).toEqual([{ id: 'synthetic-profile', host: 'git.example/team/repo', userName: 'synthetic', userEmail: 'synthetic@example.invalid', name: 'repo', authType: 'token', sshKey: null, signCommits: false, signingKey: null, color: 'string', icon: 'code' }]);
  c.dispose();
});

it('preserves each independent resource on failure and does not offer an unknown profile catalog as empty', async () => {
  let failProfiles = true, failCredentials = false;
  const request = vi.fn(async path => {
    if (path.endsWith('/identities')) { if (failProfiles) throw new Error('offline'); return []; }
    if (failCredentials) throw new Error('offline');
    return [{ host: 'git.example', username: 'synthetic' }];
  });
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-profile' });
  await c.setActive(true); expect(c.state().profiles.value).toBeNull(); expect(c.candidates()).toEqual([]);
  failProfiles = false; await c.refresh(); const prior = c.state().credentials.value;
  failCredentials = true; await c.refresh(); expect(c.state().credentials.value).toBe(prior); expect(c.state().credentials.failed).toBe(true);
  c.begin(prior![0]); expect(c.state().draft).toBeNull(); c.dispose();
});

it('uses source pairs for row identity but matches the Web host-only token import suppression', () => {
  const list = discoveredGitCredentials([{ host: 'git.example/a/b', username: 'one' }, { host: 'git.example/a/b', username: 'two' }, { host: 'git.example/a/b', username: 'one' }, { host: 'git.example', username: 'one' }]);
  expect(list).toHaveLength(3);
  expect(unimportedGitCredentials(list, [{ id: 'p', authType: 'token', host: 'git.example/a/b' }])).toEqual([{ host: 'git.example', username: 'one' }]);
  expect(unimportedGitCredentials(list, [{ id: 'p', authType: 'ssh', host: 'git.example/a/b' }])).toEqual(list);
  expect(() => discoveredGitCredentials({})).toThrow();
});

it('never replays an unknown import and reconciles only the stable exact id and full imported metadata', async () => {
  let profiles: unknown[] = [];
  const request = vi.fn(async (path, method, body) => {
    if (method === 'POST') { profiles = [body]; throw new Error('lost ACK'); }
    return path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : profiles;
  });
  const onSaved = vi.fn();
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-profile', onSaved });
  await c.setActive(true); c.begin(c.candidates()[0]); c.edit('userEmail', 'synthetic@example.invalid'); await c.save();
  expect(c.state().issue).toBe('unknown'); expect(c.state().pending?.id).toBe('synthetic-profile');
  await c.save(); c.cancel(); expect(c.state().pending).not.toBeNull();
  profiles = [{ ...(profiles[0] as object), id: 'different-id' }]; await c.refresh(); expect(c.state().pending).not.toBeNull(); expect(onSaved).not.toHaveBeenCalled();
  profiles = [{ ...c.state().pending }]; await c.refresh(); expect(c.state().pending).toBeNull(); expect(c.state().draft).toBeNull(); expect(onSaved).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1); c.dispose();
});

it('does not replay an ACKed import when refresh fails; cancellation writes nothing', async () => {
  let fail = false;
  const request = vi.fn(async (path, method, body) => {
    if (method === 'POST') { fail = true; return body; }
    if (fail) throw new Error('refresh failed');
    return path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : [];
  });
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-profile' });
  await c.setActive(true); c.begin(c.candidates()[0]); c.cancel(); expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
  c.begin(c.candidates()[0]); c.edit('userEmail', 'synthetic@example.invalid'); await c.save(); await c.save();
  expect(c.state().saved).toBe(true); expect(c.state().issue).toBe('read'); expect(c.state().pending).toBeNull(); expect(c.state().draft).toBeNull();
  expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1); c.dispose();
});

it('does no discovery while inactive or after Host generation invalidation', async () => {
  let current = true;
  const request = vi.fn(async () => []); const changed = vi.fn();
  const c = createSettingsGitCredentials({ request, current: () => current, id: () => 'synthetic-profile', changed });
  await c.refresh(); expect(request).not.toHaveBeenCalled();
  await c.setActive(true); await c.setActive(false); const count = request.mock.calls.length;
  await c.refresh(); expect(request).toHaveBeenCalledTimes(count);
  current = false; await c.setActive(true); expect(request).toHaveBeenCalledTimes(count); c.dispose();
});

it('retains the complete Web import editor semantics: editable auth, appearance, signing and normalized metadata', async () => {
  const request = vi.fn(async (path, method, body) => method === 'POST' ? body : path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : []);
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-profile' });
  await c.setActive(true); c.begin(c.candidates()[0]);
  c.edit('userEmail', ' synthetic@example.invalid '); c.edit('authType', 'ssh'); c.edit('sshKey', ' ~/.ssh/fixture '); c.edit('color', 'function'); c.edit('icon', 'briefcase'); c.setSignCommits(true);
  await c.save(); expect(c.state().issue).toBe('signing'); expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  c.edit('signingKey', ' synthetic-signing-key '); await c.save();
  expect(request.mock.calls.find(([, method]) => method === 'POST')?.[2]).toMatchObject({ authType: 'ssh', host: null, sshKey: '~/.ssh/fixture', color: 'function', icon: 'briefcase', signCommits: true, signingKey: 'synthetic-signing-key', userEmail: 'synthetic@example.invalid' });
  c.dispose();
});

it('requires a fresh inspection and explicit abandonment to leave an unresolved import, without retrying its write', async () => {
  const request = vi.fn(async (path, method) => {
    if (method === 'POST') throw new Error('unknown');
    return path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : [];
  });
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-import' });
  await c.setActive(true); c.begin(c.candidates()[0]); c.edit('userEmail', 'synthetic@example.invalid'); await c.save(); c.acknowledgeUnknown();
  expect(c.state().pending).not.toBeNull(); await c.refresh(); expect(c.state().pending).not.toBeNull(); c.acknowledgeUnknown();
  expect(c.state().pending).toBeNull(); expect(c.state().draft).toBeNull(); expect(c.state().saved).toBe(false);
  expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1); c.dispose();
});

it('does not reclassify an acknowledged import as unknown when parent navigation throws', async () => {
  let profiles: unknown[] = [];
  const request = vi.fn(async (path, method, body) => {
    if (method === 'POST') { profiles = [body]; return body; }
    return path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : profiles;
  });
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-import', onSaved: () => { throw new Error('parent failure'); } });
  await c.setActive(true); c.begin(c.candidates()[0]); c.edit('userEmail', 'synthetic@example.invalid'); await c.save(); await c.save();
  expect(c.state().pending).toBeNull(); expect(c.state().saved).toBe(true); expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1); c.dispose();
});

it('rejects malformed or ambiguous profile snapshots rather than treating them as unimported credentials', async () => {
  let profiles: unknown[] = [];
  const request = vi.fn(async path => path.endsWith('/discover-credentials') ? [{ host: 'git.example', username: 'synthetic' }] : profiles);
  const c = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-import' });
  await c.setActive(true); const previous = c.state().profiles.value;
  for (const invalid of [[{ id: 'p', host: 1, authType: 'token' }], [{ id: 'p' }, { id: 'p' }]]) {
    profiles = invalid; await c.refresh(); expect(c.state().profiles.failed).toBe(true); expect(c.state().profiles.value).toBe(previous);
    c.begin(c.candidates()[0]); expect(c.state().draft).toBeNull();
  }
  c.dispose();
});
