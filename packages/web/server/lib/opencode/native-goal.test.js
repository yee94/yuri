import { OpenCode } from '@opencode/client';
import { expect, test } from 'vitest';
import { getNativeSessionGoal } from './native-goal.js';

test('native goal adapter uses the official RPC envelope and scoped request, with no Host state', async () => {
  const requests = [];
  const goal = { id: 'g', objective: 'ship', status: 'complete', rounds: 2, maxRounds: 50, boot: 'boot', updatedAt: 1 };
  const client = OpenCode.make({ baseUrl: 'http://native.test', fetch: async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return Response.json({ output: goal });
  } });
  expect(await getNativeSessionGoal(client, 'ses_a', '/repo', new AbortController().signal)).toEqual(goal);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).pathname).toBe('/api/rpc/opencode.goal/get');
  expect(requests[0].body).toMatchObject({ input: { sessionID: 'ses_a' } });
});
