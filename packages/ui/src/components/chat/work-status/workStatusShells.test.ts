import { expect, it } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import { projectBlockingShellIds } from './workStatusShells';

const tool = (id: string, name: string, status: string, shellID?: string) =>
  ({ id, type: 'tool', tool: name, state: { status, input: {}, metadata: shellID ? { shellID } : {} } }) as unknown as Part;

it('collects shells of running shell calls only', () => {
  const ids = projectBlockingShellIds({
    messageOrder: ['m1', 'm2'],
    partsByMessageID: {
      m1: [tool('p1', 'shell', 'completed', 'sh_done'), tool('p2', 'shell', 'running', 'sh_fg')],
      m2: [tool('p3', 'task', 'running', 'sh_other'), tool('p4', 'shell', 'running')],
    },
  });
  expect(ids).toEqual(['sh_fg']);
});
