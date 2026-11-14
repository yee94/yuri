import { expect, open, test } from 'nsh/test';

const phone = { platform: 'ios' as const, locale: 'en-US' };
const webPhone = { platform: 'web' as const, locale: 'en-US', width: 390, height: 844 };
const worktree = 'id:worktree-/Users/studio/Code/yuri/.worktrees/fix-auth';

test('the projects home lists pinned work, worktrees and project sessions', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Ship the pairing sheet');
  expect(app.texts()).toContain('Ship the pairing sheet');
  expect(app.texts()).toContain('Debug relay reconnect');
  expect(app.texts()).toContain('fix/auth');
  expect(app.texts()).toContain('Publish the changelog');
  expect(app.texts()).toContain('Tidy the settings panel');
  await app.press(worktree);
  await app.waitFor('text:Fix auth redirect');
});

test('a worktree header opens its actions sheet on a long press', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:fix/auth');
  await app.longPress(worktree);
  await app.waitFor('text:New Session');
  expect(app.texts()).toContain('Cancel');
});

test('opening a session pushes its page and back returns home', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('text:Tidy the settings panel spacing.');
  await app.press('id:chat-back');
  await app.waitFor('id:session-s-old');
});

test('a project collapses to its header', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Publish the changelog');
  await app.press('id:project-p-site');
  await app.waitUntil(() => app.texts().filter((text) => text === 'Publish the changelog').length === 1);
});

test('search narrows the sessions it matches', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Tidy the settings panel');
  await app.type('id:projects-search', 'relay');
  await app.waitUntil(() => !app.texts().includes('Tidy the settings panel'));
  expect(app.texts()).toContain('Debug relay reconnect');
});

test('a left swipe reveals the pin and archive actions', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.drag('id:session-s-old', { x: -120 });
  await app.waitFor('text:Archive');
  expect(app.texts()).toContain('Pin');
});

test('show more reveals the rest of a workspace', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Tidy the settings panel');
  expect(app.texts()).not.toContain('Polish the mobile shell');
  await app.press('text:More >> nth=0');
  await app.waitFor('text:Polish the mobile shell');
  await app.press('text:Fewer');
  await app.waitUntil(() => !app.texts().includes('Polish the mobile shell'));
});

test('a swipe rail pin puts the session in the pinned surface', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.drag('id:session-s-old', { x: -120 });
  await app.press('text:Pin');
  await app.waitUntil(() => app.texts().filter((text) => text === 'Tidy the settings panel').length === 2);
});

test('renaming a session from its sheet updates the row', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.press('id:session-menu-s-old');
  await app.waitFor('text:Rename');
  await app.press('text:Rename');
  await app.waitFor('id:rename-input');
  await app.clear('id:rename-input');
  await app.type('id:rename-input', 'Renamed by test');
  await app.press('text:Save session name');
  await app.waitFor('text:Renamed by test');
  expect(app.texts()).not.toContain('Tidy the settings panel');
});

test('the session actions sheet offers pin and archive', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.press('id:session-menu-s-old');
  await app.waitFor('text:Rename');
  expect(app.texts()).toContain('Archive');
  expect(app.texts()).toContain('Delete');
});

const remoteProject = 'id:project-p-remote';
const remoteWorktree = 'id:worktree-/Users/lab/Code/remote-app/.worktrees/api';

test('a remote project keeps the local card shape with a machine tag', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Review the API contract');
  expect(app.texts()).toContain('remote-app');
  expect(app.texts()).toContain('Lab Mac');
  await app.press(remoteWorktree);
  await app.waitFor('text:Ship the API endpoint');
});

test('a remote session menu routes pin, read and archive through its machine', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Review the API contract');
  await app.press('id:session-menu-host-lab::r-main');
  await app.waitFor('text:Rename');
  expect(app.texts()).toContain('Archive');
  expect(app.texts()).toContain('Mark as unread');
});

test('the remote project menu offers worktrees, edit and close', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:remote-app');
  await app.longPress(remoteProject);
  await app.waitFor('text:New worktree');
  expect(app.texts()).toContain('Edit');
  expect(app.texts()).toContain('Close project');
});

test('editing a project updates its card name', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Publish the changelog');
  await app.longPress('id:project-p-yuri');
  await app.waitFor('text:Edit');
  await app.press('text:Edit');
  await app.waitFor('id:project-name-input');
  await app.clear('id:project-name-input');
  await app.type('id:project-name-input', 'yuri-renamed');
  await app.press('text:Save');
  await app.waitFor('text:yuri-renamed');
});

test('the new worktree sheet loads branches and validates the name', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Publish the changelog');
  await app.longPress('id:project-p-yuri');
  await app.waitFor('text:New worktree');
  await app.press('text:New worktree');
  await app.waitFor('text:Create Worktree');
  await app.waitFor('text:feature/pairing');
  expect(app.texts()).toContain('Source Branch');
  await app.clear('id:worktree-branch');
  await app.type('id:worktree-branch', 'feature/test');
  await app.press('text:Create Worktree');
  await app.waitUntil(() => app.texts().some((text) => text.includes('.worktrees/feature-test')));
  await app.waitUntil(() => !app.shows('id:worktree-branch'));
  await app.press('id:chat-back');
  await app.waitFor('text:feature/test');
});

