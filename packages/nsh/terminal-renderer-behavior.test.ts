import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { expect, it } from 'vitest';
import { createTerminalWorkspace } from './terminal-core';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/** Execute the actual production bootstrap; DOM/VT are fakes, never a terminal engine. */
async function renderer(autoAck = true) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(root, 'ios/NativeTerminalPreview.swift'), 'utf8').split('static let bootstrap = #"""')[1].split('"""#')[0];
  const events: Record<string, unknown>[] = [], writes: string[] = [], scrolls: number[] = [], copies: string[] = [];
  const state = { selection: '', bracketed: false, autoAck, fits: 0, constructions: 0, cols: 80, rows: 24, options: {} as Record<string, unknown>, onInput: undefined as ((value: Record<string, unknown>) => void) | undefined };
  const nodes = new Map<string, { value: string; listeners: Map<string, (event: Record<string, unknown>) => void>; focus: () => void; blur: () => void; setAttribute: () => void; addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => void }>();
  for (const id of ['terminal', 'input']) nodes.set(id, { value: '', listeners: new Map(), focus() {}, blur() {}, setAttribute() {}, addEventListener(name, listener) { this.listeners.set(name, listener); } });
  const documentListeners = new Map<string, (value: unknown) => void>();
  const window: Record<string, unknown> = { webkit: { messageHandlers: { terminal: { postMessage: (value: Record<string, unknown>) => {
    events.push(value);
    if (value.type === 'input') {
      state.onInput?.(value);
      if (state.autoAck) (window.terminalInputResult as (value: unknown) => void)({ key: value.key, receipt: value.receipt, status: 'accepted' });
    }
  } } } }, addEventListener() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} };
  const context = createContext({ window, document: { getElementById: (id: string) => nodes.get(id),
    addEventListener: (name: string, listener: (value: unknown) => void) => documentListeners.set(name, listener),
    removeEventListener: (name: string) => documentListeners.delete(name),
    execCommand: (name: string) => { expect(name).toBe('copy'); documentListeners.get('copy')?.({ preventDefault() {}, clipboardData: { setData: (_type: string, text: string) => copies.push(text) } }); return true; },
  }, WebAssembly: { compile: async () => ({}), instantiate: async () => ({}) }, atob: () => '', Uint8Array,
    ResizeObserver: class { observe() {} disconnect() {} },
    GhosttyWeb: { Ghostty: class {}, FitAddon: class { fit() {
      state.fits++; state.cols = Math.floor(1040 / Number(state.options.fontSize)); state.rows = Math.floor(624 / (Number(state.options.fontSize) * 2));
    } }, Terminal: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) { this.options = options; state.options = options; state.constructions++; }
      get cols() { return state.cols; } get rows() { return state.rows; } loadAddon() {} open() {} onData() {} reset() {} dispose() {}
      onScroll() {} onSelectionChange() {} hasSelection() { return !!state.selection; } getSelection() { return state.selection; }
      hasBracketedPaste() { return state.bracketed; }
      getViewportY() { return scrolls.reduce((a, b) => a + b, 0); }
      scrollLines(value: number) { scrolls.push(value); } scrollToBottom() {}
      write(value: string, done?: () => void) { writes.push(value); done?.(); }
    } },
  });
  new Script(source).runInContext(context);
  await new Script('startNativeTerminal({wasm:"",palette:{},family:"Mono",size:13,label:"input"})').runInContext(context);
  const render = window.terminalRender as (value: unknown) => void, input = nodes.get('input')!;
  const fire = (type: string, fields: Record<string, unknown> = {}) => {
    let prevented = false;
    input.listeners.get(type)?.({ preventDefault() { prevented = true; }, stopPropagation() {}, ...fields }); return prevented;
  };
  const inputs = () => events.filter(value => value.type === 'input');
  const settle = (value: Record<string, unknown>, status: string) => (window.terminalInputResult as (value: unknown) => void)({ key: value.key, receipt: value.receipt, status });
  return { state, events, writes, scrolls, copies, nodes, input, fire, render, inputs, settle, fontPreferences: window.terminalFontPreferences as (value: unknown) => void };
}

