import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createHost } from './tests/settings-outer-host.js';
import { readSettingsModels, settingsVisibleAgents } from './settings-defaults-core';
import * as model from './model';
import * as scopeCore from './runtime-scope';
import { settingsObject } from './settings-protocol';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(directory, file), 'utf8');

function assertForwardBeforeFormOwner(basics: string, forward: number) {
  const syntax = ts.createSourceFile('settings-basics.tsx', basics, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const entry = syntax.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsBasics');
  expect(entry?.body).toBeDefined();
  const statements = entry!.body!.statements;
  const form = statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(syntax) === 'state'));
  expect(form).toBeDefined();
  expect(forward).toBeLessThan(form!.getStart(syntax));
  // Public forwarding must also precede the first Host capture, not just the form constructor.
  const firstCapture = statements.find(node => ts.isVariableStatement(node) || ts.isExpressionStatement(node));
  expect(firstCapture).toBeDefined();
  expect(forward).toBeLessThan(firstCapture!.getStart(syntax));
}

describe('Settings public entrypoint and trigger structure (not an engine test)', () => {
  it('preserves Appearance and Chat public Basics consumers by forwarding before creating the basic form', () => {
    const basics = source('settings-basics.tsx');
    const forward = basics.indexOf('return <SettingsPreferences {...props} />');
    expect(forward).toBeGreaterThan(basics.indexOf('export function SettingsBasics('));
    assertForwardBeforeFormOwner(basics, forward);
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
    assertForwardBeforeFormOwner(basics, forward);
    expect(basics).not.toContain("request('/api/system/info')");
    const settings = source('settings.tsx');
    expect(settings).toContain("props.page === 'about'}><SettingsAbout");
    expect(settings).toMatch(/'usage', 'about', 'archived-sessions'/);
  });
});

describe('Actual Settings outer fixture catalog wire (pure injected transport)', () => {
  const setup = async () => {
    const host = createHost(), paths: string[] = [];
    const modules: Record<string, unknown> = {
      nsh: { host: { available: () => true, call: async (name: string, input: Record<string, unknown>) => {
        if (name === 'runtime.request') paths.push(String(input.path));
        return host.call(name, input);
      } } },
      './model': model, './runtime-scope': scopeCore,
    };
    const exports = {};
    const output = ts.transpileModule(source('runtime.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
    vm.runInNewContext(output, { exports, require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected runtime dependency ' + id); return modules[id]; } });
    const runtime = exports as typeof import('./runtime');
    const snapshot = await runtime.connections();
    expect(snapshot.runtimeScope).not.toBeNull();
    expect(snapshot.runtimeScope?.hostID).toBe(snapshot.selected);
    return { send: runtime.bindRequest(snapshot.runtimeScope), paths, host, runtime, snapshot };
  };
  it('serves the Summary location-less catalog and accepts the selected real model without touching prompts', async () => {
    const { send, paths } = await setup();
    const before = settingsObject(await send('/api/config/settings'));
    const models = await readSettingsModels(send, before);
    expect(models.map(item => [item.providerID, item.modelID])).toEqual([['fixture', 'model']]);
    expect(paths).toContain('/api/config/catalog/providers');
    await send('/api/config/settings', 'PUT', { summaryModelMode: 'provider', summaryProviderID: 'fixture', summaryModelID: 'model' });
    expect(await send('/api/config/settings')).toMatchObject({ summaryModelID: 'model', summaryCommitPrompt: 'Preserved prompt' });
  });
  it('serves the scoped Sessions model/variant/Agent catalogs used by the real selectors', async () => {
    const { send, paths } = await setup();
    const preferences = settingsObject(await send('/api/config/settings'));
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
  it('rejects reads before issuing a snapshot and rejects wrong captured scope for reads and writes', async () => {
    const unopened = createHost();
    expect(() => unopened.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: { hostID: 'outer-settings-fixture', lease: 'synthetic-settings-lease-1' } })).toThrow('snapshot not issued');
    const { host, runtime, snapshot } = await setup();
    const wrongLease = runtime.bindRequest({ ...snapshot.runtimeScope!, lease: 'wrong-synthetic-lease' });
    const wrongHost = runtime.bindRequest({ ...snapshot.runtimeScope!, hostID: 'other-synthetic-host' });
    await expect(wrongLease('/api/config/settings')).rejects.toThrow('Stale synthetic scope forwarding');
    await expect(wrongHost('/api/config/settings', 'PUT', { defaultAgent: 'visible-subagent' })).rejects.toThrow('Stale synthetic scope forwarding');
    expect(host.call('settings.fixture.scopeAudit', {})).toMatchObject({ lists: 1, admitted: 0, rejected: 2, runtimeScope: snapshot.runtimeScope });
  });
});
