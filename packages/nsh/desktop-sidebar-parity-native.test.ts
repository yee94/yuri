import { expect, test } from 'vitest';
import { runDesktopSidebarEngine } from './desktop-sidebar-test-runner';

test('sidebar parity slice exercises the actual desktop component with isolated synthetic authority', () => {
  const result = runDesktopSidebarEngine('desktop-sidebar-parity-engine.test.tsx');
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);
