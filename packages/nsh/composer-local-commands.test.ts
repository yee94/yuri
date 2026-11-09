import { expect, test } from 'vitest';
import { createNativeLocalCommands, type NativeLocalCommandAction, type NativeLocalCommandConflict, type NativeLocalCommandInvocation, type NativeLocalCommandSnapshot } from './composer-local-commands';
import { nativeCommandRows, shouldSubmitCommandOnSelection, type NativeSlashCommand } from './composer-commands-model';
import * as rules from '../ui/src/lib/composer-local-commands-core';
import { createNativeLocalHistoryActions, createNativeLocalMagicAction } from './composer-local-commands-actions';
import { messageFrom, type CompiledSubmission } from './model';
import { createNativeBtwStore } from './desktop-btw';
import { createNativeDesktopBtwAction, createNativeDesktopBtwHandle, type NativeDesktopBtwHandle } from './desktop-btw-panel-core';

const local = (name: string): NativeSlashCommand => ({ id: `yuri:${name}`, name, source: 'yuri', isBuiltIn: true });
function fixture(text: string, actions: Record<string, NativeLocalCommandAction | undefined> = {}) {
  let snapshot: NativeLocalCommandSnapshot = { authority: 'lane-1', scope: { host: 'fixture', draft: 'chat', directory: '/workspace' },
    target: { kind: 'session', id: 'session', directory: '/workspace' }, revision: 0, text, inputMode: 'normal', active: true,
    ready: true, pending: false, unknown: false, sending: false, queueEditing: false, hasReferences: false, hasMessages: true, selection: null };
  const blocked: string[] = [], outcomes: string[] = [], conflicts: string[] = [], invocations: NativeLocalCommandInvocation[] = [];
  const plans: NativeLocalCommandConflict[] = [];
  let catalogs = 0;
  const owner = createNativeLocalCommands({ t: key => key, actions, read: () => snapshot,
    replaceText: (expected, value) => { if (snapshot !== expected) return false; snapshot = { ...snapshot, text: value, revision: snapshot.revision + 1 }; return true; },
    onBlocked: (_command, reason) => blocked.push(reason),
    onConflict: value => { conflicts.push(value.phase); plans.push(value); },
    onOutcome: (invocation, outcome) => { invocations.push(invocation); outcomes.push(outcome.status); },
  });
  const commands = owner.catalog.commands;
  owner.catalog.commands = () => { catalogs++; return commands(); };
  return { owner, blocked, outcomes, conflicts, plans, invocations, catalogs: () => catalogs, read: () => snapshot,
    edit: (next: Partial<NativeLocalCommandSnapshot>) => { snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 }; },
    context: () => ({ scope: snapshot.scope, text: snapshot.text, query: snapshot.text.slice(1), start: 0, end: snapshot.text.length, editing: true }),
  };
}
const accepted = (): NativeLocalCommandAction => ({ run: () => ({ status: 'accepted' }) });

test('real asynchronous history action remains current after immediate document CAS consumes its old revision', async () => {
  let release!: () => void, before = false, after = false;
  const actions = createNativeLocalHistoryActions({ read: () => ({ complete: true, busy: false, messages: [messageFrom({ id: 'user', type: 'user', text: 'question' })!] }),
    stage: async (_message, invocation) => {
      before = invocation.current(); expect(invocation.snapshot.revision).toBe(0); expect(f.read().revision).toBe(1); expect(f.read().text).toBe('');
      await new Promise<void>(resolve => { release = resolve; });
      after = invocation.current(); return { status: after ? 'accepted' : 'rejected' };
    }, clear: async () => ({ status: 'rejected' }), onUnavailable: () => {} });
  const f = fixture('/undo', actions);
  expect(f.owner.submit()).toEqual({ kind: 'started', command: 'undo' }); expect(before).toBe(true);
  f.edit({ text: 'new independent draft' }); release(); await f.owner.settled();
  expect(after).toBe(true); expect(f.outcomes).toEqual(['accepted']); expect(f.read().text).toBe('new independent draft');
});
test('actual BTW action/handle executes after registry CAS; missing generate rejects without a fake turn', async () => {
  for (const available of [false, true]) {
    let generates = 0, opened = 0;
    const store = createNativeBtwStore({ runtime: () => ({ transport: 'fixture', generation: 1 }), resolveSelection: () => null,
      rememberSelection: () => {}, applySelection: async () => {}, generate: available ? async () => { generates++; return { text: 'answer' }; } : undefined });
    const handle = createNativeDesktopBtwHandle({ store, scope: { sessionId: 'session', directory: '/workspace' },
      current: () => true, active: () => true, interactive: () => true, visible: () => true, onClose: () => {} });
    const action = createNativeDesktopBtwAction({ open: invocation => { expect(invocation.current()).toBe(true); expect(f.read().revision).toBe(1); opened++; return handle; } });
    const f = fixture('/btw side question', { btw: action }); expect(f.owner.submit()).toMatchObject({ kind: 'started' });
    await f.owner.settled(); expect(opened).toBe(1); expect(generates).toBe(available ? 1 : 0);
    expect(f.outcomes).toEqual([available ? 'accepted' : 'rejected']); expect(store.entry(handle.scope).turns).toHaveLength(available ? 1 : 0);
    handle.dispose(); store.dispose();
  }
});

