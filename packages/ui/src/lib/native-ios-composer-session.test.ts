import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { emptyNativeComposerAutocomplete, getNativeIosComposerPlugin, NATIVE_IOS_COMPOSER_CLASS } from './native-ios-composer';
import { createNativeIosComposerSession, type NativeIosComposerSessionHandlers } from './native-ios-composer-session';
import type { NativeIosComposerPlugin, NativeIosComposerState } from './native-ios-composer';

const state = (overrides: Partial<NativeIosComposerState> = {}): NativeIosComposerState => ({
  text: '',
  placeholder: 'Tap to type',
  modelLabel: 'Grok',
  modelVariantLabel: '',
  modelIcon: '',
  canSend: false,
  canAbort: false,
  attachmentCount: 0,
  attachmentPreviews: [],
  citationRanges: [],
  chipRanges: [],
  appearance: 'dark',
  attachAria: 'Add',
  attachTitle: 'Add',
  attachPhotosLabel: 'Photos',
  attachFilesLabel: 'Files',
  attachCancelLabel: 'Cancel',
  sendAria: 'Send',
  queueAria: 'Queue',
  stopAria: 'Stop',
  modelAria: 'Model',
  agentAria: 'Agent',
  agentLabel: 'Build',
  agentColor: '#22c55e',
  agentIdenticon: Array.from({ length: 25 }, () => 0),
  suppressed: false,
  showScrollToBottom: false,
  scrollAria: 'Scroll',
  autocomplete: emptyNativeComposerAutocomplete(),
  ...overrides,
});

const createPlugin = () => {
  const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
  const plugin: NativeIosComposerPlugin = {
    present: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    setSuppressed: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    addListener: vi.fn(async (event, listener) => {
      listeners.set(event, listener as (payload: Record<string, unknown>) => void);
      return { remove: async () => { listeners.delete(event); } };
    }),
  };
  return { plugin, listeners };
};

const ownerHandlers = (): NativeIosComposerSessionHandlers => ({
  onText: vi.fn(), onSend: vi.fn(), onAbort: vi.fn(), onAttach: vi.fn(), onFiles: vi.fn(),
  onRemoveAttachment: vi.fn(), onOpenModel: vi.fn(), onCycleAgent: vi.fn(), onOpenAgent: vi.fn(),
  onHeight: vi.fn(), onScrollToBottom: vi.fn(), onAutocompleteAccept: vi.fn(), onAutocompleteDismiss: vi.fn(),
});

test('foreground CAS fences old props, late listener callbacks, cleanup and absent-owner events', async () => {
  const { plugin, listeners } = createPlugin();
  const session = createNativeIosComposerSession(() => plugin);
  const root = document.createElement('html');
  const a = Symbol('hostA'); const b = Symbol('hostB');
  const first = ownerHandlers(); const second = ownerHandlers();
  await session.claim(a, root, state({ text: 'host A' }), first);
  const lateText = listeners.get('textChanged')!;
  const lateFiles = listeners.get('filesPicked')!;
  await session.claim(b, root, state({ text: 'host B' }), second);
  vi.mocked(plugin.update).mockClear(); vi.mocked(plugin.hide).mockClear();
  lateText({ text: 'late A' }); lateFiles({});
  session.updateOwner(a, { text: 'late props' }); session.releaseOwner(a, root);
  expect(first.onText).not.toHaveBeenCalled(); expect(second.onText).not.toHaveBeenCalled();
  expect(plugin.focus).not.toHaveBeenCalled(); expect(plugin.update).not.toHaveBeenCalled(); expect(plugin.hide).not.toHaveBeenCalled();
  expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);
  listeners.get('textChanged')?.({ text: 'B edit' });
  expect(second.onText).toHaveBeenCalledWith('B edit', false, null);
  session.releaseOwner(b, root);
  listeners.get('textChanged')?.({ text: 'after release' });
  expect(second.onText).toHaveBeenCalledOnce();
  expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
  session.shutdown(root);
});

test('late listener installation cannot present the departed owner or dismiss its successor', async () => {
  const { plugin } = createPlugin();
  let resolveListeners!: () => void;
  const pending = new Promise<void>((resolve) => { resolveListeners = resolve; });
  const add = plugin.addListener;
  let calls = 0;
  plugin.addListener = vi.fn(async (...args: Parameters<typeof add>) => {
    if (++calls <= 13) await pending;
    return add(...args);
  });
  const session = createNativeIosComposerSession(() => plugin);
  const root = document.createElement('html');
  const a = Symbol('A'); const b = Symbol('B');
  const first = session.claim(a, root, state({ text: 'departed' }), ownerHandlers());
  session.releaseOwner(a, root);
  await session.claim(b, root, state({ text: 'foreground' }), ownerHandlers());
  resolveListeners(); await first;
  expect(plugin.present).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'foreground' }));
  session.releaseOwner(a, root);
  expect(session.owns(b)).toBe(true);
  session.shutdown(root);
});

