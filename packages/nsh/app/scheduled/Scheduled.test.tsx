import { expect, open, test } from 'nsh/test';

const webPhone = { platform: 'web' as const, locale: 'en-US', width: 390, height: 844 };

async function openWeb() {
  try {
    return await open('../dev/App.tsx', webPhone);
  } catch (error) {
    if (String(error).includes('ERR_NSH_TEST_UNSUPPORTED') || String(error).includes('unsupported on --target')) return null;
    throw error;
  }
}

async function openSchedule() {
  const app = await openWeb();
  if (!app) return null;
  await app.press('id:tab-scheduled');
  await app.waitFor('text:Nightly dependency audit');
  return app;
}

test('task cards keep the schedule and next run together without a timezone', async () => {
  const app = await openSchedule();
  if (!app) return;
  expect(app.texts()).toContain('Daily 02:30');
  expect(app.texts()).toContain('Weekly Mon, Wed 09:00');
  expect(app.texts().some((text) => text.includes('(UTC)'))).toBe(false);
  expect(app.shows('id:task-task-audit')).toBe(true);
});

test('the filters narrow the cards and the create action sits on the filter track', async () => {
  const app = await openSchedule();
  if (!app) return;
  await app.press('text:Active');
  await app.waitUntil(() => !app.shows('id:task-task-changelog'));
  await app.press('text:Paused');
  await app.waitUntil(() => !app.shows('id:task-task-audit'));
  expect(app.shows('id:task-task-changelog')).toBe(true);
  await app.press('id:schedule-create');
  await app.waitFor('text:New schedule');
});

test('a task history is filtered to that task and can be cleared', async () => {
  const app = await openSchedule();
  if (!app) return;
  await app.press('id:task-history-task-audit');
  await app.waitFor('text:Workspace lock timed out');
  expect(app.texts().some((text) => text === 'Weekly changelog')).toBe(false);
  await app.press('id:history-clear-filter');
  await app.waitUntil(() => app.texts().some((text) => text === 'Weekly changelog'));
});

test('the schedule header offers the assistant that owns these tasks', async () => {
  const app = await openSchedule();
  if (!app) return;
  expect(app.shows('id:schedule-assistant')).toBe(true);
  await app.press('id:schedule-assistant');
  await app.waitFor('id:chat-input');
});
