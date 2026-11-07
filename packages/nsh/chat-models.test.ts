import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, fixture: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'nsh-model-picker-'));
  fixture = path.join(temporary, 'host.js');
  // NSH's headless host is one self-contained entry, without URL or module-loader APIs.
  writeFileSync(fixture, `export function createHost() {
    let selection = { providerID: 'fixture', id: 'current', variant: 'low' };
    let agent = 'build', recentFailed = false, modelWrites = 0;
    let settings = { unrelated: 'preserve', hiddenModels: [{ providerID: 'fixture', modelID: 'hidden' }], favoriteModels: [], recentModels: [{ providerID: 'other', modelID: 'second', variant: 'high' }] };
    return { call(name, input) {
      if (name === 'fixture.nativeModal') return false;
      if (name !== 'runtime.request') throw new Error('Unexpected bridge call');
      if (input.method !== 'GET' && (input.expectedHost?.hostID !== 'fixture-host' || input.expectedHost?.lease !== 'fixture-lease')) throw new Error('Missing synthetic write authority');
      const pathname = input.path.split('?')[0];
      if (pathname === '/api/config/catalog/providers') return { status: 200, body: { schemaVersion: 1, providers: [
        { id: 'fixture', name: 'Fixture provider', models: { current: { id: 'current', name: 'Current native model', variants: { low: {}, high: {} }, capabilities: { reasoning: true, toolcall: true, input: { image: true, pdf: true } }, limit: { context: 400000 } }, hidden: { id: 'hidden', name: 'Hidden model' } } },
        { id: 'other', name: 'Other provider', models: { second: { id: 'second', name: 'Second native model', variants: { low: {}, high: {} } } } },
        { id: 'openai', name: 'OpenAI', models: { overflow: { id: 'overflow', name: 'Overflow model', variants: Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'one', 'two', 'three', 'four', 'ultra'].map(key => [key, {}])) } } }
      ] } };
      if (pathname === '/api/agent') return { status: 200, body: [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }, { name: 'hidden-agent', hidden: true }, { name: 'child', mode: 'subagent' }] };
      if (pathname === '/api/session/test-session') return { status: 200, body: { id: 'test-session', model: selection, agent } };
      if (pathname === '/api/session/test-session/model') {
        modelWrites++;
        if (modelWrites > 1) throw new Error('Selection must not be resent after recent failure');
        selection = input.body.model;
        if (!(selection.id === 'second' && selection.providerID === 'other' && selection.variant === 'high') && !(selection.id === 'overflow' && selection.providerID === 'openai' && selection.variant === 'ultra')) throw new Error('Wrong exact model or remembered variant');
        return { status: 200, body: {} };
      }
      if (pathname === '/api/session/test-session/agent') {
        if (input.body.agent !== 'plan' || input.body.model) throw new Error('Wrong independent agent write');
        agent = input.body.agent; return { status: 200, body: {} };
      }
      if (pathname === '/api/config/settings') {
        if (input.method === 'PUT') {
          if (Object.keys(input.body).some(key => key !== 'favoriteModels' && key !== 'recentModels')) throw new Error('Unrelated settings overwrite');
          if (input.body.recentModels && !recentFailed) { recentFailed = true; return { status: 503, body: { message: 'Retry recent only' } }; }
          settings = { ...settings, ...input.body };
        }
        return { status: 200, body: settings };
      }
      throw new Error('Unexpected picker wire ' + pathname);
    } };
  }`);
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'chat-models-fixture.tsx', '--web-host', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
test('native sheet embeds without tabs, filters hidden rows, expands provider and effort separately, and persists favorites', () => {
  run([
    'await app.press("id:open-model");',
    'await app.waitFor("id:model-fixture-current");',
    'expect(app.texts()).toContain("400k ctx");',
    'expect(app.spanStyle("id:model-provider-group-fixture >> text:400k ctx").fontSize).toBe(13);',
    'expect(app.spanStyle("id:model-provider-group-fixture >> text:Current native model").fontSize).toBe(14);',
    'expect(app.spanStyle("id:model-provider-group-fixture >> text:Current native model").fontWeight).toBe(500);',
    'expect(app.shows("id:model-fixture-hidden")).toBe(false);',
    'await app.press("id:model-provider-fixture");',
    'await app.press("id:model-provider-other");',
    'await app.press("id:model-provider-group-other >> id:model-variant-other-second");',
    'await app.waitFor("id:model-provider-group-other >> id:model-effort-other-second-high");',
    'await app.press("id:model-provider-group-other >> id:model-favorite-other-second");',
    'await app.waitFor("text:Favorites");',
    'await app.back();',
    'await app.waitFor("id:open-model");',
    'await app.press("id:open-model");',
    'await app.waitFor("text:Favorites");',
    'await app.type("id:model-search", "second");',
    'await app.waitUntil(() => !app.shows("id:model-fixture-current"));',
    'expect(app.texts()).toContain("Second native model");',
    'await app.press("id:model-search-clear");',
    'expect(app.value("id:model-search")).toBe("");',
    'await app.waitFor("id:model-fixture-current");',
  ]);
}, 75_000);
test('Chinese context has no number-unit whitespace and uses the mobile metadata text size', () => {
  run([
    'await app.press("id:fixture-chinese");',
    'await app.press("id:open-model");',
    'await app.waitFor("text:40万 ctx");',
    'expect(app.texts()).not.toContain("40 万 ctx");',
    'expect(app.spanStyle("id:model-provider-group-fixture >> text:40万 ctx").fontSize).toBe(13);',
  ]);
}, 75_000);
test('recent-write failure restores authoritative selection and retry never resends the successful model write', () => {
  run([
    'await app.press("id:open-model");',
    'await app.waitFor("id:model-other-second");',
    'await app.press("id:model-other-second");',
    'await app.waitFor("text:HTTP 503: Retry recent only");',
    'await app.waitUntil(() => app.enabled("id:model-picker-retry"));',
    'await app.press("id:model-picker-retry");',
    'await app.waitFor("id:open-model");',
  ]);
}, 75_000);
test('agent sheet has no model tab and writes agent independently', () => {
  run([
    'await app.press("id:open-agent");',
    'await app.waitFor("id:model-agent-plan");',
    'expect(app.shows("id:model-agent-hidden-agent")).toBe(false);',
    'expect(app.shows("id:model-agent-child")).toBe(false);',
    'expect(app.shows("id:model-provider-fixture")).toBe(false);',
    'await app.press("id:model-agent-plan");',
    'await app.waitFor("id:open-agent");',
  ]);
}, 75_000);
test('overflow has seven inline variants plus Default, a full secondary list, back and close; choosing retries recents only', () => {
  run([
    'await app.press("id:open-model");',
    'await app.waitFor("id:model-provider-openai");',
    'expect(app.shows("id:provider-logo-openai")).toBe(true);',
    'await app.press("id:model-provider-openai");',
    'await app.press("id:model-provider-group-openai >> id:model-variant-openai-overflow");',
    'await app.waitFor("id:model-effort-openai-overflow-more");',
    'expect(app.shows("id:model-effort-openai-overflow-three")).toBe(true);',
    'expect(app.shows("id:model-effort-openai-overflow-four")).toBe(false);',
    'await app.press("id:model-effort-openai-overflow-more");',
    'await app.waitFor("id:model-variant-option-ultra");',
    'expect(app.shows("id:model-search")).toBe(false);',
    'await app.press("id:model-variant-back");',
    'await app.waitFor("id:model-search");',
    'await app.press("id:model-effort-openai-overflow-more");',
    'await app.press("id:model-variant-option-ultra");',
    'await app.waitFor("text:HTTP 503: Retry recent only");',
    'await app.waitUntil(() => app.enabled("id:model-picker-retry"));',
    'await app.press("id:model-picker-retry");',
    'await app.waitFor("id:open-model");',
  ]);
}, 75_000);
test('new-session picker uses the same branded overflow page, search clear and recent-write retry without session writes', () => {
  run([
    'await app.press("id:open-new-model");',
    'await app.waitFor("id:new-session-provider-openai");',
    'await app.type("id:new-session-selection-search", "overflow");',
    'await app.waitFor("id:new-session-all-model-openai-overflow");',
    'await app.press("id:new-session-effort-all-openai-overflow");',
    'await app.waitFor("id:new-session-variant-all-openai-overflow-more");',
    'await app.press("id:new-session-search-clear");',
    'expect(app.value("id:new-session-selection-search")).toBe("");',
    'expect(app.shows("id:new-session-variant-all-openai-overflow-more")).toBe(false);',
    'await app.press("id:new-session-provider-openai");',
    'await app.press("id:new-session-effort-all-openai-overflow");',
    'await app.press("id:new-session-variant-all-openai-overflow-more");',
    'await app.waitFor("id:new-session-variant-option-ultra");',
    'await app.press("id:model-variant-back");',
    'await app.waitFor("id:new-session-selection-search");',
    'await app.press("id:new-session-variant-all-openai-overflow-more");',
    'await app.press("id:new-session-variant-option-ultra");',
    'await app.waitUntil(() => app.shows("id:new-session-catalog-retry") && app.enabled("id:new-session-catalog-retry"));',
    'await app.press("id:new-session-catalog-retry");',
    'await app.waitFor("id:open-new-model");',
  ]);
}, 75_000);
