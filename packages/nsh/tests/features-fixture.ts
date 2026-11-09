import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../model';
import * as cron from '../features-cron';
import * as scheduleDate from '../features-schedule-date';
import * as botDefaults from '../features-bot-defaults';
import * as taskDefaults from '../task-editor-defaults';

type Row = Record<string, unknown>;
type Element = { type: string | ((props: Row) => Element); props: Row; children: unknown[] };
type Request = { path: string; method: string; body?: unknown };
function signal<T>(value: T) {
  const read = () => value;
  read.set = (next: T) => { value = next; };
  return read;
}

/** Node-only callback/DTO fixture. Not an NSH renderer or gesture simulator. */
export function featureFixture(options: {
  bot?: Row; item?: Row;
  request?: (call: Request) => Promise<unknown>;
  refresh?: () => Promise<void>;
  onNavigation?: (requestLeave: ((afterLeave?: () => void) => Promise<void>) | null) => void;
  creationContext?: taskDefaults.TaskEditorCreationContext;
} = {}) {
  const calls: Request[] = [], order: string[] = [], dialogs: Row[] = [], cleanups: (() => void)[] = [];
  let generation = 1, done = 0, answer = 'cancel';
  const app = {
    connection: signal({ id: 'fixture' }),
    projects: signal([{ id: 'project', path: '/first-project', name: 'First project' }]),
    bots: signal<Row[]>([]),
  };
  const providers = [{ id: 'provider', name: 'Provider', models: { model: { id: 'model', variants: { high: {} } } } }];
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const call = { path, method, body }; calls.push(call); order.push(method);
    if (options.request) return options.request(call);
    if (path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers };
    if (path.startsWith('/api/agent')) return { data: [{ id: 'build', name: 'build' }] };
    if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
      if (path.startsWith('/api/yuri/assistants')) return { id: 'bot', revision: 2 };
      return { task: model.record(body).task, schedulerSynced: true };
    }
    if (method === 'DELETE') return { tasks: [] };
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  const h = (type: Element['type'], props: Row | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
  const controls = Object.fromEntries(['AlertDialog', 'Button', 'DatePicker', 'Input', 'NavPage', 'Select', 'Switch', 'TimeField'].map(name => [name, name]));
  const imports: Record<string, unknown> = {
    nsh: { cleanup: (callback: () => void) => cleanups.push(callback), effect: (run: () => void) => run(), locale: () => 'en', signal, computed: (read: () => unknown) => read, Text: 'Text', View: 'View', Scroll: 'Scroll' },
    'nsh/base': { ...controls, AlertDialog: { show: async (options: Row) => { dialogs.push(options); return { action: answer }; } } },
    './native-select': { NativeSelect: 'Select' },
    './native-date-picker': { NativeDatePicker: 'DatePicker' },
    './i18n': { t: (key: string) => key, language: () => 'en' },
    './model': model,
    './runtime': { request, native: async () => { throw new Error('No native date service in callback fixture'); }, query: (directory: string) => `directory=${encodeURIComponent(directory)}` },
    './state': { app, epoch: () => generation, captureHostRequest: () => request, refresh: async () => { order.push('refresh'); await options.refresh?.(); } },
    './assistants-core': { admitAssistantMutation: async () => {} },
    './assistants-avatar': { AssistantAvatarPicker: 'AssistantAvatarPicker' },
    './schedules-state': { noteScheduledCatalogWrite: () => order.push('invalidate') },
    './features-cron': cron,
    './features-schedule-date': scheduleDate,
    './features-bot-defaults': botDefaults,
    './task-editor-defaults': taskDefaults,
    './task-editor-prompt': { TaskEditorPrompt: 'TaskEditorPrompt' },
    './task-editor-owner': {},
    './task-editor-desktop': { TaskEditorDesktop: 'TaskEditorDesktop' },
  };
  const source = readFileSync(fileURLToPath(new URL('../features.tsx', import.meta.url)), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
  const exports: Record<string, (props: Row) => Element> = {};
  vm.runInNewContext(javascript, {
    exports, require: (name: string) => { if (!(name in imports)) throw new Error(`Unmocked import ${name}`); return imports[name]; },
    h, If: 'If', Each: 'Each', Date, Intl, Set, Object, String, Promise, Error,
  }, { filename: 'features.tsx' });
  const element = (kind: 'bot' | 'task') => exports[kind === 'bot' ? 'BotEditor' : 'TaskEditor']({
    bot: options.bot, item: options.item, onDone: () => { done++; }, syncPendingDescription: 'SYNC_PENDING', onNavigation: options.onNavigation, creationContext: options.creationContext,
  });
  const nodes = (element: unknown): Element[] => {
    if (!element || typeof element !== 'object' || !('type' in element)) return [];
    const node = element as Element;
    return [node, ...node.children.flat(Infinity).flatMap(nodes)];
  };
  const find = (root: Element, predicate: (node: Element) => boolean) => {
    const node = nodes(root).find(predicate);
    if (!node) throw new Error('Missing fixture element');
    return node;
  };
  return {
    app, calls, order, dialogs, element, nodes, find, providers,
    setAnswer: (next: string) => { answer = next; },
    changeHost: () => { generation++; },
    unmount: () => { cleanups.forEach(cleanup => cleanup()); },
    done: () => done,
    catalog: (root: Element) => find(root, node => typeof node.type === 'function' && node.type.name === 'CatalogFields').props.catalog as {
      load: (directory: string | null) => Promise<void>;
      providers: () => Row[]; agents: () => Row[]; error: () => string;
      loading: () => boolean; partial: () => boolean;
    },
    state: (root: Element) => find(root, node => typeof node.type === 'function' && node.type.name === 'Feedback').props.state as {
      committed: () => boolean; busy: () => boolean; error: () => string; notice: () => string;
      finish: () => Promise<void>; perform: (work: () => Promise<void>, allowCommitted?: boolean) => Promise<void>;
    },
  };
}

export const bot = { id: 'bot', revision: 1, name: 'Bot', defaultPrompt: 'Prompt', workspacePath: null, managedWorkspacePath: '/managed', effectiveWorkspacePath: '/wrong-effective', providerID: 'provider', modelID: 'model', agent: 'do-not-clear', mode: 'continuous', variant: 'high' };
export const item = { projectId: 'project', task: { id: 'task', name: 'Task', enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Do work', providerID: 'provider', modelID: 'model', agent: 'build', goalEnabled: true } } };
export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
