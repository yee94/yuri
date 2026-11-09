import { expect, open, test } from 'nsh/test';

async function launch(platform) {
  const audit = { status: 0, diff: 0, posts: 0, previews: [] };
  const app = await open('./App.tsx', { platform, width: 1000, height: 900, host: { handlers: {
    'connection.list': () => ({ selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', label: 'Fixture', url: 'https://fixture.example.invalid', lastUsedAt: 1 }] }),
    'runtime.request': async input => {
      if (input.expectedHost?.hostID !== 'fixture' || input.expectedHost?.lease !== 'fixture-lease') throw new Error('Unexpected authority');
      if (input.path === '/api/git/status?directory=%2Ffixture' && input.method === 'GET') {
        audit.status++;
        return { status: 200, body: { isClean: false, current: 'RETAINED_BRANCH', files: [{ path: 'folder/a.ts', index: 'M', working_dir: ' ' }] } };
      }
      if (input.path === '/api/git/diff?directory=%2Ffixture&path=folder%2Fa.ts&staged=false' && input.method === 'GET') {
        audit.diff++; return { status: 200, body: { diff: '@@ -1 +1 @@\n-old\n+WORKSPACE_ONLY\n' } };
      }
      if (input.path === '/api/git/commit?directory=%2Ffixture' && input.method === 'POST') {
        if (input.body.message !== 'Protected draft' || input.body.files.join(',') !== 'folder/a.ts' || input.body.stageFiles.length) throw new Error('Unsafe commit DTO');
        audit.posts++; throw new Error('Synthetic unknown write receipt');
      }
      throw new Error('Unexpected request: ' + input.method + ' ' + input.path);
    },
    'changes.presentation.preview': value => { audit.previews.push(value); },
  } } });
  await app.waitFor('text:PRESENTATION_READY');
  return { app, audit, control: action => app.host.send('changes.presentation.control', { action }) };
}
for (const platform of ['macos', 'windows', 'ios'] as const) {
  test(platform + ' nullable source close/reopen and fresh source references retain draft; source/Host/route cannot bypass guard', async () => {
    const f = await launch(platform);
    await f.control('workspace'); await f.app.waitUntil(() => f.app.enabled('id:changes-commit-message'));
    await f.app.type('id:changes-commit-message', 'Protected draft');
    await f.app.press('id:changes-view-mode'); expect(f.app.shows('text:folder/a.ts')).toBe(true);
    expect(f.app.shows('text:guard:false;blocked:0;loader:0')).toBe(true);
    const reads = f.audit.status;
    for (let index = 0; index < 50; index++) await f.app.type('id:presentation-composer', 'x');
    expect(f.audit.status).toBe(reads); expect(f.audit.diff).toBe(0); expect(f.audit.posts).toBe(0);
    expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    await f.control('close'); await f.app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await f.app.wait(50); expect(f.audit.status).toBe(reads);
    await f.control('workspace'); await f.app.waitUntil(() => f.app.enabled('id:changes-commit'));
    expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    expect(f.app.shows('text:folder/a.ts')).toBe(true);
    await f.control('pause'); await f.app.waitFor('id:native-changes-sheet', { state: 'gone' });
    const paused = f.audit.status; await f.app.wait(50); expect(f.audit.status).toBe(paused);
    await f.control('resume'); await f.control('workspace'); await f.app.waitUntil(() => f.app.enabled('id:changes-commit'));
    expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    await f.control('different'); await f.app.waitFor('id:native-changes-sheet', { state: 'gone' });
    expect(f.app.shows('text:guard:false;blocked:1;loader:0')).toBe(true);
    await f.control('workspace'); await f.app.waitUntil(() => f.app.enabled('id:changes-commit'));
    expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    await f.control('path'); await f.app.waitFor('text:WORKSPACE_ONLY');
    const navigationReads = [f.audit.status, f.audit.diff]; await f.control('line');
    expect([f.audit.status, f.audit.diff]).toEqual(navigationReads);
    await f.app.press('id:changes-back'); expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    const retired = f.audit.status; await f.control('host'); await f.app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await f.control('retire'); await f.app.wait(50);
    expect(f.audit.status).toBe(retired); expect(f.app.shows('text:guard:false;blocked:2;loader:0')).toBe(true);
  });
  test(platform + ' unknown commit survives null/reopen, cannot replay or clear draft on read recovery', async () => {
    const f = await launch(platform); await f.control('workspace'); await f.app.waitUntil(() => f.app.enabled('id:changes-commit-message'));
    await f.app.type('id:changes-commit-message', 'Protected draft'); await f.app.press('id:changes-commit');
    await f.app.waitUntil(() => f.audit.posts === 1);
    await f.control('close'); await f.app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await f.control('workspace'); await f.app.waitFor('id:changes-write-unknown');
    expect(f.app.value('id:changes-commit-message')).toBe('Protected draft'); expect(f.app.enabled('id:changes-commit')).toBe(false);
    const reads = f.audit.status; await f.app.wait(80);
    expect(f.audit.status).toBe(reads); expect(f.audit.posts).toBe(1); expect(f.app.value('id:changes-commit-message')).toBe('Protected draft');
    await f.control('different'); expect(f.app.shows('text:guard:false;blocked:1;loader:0')).toBe(true);
    await f.control('workspace'); await f.app.waitFor('id:changes-write-unknown'); expect(f.audit.posts).toBe(1);
    await f.app.clear('id:changes-commit-message');
    await f.control('history'); expect(f.app.shows('text:guard:false;blocked:2;loader:0')).toBe(true);
    await f.control('workspace'); await f.app.waitFor('id:changes-write-unknown');
    expect(f.app.value('id:changes-commit-message')).toBe(''); expect(f.app.enabled('id:changes-sync')).toBe(false); expect(f.audit.posts).toBe(1);
  });
  test(platform + ' different historical identity cancels delayed loader without borrowing workspace or current Git', async () => {
    const f = await launch(platform); await f.control('held'); await f.app.waitFor('text:guard:true;blocked:0;loader:1');
    await f.control('history'); await f.app.waitFor('text:HISTORY_exact');
    await f.control('release'); await f.app.wait(60);
    expect(f.app.shows('text:HISTORY_held')).toBe(false); expect(f.audit.status).toBe(0); expect(f.audit.diff).toBe(0); expect(f.audit.posts).toBe(0);
    await f.control('history'); expect(f.app.shows('text:guard:true;blocked:0;loader:2')).toBe(true);
    await f.app.press('id:changes-open-preview');
    expect(f.audit.previews).toHaveLength(1); expect(f.audit.previews[0].directory).toBe('/fixture'); expect(f.audit.previews[0].kind).toBe('turn');
  });
}
