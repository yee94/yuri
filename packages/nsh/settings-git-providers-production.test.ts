import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as protocol from './settings-protocol';
import * as model from './model';
import * as custom from '../web/shared/custom-provider-protocol';
import * as removal from './settings-provider-removal';
import { nativeLayoutDensity } from './native-density';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
type Node = { type: string; props: Record<string, any>; children: any[] };
// Inert native boundary; evaluate production JSX attributes lazily as NSH does.
function fixture(kind: 'git' | 'providers') {
  let observer: (() => void) | null = null;
  const pending = new Set<() => void>();
  function signal<T>(initial: T) {
    let value = initial; const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, { set(next: T) {
      if (Object.is(next, value)) return; value = next;
      for (const run of subscribers) if (!pending.has(run)) { pending.add(run); queueMicrotask(() => { pending.delete(run); run(); }); }
    } });
  }
  const effect = (work: () => void) => { const run = () => { const prior = observer; observer = run; try { work(); } finally { observer = prior; } }; run(); };
  const untracked = <T>(work: () => T) => { const prior = observer; observer = null; try { return work(); } finally { observer = prior; } };
  const active = signal(true), generation = signal(1), foreground = signal(true);
  const connection = signal({ id: 'synthetic', url: 'https://synthetic.invalid', authorizationID: 'synthetic' });
  let identities: model.Row[] = [], providers: model.Row[] = [], preferences: model.Row = {};
  const calls: Array<{ path: string; method: string; body: any }> = [];
  let respond: ((path: string, method: string, body: any) => Promise<unknown>) | null = null;
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    calls.push({ path, method, body });
    if (respond) { const result = await respond(path, method, body); if (result !== undefined) return result; }
    if (path === '/api/git/identities') {
      if (method === 'POST') { identities = [...identities, body as model.Row]; return body; }
      return identities;
    }
    if (path.startsWith('/api/git/identities/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      if (method === 'DELETE') { identities = identities.filter(row => row.id !== id); return { success: true }; }
      identities = identities.map(row => row.id === id ? body as model.Row : row); return body;
    }
    if (path === '/api/git/global-identity') return {};
    if (path === '/api/config/settings') { if (method === 'PUT') preferences = { ...preferences, ...body as object }; return preferences; }
    if (path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers };
    if (path === '/api/config/providers/custom') { const b = body as any; providers = [...providers, { ...b.config, id: b.providerId || 'generated' }]; return { providerId: b.providerId || 'generated' }; }
    throw new Error('Unexpected synthetic route: ' + path);
  };
  const captureHostOperation = () => { const captured = generation(); return { generation: captured, scope: { hostID: 'synthetic', lease: String(captured) }, current: () => captured === generation() && foreground(), request }; };
  const modules: Record<string, unknown> = {
    './appearance': { nativeDensity: () => nativeLayoutDensity() },
    nsh: { signal, effect, untracked, cleanup() {}, lifecycle: () => foreground() ? 'active' : 'inactive', Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', Input: 'Input', Switch: 'Switch', AlertDialog: { show: async () => ({ action: 'delete' }) } },
    './native-select': { NativeSelect: 'Select' }, './native-sheet': { NativeSheet: 'Sheet' },
    './i18n': { t: (key: string) => key }, './model': model, './settings-protocol': protocol,
    './state': { captureHostOperation, captureHostRequest: () => request, epoch: generation, app: { connection, runtimeScope: () => null } },
    './settings-github': { SettingsGitHub: 'GitHub' }, './settings-git-credentials': { SettingsGitCredentials: 'Credentials', credentialColors: ['keyword', 'error', 'string', 'function', 'type'], credentialIcons: ['branch', 'briefcase', 'house', 'graduation', 'code'] },
    './settings-search-core': { createSettingsTargetNavigation: () => ({ onScroll() {}, reveal() {} }) },
    '../web/shared/custom-provider-protocol': custom, './settings-provider-removal': removal,
    './settings-integration': { SettingsIntegration: 'Integration' }, './settings-quota-credentials': { SettingsQuotaCredentials: 'Quota' },
    './settings-quota-credentials-core': { quotaCredentialProviderFor: () => null },
  };
  function evaluate(filename: string): any {
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
      transformers: { after: [context => source => {
        const visit: ts.Visitor = node => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'jsx') {
            const args = node.arguments.map(arg => ts.visitNode(arg, visit) as ts.Expression);
            if (args[1] && ts.isObjectLiteralExpression(args[1])) args[1] = ts.factory.updateObjectLiteralExpression(args[1], args[1].properties.map(prop => ts.isPropertyAssignment(prop)
              ? ts.factory.createGetAccessorDeclaration(undefined, prop.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(prop.initializer)])) : prop));
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, args);
          }
          return ts.visitEachChild(node, visit, context);
        }; return ts.visitNode(source, visit) as ts.SourceFile;
      }] },
    }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, jsx: (type: string, props: Node['props'], ...children: any[]) => ({ type, props: props || {}, children }), If: 'If', Each: 'Each', require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected import ' + id); return modules[id]; } });
    return exports;
  }
  const controls = evaluate('settings-controls.tsx');
  for (const name of ['SettingsInput', 'SettingsChoice', 'SettingsToggle', 'SettingsGroup', 'SettingsFeedback']) controls[name] = name;
  modules['./settings-controls'] = controls;
  const Page = evaluate(`settings-${kind}.tsx`)[kind === 'git' ? 'SettingsGit' : 'SettingsProviders'];
  const pages: Node[] = [], backs: string[] = [];
  const open = (route: model.Row = {}) => { const tree = Page({ ...route, get active() { return active(); }, onBack: () => backs.push('back'), onOpen() {} }); pages.push(tree); return tree; };
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('props' in value)) return [];
    if (value.type === 'If' && !value.props.when) return [];
    if (value.type === 'Each') return value.props.of.flatMap((item: unknown) => nodes(value.children[0](() => item)));
    return [value, ...value.children.flatMap(nodes)];
  }
  const find = (tree: Node, id: string) => { const node = nodes(tree).find(item => item.props.testID === id); if (!node) throw new Error('Missing production control ' + id); return node; };
  return { open, active, generation, foreground, connection, calls, backs, find, nodes, setResponse: (next: typeof respond) => { respond = next; },
    setPreferences: (next: model.Row) => { preferences = next; },
    setIdentities: (next: model.Row[]) => { identities = next; }, setProviders: (next: model.Row[]) => { providers = next; },
    press: (tree: Node, id: string) => find(tree, id).props.onPress(), change: (tree: Node, id: string, value: unknown) => find(tree, id).props.onChange(value),
  };
}

