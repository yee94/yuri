import { describe, expect, test, vi } from 'vitest';
import { sessionEvents } from './sessionEvents';

describe('directory picker source', () => {
  test('captures the clicked trigger center once and clears it for keyboard/programmatic requests', () => {
    const trigger = document.createElement('button');
    const measure = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(24, 300, 24, 24));
    const listener = vi.fn();
    const unsubscribe = sessionEvents.onDirectoryRequest(listener);
    try {
      sessionEvents.requestDirectoryDialog({ currentTarget: trigger, detail: 1 });
      expect(listener).toHaveBeenLastCalledWith({ origin: { x: 36, y: 312 } });
      expect(measure).toHaveBeenCalledTimes(1);

      sessionEvents.requestDirectoryDialog({ currentTarget: trigger, detail: 0 });
      expect(listener).toHaveBeenLastCalledWith({});
      sessionEvents.requestDirectoryDialog();
      expect(listener).toHaveBeenLastCalledWith({});
      expect(measure).toHaveBeenCalledTimes(1);

      unsubscribe();
      sessionEvents.requestDirectoryDialog();
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
      measure.mockRestore();
    }
  });

  test('ignores missing or hidden trigger geometry', () => {
    const listener = vi.fn();
    const unsubscribe = sessionEvents.onDirectoryRequest(listener);
    try {
      sessionEvents.requestDirectoryDialog({ currentTarget: null, detail: 1 });
      sessionEvents.requestDirectoryDialog({ currentTarget: document.createElement('button'), detail: 1 });
      expect(listener.mock.calls).toEqual([[{}], [{}]]);
    } finally {
      unsubscribe();
    }
  });
});
