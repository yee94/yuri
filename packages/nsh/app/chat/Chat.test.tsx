import { expect, open, test } from 'nsh/test';

const phone = { platform: 'ios' as const, locale: 'en-US' };
const runningSession = 'id:session-s-running >> nth=0';

async function openRunning() {
  const app = await open('../dev/App.tsx', phone);
  await app.waitFor(runningSession);
  await app.press(runningSession);
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
  return app;
}

test('an assistant run folds its work under one completed header and tools keep their diff', async () => {
  const app = await openRunning();
  await app.waitFor('text:Worked for 40s');
  expect(app.texts()).toContain('Used');
  expect(app.texts()).toContain('1 read, 1 edit, 1 command');
  expect(app.texts()).toContain('+1');
  expect(app.texts()).toContain('-1');
  await app.press('label:Expand processing details');
  await app.waitFor('id:tool-row-t-3');
  await app.press('id:tool-row-t-3');
  await app.waitFor('text:Details:');
  await app.press('label:Collapse processing details');
  await app.waitUntil(() => !app.shows('id:tool-row-t-3'));
});

test('reading history compacts the composer and the pill restores the live edge', async () => {
  const app = await openRunning();
  await app.scroll('id:chat-transcript', -320);
  await app.waitFor('id:chat-composer-compact');
  await app.press('id:chat-compact-expand');
  await app.waitUntil(() => !app.shows('id:chat-composer-compact'));
  await app.waitFor('text:The relay keeps dropping after a reconnect. Can you find why and fix it?');
});

test('the slash catalog offers Web local commands and /model opens the system sheet', async () => {
  const app = await openRunning();
  await app.type('id:chat-input', '/mode');
  await app.waitFor('text:/model');
  await app.press('text:/model');
  await app.waitFor('id:model-search');
  expect(app.texts()).toContain('Model');
  expect(app.texts()).toContain('Select agent');
});

test('the @ catalog groups skills and agents before files', async () => {
  const app = await openRunning();
  await app.type('id:chat-input', '@');
  await app.waitFor('text:Skills');
  expect(app.texts()).toContain('Agents');
  expect(app.texts()).toContain('@build');
  await app.press('text:@build');
  expect(app.value('id:chat-input')).toBe('@build ');
});

test('a prompt queued while the session is working shows the queue card', async () => {
  const app = await openRunning();
  await app.type('id:chat-input', 'First question about the queue.');
  await app.press('id:chat-send');
  await app.waitUntil(() => app.value('id:chat-input') === '');
  await app.wait(20);
  await app.type('id:chat-input', 'queue-me');
  expect(app.value('id:chat-input')).toBe('queue-me');
  await app.press('id:chat-send');
  await app.waitUntil(() => app.value('id:chat-input') === '');
  await app.waitFor('id:chat-queue');
  expect(app.texts()).toContain('queue-me');
  expect(app.texts()).toContain('edit');
  expect(app.texts()).toContain('steer');
});

const remoteWorktree = 'id:worktree-/Users/lab/Code/remote-app/.worktrees/api';
const remoteSession = 'id:session-host-lab::r-worktree';

/** A remote session is opened from the same projects home, then rendered by the same chat. */
async function openRemote() {
  const app = await open('../dev/App.tsx', phone);
  await app.waitFor(remoteWorktree);
  await app.press(remoteWorktree);
  await app.waitFor(remoteSession);
  await app.press(remoteSession);
  await app.waitFor('text:The endpoint still returns 500 after the deploy. Can you trace it?');
  return app;
}

test('a remote session opens on the shared chat and sends through its Host', async () => {
  const app = await openRemote();
  // Same transcript chrome as a local turn: fold header, model footer, tool row.
  expect(app.texts().some((text) => text.startsWith('Worked for '))).toBe(true);
  expect(app.texts()).toContain('Claude Sonnet 4.5 · High');
  await app.type('id:chat-input', 'Recheck the endpoint.');
  await app.press('id:chat-send');
  // The mock only answers the Host-proxied prompt path, and names it in the reply.
  await app.waitUntil(() =>
    app.texts().join(' ').includes('host-lab at /api/session/r-worktree/prompt: Recheck the endpoint.'),
  );
});

test('a remote permission card replies through its Host', async () => {
  const app = await openRemote();
  await app.waitFor('id:permission-perm-remote');
  expect(app.texts()).toContain('npm test --workspace apps/api');
  await app.press('id:permission-allow-once');
  await app.waitUntil(() => !app.shows('id:permission-perm-remote'));
  expect(app.texts()).toContain('The endpoint still returns 500 after the deploy. Can you trace it?');
});