it('production font preferences update the existing terminal without changing composing input, output, or receipts', async () => {
  const f = await renderer(false); f.render({ type: 'render', key: 'tab-a', live: true, serial: 1, chunks: [{ id: 1, data: 'prior output' }] });
  f.input.value = 'pending'; f.fire('input');
  f.fire('compositionstart'); f.input.value = '拼音未提交'; f.state.selection = 'selected output';
  const writes = [...f.writes], events = [...f.events], fits = f.state.fits;
  f.fontPreferences({ fontSize: 26, fontFamily: 'Mono' });
  expect(f.state.options.fontSize).toBe(26); expect(f.state.constructions).toBe(1); expect(f.state.fits).toBe(fits + 1);
  expect(f.input.value).toBe('拼音未提交'); expect(f.state.selection).toBe('selected output');
  expect(f.writes).toEqual(writes); expect(f.events.filter(value => value.type !== 'resize')).toEqual(events.filter(value => value.type !== 'resize'));
  f.fontPreferences({ fontSize: 26, fontFamily: 'Mono' }); expect(f.state.fits).toBe(fits + 1);
  for (const size of [8, 53, NaN, '13']) expect(() => f.fontPreferences({ fontSize: size, fontFamily: 'Mono' })).toThrow();
  expect(f.state.options.fontSize).toBe(26);
  f.fire('input', { isComposing: true }); expect(f.inputs()).toHaveLength(1);
  f.settle(f.inputs()[0], 'accepted'); f.fire('compositionend');
  expect(f.inputs().at(-1)?.data).toBe('拼音未提交');
});

it('font 13→26 emits exact post-fit geometry without a container ResizeObserver event; same preferences never fit or notify again', async () => {
  const f = await renderer(); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  const fits = f.state.fits, events = f.events.length;
  f.fontPreferences({ fontSize: 26, fontFamily: 'Mono' });
  expect(f.state.fits).toBe(fits + 1);
  expect(f.state).toMatchObject({ cols: 40, rows: 12 });
  expect(f.events.slice(events)).toEqual([{ type: 'resize', key: 'tab-a', cols: 40, rows: 12 }]);
  f.fontPreferences({ fontSize: 26, fontFamily: 'Mono' });
  expect(f.state.fits).toBe(fits + 1); expect(f.events).toHaveLength(events + 1); expect(f.state.constructions).toBe(1);
});

it('touch callback maps the same 180px delta to 10 rows at 13pt and 5 rows at the current 26pt font', async () => {
  const f = await renderer(); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  const terminal = f.nodes.get('terminal')!;
  const touch = (type: string, clientY: number) => terminal.listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, pointerType: 'touch', pointerId: 1, clientX: 20, cancelable: true, clientY });
  touch('pointerdown', 100); touch('pointermove', 55); touch('pointercancel', 55);
  expect(f.scrolls).toEqual([10]);
  f.fontPreferences({ fontSize: 26, fontFamily: 'Mono' });
  touch('pointerdown', 100); touch('pointermove', 55); touch('pointercancel', 55);
  expect(f.scrolls).toEqual([10, 5]); expect(f.inputs()).toHaveLength(0);
});

