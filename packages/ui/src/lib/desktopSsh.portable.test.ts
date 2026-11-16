import { expect, it, vi } from 'vitest';
import { createDesktopSshInstance } from './desktopSsh';

vi.mock('@/lib/desktop', () => ({ hasDesktopInvoke: () => false, invokeDesktop: vi.fn() }));

it('new SSH entries select the self-contained release instead of a global package install', () => {
  expect(createDesktopSshInstance('host', 'ssh example').remoteYuri.installMethod).toBe('download_release');
});