it('ordinary Git creates one stable ID, clears irrelevant authentication metadata and notifies retained parent', async () => {
  const f = fixture('git'), parent = f.open(), editor = f.open({ create: true }); await flush();
  f.change(editor, 'settings-git-userName', ' Ada '); f.change(editor, 'settings-git-userEmail', ' ada@example.invalid ');
  f.change(editor, 'settings-git-sshKey', '/synthetic/key'); f.change(editor, 'settings-git-auth', 'token'); f.change(editor, 'settings-git-host', ' github.com ');
  f.change(editor, 'settings-git-color', 'error'); f.change(editor, 'settings-git-icon', 'house');
  f.press(editor, 'settings-git-save'); await flush();
  const writes = f.calls.filter(call => call.method === 'POST'); expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ id: expect.stringMatching(/^profile-/), name: 'Ada', userName: 'Ada', userEmail: 'ada@example.invalid', host: 'github.com', sshKey: null, color: 'error', icon: 'house' });
  expect(f.backs).toHaveLength(1); expect(f.nodes(parent).some(node => node.children.includes('Ada'))).toBe(true);
  f.press(editor, 'settings-git-save'); await flush(); expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

it('unknown Git create is reconciled by read only across lane replacement; stale pre-save reads cannot roll back ACK', async () => {
  const f = fixture('git'), editor = f.open({ create: true }); await flush();
  f.change(editor, 'settings-git-userName', 'Ada'); f.change(editor, 'settings-git-userEmail', 'ada@example.invalid');
  let saved: any;
  f.setResponse(async (_path, method, body) => { if (method === 'POST') { saved = body; throw new Error('Synthetic lost ACK'); } return []; });
  f.press(editor, 'settings-git-save'); await flush(); f.press(editor, 'settings-git-save'); await flush();
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(f.backs).toHaveLength(0);
  f.setResponse(null); f.setIdentities([saved]); f.generation.set(2); await flush();
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(f.backs).toHaveLength(1);
});