it('production bootstrap preserves IME commit, Ctrl input, output ACK and touch scrolling', async () => {
  const f = await renderer();
  f.render({ type: 'render', key: 'tab-a', live: true, serial: 1, chunks: [] });
  f.fire('compositionstart'); f.input.value = '中'; f.fire('input', { isComposing: true }); f.input.value = '中文👩‍💻'; f.fire('compositionend'); f.fire('input');
  expect(f.inputs().map(value => value.data)).toEqual(['中文👩‍💻']);
  f.fire('keydown', { key: 'c', ctrlKey: true }); f.fire('keydown', { key: 'ArrowLeft' }); f.fire('beforeinput', { inputType: 'deleteContentBackward' }); f.fire('beforeinput', { inputType: 'insertLineBreak' });
  expect(f.inputs().map(value => value.data)).toEqual(['中文👩‍💻', '\x03', '\x1b[D', '\x7f', '\r']);
  f.render({ type: 'render', key: 'tab-a', live: true, serial: 2, chunks: [{ id: 1, data: '\x1b[32mreal-wire-fixture' }] });
  f.render({ type: 'render', key: 'tab-a', live: true, serial: 3, chunks: [{ id: 1, data: 'duplicate' }] });
  expect(f.writes).toEqual(['\x1b[32mreal-wire-fixture']); expect(f.events.find(value => value.type === 'ack')).toMatchObject({ key: 'tab-a', cursor: 1, serial: 2 });
  const terminal = f.nodes.get('terminal')!;
  const touch = (type: string, fields: Record<string, unknown>) => terminal.listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, pointerType: 'touch', pointerId: 1, clientX: 20, cancelable: true, ...fields });
  touch('pointerdown', { clientY: 100 }); touch('pointermove', { clientY: 40 }); touch('pointercancel', { clientY: 40 });
  expect(f.scrolls.length).toBeGreaterThan(0); expect(f.inputs()).toHaveLength(5);
  f.render({ type: 'render', key: 'tab-a', live: false, chunks: [] }); f.input.value = 'hidden'; f.fire('input');
  expect(f.inputs()).toHaveLength(5); expect(f.input.value).toBe('hidden');
});

it('hardware Command copy has zero PTY writes; Command paste stays native, Ctrl-C remains a control input', async () => {
  const f = await renderer(); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  f.state.selection = '已选择👩‍💻';
  expect(f.fire('keydown', { key: 'c', metaKey: true })).toBe(true);
  expect(f.copies).toEqual(['已选择👩‍💻']); expect(f.inputs()).toEqual([]);
  expect(f.fire('keydown', { key: 'v', metaKey: true })).toBe(false);
  f.fire('keydown', { key: 'x', metaKey: true }); expect(f.inputs()).toEqual([]);
  f.state.selection = ''; f.fire('keydown', { key: 'c', metaKey: true }); expect(f.inputs()).toEqual([]);
  f.fire('keydown', { key: 'c', ctrlKey: true }); expect(f.inputs().map(value => value.data)).toEqual(['\x03']);
  f.fire('keydown', { key: 'ArrowLeft', metaKey: true }); expect(f.inputs().at(-1)?.data).toBe('\x1b[D');
});

it('paste uses the current Ghostty bracket mode once and does not duplicate a subsequent input/IME commit', async () => {
  const f = await renderer(); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  const text = '第一行\r\n第二行😀👩‍💻';
  const paste = () => f.fire('paste', { clipboardData: { getData: () => text } });
  f.state.bracketed = true; expect(paste()).toBe(true); f.fire('input', { inputType: 'insertFromPaste' });
  f.state.bracketed = false; paste(); f.fire('input', { inputType: 'insertFromPaste' });
  f.fire('compositionstart'); f.input.value = '拼音'; f.fire('input', { isComposing: true }); f.fire('compositionend'); f.fire('input');
  expect(f.inputs().map(value => value.data)).toEqual(['\x1b[200~' + text + '\x1b[201~', text, '拼音']);
});

it('bounded input queue keeps rejected text, serializes receipts and never replays unknown writes or suffixes', async () => {
  const f = await renderer(false); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  for (const text of ['one', 'two', 'three', 'four', 'not-admitted']) { f.input.value = text; f.fire('input'); }
  expect(f.inputs().map(value => value.data)).toEqual(['one']); expect(f.input.value).toBe('not-admitted');
  expect(f.events.some(value => value.type === 'inputRejected')).toBe(true);
  f.settle({ ...f.inputs()[0], receipt: 9999 }, 'accepted'); expect(f.inputs()).toHaveLength(1);
  f.settle(f.inputs()[0], 'accepted'); expect(f.inputs().map(value => value.data)).toEqual(['one', 'two']);
  f.settle(f.inputs()[1], 'unknown'); expect(f.input.value).toBe('twothreefournot-admitted');
  f.settle(f.inputs()[1], 'unknown'); expect(f.input.value).toBe('twothreefournot-admitted');
  f.fire('input'); f.render({ type: 'render', key: 'tab-a', live: false, chunks: [] }); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  expect(f.inputs()).toHaveLength(2); expect(f.input.value).toBe('twothreefournot-admitted');
});

