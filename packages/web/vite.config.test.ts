import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginOption } from 'vite';
import createConfig from './vite.config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function pluginNames(option: PluginOption): Promise<string[]> {
  const plugin = await option;
  if (!plugin) return [];
  if (Array.isArray(plugin)) return (await Promise.all(plugin.map(pluginNames))).flat();
  return [plugin.name];
}

beforeEach(() => {
  vi.stubEnv('YURI_HMR_REACT_COMPILER', '');
  vi.stubEnv('YURI_HMR_BUNDLED_DEV', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web development compilation budget', () => {
  it('keeps the existing import-free notification wire contract while still excluding server implementations', () => {
    const config = createConfig({ command: 'serve', mode: 'development' });
    const plugin = config.plugins?.find(p => p && !Array.isArray(p) && typeof p === 'object' && 'name' in p && p.name === 'omit-non-client-sources') as { resolveId: { handler: (id: string) => string | undefined }; load: { handler: (id: string) => string | undefined } };
    for (const id of ['server/lib/notifications/admission-event.js', '/workspace/packages/web/server/lib/notifications/admission-event.js']) {
      expect(plugin.resolveId.handler(id)).toBeUndefined();
      expect(plugin.load.handler(id)).toBeUndefined();
    }
    expect(plugin.resolveId.handler('/workspace/packages/web/server/index.js')).toBe('\0virtual:non-client-source');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server/lib/notifications/admission-event.js'), 'utf8');
    expect(source).not.toMatch(/\b(?:import|require)\s*(?:\(|['"{*])/);
    expect(source).toContain('export function notificationAdmission');
  });
  it.each(['development', 'production'])('skips compiler and vendor grouping during serve (%s)', async (mode) => {
    const config = createConfig({ command: 'serve', mode });

    expect(await pluginNames(config.plugins)).not.toContain('@rolldown/plugin-babel');
    expect(config.experimental?.bundledDev).toBe(false);
    expect(config.build?.rolldownOptions?.output).not.toHaveProperty('codeSplitting');
  });

  it('allows development to opt into the compiler without production vendor grouping', async () => {
    vi.stubEnv('YURI_HMR_REACT_COMPILER', '1');
    const config = createConfig({ command: 'serve', mode: 'development' });

    expect(await pluginNames(config.plugins)).toContain('@rolldown/plugin-babel');
    expect(config.build?.rolldownOptions?.output).not.toHaveProperty('codeSplitting');
  });

  it('keeps experimental bundled development opt-in and free of production vendor groups', async () => {
    vi.stubEnv('YURI_HMR_BUNDLED_DEV', '1');
    const config = createConfig({ command: 'serve', mode: 'development' });

    expect(config.experimental?.bundledDev).toBe(true);
    expect(await pluginNames(config.plugins)).not.toContain('@rolldown/plugin-babel');
    expect(config.build?.rolldownOptions?.output).not.toHaveProperty('codeSplitting');
  });

  it.each(['', '0', '1'])('preserves production compiler and vendor grouping (dev opt-in: %s)', async (toggle) => {
    vi.stubEnv('YURI_HMR_REACT_COMPILER', toggle);
    vi.stubEnv('YURI_HMR_BUNDLED_DEV', '1');
    const config = createConfig({ command: 'build', mode: 'production' });

    expect(await pluginNames(config.plugins)).toContain('@rolldown/plugin-babel');
    expect(config.experimental?.bundledDev).toBe(false);
    expect(config.build?.rolldownOptions?.output).toHaveProperty('codeSplitting.groups', [
      { name: expect.any(Function) },
    ]);
    expect(config.build?.rolldownOptions?.output).toHaveProperty('minify');
    expect(config.build?.rolldownOptions?.input).toHaveProperty('mobile');
    expect(config.build?.rolldownOptions?.input).toHaveProperty('miniChat');
  });
});
