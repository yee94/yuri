import { runDesktopSidebarEngine } from './desktop-sidebar-test-runner';
import { expect, test } from 'vitest';

(process.env.NSH_SIDEBAR_MOUSE === '1' ? test : test.skip)('production sidebar adapter with real AppKit mouse events (synthetic data only)', () => {
  const result = runDesktopSidebarEngine('desktop-sidebar-mouse-engine.test.tsx', 'macos');
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);