it('explicit core rejection restores queued input once and permits draft editing without PTY control writes', async () => {
  const f = await renderer(false); f.render({ type: 'render', key: 'tab-a', live: true, chunks: [] });
  f.input.value = 'retained'; f.fire('input'); f.settle(f.inputs()[0], 'rejected');
  expect(f.input.value).toBe('retained');
  expect(f.events.at(-1)).toMatchObject({ type: 'inputRejected', code: 'input_not_accepted' });
  expect(f.fire('keydown', { key: 'Backspace' })).toBe(false);
  expect(f.fire('beforeinput', { inputType: 'deleteContentBackward' })).toBe(false);
  f.input.value = 'retaine'; f.fire('input');
  expect(f.inputs()).toHaveLength(1); expect(f.input.value).toBe('retaine');
});

for (const closeA of [false, true]) for (const status of ['accepted', 'rejected', 'unknown']) {
  it(`production bootstrap ${closeA ? 'closes A' : 'switches A→B'}: late A ${status} retains drafts and never sends A suffix to B`, async () => {
    const f = await renderer(false);
    const render = (key: string, live = true) => f.render({ type: 'render', key, live, chunks: [] });
    render('tab-a');
    f.input.value = 'A-first'; f.fire('input');
    f.input.value = 'A-suffix中😀'; f.fire('input');
    f.input.value = 'A-edit';
    const original = f.inputs()[0];
    if (closeA) render('tab-a', false);
    render('tab-b');
    f.input.value = 'B-first'; f.fire('input');
    f.input.value = 'B-new-edit';
    expect(f.inputs().map(value => [value.key, value.data])).toEqual([['tab-a', 'A-first']]);
    f.settle({ ...original, key: 'tab-b' }, status);
    expect(f.inputs()).toHaveLength(1); expect(f.input.value).toBe('B-new-edit');
    f.settle(original, status);
    const expected = status === 'unknown' ? [['tab-a', 'A-first']] : [['tab-a', 'A-first'], ['tab-b', 'B-first']];
    expect(f.inputs().map(value => [value.key, value.data])).toEqual(expected);
    expect(f.input.value).toBe(status === 'unknown' ? 'B-firstB-new-edit' : 'B-new-edit');
    f.settle(original, status); // A duplicate cannot consume B's receipt or append old text twice.
    expect(f.inputs().map(value => [value.key, value.data])).toEqual(expected);
    render('tab-a', !closeA);
    expect(f.input.value).toBe((status === 'accepted' ? '' : 'A-first') + 'A-suffix中😀A-edit');
    expect(f.inputs().some(value => value.data === 'A-suffix中😀')).toBe(false);
    render('tab-b');
    if (status !== 'unknown') {
      f.settle(f.inputs()[1], 'accepted');
      f.input.value += '-retry'; f.fire('input');
      expect(f.inputs().at(-1)).toMatchObject({ key: 'tab-b', data: 'B-new-edit-retry' });
    } else {
      f.fire('input'); expect(f.inputs()).toHaveLength(1);
      expect(f.input.value).toBe('B-firstB-new-edit');
    }
  });
}

it('late A rejection preserves newer A edits and does not reuse A receipt for a B input', async () => {
  const f = await renderer(false);
  const render = (key: string) => f.render({ type: 'render', key, live: true, chunks: [] });
  render('tab-a'); f.input.value = 'old-A'; f.fire('input');
  f.input.value = 'A-suffix'; f.fire('input');
  render('tab-b'); f.input.value = 'B-draft';
  render('tab-a'); expect(f.input.value).toBe('A-suffix');
  f.input.value += '-new-edit';
  f.settle(f.inputs()[0], 'rejected');
  expect(f.input.value).toBe('old-AA-suffix-new-edit');
  render('tab-b'); expect(f.input.value).toBe('B-draft');
  f.fire('input'); expect(f.inputs().at(-1)).toMatchObject({ key: 'tab-b', data: 'B-draft' });
  const b = f.inputs().at(-1)!;
  expect(b.receipt).not.toBe(f.inputs()[0].receipt);
  f.settle(f.inputs()[0], 'accepted');
  expect(f.inputs().at(-1)).toBe(b);
});

