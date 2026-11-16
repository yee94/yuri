import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs'), 'utf8');
const discovery = source.slice(source.indexOf('const resolveDefaultTerminal ='), source.indexOf('const parseSshConfigImports ='));
const launch = source.slice(source.indexOf('const buildOpenProjectSpecs ='), source.indexOf('const quoteWindowsCommandArg ='));

const fixture = () => {
  const execFileAsync = vi.fn().mockResolvedValue({
    stdout: JSON.stringify({ appName: '/Applications/Warp.app', label: 'Warp' }),
  });
  const iconToDataUrl = vi.fn().mockResolvedValue('data:image/png;base64,warp');
  const context = vm.createContext({
    path, process: { platform: 'darwin' }, execFileAsync,
    pathExists: vi.fn().mockResolvedValue(true),
    iconToDataUrl,
    resolveAppIconPath: vi.fn(async (appPath) => `${appPath}/icon.icns`),
    resolveAppBundlePath: vi.fn(async () => '/System/Applications/Utilities/Terminal.app'),
  });
  vm.runInContext(`${discovery}\n${launch}
    globalThis.resolve = resolveDefaultTerminal;
    globalThis.decorate = withDefaultTerminal;
    globalThis.project = buildOpenProjectSpecs;
    globalThis.file = buildOpenFileSpecs;
  `, context);
  return { context, execFileAsync, iconToDataUrl };
};

test('default terminal metadata replaces the stable Terminal slot, including cached Apple icons', async () => {
  const { context, execFileAsync, iconToDataUrl } = fixture();
  const result = await context.decorate([
    { name: 'Finder', iconDataUrl: 'finder' },
    { name: 'Terminal', iconDataUrl: 'apple' },
    { name: 'Cursor' },
  ]);
  expect(result).toEqual([
    { name: 'Finder', iconDataUrl: 'finder' },
    { name: 'Terminal', appName: '/Applications/Warp.app', label: 'Warp', iconDataUrl: 'data:image/png;base64,warp' },
    { name: 'Cursor' },
  ]);
  expect(execFileAsync).toHaveBeenCalledWith('/usr/bin/osascript',
    expect.arrayContaining(['-l', 'JavaScript']), expect.objectContaining({ timeout: 3000 }));
  expect(iconToDataUrl).toHaveBeenCalledWith('/Applications/Warp.app/icon.icns', 'Warp');
  await context.decorate(result);
  expect(execFileAsync).toHaveBeenCalledTimes(2);
  expect(iconToDataUrl).toHaveBeenCalledTimes(1);
});

test('project and file actions recheck the default and pass paths as a single argument', async () => {
  const { context, execFileAsync } = fixture();
  expect(await context.project({ projectPath: "/repo/a b'; $(ignored)", appId: 'terminal', appName: 'Terminal' }))
    .toEqual([{ program: 'open', args: ['-a', '/Applications/Warp.app', "/repo/a b'; $(ignored)"] }]);
  execFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify({ appName: '/Applications/Ghostty.app', label: 'Ghostty' }) });
  expect(await context.file({ filePath: '/repo/a b/file.ts', appId: 'terminal', appName: '/Applications/Warp.app' }))
    .toEqual([{ program: 'open', args: ['-a', '/Applications/Ghostty.app', '/repo/a b'] }]);
});

test.each(['failure', 'malformed', 'missing', 'relative'])('unavailable default falls back to Apple Terminal: %s', async (reason) => {
  const { context, execFileAsync } = fixture();
  if (reason === 'failure') execFileAsync.mockRejectedValueOnce(new Error('timeout'));
  if (reason === 'malformed') execFileAsync.mockResolvedValueOnce({ stdout: 'not JSON' });
  if (reason === 'missing') context.pathExists.mockResolvedValueOnce(false);
  if (reason === 'relative') execFileAsync.mockResolvedValueOnce({ stdout: '{"appName":"Warp.app"}' });
  expect(await context.resolve()).toEqual({ appName: 'Terminal', label: 'Terminal' });
});

test('empty catalog still supplies the default terminal; Windows metadata is untouched', async () => {
  const { context, execFileAsync } = fixture();
  expect(await context.decorate([])).toEqual([
    { name: 'Terminal', appName: '/Applications/Warp.app', label: 'Warp', iconDataUrl: 'data:image/png;base64,warp' },
  ]);
  context.process.platform = 'win32';
  const windows = [{ name: 'Terminal', iconDataUrl: 'windows' }];
  expect(await context.decorate(windows)).toBe(windows);
  expect(execFileAsync).toHaveBeenCalledTimes(1);
});

test('fresh installed-app IPC and cached responses both apply default-terminal discovery', () => {
  const ipc = source.slice(source.indexOf("case 'desktop_get_installed_apps':"), source.indexOf("case 'desktop_window_runtime_set':"));
  expect(ipc).toContain('await withDefaultTerminal(await buildInstalledApps(');
  expect(ipc).toContain('apps: await withDefaultTerminal(cachedApps)');
});
