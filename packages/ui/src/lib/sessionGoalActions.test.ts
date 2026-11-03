import { beforeEach, expect, test, vi } from 'vitest';

const command = vi.hoisted(() => vi.fn());
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {
  getScopedSdkClient: () => ({ session: { command } }),
  getSdkClient: () => ({ session: { command } }),
} }));
vi.mock('@/queries/sessionGoalQueries', () => ({ refreshSessionGoal: vi.fn().mockResolvedValue(null) }));
import { clearSessionGoal, setSessionGoalStatus } from './sessionGoalActions';

beforeEach(() => { command.mockReset().mockResolvedValue(undefined); });

test('all goal mutations use the native command, not Yuri metadata or objective files', async () => {
  await setSessionGoalStatus('ses_a', '/repo', 'paused');
  await setSessionGoalStatus('ses_a', '/repo', 'active');
  await clearSessionGoal('ses_a', '/repo');
  expect(command.mock.calls.map(([input]) => input)).toEqual([
    { sessionID: 'ses_a', name: 'goal', text: 'pause' },
    { sessionID: 'ses_a', name: 'goal', text: 'resume' },
    { sessionID: 'ses_a', name: 'goal', text: 'clear' },
  ]);
});

test('native command errors propagate without metadata fallback', async () => {
  command.mockRejectedValue(new Error('No paused goal to resume.'));
  await expect(setSessionGoalStatus('ses_a', '/repo', 'active')).rejects.toThrow('No paused goal');
});