test('deleting a worktree removes it from the project', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:fix/auth');
  await app.longPress(worktree);
  await app.waitFor('text:Delete worktree');
  await app.press('text:Delete worktree');
  await app.waitFor('text:Also delete local branch');
  await app.press('text:Remove');
  await app.waitUntil(() => !app.texts().includes('fix/auth'));
});

test('archiving a session offers an undo toast that restores it', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.drag('id:session-s-old', { x: -120 });
  await app.press('text:Archive');
  await app.waitFor('text:Session archived');
  await app.press('text:Undo');
  await app.waitFor('id:session-s-old');
});

test('deleting a session can be undone from its toast', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('id:session-s-old');
  await app.press('id:session-menu-s-old');
  await app.waitFor('text:Delete');
  app.onDialog((dialog) => dialog.title?.includes('Delete session') ? 'Delete session' : null);
  await app.press('text:Delete');
  await app.waitFor('text:Session deleted');
  await app.press('text:Undo');
  await app.waitFor('id:session-s-old');
});

test('global search finds sessions by title and message content', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.waitFor('text:Publish the changelog');
  await app.press('id:global-search-button');
  await app.waitFor('id:global-search-input');
  await app.type('id:global-search-input', 'relay');
  await app.waitFor('text:Debug relay reconnect');
  expect(app.texts()).toContain('Message about relay.');
});

// Web-only surfaces (the `Tabs` fallback and DOM-dependent pages). Device
// targets cannot host `platform: 'web'`; those runs skip these two.
async function openWeb() {
  try { return await open('./dev/App.tsx', webPhone); } catch (error) {
    if (String(error).includes('ERR_NSH_TEST_UNSUPPORTED') || String(error).includes('unsupported on --target')) return null;
    throw error;
  }
}

test('the bots tab lists contacts and opens the bot editor', async () => {
  const app = await openWeb();
  if (!app) return;
  await app.press('id:tab-assistant');
  await app.waitFor('text:Ops Bot');
  expect(app.texts()).toContain('Deploy finished on the staging host.');
  await app.press('id:assistants-create');
  await app.waitFor('text:Default prompt');
  expect(app.texts()).toContain('Save bot');
});

test('the schedule tab lists tasks and opens run history', async () => {
  const app = await openWeb();
  if (!app) return;
  await app.press('id:tab-scheduled');
  await app.waitFor('text:Nightly dependency audit');
  expect(app.texts()).toContain('Weekly changelog');
  await app.press('id:task-history-task-audit');
  await app.waitFor('text:Workspace lock timed out');
});

test('the settings tab lists groups and opens appearance', async () => {
  const app = await openWeb();
  if (!app) return;
  await app.press('id:tab-settings');
  await app.waitFor('text:Appearance');
  expect(app.texts()).toContain('Connection');
  await app.press('text:Appearance');
  await app.waitFor('text:Switch theme');
});

const runningSession = 'id:session-s-running >> nth=0';

test('a running session opens its transcript with activity, markdown and a permission card', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  expect(app.texts()).toContain('Used');
  await app.press('label:Expand processing details');
  await app.waitFor('text:packages/ui/src/sync/relay-client.ts');
  expect(app.texts()).toContain(
    'Found it: relay-client.ts recreates the socket without draining the queued frames.',
  );
  await app.waitFor('text:git status --short');
  await app.press('text:Allow once');
  await app.waitUntil(() => !app.texts().includes('git status --short'));
});

test('sending a prompt streams the assistant reply into the transcript', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  await app.type('id:chat-input', 'Can you recheck the relay queue?');
  await app.press('id:chat-send');
  await app.wait(2500);
  expect(app.texts().join(' ')).toContain('the queue drains now');
});

test('a question form can be answered and leaves the transcript', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:question-frm-demo');
  expect(app.texts()).toContain('Where should the relay reconnect land?');
  await app.press('text:Drain then retry');
  await app.press('id:question-submit');
  await app.waitUntil(() => !app.shows('id:question-frm-demo'));
});

test('older history loads from the top of the transcript', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  // The full-mounted transcript keeps older history above the viewport:
  // drag to the top, where the reader (or the edge trigger) loads it.
  await app.scroll('id:chat-transcript', -4000);
  await app.waitFor('text:Background question 1: summarize what this module does.');
  await app.waitFor('id:chat-scroll-latest');
  await app.press('id:chat-scroll-latest');
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  await app.waitUntil(() => !app.shows('id:chat-scroll-latest'));
});

test('a new session sends its first prompt and becomes the live chat', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-new');
  await app.press('id:chat-more-new');
  await app.waitFor('id:chat-draft-directory');
  await app.type('id:chat-input', 'Plan the mobile work');
  await app.press('id:chat-send');
  await app.waitUntil(() => !app.shows('id:chat-draft-directory'));
  await app.wait(2500);
  expect(app.texts().join(' ')).toContain('the queue drains now');
});

