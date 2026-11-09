import { runDesktopSidebarEngine } from './desktop-sidebar-test-runner';
import { expect, test } from 'vitest';

test('production desktop sidebar on NSH 0.4 native headless desktop engine', () => {
  const result = runDesktopSidebarEngine('desktop-sidebar-engine.test.tsx');
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);
