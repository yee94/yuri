import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App): Promise<Array<{ path: string; method: string }>> {
  const previous = app.texts().find(value => value.startsWith('audit:'));
  await app.press('id:fixture-assistants-audit');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('audit:[') && value !== previous));
  return JSON.parse(app.texts().find(value => value.startsWith('audit:['))!.slice(6));
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} headless: desktop contacts select an inline conversation, not mobile navigation`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.shows('text:changes:0:')).toBe(true);
    await app.press('id:desktop-assistant-a');
    expect(app.shows('text:changes:0:')).toBe(true);
    expect(app.shows('id:assistant-toggle-search')).toBe(false);
    expect(app.shows('id:assistant-swipe-delete-a')).toBe(false);
    expect(app.shows('text:Authoritative latest reply')).toBe(true);
    expect(app.enabled('id:desktop-assistant-mini-chat')).toBe(false);
    await app.press('id:desktop-assistant-b');
    await app.waitFor('id:desktop-assistant-conversation-b');
    expect(app.shows('text:owners:2:1')).toBe(true);
    expect(app.shows('text:unexpected-mobile-navigation')).toBe(false);
    await app.press('id:desktop-assistant-settings'); await app.waitFor('text:edit:b');
    await app.press('id:desktop-assistant-create'); await app.waitFor('text:create');
    expect(app.shows('text:changes:1:current')).toBe(true);
    await app.setViewport(640, 480);
    expect(app.shows('id:desktop-assistants-contacts')).toBe(true);
    expect(app.shows('id:desktop-assistant-conversation-b')).toBe(true);
    expect(app.shows('text:owners:2:1')).toBe(true);
  });
  // NSH 0.4 headless keyboard.rs::tabs_to_views only supports macOS/Web;
  // do not install production key bindings to imitate missing Win32 test dispatch.
  (platform === 'macos' ? test : test.skip)(`${platform} headless: native semantic controls admit Tab/Return without custom key ownership`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-a');
    await app.keyboard.press('tab');
    await app.keyboard.press('tab');
    await app.keyboard.press('enter');
    await app.waitFor('text:create');
    expect((await audit(app)).some(row => row.method === 'POST' || row.method === 'PATCH' || row.method === 'DELETE')).toBe(false);
  });
  test(`${platform} headless: one retained owner survives snapshot/50 draft keystrokes/20 modal toggles`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    const before = await audit(app);
    await app.type('id:fixture-assistant-draft', 'x'.repeat(50));
    const draft = app.value('id:fixture-assistant-draft');
    for (let i = 0; i < 20; i++) {
      await app.press('id:fixture-assistants-modal');
      expect(app.shows('text:owners:1:0')).toBe(true);
      expect(app.value('id:fixture-assistant-draft')).toBe(draft);
      expect(app.shows('id:desktop-assistant-a')).toBe(true);
    }
    const after = await audit(app);
    expect(app.shows('text:changes:0:')).toBe(true);
    expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:fixture-assistants-refresh'); await app.wait(200);
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.value('id:fixture-assistant-draft')).toBe(draft);
    await app.press('id:fixture-assistants-modal');
    expect(app.enabled('id:desktop-assistant-create')).toBe(false);
    await app.rightClick('id:desktop-assistant-a'); expect(app.shows('role:menuitem[Pin]')).toBe(false);
    await app.press('id:fixture-assistants-modal');
    await app.type('id:fixture-assistant-draft', ' restored');
    expect(app.value('id:fixture-assistant-draft')).toBe(draft + ' restored');
  });
  test(`${platform} actual AssistantHome: veto/unknown preserve selection and draft, late commits cannot take over`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    await app.type('id:fixture-assistant-draft', 'retained draft');
    const before = await audit(app);
    await app.press('id:fixture-admission-veto'); await app.press('id:desktop-assistant-b');
    await app.waitFor('text:changes:1:current');
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.value('id:fixture-assistant-draft')).toBe('retained draft');
    await app.press('id:fixture-admission-late');
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
    await app.press('id:fixture-admission-unknown'); await app.press('id:desktop-assistant-b');
    await app.waitFor('text:synthetic_writer_unknown');
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
    expect(app.shows('id:desktop-assistant-b')).toBe(true);
    expect(app.value('id:fixture-assistant-draft')).toBe('retained draft');
    const after = await audit(app);
    expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:fixture-admission-allow'); await app.press('id:desktop-assistant-b');
    await app.waitFor('id:desktop-assistant-conversation-b');
    expect(app.shows('text:owners:2:1')).toBe(true);
  });
  for (const retirement of ['remove-b', 'remove-restore-b', 'host', 'reselect', 'supersede', 'modal'] as const) {
    test(`${platform} actual AssistantHome: held change rejects ${retirement} and stale/late commit`, async () => {
      const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
      await app.waitFor('id:desktop-assistant-conversation-a');
      await app.type('id:fixture-assistant-draft', 'held draft');
      await app.press('id:fixture-admission-hold'); await app.press('id:desktop-assistant-b');
      await app.waitFor('text:changes:1:');
      if (retirement === 'remove-b' || retirement === 'remove-restore-b') {
        await app.press('id:fixture-assistants-remove-b');
        await app.waitUntil(() => !app.shows('id:desktop-assistant-b'));
        if (retirement === 'remove-restore-b') { await app.press('id:fixture-assistants-restore-b'); await app.waitFor('id:desktop-assistant-b'); }
      } else if (retirement === 'host') await app.press('id:fixture-admission-host');
      else if (retirement === 'reselect') await app.press('id:desktop-assistant-a');
      else if (retirement === 'supersede') await app.press('id:desktop-assistant-c');
      else { await app.press('id:fixture-assistants-modal'); await app.press('id:fixture-assistants-modal'); }
      await app.press('id:fixture-admission-resolve'); await app.waitFor('text:changes:1:stale');
      await app.press('id:fixture-admission-late');
      expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
      expect(app.value('id:fixture-assistant-draft')).toBe('held draft');
      expect(app.shows('text:owners:1:0')).toBe(true);
      if (retirement !== 'host') {
        await app.press('id:fixture-admission-allow'); await app.press('id:desktop-assistant-a');
        expect(app.shows('text:changes:1:stale')).toBe(true);
        await app.press('id:desktop-assistant-c'); await app.waitFor('id:desktop-assistant-conversation-c');
        expect(app.shows('text:owners:2:1')).toBe(true);
      }
    });
  }
  test(`${platform} actual AssistantHome: selected delete guards local destruction and retries ACK without repeating DELETE or confirmation`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    await app.type('id:fixture-assistant-draft', 'delete retained');
    let confirmations = 0;
    app.onDialog(() => { confirmations++; return 'Delete'; });
    await app.rightClick('id:desktop-assistant-a'); await app.press('role:menuitem[Delete]');
    await app.waitFor('text:HTTP 503: synthetic_delete_failed');
    expect(app.shows('text:changes:0:')).toBe(true);
    await app.press('id:fixture-admission-veto');
    await app.rightClick('id:desktop-assistant-a'); await app.press('role:menuitem[Delete]');
    await app.waitFor('text:changes:1:current');
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
    expect(app.value('id:fixture-assistant-draft')).toBe('delete retained');
    expect(app.shows('id:desktop-assistant-b')).toBe(true);
    expect(app.shows('id:desktop-assistant-c')).toBe(true);
    expect(app.shows('id:desktop-assistant-a')).toBe(false);
    expect(app.enabled('id:fixture-assistant-draft')).toBe(false);
    const before = await audit(app), confirmed = confirmations;
    await app.press('id:fixture-admission-allow');
    await app.press('id:desktop-assistants-retry');
    await app.waitFor('text:owners:1:1');
    expect(app.shows('id:desktop-assistant-conversation-b')).toBe(false);
    const after = await audit(app);
    expect(after.filter(row => row.method === 'DELETE').length).toBe(before.filter(row => row.method === 'DELETE').length);
    expect(confirmations).toBe(confirmed);
    expect(app.shows('text:released:1:mutations:0')).toBe(true);
    await app.press('id:desktop-assistant-b'); await app.waitFor('id:desktop-assistant-conversation-b');
    expect(app.shows('text:owners:2:1')).toBe(true);
  });
  for (const boundary of ['remove-a', 'disabled', 'move-a'] as const) {
    for (const decision of ['hold', 'veto', 'unknown'] as const) {
      test(`${platform} actual AssistantHome: ${boundary}/${decision} retains exact readonly owner until approved release`, async () => {
        const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
        await app.waitFor('id:desktop-assistant-conversation-a');
        await app.type('id:fixture-assistant-draft', 'authority retired draft');
        await app.press(`id:fixture-admission-${decision}`);
        await app.press(`id:fixture-assistants-${boundary}`);
        await app.waitFor('text:admission:false:false');
        await app.waitUntil(() => app.texts().some(value => value.startsWith('changes:1:')));
        expect(app.shows('text:owners:1:0')).toBe(true);
        expect(app.shows('text:scope:/workspace')).toBe(true);
        expect(app.value('id:fixture-assistant-draft')).toBe('authority retired draft');
        expect(app.enabled('id:fixture-assistant-draft')).toBe(false);
        expect(app.enabled('id:desktop-assistant-settings')).toBe(false);
        expect(app.shows('id:desktop-assistant-b')).toBe(true);
        expect(app.shows('id:desktop-assistant-c')).toBe(true);
        expect(app.shows('id:desktop-assistants-retry')).toBe(true);
        await app.press('id:fixture-admission-mutate');
        expect(app.shows('text:released:0:mutations:0')).toBe(true);
        const before = await audit(app);
        expect(before.some(row => row.method === 'POST' || row.method === 'PATCH' || row.method === 'DELETE')).toBe(false);
        if (decision === 'hold') {
          await app.press('id:fixture-admission-resolve');
        } else {
          if (decision === 'unknown') await app.waitFor('text:synthetic_writer_unknown');
          else await app.waitFor('text:changes:1:current');
          await app.press('id:fixture-assistants-refresh'); await app.wait(200);
          expect(app.shows('text:owners:1:0')).toBe(true);
          expect(app.texts().some(value => value.startsWith('changes:1:'))).toBe(true);
          await app.press('id:fixture-admission-allow'); await app.press('id:desktop-assistants-retry');
        }
        await app.waitFor('text:owners:1:1');
        expect(app.shows('text:released:1:mutations:0')).toBe(true);
        expect(app.shows('id:desktop-assistant-conversation-a')).toBe(false);
        expect(app.shows('id:desktop-assistant-conversation-b')).toBe(false);
        expect(app.shows('id:desktop-assistant-b')).toBe(true);
        expect(app.shows('id:desktop-assistant-c')).toBe(true);
        await app.press('id:fixture-admission-late');
        expect(app.shows('text:owners:1:1')).toBe(true);
      });
    }
    test(`${platform} actual AssistantHome: ${boundary} terminal lifetime cannot revive on same Bot reappearance`, async () => {
      const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
      await app.waitFor('id:desktop-assistant-conversation-a');
      await app.type('id:fixture-assistant-draft', 'never reacquire');
      await app.press('id:fixture-admission-hold'); await app.press(`id:fixture-assistants-${boundary}`);
      await app.waitFor('text:admission:false:false'); await app.waitFor('text:changes:1:');
      await app.press('id:fixture-assistants-restore-a'); await app.waitFor('id:desktop-assistant-a');
      await app.press('id:fixture-assistants-refresh'); await app.wait(200);
      expect(app.shows('text:admission:false:false')).toBe(true);
      expect(app.shows('text:owners:1:0')).toBe(true);
      expect(app.value('id:fixture-assistant-draft')).toBe('never reacquire');
      await app.press('id:fixture-admission-mutate');
      expect(app.shows('text:released:0:mutations:0')).toBe(true);
      await app.press('id:fixture-admission-resolve'); await app.waitFor('text:owners:1:1');
      await app.press('id:fixture-admission-late');
      await app.press('id:fixture-assistants-refresh'); await app.wait(200);
      expect(app.shows('id:desktop-assistant-a')).toBe(true);
      expect(app.shows('id:desktop-assistant-conversation-a')).toBe(false);
      expect(app.shows('id:desktop-assistant-conversation-b')).toBe(false);
      expect(app.shows('text:released:1:mutations:0')).toBe(true);
      expect(app.shows('text:owners:1:1')).toBe(true);
      await app.press('id:fixture-admission-allow'); await app.press('id:desktop-assistant-a');
      await app.waitFor('id:desktop-assistant-conversation-a');
      expect(app.shows('text:owners:2:1')).toBe(true);
    });
  }
  test(`${platform} actual AssistantHome: a newer target invalidates held retirement without taking over the old owner`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    await app.press('id:fixture-admission-hold'); await app.press('id:fixture-assistants-remove-a');
    await app.waitFor('text:admission:false:false'); await app.waitFor('text:changes:1:');
    await app.press('id:desktop-assistant-b'); await app.press('id:fixture-admission-resolve');
    await app.waitFor('text:changes:1:stale');
    expect(app.shows('text:released:0:mutations:0')).toBe(true);
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.shows('id:desktop-assistant-conversation-b')).toBe(false);
    await app.press('id:fixture-admission-late');
    expect(app.shows('text:owners:1:0')).toBe(true);
    await app.press('id:fixture-admission-allow'); await app.press('id:desktop-assistant-b');
    await app.waitFor('id:desktop-assistant-conversation-b');
    expect(app.shows('text:released:1:mutations:0')).toBe(true);
    expect(app.shows('text:owners:2:1')).toBe(true);
  });
  for (const mutation of ['external-remove', 'inplace-dir'] as const) {
    test(`${platform} actual AssistantHome: direct authoritative ${mutation} retains original slot props and gates mutation`, async () => {
      const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
      await app.waitFor('id:desktop-assistant-conversation-a');
      await app.press('id:fixture-admission-hold'); await app.press(`id:fixture-admission-${mutation}`);
      await app.waitFor('text:admission:false:false'); await app.waitFor('text:changes:1:');
      expect(app.shows('text:scope:/workspace')).toBe(true);
      expect(app.shows('text:owners:1:0')).toBe(true);
      expect(app.shows('id:desktop-assistant-b')).toBe(true);
      expect(app.shows('id:desktop-assistant-c')).toBe(true);
      await app.press('id:fixture-admission-mutate');
      expect(app.shows('text:released:0:mutations:0')).toBe(true);
      await app.press('id:fixture-admission-resolve'); await app.waitFor('text:owners:1:1');
      expect(app.shows('text:released:1:mutations:0')).toBe(true);
      expect(app.shows('id:desktop-assistant-conversation-a')).toBe(false);
    });
  }
  test(`${platform} actual AssistantHome: unsupported capability retires the prior owner without hiding complete contacts`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-conversation-a');
    await app.press('id:fixture-admission-hold'); await app.press('id:fixture-assistants-unsupported');
    await app.waitFor('text:HTTP 503: synthetic_assistants_offline');
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.shows('text:changes:0:')).toBe(true);
    await app.press('id:desktop-assistants-retry');
    await app.waitFor('text:admission:false:false'); await app.waitFor('text:changes:1:');
    expect(app.shows('text:owners:1:0')).toBe(true);
    expect(app.shows('id:desktop-assistant-b')).toBe(true);
    expect(app.shows('id:desktop-assistant-c')).toBe(true);
    await app.press('id:fixture-admission-mutate');
    expect(app.shows('text:released:0:mutations:0')).toBe(true);
    await app.press('id:fixture-assistants-restore-a');
    await app.waitUntil(() => app.enabled('id:desktop-assistant-b'));
    expect(app.shows('text:admission:false:false')).toBe(true);
    expect(app.shows('text:owners:1:0')).toBe(true);
    await app.press('id:fixture-admission-resolve'); await app.waitFor('text:owners:1:1');
    expect(app.shows('text:released:1:mutations:0')).toBe(true);
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(false);
  });
  test(`${platform} headless: context pin/edit/delete confirmation and partial failure retain authoritative rows`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-a');
    await app.rightClick('id:desktop-assistant-a'); await app.press('role:menuitem[Pin]');
    await app.waitUntil(() => !app.shows('role:menuitem[Pin]'));
    await app.rightClick('id:desktop-assistant-a'); await app.waitFor('role:menuitem[Unpin]');
    await app.press('role:menuitem[Edit]'); await app.waitFor('text:edit:a');
    app.onDialog(() => 'Cancel');
    await app.rightClick('id:desktop-assistant-a'); await app.press('role:menuitem[Delete]');
    expect((await audit(app)).some(row => row.method === 'DELETE')).toBe(false);
    app.onDialog(() => 'Delete');
    await app.rightClick('id:desktop-assistant-a'); await app.press('role:menuitem[Delete]');
    await app.waitFor('text:HTTP 503: synthetic_delete_failed');
    expect(app.shows('id:desktop-assistant-a')).toBe(true);
    expect(app.shows('id:desktop-assistant-conversation-a')).toBe(true);
    await app.press('id:desktop-assistants-retry');
    await app.waitUntil(() => !app.shows('text:HTTP 503: synthetic_delete_failed'));
    await app.press('id:desktop-assistants-mark-read');
    await app.waitUntil(() => !app.enabled('id:desktop-assistants-mark-read'));
  });
  test(`${platform} headless: failed reads are not empty success; disabled/unknown capability are unavailable`, async () => {
    const app = await open('./desktop-assistants-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-assistant-a');
    await app.press('id:fixture-assistants-fail'); await app.waitFor('text:HTTP 503: synthetic_assistants_offline');
    expect(app.shows('id:desktop-assistant-a')).toBe(true);
    expect(app.shows('id:desktop-assistants-onboarding')).toBe(false);
    await app.press('id:desktop-assistants-retry');
    await app.waitUntil(() => !app.shows('text:HTTP 503: synthetic_assistants_offline'));
    await app.press('id:fixture-assistants-empty'); await app.waitFor('id:desktop-assistants-onboarding');
    await app.press('id:fixture-assistants-disabled'); await app.waitFor('id:desktop-assistants-unavailable');
    await app.press('id:fixture-assistants-unknown'); await app.waitFor('id:desktop-assistants-retry');
    await app.press('id:desktop-assistants-retry');
    await app.waitFor('id:desktop-assistants-unavailable');
    expect(app.shows('id:desktop-assistants-onboarding')).toBe(false);
  });
}
