import { runDesktopSidebarEngine } from './desktop-sidebar-test-runner';
import { expect, test } from 'vitest';

test('sidebar chrome parity on the NSH 0.4 headless desktop models (not native windows)', () => {
  const result = runDesktopSidebarEngine('desktop-sidebar-chrome-engine.test.tsx');
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);