describe('native iOS composer session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('overlapping release then retain keeps one overlay and does not dismiss', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.retain(root, state({ text: 'a' }));
    await Promise.resolve();
    expect(plugin.present).toHaveBeenCalledTimes(1);
    expect(plugin.addListener).toHaveBeenCalledTimes(13);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);

    session.release(root);
    expect(session.snapshot().hidePending).toBe(true);

    await session.retain(root, state({ text: 'b' }));
    expect(plugin.present).toHaveBeenCalledTimes(2);
    expect(plugin.addListener).toHaveBeenCalledTimes(13);
    expect(session.snapshot()).toMatchObject({
      retainCount: 1,
      hidePending: false,
    });

    await vi.runAllTimersAsync();
    expect(plugin.dismiss).not.toHaveBeenCalled();
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);
  });

  test('idle release dismisses without dropping listeners', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.retain(root, state());
    await Promise.resolve();
    session.release(root);
    await vi.runAllTimersAsync();

    expect(plugin.dismiss).toHaveBeenCalledTimes(1);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
    expect(session.snapshot()).toMatchObject({
      retainCount: 0,
      listenerCount: 13,
      hidePending: false,
      concealed: false,
      warmed: true,
    });
  });

  test('warm installs a hidden overlay without the document class', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.warm();
    expect(plugin.present).toHaveBeenCalledTimes(1);
    expect(vi.mocked(plugin.present).mock.calls[0][0]).toMatchObject({ suppressed: true });
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
    expect(session.snapshot()).toMatchObject({
      retainCount: 0,
      warmed: true,
      listenerCount: 0,
    });

    await session.warm();
    expect(plugin.present).toHaveBeenCalledTimes(1);

    await session.retain(root, state({ text: 'hi' }));
    await Promise.resolve();
    expect(plugin.present).toHaveBeenCalledTimes(2);
    expect(vi.mocked(plugin.present).mock.calls[1][0]).toMatchObject({ text: 'hi', suppressed: false });
    expect(plugin.addListener).toHaveBeenCalledTimes(13);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);
  });

  test('shutdown dismisses a warmed overlay and allows warm again', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.warm();
    session.shutdown(root);
    session.shutdown(root);
    expect(plugin.dismiss).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      retainCount: 0,
      warmed: false,
      concealed: false,
    });
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);

    await session.warm();
    expect(plugin.present).toHaveBeenCalledTimes(2);
    expect(session.snapshot().warmed).toBe(true);
  });

  test('web startup shutdown never invokes the unimplemented native plugin', async () => {
    const failures: string[] = [];
    const { plugin } = createPlugin();
    plugin.dismiss = vi.fn(() => getNativeIosComposerPlugin().dismiss().catch((error: Error) => {
      failures.push(error.message);
    }));
    const getPlugin = vi.fn(() => plugin);
    const session = createNativeIosComposerSession(getPlugin);
    const root = document.createElement('html');
    root.classList.add(NATIVE_IOS_COMPOSER_CLASS);

    session.shutdown(root);
    session.shutdown(root);
    await vi.runAllTimersAsync();

    expect(failures).toEqual([]);
    expect(getPlugin).not.toHaveBeenCalled();
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
  });

  test('warm is a no-op while the overlay is retained', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.retain(root, state({ text: 'live' }));
    await session.warm();
    expect(plugin.present).toHaveBeenCalledTimes(1);
    expect(vi.mocked(plugin.present).mock.calls[0][0]).toMatchObject({ text: 'live' });
  });

  test('conceal hides immediately and leaves the overlay installed', async () => {
    const { plugin } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const root = document.createElement('html');

    await session.retain(root, state({ text: 'keep' }));
    await Promise.resolve();
    session.conceal();

    expect(plugin.hide).toHaveBeenCalledTimes(1);
    expect(plugin.dismiss).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({
      retainCount: 1,
      concealed: true,
    });
    expect(session.snapshot().listenerCount).toBeGreaterThan(0);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);

    session.conceal();
    expect(plugin.hide).toHaveBeenCalledTimes(1);

    session.reveal();
    expect(plugin.present).toHaveBeenCalledTimes(1);
    expect(plugin.show).toHaveBeenCalledTimes(1);
    expect(session.snapshot().concealed).toBe(false);
  });

  test('send dispatches the live owner without calling present or update', async () => {
    const { plugin, listeners } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const onSend = vi.fn();
    session.bind({
      onText: () => undefined,
      onSend,
      onAbort: () => undefined,
      onAttach: () => undefined,
      onFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onOpenModel: () => undefined,
      onCycleAgent: () => undefined,
      onOpenAgent: () => undefined,
      onHeight: () => undefined,
      onScrollToBottom: () => undefined,
      onAutocompleteAccept: () => undefined,
      onAutocompleteDismiss: () => undefined,
    });
    await session.retain(document.documentElement, state({ text: 'ready' }));
    await Promise.resolve();
    vi.mocked(plugin.present).mockClear();
    vi.mocked(plugin.update).mockClear();
    listeners.get('send')?.({ text: 'ready' });
    expect(onSend).toHaveBeenCalledWith('ready');
    expect(plugin.present).not.toHaveBeenCalled();
    expect(plugin.update).not.toHaveBeenCalled();
  });

  test('rebinding owners keeps send and text on the live page', async () => {
    const { plugin, listeners } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const first = { onSend: vi.fn(), onText: vi.fn() };
    const second = { onSend: vi.fn(), onText: vi.fn() };
    const noop = {
      onAbort: () => undefined,
      onAttach: () => undefined,
      onFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onOpenModel: () => undefined,
      onCycleAgent: () => undefined,
      onOpenAgent: () => undefined,
      onHeight: () => undefined,
      onScrollToBottom: () => undefined,
      onAutocompleteAccept: () => undefined,
      onAutocompleteDismiss: () => undefined,
    };

    session.bind({ ...noop, onSend: first.onSend, onText: first.onText });
    await session.retain(document.documentElement, state());
    await Promise.resolve();
    session.bind({ ...noop, onSend: second.onSend, onText: second.onText });
    listeners.get('send')?.({ text: 'go' });

    expect(first.onSend).not.toHaveBeenCalled();
    expect(second.onSend).toHaveBeenCalledWith('go');
  });

  test('forwards removeAttachment and composing text to the live owner', async () => {
    const { plugin, listeners } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const onRemoveAttachment = vi.fn();
    const onText = vi.fn();
    session.bind({
      onText,
      onSend: () => undefined,
      onAbort: () => undefined,
      onAttach: () => undefined,
      onFiles: () => undefined,
      onRemoveAttachment,
      onOpenModel: () => undefined,
      onCycleAgent: () => undefined,
      onOpenAgent: () => undefined,
      onHeight: () => undefined,
      onScrollToBottom: () => undefined,
      onAutocompleteAccept: () => undefined,
      onAutocompleteDismiss: () => undefined,
    });
    await session.retain(document.documentElement, state());
    await Promise.resolve();
    listeners.get('textChanged')?.({ text: 'ni', composing: true });
    listeners.get('removeAttachment')?.({ id: 'att-1' });
    expect(onText).toHaveBeenCalledWith('ni', true, null);
    expect(onRemoveAttachment).toHaveBeenCalledWith('att-1');
  });

  test('forwards autocomplete accept and caret on textChanged', async () => {
    const { plugin, listeners } = createPlugin();
    const session = createNativeIosComposerSession(() => plugin);
    const onText = vi.fn();
    const onAutocompleteAccept = vi.fn();
    session.bind({
      onText,
      onSend: () => undefined,
      onAbort: () => undefined,
      onAttach: () => undefined,
      onFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onOpenModel: () => undefined,
      onCycleAgent: () => undefined,
      onOpenAgent: () => undefined,
      onHeight: () => undefined,
      onScrollToBottom: () => undefined,
      onAutocompleteAccept,
      onAutocompleteDismiss: () => undefined,
    });
    await session.retain(document.documentElement, state());
    await Promise.resolve();
    listeners.get('textChanged')?.({ text: '/un', composing: false, selectionStart: 3, selectionEnd: 3 });
    listeners.get('autocompleteAccept')?.({ index: 1 });
    expect(onText).toHaveBeenCalledWith('/un', false, { start: 3, end: 3 });
    expect(onAutocompleteAccept).toHaveBeenCalledWith(1);
  });
});
