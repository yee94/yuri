import { getSlashTokenRange, shouldSubmitCommandOnSelection } from '../ui/src/components/chat/commandSelection';
import * as WebRules from '../ui/src/lib/composer-local-commands-core';
import type { ComposerLocalCommandDescription } from '../ui/src/lib/composer-local-commands-core';
import { magicCommand } from './composer';
import type { NativeLocalCommandCatalog, NativeSlashCommand } from './composer-commands-model';
import { sameReferenceScope, type ReferenceScope } from './composer-references';
import type { ReferenceKeyboardContext } from './composer-reference-keyboard';
import type { ModelRef } from './chat-models-helpers';

export type NativeLocalCommandSnapshot = {
  scope: ReferenceScope;
  /** Captured Host/page operation generation, independent of durable draft identity. */
  authority: string;
  target: { kind: 'session' | 'draft' | 'assistant'; id: string; directory: string };
  /** Monotonic document/resource revision, not text equality (prevents ABA). */
  revision: number;
  text: string;
  inputMode: 'normal' | 'shell';
  active: boolean;
  ready: boolean;
  pending: boolean;
  unknown: boolean;
  sending: boolean;
  queueEditing: boolean;
  hasReferences: boolean;
  hasMessages: boolean;
  /** Actual selection at invocation time; null means unresolved, never a guessed default. */
  selection: { model?: ModelRef; agent?: string } | null;
};
export type NativeLocalCommandBlock = 'inactive' | 'not-ready' | 'pending' | 'unknown' | 'queue-edit' | 'session-required' | 'assistant-target' | 'references' | 'host-command-collision' | 'unbound' | 'stale';
export type NativeLocalCommandConflict = { kind: 'conflict'; command: string; phase: 'selection' | 'submit'; snapshot: NativeLocalCommandSnapshot; webText: string; presetText?: string };
export type NativeLocalCommandOutcome = { status: 'accepted' | 'rejected' | 'unknown' };
export type NativeLocalCommandInvocation = {
  command: string;
  tail: string;
  snapshot: NativeLocalCommandSnapshot;
  /** All local commands bypass the ordinary queue and retain attachments/references. */
  resourcePolicy: 'preserve';
  current: () => boolean;
};
export type NativeLocalCommandAction = {
  run: (invocation: NativeLocalCommandInvocation) => NativeLocalCommandOutcome | Promise<NativeLocalCommandOutcome>;
};
export type NativeLocalCommandAdmission = { kind: 'pass' } | { kind: 'blocked'; command: string; reason: NativeLocalCommandBlock } | { kind: 'started'; command: string } | NativeLocalCommandConflict;

const webOptions = { reloadEnabled: false };
const tailOf = (value: string) => value.trimStart().replace(/^\/\u2003?[^\s]+/, '').trim();
const sameOwner = (a: NativeLocalCommandSnapshot, b: NativeLocalCommandSnapshot) => a.authority === b.authority && sameReferenceScope(a.scope, b.scope)
  && a.target.kind === b.target.kind && a.target.id === b.target.id && a.target.directory === b.target.directory;