it('Provider model sheet guards every native dismissal channel while save is pending', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', name: 'Fixture', models: { coder: { name: 'Coder', capabilities: { toolcall: true, reasoning: true, input: { text: true, image: true } }, limit: { context: 32000, output: 4000 } } } }]);
  const page = f.open({ entity: 'fixture' }); await flush();
  f.press(page, 'settings-provider-edit-coder');
  let finish!: (value: unknown) => void; f.setResponse(async () => new Promise(resolve => { finish = resolve; }));
  f.press(page, 'settings-provider-model-save'); await flush();
  const sheet = f.find(page, 'settings-provider-model-sheet');
  expect(sheet.props.closeOnSwipe).toBe(false); expect(sheet.props.closeOnEscape).toBe(false); expect(sheet.props.closeOnBackdropPress).toBe(false);
  sheet.props.onOpenChange({ open: false }); expect(sheet.props.open).toBe(true);
  finish({}); await flush();
});

it('Provider model rows expose real catalog capabilities and bulk add preserves other providers', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', name: 'Fixture', models: { coder: { name: 'Coder', capabilities: { toolcall: true, reasoning: true, input: { image: true } }, limit: { context: 32000, output: 4000 } } } }]);
  f.setPreferences({ hiddenModels: [{ providerID: 'fixture', modelID: 'coder' }, { providerID: 'other', modelID: 'keep' }] });
  const page = f.open({ entity: 'fixture' }); await flush();
  const texts = f.nodes(page).flatMap(node => node.children).filter(value => typeof value === 'string').join('\n');
  for (const key of ['toolCalling', 'reasoning', 'imageInput']) expect(texts).toContain('settings.providers.page.models.capability.' + key);
  expect(texts).toContain('32K'); expect(texts).toContain('4K');
  f.press(page, 'settings-provider-add-all'); await flush();
  expect(f.calls.find(call => call.method === 'PUT')?.body).toEqual({ hiddenModels: [{ providerID: 'other', modelID: 'keep' }] });
});

it('Provider create ACK publishes catalog revision and repeated Done never repeats POST', async () => {
  const f = fixture('providers'), parent = f.open(), page = f.open({ create: true }); await flush();
  f.change(page, 'settings-provider-name', 'Created'); f.change(page, 'settings-provider-url', 'https://provider.example.invalid/v1');
  f.press(page, 'settings-provider-add-model'); f.change(page, 'settings-provider-model-id', 'coder'); f.press(page, 'settings-provider-model-save'); await flush();
  f.press(page, 'settings-provider-save'); await flush();
  expect(f.nodes(parent).some(node => node.children.includes('Created'))).toBe(true);
  f.press(page, 'settings-provider-save'); await flush(); expect(f.calls.filter(call => call.path === '/api/config/providers/custom' && call.method === 'POST')).toHaveLength(1);
});

it('Git delete lost ACK resumes by GET absence without trying to reload the deleted editor or repeat DELETE', async () => {
  const f = fixture('git'); f.setIdentities([{ id: 'existing', userName: 'Ada', userEmail: 'ada@example.invalid' }]);
  const page = f.open({ entity: 'existing' }); await flush();
  f.setResponse(async (_path, method) => { if (method === 'DELETE') { f.setIdentities([]); throw new Error('Lost delete ACK'); } return []; });
  f.press(page, 'settings-git-delete'); await flush(); f.setResponse(null); f.generation.set(2); await flush();
  expect(f.backs).toHaveLength(1); expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
});

it('Provider unknown create adopts only its stable ID on restored GET, never replays POST', async () => {
  const f = fixture('providers'), page = f.open({ create: true }); await flush();
  f.change(page, 'settings-provider-name', 'Created'); f.change(page, 'settings-provider-url', 'https://provider.example.invalid/v1');
  f.press(page, 'settings-provider-add-model'); f.change(page, 'settings-provider-model-id', 'coder'); f.press(page, 'settings-provider-model-save'); await flush();
  let saved: any;
  f.setResponse(async (_path, method, body) => { if (method === 'POST') { saved = { ...body.config, id: body.providerId }; throw new Error('Lost create ACK'); } throw new Error('Read failed'); });
  f.press(page, 'settings-provider-save'); await flush(); f.setProviders([saved]); f.setResponse(null); f.generation.set(2); await flush();
  f.press(page, 'settings-provider-save'); await flush(); expect(f.backs).toHaveLength(1);
  expect(f.calls.filter(call => call.path === '/api/config/providers/custom' && call.method === 'POST')).toHaveLength(1);
});

