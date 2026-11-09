import { expect, open, test } from 'nsh/test';

for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' unselected project is normal readonly Composer, zero durable/writer IO until explicit project and canonical ACK', async () => {
    const app = await open('./App.tsx', { platform, width: 1300, height: 1100 });
    await app.waitFor('id:new-session-writer-waiting'); await app.press('id:writer-unbound'); await app.waitFor('id:new-session-choose-project');
    expect(app.shows('id:new-session-composer')).toBe(true); expect(app.enabled('id:new-session-composer')).toBe(false); expect(app.enabled('id:send')).toBe(false);
    expect(app.texts()).toContain('Choose a project first'); expect(app.texts()).not.toContain('Unavailable');
    expect(Object.keys(app.storage()).filter(key => key.startsWith('nsh:chat-draft:') || key.startsWith('nsh:new-session:'))).toHaveLength(0);
    await app.press('id:writer-request-guard'); await app.waitFor('text:guard-result:prepare:true:final:true');
    await app.press('id:writer-release-guard'); await app.waitFor('text:guard-result:release:true');
    await app.press('id:writer-cancel-guard');
    await app.press('id:writer-audit'); await app.waitFor('text:control:audit');
    const audit = () => JSON.parse((app.texts().find(value => value.startsWith('audit=')) ?? 'audit={}').slice(6));
    expect(audit().names).toHaveLength(0); expect(audit().held).toHaveLength(0);
    await app.press('id:new-session-project'); await app.waitFor('id:new-session-project-fixture-project'); await app.press('id:new-session-project-fixture-project');
    await app.waitFor('id:new-session-writer-waiting'); expect(app.shows('id:new-session-composer')).toBe(false); expect(audit().names).toHaveLength(0);
    await app.press('id:writer-load'); await app.waitFor('id:new-session-composer'); expect(app.enabled('id:new-session-composer')).toBe(true);
    expect(audit().held).toHaveLength(1); expect(audit().held[0].id).toBe('/fixture/project'); expect(audit().names.filter((name: string) => name === 'acquire')).toHaveLength(1);
  });
  async function launch(mode?: string) {
    const app = await open('./App.tsx', { platform, width: 1300, height: 1100 });
    const audit = () => JSON.parse((app.texts().find(value => value.startsWith('audit=')) ?? 'audit={}').slice(6)) as { names: string[]; held: Array<{ kind: string; id: string; ownerID: string }>; creates: number; prompts: number };
    await app.waitFor('id:new-session-writer-waiting');
    expect(app.shows('id:new-session-composer')).toBe(false);
    if (mode) { await app.press('id:writer-' + mode); await app.waitFor('text:control:' + mode); }
    await app.press('id:writer-load');
    await app.waitFor(mode === 'no-capability' ? 'text:client:unavailable' : 'text:client:ready');
    return { app, audit };
  }
  test(platform + ' canonical admission before editor, 50 inputs zero capability reads, temporary modal preserves owner, exact session handoff', async () => {
    const f = await launch(); await f.app.waitFor('id:new-session-composer');
    const initial = f.audit().names.length, original = f.audit().held[0].ownerID;
    expect(f.app.texts()).toContain('guards:source'); expect(f.app.texts()).toContain('guard-events:waiting+,source+,waiting-');
    for (let i = 0; i < 50; i++) await f.app.type('id:new-session-composer', 'x');
    expect(f.audit().names).toHaveLength(initial); expect(f.audit().names.filter(name => name === 'capabilities')).toHaveLength(1);
    expect(f.app.texts()).toContain('observer-calls:1'); expect(f.app.texts()).toContain('guards:source');
    await f.app.press('id:writer-cover'); expect(f.app.enabled('id:new-session-composer')).toBe(false);
    await f.app.press('id:writer-cover'); expect(f.app.value('id:new-session-composer')).toBe('x'.repeat(50)); expect(f.audit().held[0].ownerID).toBe(original);
    await f.app.setLifecycle('background'); await f.app.setLifecycle('active');
    expect(f.app.value('id:new-session-composer')).toBe('x'.repeat(50)); expect(f.audit().held[0].ownerID).toBe(original);
    await f.app.press('id:new-session-project'); await f.app.waitFor('id:new-session-directory');
    await f.app.type('id:new-session-directory', '/symlink'); await f.app.press('id:new-session-directory-choose'); await f.app.waitFor('id:new-session-directory', { state: 'gone' });
    expect(f.app.value('id:new-session-composer')).toBe('x'.repeat(50)); expect(f.audit().held[0].ownerID).toBe(original); expect(f.audit().names).toHaveLength(initial);
    await f.app.press('id:send'); await f.app.waitFor('text:complete');
    expect(f.audit().creates).toBe(1); expect(f.audit().prompts).toBe(1); expect(f.audit().held).toHaveLength(1); expect(f.audit().held[0].kind).toBe('session');
    expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(2); expect(f.audit().names.filter(name => name === 'release')).toHaveLength(1);
  });
  test(platform + ' missing native capability never admits the initial draft', async () => {
    const f = await launch('no-capability'); expect(f.app.shows('id:new-session-composer')).toBe(false);
    expect(f.audit().held).toHaveLength(0); expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(0);
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:true:final:true');
    await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:true');
    expect(f.app.texts()).toContain('guards:waiting'); expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
  });
  test(platform + ' canonical resolve pending vetoes navigation/native close and guard release, source registration takes over without a gap', async () => {
    const f = await launch('hold-resolve'); expect(f.app.texts()).toContain('guards:waiting');
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:false:final:false');
    await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:false');
    expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(0);
    await f.app.press('id:writer-release-resolve'); await f.app.waitFor('id:new-session-composer');
    expect(f.app.texts()).toContain('guards:source'); expect(f.app.texts()).toContain('guard-events:waiting+,source+,waiting-');
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:true:final:true');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
    await f.app.press('id:writer-cancel-guard'); await f.app.type('id:new-session-composer', 'same source after veto/cancel');
    expect(f.app.value('id:new-session-composer')).toBe('same source after veto/cancel');
  });
  test(platform + ' pending acquire keeps one waiting guard across same-Host modal, vetoes close/release then becomes exactly one source guard', async () => {
    const f = await launch('hold-acquire'); expect(f.app.texts()).toContain('guards:waiting');
    await f.app.waitUntil(() => f.audit().held.length === 1);
    const held = f.audit().held[0].ownerID;
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:false:final:false');
    await f.app.press('id:new-session-project'); await f.app.waitFor('id:new-session-project-fixture-project');
    await f.app.press('id:new-session-project-fixture-project'); await f.app.waitFor('id:new-session-directory', { state: 'gone' });
    expect(f.app.texts()).toContain('guards:waiting'); expect(f.app.texts()).toContain('observer-calls:1');
    await f.app.press('id:writer-cover'); await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:false');
    expect(f.app.texts()).toContain('guards:waiting'); expect(f.app.texts()).toContain('observer-calls:1');
    await f.app.press('id:writer-cover'); await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:false:final:false');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
    await f.app.press('id:writer-release-acquire'); await f.app.waitFor('id:new-session-composer');
    expect(f.app.texts()).toContain('guards:source'); expect(f.app.texts()).toContain('guard-events:waiting+,source+,waiting-');
    expect(f.audit().held[0].ownerID).toBe(held); expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(1);
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:true:final:true');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
  });
  test(platform + ' failed canonical read leaves no authority and permits guarded departure with zero claim/release', async () => {
    const f = await launch('fail-resolve'); await f.app.waitFor('text:Unavailable');
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:true:final:true');
    await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:true');
    expect(f.audit().names.filter(name => name === 'acquire' || name === 'release')).toHaveLength(0);
    await f.app.press('id:writer-retire'); await f.app.waitFor('text:guards:');
  });
  test(platform + ' explicit release ACK keeps durable alive until route removal, then one local close without another release', async () => {
    const f = await launch(); await f.app.waitFor('id:new-session-composer'); await f.app.type('id:new-session-composer', 'retain until commit');
    await f.app.press('id:writer-release-source'); await f.app.waitFor('text:control:source-release:true:owned:true');
    expect(f.app.value('id:new-session-composer')).toBe('retain until commit'); expect(f.app.texts()).toContain('durable-closes:0');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(1);
    await f.app.press('id:writer-retire'); await f.app.waitFor('text:durable-closes:1');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(1);
  });
  test(platform + ' unknown explicit release never closes durable or automatically reissues release on route cleanup', async () => {
    const f = await launch('lose-release'); await f.app.waitFor('id:new-session-composer'); await f.app.type('id:new-session-composer', 'retain unknown release');
    await f.app.press('id:writer-release-source'); await f.app.waitFor('text:control:source-release:false:owned:true');
    expect(f.app.value('id:new-session-composer')).toBe('retain unknown release'); expect(f.app.texts()).toContain('durable-closes:0');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(1);
    await f.app.press('id:writer-release-source'); await f.app.press('id:writer-retire'); await f.app.press('id:writer-audit'); await f.app.waitFor('text:control:audit');
    expect(f.app.texts()).toContain('durable-closes:0'); expect(f.audit().names.filter(name => name === 'release')).toHaveLength(1);
  });
  test(platform + ' real producer peer conflict stays readonly and never adopts peer owner', async () => {
    const f = await launch('conflict'); await f.app.waitFor('text:Unavailable');
    expect(f.app.shows('id:new-session-composer')).toBe(false); expect(f.audit().held).toHaveLength(1); expect(f.audit().held[0].ownerID).toBe('synthetic-peer-owner');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:true:final:true');
    await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:true');
    expect(f.audit().held[0].ownerID).toBe('synthetic-peer-owner');
  });
  test(platform + ' source acquire unknown never exposes editor or automatically releases/reclaims', async () => {
    const f = await launch('lose-acquire'); await f.app.waitFor('text:Unavailable');
    expect(f.app.shows('id:new-session-composer')).toBe(false); expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(1);
    await f.app.press('id:writer-request-guard'); await f.app.waitFor('text:guard-result:prepare:false:final:false');
    await f.app.press('id:writer-release-guard'); await f.app.waitFor('text:guard-result:release:false');
    await f.app.press('id:new-session-project'); await f.app.waitFor('id:new-session-project-fixture-project');
    await f.app.press('id:new-session-project-fixture-project'); await f.app.waitFor('id:new-session-directory', { state: 'gone' });
    expect(f.app.texts()).toContain('guards:waiting'); expect(f.app.texts()).toContain('observer-calls:1');
    await f.app.press('id:writer-retire'); await f.app.press('id:writer-audit'); await f.app.waitFor('text:control:audit');
    expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0); expect(f.audit().held).toHaveLength(1);
  });
  test(platform + ' late acquire after owner retirement settles original ACK, zero draft restore and one safe release', async () => {
    const f = await launch('hold-acquire'); expect(f.app.shows('id:new-session-composer')).toBe(false);
    await f.app.press('id:writer-retire'); await f.app.press('id:writer-release-acquire'); await f.app.waitFor('text:control:release-acquire');
    await f.app.waitUntil(() => f.audit().names.filter(name => name === 'release').length === 1);
    expect(f.app.shows('id:new-session-composer')).toBe(false); expect(f.audit().held).toHaveLength(0);
  });
  test(platform + ' session transfer acquire unknown retains created input and makes zero second create', async () => {
    const f = await launch('lose-session'); await f.app.waitFor('id:new-session-composer'); await f.app.type('id:new-session-composer', 'retain transfer');
    await f.app.press('id:send'); await f.app.waitFor('id:new-session-error');
    expect(f.audit().creates).toBe(1); expect(f.audit().prompts).toBe(0); expect(f.audit().held).toHaveLength(2);
    await f.app.press('id:writer-retire'); await f.app.press('id:writer-audit'); await f.app.waitFor('text:control:audit');
    expect(f.audit().creates).toBe(1); expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
  });
  test(platform + ' unknown create retains stable snapshot and never releases or claims a guessed session', async () => {
    const f = await launch('lose-create'); await f.app.waitFor('id:new-session-composer'); await f.app.type('id:new-session-composer', 'retain unknown');
    await f.app.press('id:send'); await f.app.waitFor('id:new-session-create-unknown');
    expect(f.audit().creates).toBe(1); expect(f.audit().names.filter(name => name === 'acquire')).toHaveLength(1);
    await f.app.press('id:writer-retire'); await f.app.press('id:writer-audit'); await f.app.waitFor('text:control:audit');
    expect(f.audit().creates).toBe(1); expect(f.audit().names.filter(name => name === 'release')).toHaveLength(0);
  });
}

test('iOS old editor path ignores desktop getter and root load button: zero writer/capability calls', async () => {
  const app = await open('./App.tsx', { platform: 'ios', width: 390, height: 844 });
  await app.waitFor('id:new-session-composer'); await app.type('id:new-session-composer', 'iOS draft'); await app.press('id:writer-load');
  await app.press('id:writer-audit'); await app.waitFor('text:control:audit');
  const audit = JSON.parse((app.texts().find(value => value.startsWith('audit=')) ?? 'audit={}').slice(6));
  expect(audit.names).toHaveLength(0); expect(audit.held).toHaveLength(0); expect(app.value('id:new-session-composer')).toBe('iOS draft');
  expect(app.texts()).toContain('observer-calls:0'); expect(app.texts()).toContain('guards:');
});