/** One actual Chat/draft owner. No effects, catalog fetches, timers or input subscriptions. */
export function createNativeLocalCommands(options: {
  t: (key: ComposerLocalCommandDescription) => string;
  read: () => NativeLocalCommandSnapshot;
  /** Atomic document-only CAS. Must preserve resource owners and rebase inline references. */
  replaceText: (expected: NativeLocalCommandSnapshot, value: string) => boolean;
  actions: Readonly<Record<string, NativeLocalCommandAction | undefined>>;
  onBlocked: (command: string, reason: NativeLocalCommandBlock) => void;
  /** Report the exact Web text replacement to the page owner; never invent a destructive tail policy. */
  onConflict: (conflict: NativeLocalCommandConflict) => void;
  onOutcome: (invocation: NativeLocalCommandInvocation, outcome: NativeLocalCommandOutcome) => void;
}) {
  let alive = true, flight = false, btwFlight = false;
  const uncertain = new Set<NativeLocalCommandInvocation>();
  let selectedHost: NativeLocalCommandSnapshot | undefined;
  let completion: Promise<void> = Promise.resolve();
  const classify = (value: string, mode: 'normal' | 'shell') => WebRules.getLocalChatCommand(value, mode, webOptions);
  const owned = (snapshot: NativeLocalCommandSnapshot) => alive && sameOwner(snapshot, options.read());
  const live = (snapshot: NativeLocalCommandSnapshot) => {
    if (!alive) return false;
    const next = options.read(); return sameOwner(snapshot, next) && next.active;
  };
  function blocked(command: string, reason: NativeLocalCommandBlock): NativeLocalCommandAdmission {
    if (alive && options.read().active) options.onBlocked(command, reason);
    return { kind: 'blocked', command, reason };
  }
  function conflict(snapshot: NativeLocalCommandSnapshot, command: string, phase: 'selection' | 'submit', webText: string, presetText?: string): NativeLocalCommandConflict {
    const value: NativeLocalCommandConflict = { kind: 'conflict', command, phase, snapshot, webText, ...(presetText ? { presetText } : {}) };
    if (alive && snapshot.active) options.onConflict(value);
    return value;
  }
  function reason(snapshot: NativeLocalCommandSnapshot, command: string): NativeLocalCommandBlock | undefined {
    if (!alive || !snapshot.active) return 'inactive';
    if (!snapshot.ready || !snapshot.authority || !snapshot.scope.host || !snapshot.scope.draft || !snapshot.scope.directory
      || snapshot.scope.directory !== snapshot.target.directory) return 'not-ready';
    if (snapshot.unknown || uncertain.size) return 'unknown';
    if (snapshot.target.kind === 'assistant') return 'assistant-target';
    if (snapshot.queueEditing) return 'queue-edit';
    // /btw runs before the main-turn flight gate, but never through an unknown receipt.
    if (command === 'btw' ? btwFlight : flight || snapshot.pending || snapshot.sending) return 'pending';
    const magic = magicCommand(`/${command}`);
    if (snapshot.target.kind !== 'session' && command !== 'new' && command !== 'model' && !(magic && command !== 'summary')) return 'session-required';
    if (snapshot.target.kind === 'session' && !snapshot.target.id) return 'session-required';
    if (snapshot.hasReferences) return 'references';
    if (!options.actions[command]) return 'unbound';
  }
  function start(snapshot: NativeLocalCommandSnapshot, command: string): NativeLocalCommandAdmission {
    const denied = reason(snapshot, command);
    if (denied) return blocked(command, denied);
    if (!WebRules.preservesComposerResources(snapshot.text, snapshot.inputMode, webOptions)) return blocked(command, 'stale');
    const action = options.actions[command];
    if (!action) return blocked(command, 'unbound');
    if (WebRules.consumesImmediateCommandText(snapshot.text, snapshot.inputMode, webOptions) && tailOf(snapshot.text)) return conflict(snapshot, command, 'submit', '');
    const captured: NativeLocalCommandSnapshot = { ...snapshot, scope: { ...snapshot.scope }, target: { ...snapshot.target },
      selection: snapshot.selection ? { ...snapshot.selection, ...(snapshot.selection.model ? { model: { ...snapshot.selection.model } } : {}) } : null };
    const invocation: NativeLocalCommandInvocation = {
      command, tail: tailOf(snapshot.text), snapshot: captured, resourcePolicy: 'preserve', current: () => live(captured),
    };
    // Immediate actions consume before navigation/first await. Model, timeline and magic keep text.
    if (WebRules.consumesImmediateCommandText(snapshot.text, snapshot.inputMode, webOptions) || command === 'btw') {
      if (!options.replaceText(snapshot, '')) return blocked(command, 'stale');
    }
    if (command === 'btw') btwFlight = true; else flight = true;
    let result: ReturnType<NativeLocalCommandAction['run']>;
    try { result = action.run(invocation); }
    catch { result = { status: 'unknown' }; }
    const task = Promise.resolve(result).catch((): NativeLocalCommandOutcome => ({ status: 'unknown' })).then(outcome => {
      if (command === 'btw') btwFlight = false; else flight = false;
      if (!owned(captured)) return;
      // Missing/invalid acknowledgement is not success and cannot be automatically replayed.
      const safe: NativeLocalCommandOutcome = outcome?.status === 'accepted' || outcome?.status === 'rejected' ? outcome : { status: 'unknown' };
      if (safe.status === 'unknown') uncertain.add(invocation);
      if (live(captured)) options.onOutcome(invocation, safe);
    });
    completion = Promise.all([completion, task]).then(() => undefined);
    return { kind: 'started', command };
  }
  function submit(): NativeLocalCommandAdmission {
    if (!alive) return { kind: 'blocked', command: '', reason: 'inactive' };
    const snapshot = options.read(), command = classify(snapshot.text, snapshot.inputMode);
    if (command && selectedHost && sameOwner(selectedHost, snapshot) && selectedHost.revision === snapshot.revision) return blocked(command, 'host-command-collision');
    return command ? start(snapshot, command) : { kind: 'pass' };
  }
  const catalog: NativeLocalCommandCatalog = {
    commands: () => {
      if (!alive) return [];
      const snapshot = options.read(), hasSession = snapshot.target.kind === 'session' && !!snapshot.target.id;
      return WebRules.getComposerLocalCommandMetadata({ hasSession, hasMessages: snapshot.hasMessages,
        canStartSessionCommand: hasSession || snapshot.target.kind === 'draft', reloadEnabled: false }, options.t);
    },
    canAutoRun: command => alive && command.source === 'yuri' && command.id === `yuri:${command.name}`
      && classify(`/${command.name}`, 'normal') === command.name && !!options.actions[command.name]
      && shouldSubmitCommandOnSelection(command, true),
  };
  function choose(command: NativeSlashCommand, submitIntent: boolean, context: ReferenceKeyboardContext): boolean {
    if (!alive) return false;
    const before = options.read();
    if (!before.active || !context.editing || !sameReferenceScope(before.scope, context.scope) || before.text !== context.text
      || !Number.isInteger(context.start) || !Number.isInteger(context.end) || context.start < 0 || context.end < context.start || context.end > context.text.length) return false;
    if (getSlashTokenRange(before.text, context.end)?.start !== context.start) return false;
    const local = command.source === 'yuri' && command.id === `yuri:${command.name}` && classify(`/${command.name}`, 'normal') === command.name;
    const prefix = before.text.slice(0, context.start), suffix = before.text.slice(context.end);
    const autoRun = local && submitIntent && catalog.canAutoRun(command);
    // Web replaces the plain document except for /btw's token-range insertion. Its preset
    // auto-submit still uses bare /btw. Return any potential data loss to the page owner.
    const next = command.name === 'btw' ? `${prefix}/${command.name} ${suffix}` : `/${command.name} `;
    if ((command.name !== 'btw' || autoRun) && (prefix.trim() || suffix.trim() || before.hasReferences)) {
      conflict(before, command.name, 'selection', next, autoRun ? `/${command.name}` : undefined); return false;
    }
    if (!options.replaceText(before, next)) return false;
    const after = options.read();
    selectedHost = command.source === 'opencode' ? after : undefined;
    if (autoRun) start(after, command.name);
    return true;
  }
  return {
    catalog, choose, submit,
    settled: () => completion,
    /** Authority recovery only. Never calls run again; main must verify the original operation receipt. */
    resolveUnknown: (invocation: NativeLocalCommandInvocation, outcome: 'accepted' | 'rejected') => {
      if (!uncertain.has(invocation) || !live(invocation.snapshot)) return false;
      uncertain.delete(invocation);
      options.onOutcome(invocation, { status: outcome });
      return true;
    },
    dispose: () => { alive = false; },
  };
}
