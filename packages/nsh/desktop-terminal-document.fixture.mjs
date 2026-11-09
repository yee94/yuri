// Execute the delivered fixed document and real pinned CanvasRenderer/WASM.
// DOM, Terminal I/O and FitAddon are fixtures: not a browser/pixel/Win32 test.
import { createContext, Script } from 'node:vm';
import { TextEncoder, TextDecoder } from 'node:util';
import assert from 'node:assert/strict';

export async function checkTerminalDocument(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  const posted = [], writes = [], listeners = new Map(), nodes = new Map(), documentListeners = new Map(), clipboard = new Map();
  const documentFire = (key, event) => { for (const handler of [...(documentListeners.get(key) ?? [])]) handler(event); };
  const canvasContext = new Proxy({ measureText: () => ({ width: 7, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 }) }, { get: (value, key) => value[key] ?? (() => {}) });
  const node = name => {
    const handlers = new Map();
    const value = { value: '', style: {}, clientWidth: 420, clientHeight: 210, width: 420, height: 210,
      getContext: () => canvasContext, setAttribute() {}, appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 210 }),
      addEventListener: (key, fn) => { const all = handlers.get(key) ?? []; all.push(fn); handlers.set(key, all); },
      fire: (key, event = {}) => { for (const fn of handlers.get(key) ?? []) fn(event); },
      focus: () => value.fire('focus'), blur: () => value.fire('blur'),
    };
    nodes.set(name, value); return value;
  };
  const input = node('input'); node('terminal');
  const document = { createElement: () => node(`canvas${nodes.size}`), getElementById: name => nodes.get(name),
    addEventListener: (key, fn) => { const handlers = documentListeners.get(key) ?? new Set(); handlers.add(fn); documentListeners.set(key, handlers); },
    removeEventListener: (key, fn) => documentListeners.get(key)?.delete(fn),
    execCommand: command => { assert.equal(command, 'copy'); documentFire('copy', { preventDefault() {}, clipboardData: { setData: (type, text) => clipboard.set(type, text) } }); return true; },
  };
  const context = createContext({ document, console, TextEncoder, TextDecoder, Uint8Array, WebAssembly, atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout, clearTimeout, setInterval, clearInterval, ResizeObserver: class { observe() {} disconnect() {} },
    devicePixelRatio: 1, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, addEventListener() {},
    chrome: { webview: { postMessage: value => posted.push(value), addEventListener: (name, fn) => listeners.set(name, fn) } },
  });
  context.window = context;
  new Script(scripts[0]).runInContext(context);
  const ActualRenderer = context.GhosttyWeb.CanvasRenderer;
  let terminal, measurable = true, selection = '', nextURL = 'http://localhost:3000/app';
  context.GhosttyWeb.Terminal = class {
    constructor(options) {
      terminal = this; this.cols = 80; this.rows = 24;
      this.buffer = { active: { getLine: () => ({ length: 80, getCell: () => ({ getHyperlinkId: () => 0 }) }) } };
      this.linkDetector = new context.GhosttyWeb.LinkDetector(this);
      this.linkDetector.registerProvider({ provideLinks: (row, callback) => callback([{ text: nextURL, range: { start: { x: 0, y: row }, end: { x: 60, y: row } }, activate() { throw new Error('must not call original window.open activation'); } }]) });
      this.renderer = new ActualRenderer(node('actual-canvas'), options);
      this.options = new Proxy(options, { set: (target, key, value) => {
        target[key] = value;
        if (key === 'fontSize') this.renderer.setFontSize(value);
        if (key === 'fontFamily') this.renderer.setFontFamily(value);
        return true;
      } });
    }
    loadAddon(addon) { addon.terminal = this; }
    open() {} onScroll() {} onSelectionChange() {} onData(fn) { this.data = fn; }
    scrollToBottom() {} hasSelection() { return !!selection; } getSelection() { return selection; } hasBracketedPaste() { return true; }
    getViewportY() { return 0; } scrollLines() {} reset() {} dispose() {}
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    write(data, callback) { assert.equal(callback, undefined, 'ACK must not wait for rAF'); writes.push(data); }
  };
  context.GhosttyWeb.FitAddon = class { proposeDimensions() { if (!measurable) return; const metrics = this.terminal.renderer.getMetrics(); return { cols: Math.floor(420 / metrics.width), rows: Math.floor(210 / metrics.height) }; } };
  await new Script(scripts[1]).runInContext(context);
  assert(posted.some(event => event.type === 'ready'));
  assert(!posted.some(event => event.type === 'error'));
  const config = JSON.parse(scripts[1].match(/startNativeTerminal\((\{[^]*\})\);\s*$/)[1]);
  assert.equal(terminal.renderer.getMetrics().height, Math.max(14, Math.ceil(config.size * config.lineHeight)), 'real cell metrics use supplied code line-height');
  const send = (command, value, bridge = config.bridge) => listeners.get('message')({ data: { command, value, bridge } });
  measurable = false;
  const resizes = posted.filter(event => event.type === 'resize').length;
  send('layout');
  assert.equal(posted.filter(event => event.type === 'resize').length, resizes, 'hidden/unmeasurable document must not admit default 80x24 geometry');
  measurable = true;
  const render = (key, serial = 1) => send('render', { type: 'render', key, serial, live: true, chunks: [{ id: 1, data: 'VT_DATA' }] });
  send('active', true);
  send('eval', { source: 'throw new Error("must not execute")' });
  render('first'); assert.deepEqual(writes, ['VT_DATA']);
  send('shortcuts', [{ actionId: 'toggle_terminal_expanded', keystroke: 'ctrl+alt+e' }]);
  const key = overrides => documentFire('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, altKey: true, preventDefault() {}, stopImmediatePropagation() {}, ...overrides });
  key({ key: 'J', code: 'KeyJ', altKey: false, shiftKey: true });
  assert(!posted.some(event => event.type === 'shortcut'), 'old fixed mod+shift+j is not bound');
  key({}); assert.equal(posted.filter(event => event.type === 'shortcut').length, 1);
  key({ isComposing: true }); assert.equal(posted.filter(event => event.type === 'shortcut').length, 1);
  assert(posted.some(event => event.type === 'ack' && event.key === 'first' && event.serial === 1 && event.cursor === 1));
  send('render', { type: 'render', key: 'forbidden', live: true, serial: 2, chunks: [{ id: 2, data: 'BAD' }] }, { ...config.bridge, generation: 999 });
  assert.deepEqual(writes, ['VT_DATA']);
  send('configure', { ...config, size: 20, lineHeight: 1.8 });
  assert.equal(terminal.renderer.getMetrics().height, 36);
  assert.equal(terminal.rows, 5, 'FitAddon sees exactly the renderer height after preference change');
  const click = () => { const event = { isTrusted: true, ctrlKey: true, target: {} }; documentFire('click', event); return event; };
  let event = click();
  (await terminal.linkDetector.getLinkAt(0, 0)).activate(event);
  assert(posted.some(value => value.type === 'openPreview' && value.key === 'first' && value.url === nextURL && value.mode === 'preview'));
  nextURL = 'https://example.invalid/docs'; terminal.linkDetector.invalidateCache(); event = click();
  (await terminal.linkDetector.getLinkAt(0, 0)).activate(event);
  assert(posted.some(value => value.type === 'openPreview' && value.url === nextURL && value.mode === 'external'));
  const opened = posted.filter(value => value.type === 'openPreview').length;
  const lateClick = click(), lateLink = await terminal.linkDetector.getLinkAt(0, 0);
  render('second'); lateLink.activate(lateClick);
  assert.equal(posted.filter(value => value.type === 'openPreview').length, opened, 'async detection may not route an old-tab link into the new tab');
  lateLink.activate({ isTrusted: false, ctrlKey: true });
  assert.equal(posted.filter(value => value.type === 'openPreview').length, opened, 'output alone is never a trusted link activation');
  nextURL = 'javascript:alert(1)'; terminal.linkDetector.invalidateCache(); event = click();
  (await terminal.linkDetector.getLinkAt(0, 0)).activate(event);
  assert.equal(posted.filter(value => value.type === 'openPreview').length, opened, 'link detection must not admit a non-HTTP target');
  render('first');
  const nativeKey = overrides => input.fire('keydown', { key: 'c', preventDefault() {}, ...overrides });
  selection = 'selected 中\nsecond line';
  let sent = posted.filter(value => value.type === 'input').length;
  nativeKey({ ctrlKey: true, shiftKey: true });
  assert.equal(clipboard.get('text/plain'), selection);
  assert.equal(posted.filter(value => value.type === 'input').length, sent, 'copy selection must not type Ctrl-C');
  nativeKey({ metaKey: true });
  assert.equal(posted.filter(value => value.type === 'input').length, sent);
  send('render', { type: 'render', key: 'first', serial: 0, live: false, chunks: [] });
  selection = 'copy after PTY exit';
  documentFire('copy', { preventDefault() {}, clipboardData: { setData: (type, text) => clipboard.set(type, text) } });
  assert.equal(clipboard.get('text/plain'), selection, 'visible historical output remains copyable even when the PTY is not live');
  send('active', false); selection = 'hidden selection';
  documentFire('copy', { preventDefault() {}, clipboardData: { setData: (type, text) => clipboard.set(type, text) } });
  assert.equal(clipboard.get('text/plain'), 'copy after PTY exit', 'hidden terminal cannot own the native copy event');
  send('active', true); render('first');
  selection = '';
  sent = posted.filter(value => value.type === 'input').length;
  nativeKey({ key: 'v', code: 'KeyV', ctrlKey: true });
  nativeKey({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true });
  assert.equal(posted.filter(value => value.type === 'input').length, sent, 'native paste shortcut must not become Ctrl-V PTY input');
  nativeKey({ ctrlKey: true });
  let receipt = posted.filter(value => value.type === 'input').at(-1);
  assert.equal(receipt.data, '\x03', 'without a selection Ctrl-C remains PTY input');
  send('inputResult', { key: receipt.key, receipt: receipt.receipt, status: 'accepted' });
  const paste = 'paste 中\nline 2';
  input.fire('paste', { clipboardData: { getData: () => paste }, preventDefault() {}, stopPropagation() {} });
  receipt = posted.filter(value => value.type === 'input').at(-1);
  assert.equal(receipt.data, '\x1b[200~' + paste + '\x1b[201~');
  send('inputResult', { key: receipt.key, receipt: receipt.receipt, status: 'accepted' });
  nativeKey({ key: 'x', altKey: true });
  receipt = posted.filter(value => value.type === 'input').at(-1);
  assert.equal(receipt.data, '\x1bx');
  send('inputResult', { key: receipt.key, receipt: receipt.receipt, status: 'accepted' });
  const type = text => { input.value = text; input.fire('input', { isComposing: false }); };
  type('HIDDEN_DRAFT'); const first = posted.filter(event => event.type === 'input').at(-1);
  send('active', false); send('inputResult', { key: first.key, receipt: first.receipt, status: 'suspended' });
  assert.equal(input.value, 'HIDDEN_DRAFT'); const before = posted.filter(event => event.type === 'input').length;
  send('active', true); render('first', 2); assert.equal(posted.filter(event => event.type === 'input').length, before, 'resume never replays restored draft');
  type('UNKNOWN_SENT'); const uncertain = posted.filter(event => event.type === 'input').at(-1);
  send('inputResult', { key: uncertain.key, receipt: uncertain.receipt, status: 'unknown' });
  render('second'); type('OTHER_TAB'); send('inputResult', { key: 'second', status: 'closed' }); render('second');
  assert.equal(posted.filter(event => event.type === 'input').length, before + 1, 'closing another tab cannot replay unknown input');
  send('inputResult', { key: uncertain.key, status: 'closed' });
  render('second'); assert.equal(posted.filter(event => event.type === 'input').length, before + 1);
  type('EXPLICIT_FRESH'); assert.equal(posted.filter(event => event.type === 'input').length, before + 2);
  assert(posted.some(event => event.type === 'input' && event.data === 'EXPLICIT_FRESH'));
  terminal.renderer.dispose();
}
