import { describe, expect, it } from 'vitest';
import { createBotCreationContext, readBotCreationDefaults, resolveBotDefaultModel } from './features-bot-defaults';
import { featureFixture, settle } from './tests/features-fixture';

const providers = [{ id: 'z', models: { second: { id: 'second' }, first: { id: 'first' } } }];
const current = { providerID: 'selected', modelID: 'actual', variant: 'medium' };
describe('Bot creation Web defaults', () => {
  it('captures only a real composer context and rejects it after a Host generation change', () => {
    let generation = 1;
    const context = createBotCreationContext(() => generation);
    expect(context.snapshot()).toBeUndefined();
    context.update('/workspace/actual', current, 'plan');
    const snapshot = context.snapshot()!;
    expect(snapshot).toEqual({ directory: '/workspace/actual', selection: current, agent: 'plan' });
    snapshot.selection!.modelID = 'must-not-change-authority';
    expect(context.snapshot()?.selection?.modelID).toBe('actual');
    context.update('/workspace/other');
    expect(context.snapshot()).toEqual({ directory: '/workspace/other' });
    generation++;
    expect(context.snapshot()).toBeUndefined();
    expect(snapshot.directory).toBe('/workspace/actual');
  });
  it('prefers settings including inline variant, then settings variant', () => {
    expect(resolveBotDefaultModel({ settings: { defaultModel: 'p/model#high', defaultVariant: 'low' }, providers, current })).toEqual({ providerID: 'p', modelID: 'model', variant: 'high' });
    expect(resolveBotDefaultModel({ settings: { defaultModel: 'p/model', defaultVariant: 'low' }, providers, current })).toEqual({ providerID: 'p', modelID: 'model', variant: 'low' });
  });
  it('uses actual selection before OpenCode, never recent/favorite/provider default guesses', () => {
    expect(resolveBotDefaultModel({ settings: { recentModels: [{ providerID: 'wrong', modelID: 'wrong' }] }, providers, current, opencodeDefaultModel: 'config/other#x' })).toEqual(current);
    expect(resolveBotDefaultModel({ settings: {}, providers, opencodeDefaultModel: 'config/other#x' })).toEqual({ providerID: 'config', modelID: 'other', variant: 'x' });
  });
  it('matches invalid/empty settings behavior and ordered catalog fallback', () => {
    expect(resolveBotDefaultModel({ settings: { defaultModel: 'invalid' }, current, providers, opencodeDefaultModel: 'config/other' })).toEqual(current);
    expect(resolveBotDefaultModel({ settings: { defaultModel: '' }, providers, opencodeDefaultModel: 'config/other' })).toEqual({ providerID: 'z', modelID: 'second' });
    expect(resolveBotDefaultModel({ settings: {}, providers: [{ id: 'first', models: [] }, { id: 'next', models: [{ id: 'actual-first' }] }] })).toEqual({ providerID: 'next', modelID: 'actual-first' });
    expect(resolveBotDefaultModel({ settings: {}, providers: [] })).toBeNull();
  });
  it('reads real document ordering and first-name snapshot, with exact supplied directory only', async () => {
    const paths: string[] = [];
    const send = async (path: string) => {
      paths.push(path);
      if (path === '/api/config/settings/bootstrap') return { schemaVersion: 1, defaultVariant: 'settings-effort' };
      if (path.startsWith('/api/config?')) return [{ type: 'document', info: { model: 'old/model' } }, { type: 'directory', info: { model: 'not-config/model' } }, { type: 'document', info: { model: 'new/model#effort' } }];
      if (path.startsWith('/api/config/catalog')) return { schemaVersion: 1, providers };
      return { assistants: [] };
    };
    expect(await readBotCreationDefaults(send, { directory: '/workspace/selected' })).toEqual({ name: 'Yuri', model: { providerID: 'new', modelID: 'model', variant: 'effort' } });
    expect(paths).toEqual(['/api/config/settings/bootstrap', '/api/config?location%5Bdirectory%5D=%2Fworkspace%2Fselected', '/api/config/catalog/providers?directory=%2Fworkspace%2Fselected', '/api/yuri/assistants/snapshot']);
  });
  it('does not infer first project/current model, and only names the first bot', async () => {
    const paths: string[] = [];
    const result = await readBotCreationDefaults(async path => {
      paths.push(path);
      if (path === '/api/config/settings/bootstrap') return { schemaVersion: 1, projects: [{ path: '/must-not-read' }] };
      if (path === '/api/config') return [];
      if (path.includes('catalog')) return { schemaVersion: 1, providers: [] };
      return { assistants: [{ id: 'existing' }] };
    });
    expect(result).toEqual({ name: '', model: null });
    expect(paths).not.toContainEqual(expect.stringContaining('must-not-read'));
  });
  it('does not treat partial/failed snapshot or config as empty authority', async () => {
    await expect(readBotCreationDefaults(async path => {
      if (path === '/api/config/settings/bootstrap') return { schemaVersion: 1 };
      if (path === '/api/config') return [];
      if (path.includes('catalog')) return { schemaVersion: 1, providers: [], partial: true };
      return { assistants: [], partial: true };
    })).rejects.toThrow();
    await expect(readBotCreationDefaults(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
  it('production BotEditor saves resolved defaults without touching a Host setting', async () => {
    const f = featureFixture({ request: async call => {
      if (call.path === '/api/config/settings/bootstrap') return { schemaVersion: 1, defaultModel: 'provider/model#high' };
      if (call.path === '/api/config') return [];
      if (call.path.includes('catalog')) return { schemaVersion: 1, providers: [{ id: 'provider', models: { model: { id: 'model', variants: { high: {} } } } }] };
      if (call.path.endsWith('/snapshot')) return { assistants: [] };
      if (call.path === '/api/yuri/assistants' && call.method === 'POST') return { id: 'created', revision: 1 };
      throw new Error('Unexpected wire');
    } });
    const root = f.element('bot'); await settle();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.calls.find(call => call.method === 'POST')?.body).toMatchObject({ name: 'Yuri', providerID: 'provider', modelID: 'model', variant: 'high', workspacePath: null });
    expect(f.calls.some(call => call.path === '/api/config/settings' && call.method !== 'GET')).toBe(false);
  });
  it('resolved creation defaults are pristine, so Cancel does not show unsaved confirmation', async () => {
    const f = featureFixture({ request: async call => {
      if (call.path === '/api/config/settings/bootstrap') return { schemaVersion: 1, defaultModel: 'provider/model#high' };
      if (call.path === '/api/config') return [];
      if (call.path.includes('catalog')) return { schemaVersion: 1, providers: [] };
      return { assistants: [] };
    } });
    const root = f.element('bot'); await settle();
    const button = f.find(root, node => node.props.testID === 'features-bot-cancel');
    (button.props.onPress as () => void)(); await settle();
    expect(f.dialogs).toHaveLength(0); expect(f.done()).toBe(1);
  });
  it('does not overwrite a user name typed before the defaults response, nor apply an old Host response', async () => {
    let finish!: (value: unknown) => void;
    const f = featureFixture({ request: async call => {
      if (call.path === '/api/config/settings/bootstrap') return new Promise(resolve => { finish = resolve; });
      if (call.path === '/api/config') return [];
      if (call.path.includes('catalog')) return { schemaVersion: 1, providers: [] };
      if (call.path.endsWith('/snapshot')) return { assistants: [] };
      return { id: 'created', revision: 1 };
    } });
    const root = f.element('bot');
    await settle();
    (f.find(root, node => node.props.testID === 'features-bot-name').props.onChange as (value: { value: string }) => void)({ value: 'My bot' });
    finish({ schemaVersion: 1, defaultModel: 'provider/model' }); await settle();
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.calls.find(call => call.method === 'POST')?.body).toMatchObject({ name: 'My bot' });
    const old = featureFixture({ request: async call => call.path === '/api/config/settings/bootstrap' ? new Promise(resolve => { finish = resolve; }) : call.path === '/api/config' ? [] : call.path.includes('catalog') ? { schemaVersion: 1, providers: [] } : { assistants: [] } });
    const oldRoot = old.element('bot'); await settle(); old.changeHost(); finish({ schemaVersion: 1, defaultModel: 'provider/model' }); await settle();
    (oldRoot.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(old.calls.some(call => call.method !== 'GET')).toBe(false);
  });
});