it('Tab migration keeps the four-item/UTF-8 budget and requires explicit input to send a restored draft', async () => {
  const f = await renderer(false);
  const render = (key: string) => f.render({ type: 'render', key, live: true, chunks: [] });
  const full = '中'.repeat(21_844) + '😀'; // Exactly 65,536 UTF-8 bytes.
  render('tab-a');
  for (let i = 0; i < 4; i++) { f.input.value = full; f.fire('input'); expect(f.input.value === '').toBe(true); }
  f.input.value = 'A-over-budget'; f.fire('input'); expect(f.input.value).toBe('A-over-budget');
  render('tab-b');
  for (let i = 0; i < 3; i++) { f.input.value = full; f.fire('input'); expect(f.input.value === '').toBe(true); }
  f.input.value = 'B-over-budget'; f.fire('input'); expect(f.input.value).toBe('B-over-budget');
  f.settle(f.inputs()[0], 'accepted'); expect(f.inputs()).toHaveLength(2);
  expect(f.inputs()[1]).toMatchObject({ key: 'tab-b', data: full });
  render('tab-a'); expect(f.input.value === full.repeat(3) + 'A-over-budget').toBe(true);
  f.settle(f.inputs()[1], 'accepted'); expect(f.inputs()).toHaveLength(2);
  f.fire('input'); expect(f.inputs()).toHaveLength(2); // Oversized retained draft stays intact.
  expect(f.input.value === full.repeat(3) + 'A-over-budget').toBe(true);
});

it('actual bootstrap → production core → synthetic bridge accepts 20k ASCII/Unicode and returns admission feedback', async () => {
  const scope = { hostID: 'host', lease: '10000000-0000-4000-8000-000000000001' };
  let receive!: (event: unknown) => void;
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let rejectInput = false;
  const core = createTerminalWorkspace({ scope, subscribe: callback => { receive = callback; return () => {}; }, changed() {}, call: async (name, body) => {
    calls.push({ name, body }); if (name === 'terminal.create') return { sessionId: 'pty' };
    if (name === 'terminal.input' && rejectInput) throw new Error('unknown send'); return true;
  } });
  core.setDirectory('/work'); core.setActive(true); core.resize({ cols: 80, rows: 24 }); await flush();
  const attach = calls.find(value => value.name === 'terminal.attach')!.body;
  receive({ ...attach, type: 'connected' });
  const f = await renderer(false); f.render({ type: 'render', key: attach.owner, live: true, chunks: [] });
  f.state.onInput = value => { void core.inputOutcome(value.data as string).then(status => f.settle(value, status)); };
  f.input.value = 'a'.repeat(20_000); f.fire('input'); await flush();
  f.input.value = '中😀'.repeat(9000); f.fire('input'); await flush();
  const writes = () => calls.filter(value => value.name === 'terminal.input');
  expect(writes().map(value => value.body.data)).toEqual(['a'.repeat(20_000), '中😀'.repeat(9000)]);
  f.input.value = '中😀'.repeat(10_000); f.fire('input'); await flush();
  expect(writes()).toHaveLength(2); expect(f.input.value).toBe('中😀'.repeat(10_000));
  f.input.value = ''; rejectInput = true;
  f.input.value = 'uncertain'; f.fire('input'); f.input.value = 'suffix'; f.fire('input'); await flush();
  expect(writes()).toHaveLength(3); expect(writes().at(-1)?.body.data).toBe('uncertain');
  expect(f.input.value).toBe('uncertainsuffix');
  f.fire('input'); await flush(); expect(writes()).toHaveLength(3);
  core.dispose();
});