it('Provider catalog model edits retain unknown submission; retry reads, never sends a second PUT', async () => {
  const f = fixture('providers'); const original = { id: 'fixture', name: 'Fixture', models: { coder: { name: 'Coder', capabilities: { toolcall: true, input: { text: true } } } } };
  f.setProviders([original]); const page = f.open({ entity: 'fixture' }); await flush();
  f.press(page, 'settings-provider-edit-coder'); f.change(page, 'settings-model-name', 'Edited');
  f.setResponse(async (_path, method) => { if (method === 'PUT') throw new Error('Lost model ACK'); throw new Error('Failed read'); });
  f.press(page, 'settings-provider-model-save'); await flush(); f.press(page, 'settings-provider-model-save'); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  f.setProviders([{ ...original, models: { coder: { ...original.models.coder, name: 'Edited' } } }]); f.setResponse(null); f.generation.set(2); await flush();
  expect(f.find(page, 'settings-provider-model-sheet').props.open).toBe(false);
});

it.each(['git', 'providers'] as const)('%s retained parent queues revision refresh behind an old read and refreshes again on returning to top', async kind => {
  const f = fixture(kind); let release!: (value: unknown) => void; let first = true;
  f.setResponse(async resource => {
    if (first && (resource === '/api/git/identities' || resource.startsWith('/api/config/catalog/providers'))) { first = false; return new Promise(resolve => { release = resolve; }); }
  });
  const parent = f.open(); await flush();
  if (kind === 'git') {
    const page = f.open({ create: true }); await flush(); f.change(page, 'settings-git-userName', 'Created'); f.change(page, 'settings-git-userEmail', 'ada@example.invalid'); f.press(page, 'settings-git-save');
  } else {
    const page = f.open({ create: true }); await flush(); f.change(page, 'settings-provider-name', 'Created'); f.change(page, 'settings-provider-url', 'https://provider.example.invalid/v1');
    f.press(page, 'settings-provider-add-model'); f.change(page, 'settings-provider-model-id', 'coder'); f.press(page, 'settings-provider-model-save'); await flush(); f.press(page, 'settings-provider-save');
  }
  await flush(); release(kind === 'git' ? [] : { schemaVersion: 1, providers: [] }); await flush();
  expect(f.nodes(parent).some(node => node.children.includes('Created'))).toBe(true);
  f.active.set(false); await flush(); const before = f.calls.length; f.active.set(true); await flush(); expect(f.calls.length).toBeGreaterThan(before);
});

it('unknown model visibility PUT retries only GET even when user requests the opposite action', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: { coder: { name: 'Coder' } } }]);
  const page = f.open({ entity: 'fixture' }); await flush();
  f.setResponse(async (resource, method, body) => { if (resource === '/api/config/settings' && method === 'PUT') { f.setPreferences(body); throw new Error('Lost visibility ACK'); } });
  f.press(page, 'settings-provider-toggle-coder'); await flush(); f.press(page, 'settings-provider-add-all'); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

it('acknowledged model edit waits for matching catalog, preserves the submission through stale reads and retries GET only', async () => {
  const f = fixture('providers'); const original = { id: 'fixture', models: { coder: { name: 'Coder', capabilities: { toolcall: true, input: { text: true } } } } };
  f.setProviders([original]); const page = f.open({ entity: 'fixture' }); await flush();
  f.press(page, 'settings-provider-edit-coder'); f.change(page, 'settings-model-name', 'Edited');
  f.setResponse(async (_resource, method) => method === 'PUT' ? { providerId: 'fixture', modelId: 'coder' } : undefined);
  f.press(page, 'settings-provider-model-save'); await flush(); expect(f.find(page, 'settings-provider-model-sheet').props.open).toBe(true);
  f.change(page, 'settings-model-name', 'Must not replace submission');
  expect(f.find(page, 'settings-model-name').props.value).toBe('Edited');
  f.setProviders([{ ...original, models: { coder: { ...original.models.coder, name: 'Edited' } } }]);
  f.press(page, 'settings-provider-model-save'); await flush(); expect(f.find(page, 'settings-provider-model-sheet').props.open).toBe(false);
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

it.each(['git', 'providers'] as const)('%s old production callbacks cannot dispatch after Host A → B → A', async kind => {
  const f = fixture(kind), page = f.open({ create: true }); await flush();
  const callback = f.find(page, kind === 'git' ? 'settings-git-save' : 'settings-provider-save').props.onPress;
  f.connection.set({ id: 'other', url: 'https://other.invalid', authorizationID: 'other' }); await flush();
  f.connection.set({ id: 'synthetic', url: 'https://synthetic.invalid', authorizationID: 'synthetic' }); f.generation.set(2); await flush();
  const count = f.calls.length; callback(); await flush(); expect(f.calls).toHaveLength(count); expect(f.backs).toHaveLength(0);
});

it('fifty model filter updates perform no network or model writes', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: Object.fromEntries(Array.from({ length: 500 }, (_, index) => ['model-' + index, { name: 'Model ' + index, capabilities: { toolcall: true } }])) }]);
  const page = f.open({ entity: 'fixture' }); await flush(); const count = f.calls.length;
  for (let i = 0; i < 50; i++) { f.change(page, 'settings-provider-filter', 'model-' + i); f.nodes(page); }
  await flush(); expect(f.calls).toHaveLength(count);
});

