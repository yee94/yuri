import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHost } from './tests/settings-outer-host.js';
import { readSettingsModels, settingsVisibleAgents } from './settings-defaults-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(directory, file), 'utf8');

describe('Settings public entrypoint and trigger structure (not an engine test)', () => {
  it('preserves Appearance and Chat public Basics consumers by forwarding before creating the basic form', () => {
    const basics = source('settings-basics.tsx');
    const forward = basics.indexOf('return <SettingsPreferences {...props} />');
    expect(forward).toBeGreaterThan(basics.indexOf('export function SettingsBasics('));
    expect(forward).toBeLessThan(basics.indexOf('const state = settingsLifetime()'));
    expect(basics.slice(basics.indexOf('export function SettingsBasics('), forward)).toContain("props.page === 'appearance'");
    expect(basics.slice(basics.indexOf('export function SettingsBasics('), forward)).toContain("props.page === 'chat'");
    expect(source('appearance-settings-test-app.tsx')).toContain('<SettingsBasics page="appearance"');
  });
  it('places a SettingsChoice testID on the custom Select trigger, never its non-pressable component host', () => {
    const controls = source('settings-controls.tsx');
    expect(controls).not.toContain('<Select testID={props.testID}');
    expect(controls).toContain('trigger={<View testID={props.testID}');
  });
  it('routes About to the dedicated owner rather than mounting the legacy basic loader', () => {
    const basics = source('settings-basics.tsx');
    const forward = basics.indexOf('return <SettingsAbout target={props.target} active={props.active} />');
    expect(forward).toBeGreaterThan(basics.indexOf('export function SettingsBasics('));
    expect(forward).toBeLessThan(basics.indexOf('const state = settingsLifetime()'));
    expect(basics).not.toContain("request('/api/system/info')");
    const settings = source('settings.tsx');
    expect(settings).toContain("props.page === 'about'}><SettingsAbout");
    expect(settings).toMatch(/'usage', 'about', 'archived-sessions'/);
  });
});

describe('Actual Settings outer fixture catalog wire (pure injected transport)', () => {
  const setup = () => {
    const host = createHost(), paths: string[] = [];
    const send = async (path: string, method = 'GET', body?: unknown) => {
      paths.push(path);
      const result = host.call('runtime.request', { path, method, body });
      if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}`);
      return result.body;
    };
    return { send, paths };
  };
  it('serves the Summary location-less catalog and accepts the selected real model without touching prompts', async () => {
    const { send, paths } = setup();
    const before = await send('/api/config/settings');
    const models = await readSettingsModels(send, before);
    expect(models.map(item => [item.providerID, item.modelID])).toEqual([['fixture', 'model']]);
    expect(paths).toContain('/api/config/catalog/providers');
    await send('/api/config/settings', 'PUT', { summaryModelMode: 'provider', summaryProviderID: 'fixture', summaryModelID: 'model' });
    expect(await send('/api/config/settings')).toMatchObject({ summaryModelID: 'model', summaryCommitPrompt: 'Preserved prompt' });
  });
  it('serves the scoped Sessions model/variant/Agent catalogs used by the real selectors', async () => {
    const { send, paths } = setup();
    const preferences = await send('/api/config/settings');
    const models = await readSettingsModels(send, preferences, '/fixture/project');
    expect(models[0].model.variants).toEqual({ high: {} });
    expect(paths).toContain('/api/config/catalog/providers?directory=%2Ffixture%2Fproject');
    const agents = settingsVisibleAgents(await send('/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject'));
    expect(agents.map(agent => agent.name)).toEqual(['build', 'visible-subagent']);
    await send('/api/config/settings', 'PUT', { defaultModel: 'fixture/model', defaultVariant: '' });
    await send('/api/config/settings', 'PUT', { defaultVariant: 'high' });
    await send('/api/config/settings', 'PUT', { defaultAgent: 'visible-subagent' });
    expect(await send('/api/config/settings')).toMatchObject({ defaultModel: 'fixture/model', defaultVariant: 'high', defaultAgent: 'visible-subagent' });
  });
});