test.each(['question', ''])('BTW awaits mounted handle; new draft survives and bare command never generates: %s', async question => {
  let publish!: (handle: NativeDesktopBtwHandle | null) => void, generates = 0;
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'fixture', generation: 1 }), resolveSelection: () => null,
    rememberSelection: () => {}, applySelection: async () => {}, generate: async () => { generates++; return { text: 'answer' }; } });
  const f = fixture(`/btw ${question}`, { btw: createNativeDesktopBtwAction({ open: () => new Promise(resolve => { publish = resolve; }) }) });
  expect(f.owner.submit().kind).toBe('started'); expect(generates).toBe(0); expect(f.outcomes).toEqual([]);
  f.edit({ text: 'new independent draft' });
  // The consumer publishes only after mounting, not a placeholder accepted at tabs.open time.
  const handle = createNativeDesktopBtwHandle({ store, scope: { sessionId: 'session', directory: '/workspace' },
    current: () => true, active: () => true, interactive: () => true, visible: () => true, onClose: () => {} });
  publish(handle); await f.owner.settled();
  expect(generates).toBe(question ? 1 : 0); expect(f.outcomes).toEqual(['accepted']); expect(f.read().text).toBe('new independent draft');
  handle.dispose(); store.dispose();
});

test.each(['reject', 'null', 'closed', 'disposed', 'target', 'directory', 'invocation'])('late BTW opening rejects without generate or consuming new draft: %s', async reason => {
  let publish!: (handle: NativeDesktopBtwHandle | null) => void, reject!: (error: Error) => void, generates = 0;
  const store = createNativeBtwStore({ runtime: () => ({ transport: 'fixture', generation: 1 }), resolveSelection: () => null,
    rememberSelection: () => {}, applySelection: async () => {}, generate: async () => { generates++; return { text: 'answer' }; } });
  const f = fixture('/btw original question', { btw: createNativeDesktopBtwAction({ open: () => new Promise((yes, no) => { publish = yes; reject = no; }) }) });
  f.owner.submit(); f.edit({ text: 'must remain' });
  const handle = createNativeDesktopBtwHandle({ store, scope: { sessionId: reason === 'target' ? 'other' : 'session', directory: reason === 'directory' ? '/other' : '/workspace' },
    current: () => true, active: () => true, interactive: () => true, visible: () => true, onClose: () => {} });
  if (reason === 'closed') handle.close();
  if (reason === 'disposed') handle.dispose();
  if (reason === 'invocation') f.edit({ authority: 'retired-lane' });
  if (reason === 'reject') reject(new Error('opening_retired')); else publish(reason === 'null' ? null : handle);
  await f.owner.settled();
  expect(generates).toBe(0); expect(f.read().text).toBe('must remain');
  expect(f.outcomes).toEqual(reason === 'invocation' ? [] : ['rejected']);
  handle.dispose(); store.dispose();
});

