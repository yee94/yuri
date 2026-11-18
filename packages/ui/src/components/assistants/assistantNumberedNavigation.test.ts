import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ snapshot: undefined as unknown, openAssistant: vi.fn() }));
vi.mock('@/queries/assistantQueries', () => ({ readAssistantSnapshot: () => mocks.snapshot }));
vi.mock('@/stores/useAssistantUIStore', () => ({ openAssistant: mocks.openAssistant }));

import { activateNumberedAssistant } from './assistantNumberedNavigation';

const contact = (id: string, createdAt?: number, pinnedAt?: number) => ({
  id,
  pinnedAt,
  latestMessagePreview: createdAt === undefined ? undefined : { createdAt },
});

describe('activateNumberedAssistant', () => {
  beforeEach(() => {
    mocks.openAssistant.mockClear();
    mocks.snapshot = { enabled: true, assistants: [contact('old', 10), contact('new', 30), contact('pinned', 20, 1)] };
  });

  test('numbers the contact list as rendered: pinned first, then newest message first', () => {
    expect([1, 2, 3].map((slot) => {
      mocks.openAssistant.mockClear();
      activateNumberedAssistant(slot);
      return mocks.openAssistant.mock.calls[0][0];
    })).toEqual(['pinned', 'new', 'old']);
  });

  test('an empty slot does nothing', () => {
    expect(activateNumberedAssistant(4)).toBe(false);
    expect(mocks.openAssistant).not.toHaveBeenCalled();
  });

  test('does nothing while Assistants are disabled or not loaded', () => {
    mocks.snapshot = { enabled: false, assistants: [contact('only', 1)] };
    expect(activateNumberedAssistant(1)).toBe(false);
    mocks.snapshot = undefined;
    expect(activateNumberedAssistant(1)).toBe(false);
    expect(mocks.openAssistant).not.toHaveBeenCalled();
  });
});
