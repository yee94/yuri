import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

test('home and chat overflow converge on one shell-owned remote desktop panel', async () => {
  const source = await readFile(join(sourceDirectory, 'MobileApp.tsx'), 'utf8');
  const shell = await readFile(join(sourceDirectory, '../mobile/MobilePhoneShell.tsx'), 'utf8');
  const home = await readFile(join(sourceDirectory, '../mobile/projects/MobileProjectsHomeContainer.tsx'), 'utf8');

  expect(source.match(/<RemoteDesktopPanel\b/g)).toHaveLength(1);
  expect(source).toMatch(/const openRemoteDesktop = useEvent\(\(\) => \{\s*setOverflowOpen\(false\);\s*setRemoteDesktopOpen\(true\);/);
  expect(source).not.toContain('requestDesktopOrientationPermission');
  expect(source).toMatch(/key: 'remote-desktop',\s*icon: 'computer',\s*label: t\('remoteDesktop.title'\),\s*onSelect: openRemoteDesktop,/);
  expect(source).toContain('onRemoteDesktop={openRemoteDesktop}');
  expect(source).toContain('onClose={closeRemoteDesktop}');
  expect(source).toContain('instanceName={connection.connections.find(isActiveRuntimeConnection)?.label}');
  expect(shell).toContain('onRemoteDesktop={onRemoteDesktop}');
  expect(home).toContain('onRemoteDesktop={onRemoteDesktop}');
  expect(home).not.toContain('RemoteDesktopPanel');
  expect(home).not.toContain('setRemoteDesktopOpen');
});

test('remote desktop blocks underlying navigation and Android back dismisses it first', async () => {
  const source = await readFile(join(sourceDirectory, 'MobileApp.tsx'), 'utf8');
  const blocked = source.match(/const rootBackRoutesBlocked[\s\S]*?;/)![0];
  expect(blocked).not.toContain('remoteDesktopOpen');
  expect(source).toContain('remoteDesktopActive={remoteDesktopOpen}');
  expect(source).toMatch(/const headerSwipeDisabled[\s\S]*?\|\| remoteDesktopOpen;/);
  expect(source).toMatch(/const handleNativeBack = useEvent\(\(\) => \{\s*if \(remoteDesktopOpen\) \{\s*closeRemoteDesktop\(\);\s*return true;/);
});
