import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopAttachments } from './desktop-attachments';
import { desktopAttachmentRecovery } from './desktop-attachments-recovery';

const root = path.dirname(fileURLToPath(import.meta.url));
const attachment = (index: number) => ({ uri: `file:///synthetic/${index}.txt`, name: `${index}.txt`, mime: 'text/plain' });
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let sequence = 0;

/** Execute actual production attachment/lifecycle closures. No renderer, disk bytes or Host. */
function fixture(options: { desktop?: boolean; key?: string; handler?: (name: string, body: Record<string, unknown>) => Promise<unknown>; choice?: Promise<{ action: string }> } = {}) {
  const key = options.key ?? `draft_${++sequence}`;
  const effects: Array<() => void> = [], cleanups: Array<() => void> = [], writes: unknown[] = [], uiWrites: unknown[] = [];
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; uiWrites.push(next); } }); };
  let active = true, foreground = true, owned = true, files = [attachment(0)];
  const scope = { hostID: 'synthetic-host', lease: '00000000-0000-4000-8000-000000000001' };
  let authority = { scope, current: () => owned && foreground };
  const owner = {
    current: () => owned && authority.current(), operation: () => authority,
    captureOperation: () => { const captured = authority; return { ...captured, current: () => captured === authority && active && foreground && owned }; },
    phase: () => 'draft', submitting: () => false, status: () => 'ready',
    durable: { scope: { host: scope.hostID, directory: `/synthetic/${key}`, draft: key }, attachments: () => files, flush: async () => {} },
    project: { name: 'Synthetic', id: 'synthetic', path: '/synthetic' }, directory: '/synthetic',
    setAttachments: (next: typeof files) => { if (!owned || !active || !foreground) return false; files = next; writes.push(next); return true; },
  };
  const native = vi.fn(async (name: string, body: Record<string, unknown>) => {
    if (options.handler) return await options.handler(name, body);
    if (name === 'runtime.pickAttachment') return attachment(1);
    return { requestID: body.requestID, state: name.endsWith('.pick') || name.endsWith('.status') ? 'ready' : 'retired', attachments: name.endsWith('.pick') || name.endsWith('.status') ? [attachment(1)] : [], orphaned: 0 };
  });
  const ports = {
    signal, computed: (work: () => unknown) => work, untracked: (work: () => unknown) => work(),
    effect: (work: () => void) => { effects.push(work); work(); }, cleanup: (work: () => void) => cleanups.push(work),
    lifecycle: () => foreground ? 'active' : 'background', platform: { desktop: options.desktop !== false },
    captureHostRequest: () => vi.fn(), app: { connection: () => ({ url: 'https://synthetic.invalid', authorizationID: 'synthetic-authorization' }) },
    createDesktopAttachments, desktopAttachmentRecovery, native, id: () => `pick_${++sequence}`,
    t: (key: string) => key, newSessionText: (key: string) => key,
    createNativeReferenceKeyboard: () => ({ dismiss() {}, ref() {}, selectedRange() {} }),
    AlertDialog: { show: () => options.choice ?? Promise.resolve({ action: 'files' }) },
  };
  const source = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(root, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NewSessionBody')!.body!;
  const statements = body.statements.filter(node => !ts.isReturnStatement(node)).map(node => node.getText(source)).join('\n');
  const output = ts.transpileModule(`function fixture(props) { ${statements}; return { attach, checkAttachment, attaching, attachmentFailure, attachmentStatus, attachmentRefreshing, attachmentRecoveryKey }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  const component = new Function(...Object.keys(ports), `${output}; return fixture;`)(...Object.values(ports));
  const api = component({ ownership: { owner, transferred: () => false }, active: () => active && foreground, switching: () => false });
  return { api, owner, native, writes, uiWrites, files: () => files, effects: () => effects.forEach(work => work()),
    suspend: () => { active = false; }, resume: () => { active = true; },
    renew: () => { authority = { scope: { ...scope }, current: () => owned && foreground }; },
    switchHost: () => { owned = false; },
    unmount: () => { cleanups.forEach(work => work()); },
    forget: () => { const saved = desktopAttachmentRecovery.get(api.attachmentRecoveryKey); if (saved) desktopAttachmentRecovery.forget(api.attachmentRecoveryKey, saved.receipt.requestID); },
  };
}

describe('new-session production desktop attachment closures', () => {
  it('uses captured native lease, a stable owner, and read-only retry; partial files survive failure/cancel', async () => {
    let second = false;
    const page = fixture({ handler: async (name, body) => ({ requestID: body.requestID, state: name.endsWith('.cancel') ? 'retired' : 'unknown', attachments: name.endsWith('.cancel') ? [] : second ? [attachment(1), attachment(2)] : [attachment(1)], orphaned: name.endsWith('.cancel') ? 2 : 0 }) });
    await page.api.attach(); expect(page.files()).toEqual([attachment(0), attachment(1)]); expect(page.api.attaching()).toBe(true);
    second = true; await page.api.checkAttachment(); await page.api.checkAttachment();
    expect(page.files()).toEqual([attachment(0), attachment(1), attachment(2)]);
    const calls = page.native.mock.calls;
    expect(calls.map(([name]) => name)).toEqual(['desktop.attachments.pick', 'desktop.attachments.status', 'desktop.attachments.status']);
    expect(calls.every(([,body]) => JSON.stringify(body.expectedHost) === JSON.stringify(page.owner.operation().scope))).toBe(true);
    expect(new Set(calls.map(([,body]) => body.requestID)).size).toBe(1);
    await page.api.checkAttachment(true); expect(page.api.attaching()).toBe(false); expect(page.files()).toHaveLength(3);
    expect(page.api.attachmentStatus().orphaned).toBe(0); page.unmount(); page.forget();
  });
  it('same-scope new authority retires and cancels exactly the old request, with no late UI/draft setters', async () => {
    const pending = deferred<unknown>(); let requestID = '';
    const page = fixture({ handler: async (name, body) => {
      requestID = String(body.requestID);
      return name.endsWith('.pick') ? pending.promise : { requestID: body.requestID, state: 'retired', attachments: [], orphaned: name.endsWith('.release') ? 1 : 0 };
    } });
    const flight = page.api.attach(); await flush();
    const original = page.native.mock.calls[0]![1]; page.renew(); page.effects(); await flush();
    const setters = page.uiWrites.length;
    pending.resolve({ requestID, state: 'ready', attachments: [attachment(1)], orphaned: 0 }); await flight; await flush();
    expect(page.uiWrites).toHaveLength(setters); expect(page.writes).toEqual([]);
    expect(page.native.mock.calls.filter(([name]) => name.endsWith('.cancel'))[0]![1]).toEqual({ requestID: original.requestID, expectedHost: original.expectedHost });
    expect(page.native.mock.calls.map(([name]) => name)).toContain('desktop.attachments.release');
    page.unmount(); page.forget();
  });
  it('Host retirement only releases metadata, and 401 retry never falls through to storage or a second pick', async () => {
    let denied = false;
    const page = fixture({ handler: async (name, body) => {
      if (denied) throw Object.assign(new Error('HTTP 401'), { status: 401 });
      return { requestID: body.requestID, state: name.endsWith('.pick') ? 'unknown' : 'retired', attachments: name.endsWith('.pick') ? [attachment(1)] : [], orphaned: 0 };
    } });
    await page.api.attach(); denied = true; await page.api.checkAttachment();
    expect(page.api.attachmentFailure()).toBe(true); expect(page.api.attaching()).toBe(true); expect(page.files()).toHaveLength(2);
    expect(page.native.mock.calls.map(([name]) => name)).toEqual(['desktop.attachments.pick', 'desktop.attachments.status']);
    page.switchHost(); page.effects(); await flush(); const setters = page.uiWrites.length;
    denied = false; await flush(); expect(page.uiWrites).toHaveLength(setters); expect(page.files()).toHaveLength(2);
    page.unmount(); page.forget();
  });
  it('closed-page unknown ID survives only in bounded runtime metadata and can be inspected under its original lease without re-adoption', async () => {
    const key = `recovery_${++sequence}`;
    const first = fixture({ key, handler: async (name, body) => ({ requestID: body.requestID, state: name.endsWith('.pick') ? 'unknown' : 'retired', attachments: name.endsWith('.pick') ? [attachment(1)] : [], orphaned: name.endsWith('.pick') ? 0 : 1 }) });
    await first.api.attach(); const original = first.native.mock.calls[0]![1]; first.unmount(); await flush();
    expect(desktopAttachmentRecovery.get(first.api.attachmentRecoveryKey)?.receipt).toMatchObject({ requestID: original.requestID, uncertain: true });
    const reopened = fixture({ key });
    expect(reopened.api.attaching()).toBe(true);
    await reopened.api.checkAttachment(); expect(reopened.files()).toEqual([attachment(0)]);
    expect(reopened.native.mock.calls[0]).toEqual(['desktop.attachments.status', { requestID: original.requestID, expectedHost: original.expectedHost }]);
    expect(reopened.native.mock.calls.map(([name]) => name)).not.toContain('desktop.attachments.pick');
    await reopened.api.checkAttachment(true); expect(reopened.api.attaching()).toBe(false);
    first.forget(); reopened.forget(); reopened.unmount();
  });
  it('iOS keeps its original runtime.pickAttachment wire and does not create a desktop receipt', async () => {
    const page = fixture({ desktop: false }); await page.api.attach();
    expect(page.native.mock.calls).toEqual([['runtime.pickAttachment', { kind: 'files' }]]); expect(page.files()).toEqual([attachment(0), attachment(1)]);
    page.unmount(); page.forget();
  });
  it('chooser cancellation fences a late chooser response before any native upload call', async () => {
    const choice = deferred<{ action: string }>(); const page = fixture({ choice: choice.promise });
    const flight = page.api.attach(); await flush(); await page.api.checkAttachment(true);
    choice.resolve({ action: 'files' }); await flight; expect(page.native).not.toHaveBeenCalled(); expect(page.api.attaching()).toBe(false);
    page.unmount(); page.forget();
  });
  it('attachment retry/cancel UI reuses all ten locales and never calls owner.retryStorage', () => {
    const source = readFileSync(path.join(root, 'new-session-page.tsx'), 'utf8');
    const start = source.indexOf('<If when={platform?.desktop && (attaching() || attachmentFailure())}');
    const fragment = source.slice(start, source.indexOf('<Each of={owner.durable.attachments()}', start));
    expect(fragment).toContain('new-session-attachment-retry'); expect(fragment).toContain('checkAttachment()'); expect(fragment).toContain('checkAttachment(true)');
    expect(fragment).not.toContain('retryStorage');
    const keys = ['chat.chatInput.actions.addAttachment', 'chat.questionDelegate.uncertain', 'chat.questionDelegate.refreshStatus', 'chat.chatInput.actions.attachCancel', 'common.loading'];
    for (const locale of ['en','ja','es','fr','ko','pl','pt-BR','uk','zh-CN','zh-TW']) {
      const dictionary = readFileSync(path.join(root, '../ui/src/lib/i18n/messages', `${locale}.ts`), 'utf8');
      for (const key of keys) expect(dictionary.includes(`'${key}'`) || dictionary.includes(`"${key}"`), `${locale}: ${key}`).toBe(true);
    }
  });
});