it.each(['edit', 'delete'] as const)('ordinary Git %s ACK refreshes the already mounted parent list', async action => {
  const f = fixture('git'); f.setIdentities([{ id: 'existing', name: 'Before', userName: 'Ada', userEmail: 'ada@example.invalid', authType: 'ssh' }]);
  const parent = f.open(), page = f.open({ entity: 'existing' }); await flush();
  if (action === 'edit') { f.change(page, 'settings-git-name', 'After'); f.press(page, 'settings-git-save'); }
  else f.press(page, 'settings-git-delete');
  await flush(); const texts = f.nodes(parent).flatMap(node => node.children);
  expect(texts.includes('Before')).toBe(false); expect(texts.includes('After')).toBe(action === 'edit'); expect(f.backs).toHaveLength(1);
});

it.each([false, true])('Provider recovery only clears its in-memory key when the captured stable ID is found (matched=%s)', async matched => {
  const f = fixture('providers'), page = f.open({ create: true }); await flush();
  f.change(page, 'settings-provider-name', 'Created'); f.change(page, 'settings-provider-url', 'https://provider.example.invalid/v1');
  const key = () => f.nodes(page).find(node => node.props.title === 'settings.voice.page.field.apiKey')!;
  key().props.onChange('synthetic-key'); f.press(page, 'settings-provider-add-model'); f.change(page, 'settings-provider-model-id', 'coder'); f.press(page, 'settings-provider-model-save'); await flush();
  let submitted: any;
  f.setResponse(async (_path, method, body) => { if (method === 'POST') { submitted = body; throw new Error('Lost ACK'); } });
  f.press(page, 'settings-provider-save'); await flush();
  expect(Object.keys(submitted).sort()).toEqual(['apiKey', 'config', 'directory', 'providerId']); expect(submitted.providerId).toMatch(/^custom-[a-z0-9-]+$/);
  f.setProviders([{ ...submitted.config, id: matched ? submitted.providerId : 'another-provider' }]); f.setResponse(null); f.generation.set(2); await flush();
  expect(key().props.value).toBe(matched ? '' : 'synthetic-key'); f.press(page, 'settings-provider-save'); await flush();
  expect(f.backs).toHaveLength(matched ? 1 : 0); expect(f.calls.filter(call => call.path === '/api/config/providers/custom' && call.method === 'POST')).toHaveLength(1);
});

it('model names longer than the Host limit are rejected locally with zero PUT and remain editable', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: { coder: { name: 'Coder' } } }]);
  const page = f.open({ entity: 'fixture' }); await flush(); f.press(page, 'settings-provider-edit-coder');
  f.change(page, 'settings-model-name', 'x'.repeat(1025)); f.press(page, 'settings-provider-model-save'); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  expect(f.find(page, 'settings-model-name').props.disabled).toBe(false);
  f.change(page, 'settings-model-name', 'Corrected'); expect(f.find(page, 'settings-model-name').props.value).toBe('Corrected');
});

it.each(['code', 'current-wire'] as const)('explicit model validation rejection (%s) releases only the rejected attempt and allows one corrected PUT', async shape => {
  const f = fixture('providers'); const original = { id: 'fixture', models: { coder: { name: 'Coder', capabilities: { toolcall: true, input: { text: true } } } } };
  f.setProviders([original]); const page = f.open({ entity: 'fixture' }); await flush(); f.press(page, 'settings-provider-edit-coder');
  f.change(page, 'settings-model-name', 'Rejected draft');
  f.setResponse(async (_resource, method) => { if (method === 'PUT') throw shape === 'code' ? Object.assign(new Error('INVALID_MODEL'), { status: 400, code: 'INVALID_MODEL' }) : Object.assign(new Error('HTTP 400: Unable to save provider model'), { status: 400 }); });
  f.press(page, 'settings-provider-model-save'); await flush();
  expect(f.find(page, 'settings-provider-model-sheet').props.open).toBe(true);
  expect(f.find(page, 'settings-model-name').props.value).toBe('Rejected draft'); expect(f.find(page, 'settings-model-name').props.disabled).toBe(false);
  f.change(page, 'settings-model-name', 'Corrected'); expect(f.find(page, 'settings-model-name').props.value).toBe('Corrected');
  f.setResponse(async (_resource, method, body) => {
    if (method !== 'PUT') return;
    expect(body.name).toBe('Corrected'); f.setProviders([{ ...original, models: { coder: { ...original.models.coder, name: body.name } } }]);
    return { providerId: 'fixture', modelId: 'coder' };
  });
  f.press(page, 'settings-provider-model-save'); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(2); expect(f.find(page, 'settings-provider-model-sheet').props.open).toBe(false);
});