test('actual Web classifier claims every reserved command, including absent consumers, without Host fallback', () => {
  for (const name of rules.LOCAL_CHAT_COMMANDS) {
    const f = fixture(`/\u2003${name.toUpperCase()}`);
    expect(f.owner.submit()).toMatchObject(name === 'reload' ? { kind: 'pass' } : { kind: 'blocked', command: name, reason: 'unbound' });
    expect(f.read().text).toBe(`/\u2003${name.toUpperCase()}`);
    expect(f.catalogs()).toBe(0);
  }
  for (const value of ['/goal keep running', '/custom', 'ordinary', '/forked']) expect(fixture(value).owner.submit()).toEqual({ kind: 'pass' });
  const shell = fixture('/fork'); shell.edit({ inputMode: 'shell' }); expect(shell.owner.submit()).toEqual({ kind: 'pass' });
});
test('desktop rows retain unavailable locals, exclude Host collisions and only bound local actions auto-run', () => {
  const f = fixture('', { fork: accepted(), model: accepted(), summary: accepted() });
  const rows = nativeCommandRows([{ name: 'fork', isBuiltIn: true }, { name: 'custom' }], '', f.read().scope, key => key, f.owner.catalog);
  expect(rows.filter(row => row.command.name === 'fork')).toHaveLength(1);
  expect(rows.some(row => row.command.name === 'undo')).toBe(true);
  for (const row of rows) {
    expect(shouldSubmitCommandOnSelection(row.command, false)).toBe(false);
    expect(shouldSubmitCommandOnSelection(row.command, true)).toBe(['fork', 'model'].includes(row.command.name));
  }
  expect(shouldSubmitCommandOnSelection({ id: 'opencode:fork', name: 'fork', source: 'opencode', isBuiltIn: true, localAutoRun: true }, true)).toBe(false);
});
test('Tab inserts, Enter/click require a local consumer, and Host selection remains distinguishable at send', async () => {
  for (const submit of [false, true]) {
    let calls = 0; const f = fixture('/fo', { fork: { run: () => { calls++; expect(f.read().text).toBe(''); return { status: 'accepted' }; } } });
    expect(f.owner.choose(local('fork'), submit, f.context())).toBe(true);
    await f.owner.settled(); expect(calls).toBe(submit ? 1 : 0); expect(f.read().text).toBe(submit ? '' : '/fork ');
  }
  const unbound = fixture('/un'); expect(unbound.owner.choose(local('undo'), true, unbound.context())).toBe(true);
  expect(unbound.read().text).toBe('/undo '); expect(unbound.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'unbound' });
  let calls = 0; const host = fixture('/fo', { fork: { run: () => { calls++; return { status: 'accepted' }; } } });
  host.owner.choose({ id: 'opencode:fork', name: 'fork', source: 'opencode', isBuiltIn: true }, true, host.context());
  expect(host.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'host-command-collision' }); expect(calls).toBe(0);
});
test('Web destructive tail replacement is returned to main unchanged; model/timeline/magic retain their Web text policy', async () => {
  const f = fixture('/fo\nKEEP', { fork: accepted() });
  expect(f.owner.choose(local('fork'), true, { ...f.context(), end: 3 })).toBe(false);
  expect(f.read().text).toBe('/fo\nKEEP'); expect(f.conflicts).toEqual(['selection']);
  f.edit({ text: '/fork KEEP' });
  expect(f.owner.submit()).toMatchObject({ kind: 'conflict', phase: 'submit', webText: '' });
  expect(f.read().text).toBe('/fork KEEP');
  for (const command of ['model', 'timeline', 'summary', 'craft-goal']) {
    const p = fixture(`/${command} topic`, { [command]: accepted() });
    expect(p.owner.submit().kind).toBe('started'); await p.owner.settled(); expect(p.read().text).toBe(`/${command} topic`);
  }
});
test('actual target/session, ready, resource, queue and receipt gates retain the complete document', () => {
  const variants: Array<[Partial<NativeLocalCommandSnapshot>, string]> = [
    [{ active: false }, 'inactive'], [{ ready: false }, 'not-ready'], [{ pending: true }, 'pending'], [{ sending: true }, 'pending'],
    [{ unknown: true }, 'unknown'], [{ queueEditing: true }, 'queue-edit'], [{ hasReferences: true }, 'references'],
    [{ target: { kind: 'assistant', id: 'bot', directory: '/workspace' } }, 'assistant-target'],
    [{ target: { kind: 'draft', id: 'draft', directory: '/workspace' } }, 'session-required'],
  ];
  for (const [patch, reason] of variants) {
    const f = fixture('/fork', { fork: accepted() }); f.edit(patch);
    expect(f.owner.submit()).toMatchObject({ kind: 'blocked', reason }); expect(f.read().text).toBe('/fork');
  }
  for (const name of ['new', 'model', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore']) {
    const f = fixture(`/${name}`, { [name]: accepted() }); f.edit({ target: { kind: 'draft', id: 'draft', directory: '/workspace' } });
    expect(f.owner.submit().kind).toBe('started');
  }
});
test('/btw dispatches before main flight, preserves resources and passes the entire question; references claim without mutation', async () => {
  let question = ''; const f = fixture('/btw question\nsecond line', { btw: { run: input => { question = input.tail; return { status: 'accepted' }; } } });
  f.edit({ pending: true, sending: true }); expect(f.owner.submit().kind).toBe('started');
  expect(f.read().text).toBe(''); await f.owner.settled(); expect(question).toBe('question\nsecond line');
  const refs = fixture('/btw question', { btw: accepted() }); refs.edit({ hasReferences: true });
  expect(refs.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'references' }); expect(refs.read().text).toBe('/btw question');
});
test('/btw Tab follows Web token replacement, while Enter tail loss returns both the insertion and bare preset to main', () => {
  const f = fixture('/btw question', { btw: accepted() }), context = { ...f.context(), end: 4 };
  expect(f.owner.choose(local('btw'), true, context)).toBe(false); expect(f.read().text).toBe('/btw question');
  expect(f.plans[0]).toMatchObject({ phase: 'selection', webText: '/btw  question', presetText: '/btw' });
  expect(f.owner.choose(local('btw'), false, context)).toBe(true); expect(f.read().text).toBe('/btw  question');
});
test('/btw has its own pending lane during compaction; ordinary follow-ups never join a local flight', async () => {
  let finish!: (value: { status: 'accepted' }) => void, questions = 0;
  const f = fixture('/compact', { compact: { run: () => new Promise(resolve => { finish = resolve; }) }, btw: { run: () => { questions++; return { status: 'accepted' }; } } });
  expect(f.owner.submit().kind).toBe('started'); f.edit({ text: 'follow-up' }); expect(f.owner.submit()).toEqual({ kind: 'pass' });
  f.edit({ text: '/btw side question' }); expect(f.owner.submit().kind).toBe('started'); expect(questions).toBe(1);
  finish({ status: 'accepted' }); await f.owner.settled(); expect(f.outcomes).toEqual(['accepted', 'accepted']);
});
test('unknown is latched, explicit authority settlement never replays, and later edits survive completion', async () => {
  let finish!: (value: { status: 'unknown' }) => void, calls = 0;
  const f = fixture('/compact', { compact: { run: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } });
  f.owner.submit(); f.edit({ text: 'later edit' }); finish({ status: 'unknown' }); await f.owner.settled();
  expect(f.read().text).toBe('later edit'); f.edit({ text: '/compact' });
  expect(f.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'unknown' }); expect(calls).toBe(1);
  expect(f.owner.resolveUnknown({ ...f.invocations[0] }, 'accepted')).toBe(false);
  expect(f.owner.resolveUnknown(f.invocations[0], 'accepted')).toBe(true); expect(calls).toBe(1);
});
test('late completion after owner retirement does not publish, clear text or touch new owner', async () => {
  let finish!: (value: { status: 'accepted' }) => void;
  const f = fixture('/fork', { fork: { run: () => new Promise(resolve => { finish = resolve; }) } });
  f.owner.submit(); f.edit({ text: 'new draft' }); f.owner.dispose(); finish({ status: 'accepted' }); await f.owner.settled();
  expect(f.outcomes).toEqual([]); expect(f.read().text).toBe('new draft');
  expect(f.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'inactive' });
});
test('unknown received while temporarily covered stays locked on resume without publishing to the covering page', async () => {
  let finish!: (value: { status: 'unknown' }) => void;
  let original!: NativeLocalCommandInvocation;
  const f = fixture('/fork', { fork: { run: input => { original = input; return new Promise(resolve => { finish = resolve; }); } } });
  f.owner.submit(); f.edit({ active: false, text: 'covered draft' }); finish({ status: 'unknown' }); await f.owner.settled();
  expect(f.outcomes).toEqual([]); expect(f.read().text).toBe('covered draft');
  f.edit({ active: true, text: '/fork' }); expect(f.owner.submit()).toMatchObject({ kind: 'blocked', reason: 'unknown' });
  expect(f.owner.resolveUnknown(original, 'accepted')).toBe(true); expect(f.outcomes).toEqual(['accepted']);
});
test('invocation freezes actual model/variant/Agent values before an async consumer can observe later selection edits', async () => {
  let captured!: NativeLocalCommandInvocation;
  const selection = { model: { providerID: 'fixture', modelID: 'first', variant: 'low' }, agent: 'first-agent' };
  const f = fixture('/summary', { summary: { run: invocation => { captured = invocation; return { status: 'accepted' }; } } });
  f.edit({ selection }); f.owner.submit(); selection.model.modelID = 'later'; selection.model.variant = 'high'; selection.agent = 'later-agent';
  await f.owner.settled(); expect(captured.snapshot.selection).toEqual({ model: { providerID: 'fixture', modelID: 'first', variant: 'low' }, agent: 'first-agent' });
});
test('stale range/scope cannot insert; 50 ordinary edits do not enumerate catalog or invoke actions', () => {
  const f = fixture('/fo', { fork: accepted() }), context = f.context();
  f.edit({ text: '/foo' }); expect(f.owner.choose(local('fork'), true, context)).toBe(false);
  for (let index = 0; index < 50; index++) { f.edit({ text: `ordinary ${index}` }); expect(f.owner.submit()).toEqual({ kind: 'pass' }); }
  expect(f.catalogs()).toBe(0); expect(f.outcomes).toEqual([]);
});
test('magic uses production compiler with empty delivery resources and preserves the authored command after ACK', async () => {
  const requests: string[] = [], sent: CompiledSubmission[] = [];
  const action = createNativeLocalMagicAction({ request: async path => { requests.push(path); return { version: 1, overrides: {} }; },
    admit: async compiled => { sent.push(compiled); return { status: 'accepted' }; }, onPreparationError: () => { throw new Error('unexpected'); } });
  const f = fixture('/summary focused topic', { summary: action });
  f.owner.submit(); await f.owner.settled();
  expect(requests).toEqual(['/api/magic-prompts']); expect(sent).toHaveLength(1); expect(sent[0].files).toEqual([]);
  expect(sent[0].text).toContain('focused topic'); expect(f.read().text).toBe('/summary focused topic');
  expect(f.outcomes).toEqual(['accepted']);
});
test('magic preparation failure is safely rejected before admission; late preparation never dispatches', async () => {
  let admissions = 0, errors = 0;
  const action = createNativeLocalMagicAction({ request: async () => { throw new Error('synthetic'); },
    admit: async () => { admissions++; return { status: 'accepted' }; }, onPreparationError: () => { errors++; } });
  const f = fixture('/summary', { summary: action }); f.owner.submit(); await f.owner.settled();
  expect(admissions).toBe(0); expect(errors).toBe(1); expect(f.outcomes).toEqual(['rejected']); expect(f.read().text).toBe('/summary');
  let finish!: (value: unknown) => void;
  const lateAction = createNativeLocalMagicAction({ request: () => new Promise(resolve => { finish = resolve; }),
    admit: async () => { admissions++; return { status: 'accepted' }; }, onPreparationError: () => { errors++; } });
  const late = fixture('/summary', { summary: lateAction }); late.owner.submit(); late.owner.dispose(); finish({}); await late.owner.settled();
  expect(admissions).toBe(0); expect(errors).toBe(1);
});
test('history adapter uses Web conversation order: undo previous user, redo next user, clear only after the last', async () => {
  const messages = [messageFrom({ id: 'z-first', type: 'user' })!, messageFrom({ id: 'a-reply', type: 'assistant' })!, messageFrom({ id: 'b-last', type: 'user' })!];
  const stages: string[] = [], unavailable: string[] = []; let marker: string | undefined, clears = 0, complete = true;
  const actions = createNativeLocalHistoryActions({ read: () => ({ messages, revertMessageID: marker, complete, busy: false }),
    stage: async message => { stages.push(message.id); marker = message.id; return { status: 'accepted' }; },
    clear: async () => { clears++; marker = undefined; return { status: 'accepted' }; }, onUnavailable: reason => unavailable.push(reason) });
  const f = fixture('/undo', actions);
  f.owner.submit(); await f.owner.settled(); expect(stages).toEqual(['b-last']);
  f.edit({ text: '/undo' }); f.owner.submit(); await f.owner.settled(); expect(stages).toEqual(['b-last', 'z-first']);
  f.edit({ text: '/redo' }); f.owner.submit(); await f.owner.settled(); expect(stages).toEqual(['b-last', 'z-first', 'b-last']); expect(clears).toBe(0);
  complete = false; f.edit({ text: '/redo' }); f.owner.submit(); await f.owner.settled(); expect(clears).toBe(0); expect(unavailable).toEqual(['history-incomplete']);
  complete = true; f.edit({ text: '/redo' }); f.owner.submit(); await f.owner.settled(); expect(clears).toBe(1);
});
