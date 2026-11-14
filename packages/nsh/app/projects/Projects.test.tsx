import { expect, open, test } from 'nsh/test';

const phone = { platform: 'ios' as const, locale: 'en-US' };
const entry = '../dev/App.tsx';

const remotePinned = 'id:pinned-session-host-lab::r-pinned';
const localPinned = 'id:pinned-session-s-pinned';
const localRow = 'id:session-s-old';
const worktreeRow = 'id:session-s-worktree';
const remoteRow = 'id:session-host-lab::r-main';
const remoteWorktreeRow = 'id:session-host-lab::r-worktree';
const remoteWorktree = 'id:worktree-/Users/lab/Code/remote-app/.worktrees/api';
const fixWorktree = 'id:worktree-/Users/studio/Code/yuri/.worktrees/fix-auth';
const cacheWorktree = 'id:worktree-/Users/studio/Code/yuri/.worktrees/cache-lab';

test('the pinned surface names the owning project and tags remote rows with their machine', async () => {
  const app = await open(entry, phone);
  await app.waitFor(remotePinned);
  // Web `MobileProjectsHome` pins: `subtitle = project · branch`, machine tag as the row suffix.
  expect(app.shows('id:pinned-session-machine-host-lab::r-pinned')).toBe(true);
  // A local pinned row has the project subtitle but no machine tag.
  expect(app.shows(localPinned)).toBe(true);
  expect(app.shows('id:pinned-session-machine-s-pinned')).toBe(false);
});

test('local, worktree and remote sessions are the same row with the same menu', async () => {
  const app = await open(entry, phone);
  await app.waitFor(localRow);
  // A worktree group starts collapsed, exactly like Web's `MobileLabeledSurfaceGroup`.
  await app.press(fixWorktree);
  await app.waitFor(worktreeRow);
  expect(app.shows('id:session-menu-s-old')).toBe(true);
  expect(app.shows('id:session-menu-s-worktree')).toBe(true);

  await app.press('id:session-menu-s-old');
  await app.waitFor('text:Rename');
  // Web `buildSessionMenuItems`: pin, read, rename, refresh transcript, archive, delete.
  expect(app.texts()).toContain('Sync messages');
  expect(app.texts()).toContain('Archive');
  expect(app.texts()).toContain('Delete');
});

test('a remote session row opens the same menu as a local one', async () => {
  const app = await open(entry, phone);
  await app.waitFor(remoteRow);
  await app.press('id:session-menu-host-lab::r-main');
  await app.waitFor('text:Rename');
  expect(app.texts()).toContain('Pin');
  expect(app.texts()).toContain('Mark as unread');
  expect(app.texts()).toContain('Sync messages');
  expect(app.texts()).toContain('Archive');
  expect(app.texts()).toContain('Delete');
});

test('the project menu keeps the Web order', async () => {
  const app = await open(entry, phone);
  await app.waitFor(localRow);
  await app.longPress('id:project-p-yuri');
  await app.waitFor('text:New worktree');
  const texts = app.texts();
  const at = (label: string) => texts.indexOf(label);
  expect(at('New Session')).toBeGreaterThanOrEqual(0);
  expect(at('New Session')).toBeLessThan(at('New worktree'));
  expect(at('New worktree')).toBeLessThan(at('Sync sessions'));
  expect(at('Sync sessions')).toBeLessThan(at('Edit'));
  expect(at('Edit')).toBeLessThan(at('Close project'));
});

test('a remote workspace asks for its next page when More is pressed', async () => {
  const app = await open(entry, phone);
  await app.waitFor(remoteWorktree);
  await app.press(remoteWorktree);
  await app.waitFor('text:Ship the API endpoint');
  await app.waitFor('text:Ship the API migration');
  expect(app.texts()).not.toContain('Ship the API docs');
  await app.press('id:__show_more__:p-remote::/Users/lab/Code/remote-app/.worktrees/api');
  await app.waitFor('text:Ship the API docs');
  await app.waitFor('text:Ship the API client');
  expect(app.shows('id:__show_more__:p-remote::/Users/lab/Code/remote-app/.worktrees/api')).toBe(false);
});

test('a row clock follows the session time, not the title refresh', async () => {
  const app = await open(entry, phone);
  await app.waitFor('text:Compare cache clocks');
  // `time.updated` is 2.5h old while the title refresh ran a minute ago.
  expect(app.texts()).toContain('2h');
});

test('a cached catalog survives a refresh that does not report its directory', async () => {
  const directory = '/Users/studio/Code/yuri/.worktrees/cache-lab';
  const now = Date.now();
  const cache = {
    version: 1,
    connectionId: 'mock',
    projects: [{ id: 'p-yuri', label: 'yuri', path: '/Users/studio/Code/yuri', addedAt: now }],
    activeProjectId: 'p-yuri',
    pinned: [],
    sessions: [
      [
        directory,
        [
          {
            id: 'cached-row',
            title: 'Cached worktree row',
            directory,
            updated: now - 60000,
            activity: now - 60000,
            created: now - 60000,
            pinned: false,
            archived: false,
          },
        ],
      ],
    ],
    worktrees: [
      ['/Users/studio/Code/yuri', [{ path: directory, name: 'cache-lab', branch: 'cache/lab' }]],
    ],
    repos: ['/Users/studio/Code/yuri'],
  };
  const app = await open(entry, { ...phone, storage: { 'catalog:cache-v1': JSON.stringify(cache) } });
  // The device cache is on screen while the refresh is still merging.
  await app.waitFor(cacheWorktree);
  await app.press(cacheWorktree);
  await app.waitFor('text:Cached worktree row');
  // The refreshed catalog landed next to the cached rows instead of clearing them.
  expect(app.texts()).toContain('Ship the pairing sheet');
  expect(app.storage()['catalog:cache-v1']).toContain('Cached worktree row');
});

test('archiving a session takes its tree and links to the archived list', async () => {
  const app = await open(entry, phone);
  await app.waitFor('text:More >> nth=0');
  await app.press('text:More >> nth=0');
  await app.waitFor('id:session-s-index');
  await app.press('id:session-menu-s-index');
  await app.waitFor('text:Archive');
  await app.press('text:Archive');
  await app.waitFor('text:Archived 2 sessions');
  await app.press('text:View archived');
  await app.waitFor('text:Audit the session index');
  expect(app.texts()).toContain('Child of the index audit');
});