it.each(['generic-400', 'invalid-model-500', 'network'] as const)('model %s failures retain the unknown submission and retry only GET', async shape => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: { coder: { name: 'Coder' } } }]);
  const page = f.open({ entity: 'fixture' }); await flush(); f.press(page, 'settings-provider-edit-coder'); f.change(page, 'settings-model-name', 'Unknown draft');
  f.setResponse(async (_resource, method) => { if (method === 'PUT') throw shape === 'generic-400' ? Object.assign(new Error('Other rejection'), { status: 400 }) : shape === 'invalid-model-500' ? Object.assign(new Error('INVALID_MODEL'), { status: 500, code: 'INVALID_MODEL' }) : new Error('Network lost ACK'); });
  f.press(page, 'settings-provider-model-save'); await flush();
  expect(f.find(page, 'settings-model-name').props.disabled).toBe(true); f.change(page, 'settings-model-name', 'Must stay unknown');
  expect(f.find(page, 'settings-model-name').props.value).toBe('Unknown draft');
  f.press(page, 'settings-provider-model-save'); await flush(); expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

it('visibility preflight GET failure submits no PUT; explicit retry removes and adds through real settings PUTs', async () => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: { coder: { name: 'Coder' } } }]);
  f.setPreferences({ hiddenModels: [{ providerID: 'other', modelID: 'keep' }] });
  const page = f.open({ entity: 'fixture' }); await flush();
  f.setResponse(async (resource, method) => { if (resource === '/api/config/settings' && method === 'GET') throw Object.assign(new Error('HTTP 500: Failed to read settings'), { status: 500 }); });
  f.press(page, 'settings-provider-toggle-coder'); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  expect(f.find(page, 'settings-provider-toggle-coder').children[0].children).toContain('−');
  f.setResponse(null); f.press(page, 'settings-provider-toggle-coder'); await flush();
  expect(f.find(page, 'settings-provider-toggle-coder').children[0].children).toContain('+');
  expect(f.calls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ hiddenModels: [{ providerID: 'other', modelID: 'keep' }, { providerID: 'fixture', modelID: 'coder' }] }]);
  f.press(page, 'settings-provider-toggle-coder'); await flush();
  expect(f.find(page, 'settings-provider-toggle-coder').children[0].children).toContain('−');
  expect(f.calls.filter(call => call.method === 'PUT').at(-1)?.body).toEqual({ hiddenModels: [{ providerID: 'other', modelID: 'keep' }] });
});

it.each(['visibility', 'model'] as const)('synthetic %s 409 with no committed value cannot certify a second PUT', async surface => {
  const f = fixture('providers'); f.setProviders([{ id: 'fixture', models: { coder: { name: 'Coder' } } }]);
  const page = f.open({ entity: 'fixture' }); await flush();
  if (surface === 'model') { f.press(page, 'settings-provider-edit-coder'); f.change(page, 'settings-model-name', 'Unconfirmed'); }
  f.setResponse(async (_resource, method) => { if (method === 'PUT') throw Object.assign(new Error(surface === 'model' ? 'HTTP 409: Fixture model conflict' : 'HTTP 409: Fixture visibility conflict'), { status: 409 }); });
  const action = surface === 'model' ? 'settings-provider-model-save' : 'settings-provider-toggle-coder';
  f.press(page, action); await flush(); const afterFailure = f.calls.length;
  f.press(page, action); await flush();
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  expect(f.calls.slice(afterFailure).every(call => call.method === 'GET')).toBe(true);
  if (surface === 'model') {
    expect(f.find(page, 'settings-model-name').props.disabled).toBe(true);
    expect(f.find(page, 'settings-model-name').props.value).toBe('Unconfirmed');
  } else expect(f.find(page, 'settings-provider-toggle-coder').children[0].children).toContain('−');
});