test('an attached file becomes a chip that sends with the prompt', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-attach');
  await app.waitFor('id:attachment-chip-screenshot.png');
  expect(app.texts()).toContain('180 KB');
  await app.press('id:attachment-remove-screenshot.png');
  await app.waitUntil(() => !app.shows('id:attachment-chip-screenshot.png'));

  await app.press('id:chat-attach');
  await app.waitFor('id:attachment-chip-screenshot.png');
  await app.type('id:chat-input', 'Sending the screenshot now.');
  await app.press('id:chat-send');
  await app.waitUntil(() => !app.shows('id:attachment-chip-screenshot.png'));
  await app.waitFor('text:Sending the screenshot now.');
});

test('a message long press offers the actions and copy fills the clipboard', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  app.onDialog((dialog) => (dialog.buttons.includes('Copy message') ? 'Copy message' : null));
  await app.longPress('id:message-m-run-2');
  await app.waitUntil(() => (app.clipboard() ?? '').includes('recreates the socket without draining'));
});

test('reverting from a user turn drops the replies after it', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('text:Aligned the rows to the shared control radius.');
  app.onDialog((dialog) => (dialog.buttons.includes('Revert from here') ? 'Revert from here' : null));
  await app.longPress('id:message-m-old-panel-1');
  await app.waitUntil(() => !app.texts().includes('Aligned the rows to the shared control radius.'));
  await app.waitUntil(() => app.texts().some((text) => text.startsWith('Reverted to Tidy the settings panel spacing.')));
});

test('the changes sheet lists dirty files and shows one file diff', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-changes');
  await app.press('id:chat-more-changes');
  await app.waitFor('text:packages/ui/src/sync/relay-client.test.ts');
  await app.waitFor('text:Branch: main');
  expect(app.texts()).toContain('Staged');
  expect(app.texts()).toContain('Changed');
  await app.press('id:changes-file-packages/ui/src/sync/relay-client.ts');
  await app.waitUntil(() => app.texts().some((text) => text.includes('flushPending(socket);')));
});

test('compact is unavailable while the draft has no session', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-new');
  await app.press('id:chat-more-new');
  await app.waitFor('id:chat-draft-directory');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-compact');
  await expect(app.press('id:chat-more-compact')).rejects.toMatchObject({ code: 'ERR_NSH_TEST_DISABLED' });
});

test('confirming compact marks the session as compacted', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-compact');
  app.onDialog((dialog) => (dialog.buttons.includes('Done') ? 'Done' : null));
  await app.press('id:chat-more-compact');
  await app.waitFor('text:Compaction complete');
});

test('an @ pick becomes a reference chip and sends the file with the prompt', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.type('id:chat-input', '@relay');
  await app.waitFor('text:packages/ui/src/sync/relay-client.ts');
  await app.press('text:packages/ui/src/sync/relay-client.ts');
  await app.waitFor('text:@packages/ui/src/sync/relay-client.ts');
  expect(app.value('id:chat-input')).toBe('@packages/ui/src/sync/relay-client.ts ');
  await app.type('id:chat-input', 'summarize this');
  await app.press('id:chat-send');
  await app.waitUntil(() => app.value('id:chat-input') === '');
  await app.waitUntil(() => !app.texts().includes('@packages/ui/src/sync/relay-client.ts'));
});

test('the mcp sheet reconnects a failing server', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-input');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-mcp');
  await app.press('id:chat-more-mcp');
  await app.waitFor('text:Authentication required');
  expect(app.texts()).toContain('filesystem');
  await app.press('id:mcp-toggle-github');
  await app.waitUntil(() => app.texts().filter((text) => text === 'Connected').length === 2);
  expect(app.texts()).not.toContain('Authentication required');
});

test('the timeline lists user turns and reveals the chosen one', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-timeline');
  await app.press('id:chat-more-timeline');
  await app.waitFor('id:timeline-search');
  await app.waitFor('text:Background question 3: summarize what this module does.');
  await app.press('id:timeline-row-m-run-1');
  await app.waitUntil(() => !app.shows('id:timeline-search'));
  expect(app.texts()).toContain('The relay keeps dropping after a reconnect. Can you find why and fix it?');
});

test('the subagents sheet opens a child session', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  await app.press('id:chat-more');
  await app.waitFor('id:chat-more-children');
  await app.press('id:chat-more-children');
  await app.waitFor('text:Explore the relay queue');
  await app.press('id:child-session-s-child-1');
  await app.waitUntil(() => !app.shows('id:child-session-s-child-1'));
  await app.waitFor('text:Explore the relay queue');
  expect(app.texts()).not.toContain('The relay keeps dropping after a reconnect. Can you find why and fix it?');
});

test('session metadata shows context tokens and provider usage', async () => {
  const app = await open('./dev/App.tsx', phone);
  await app.press('id:session-s-old');
  await app.waitFor('id:chat-context');
  await app.press('id:chat-context');
  await app.waitFor('text:19.5K/200.0K');
  expect(app.texts()).toContain('9.8%');
  await app.waitFor('text:Claude');
  expect(app.texts()).toContain('42%');
  expect(app.texts()).toContain('71%');
});
