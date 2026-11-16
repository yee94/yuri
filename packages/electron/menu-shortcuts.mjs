import { isGuiPluginUiUrl } from './gui-plugin-origin.mjs';

const MAX_COMBOS = 4096;
const MAX_COMBO_LENGTH = 128;
const FALLBACK_INTERVAL_MS = 1000;
const SHIFTED_KEYS = {
  '{': '[', '}': ']', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '|': '\\',
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0',
};

// Keep key semantics aligned with shared UI keyToShortcutToken/eventMatchesShortcut.
const keyToken = (key) => {
  const lower = String(key ?? '').toLowerCase();
  if (lower === ',') return 'comma';
  if (lower === '.') return 'period';
  if (lower === ' ') return 'space';
  if (lower === 'esc') return 'escape';
  if (lower === '+') return 'plus';
  if (lower === '-' || lower === '_') return 'minus';
  if (lower === '`') return 'backtick';
  return SHIFTED_KEYS[lower] ?? lower;
};

const signature = (key, meta, control, shift, alt) =>
  `${Number(meta)}${Number(control)}${Number(shift)}${Number(alt)}:${key}`;

const comboSignature = (combo, platform) => {
  if (typeof combo !== 'string' || !combo || combo.length > MAX_COMBO_LENGTH) return null;
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop();
  if (!key || key.trim() !== key || ['mod', 'ctrl', 'shift', 'alt', '__unassigned__'].includes(key)
    || parts.some(part => !['mod', 'ctrl', 'shift', 'alt'].includes(part))) return null;
  const modifiers = new Set(parts);
  const mod = modifiers.has('mod');
  return signature(keyToken(key), mod && platform === 'darwin',
    modifiers.has('ctrl') || (mod && platform !== 'darwin'), modifiers.has('shift'), modifiers.has('alt'));
};

const inputSignature = (input) => {
  let key = input.key;
  if ((!key || key === 'Dead') && input.code === 'Backquote') key = '`';
  if (input.alt && /^Key[A-Z]$/.test(input.code)) key = input.code.slice(3);
  else if (input.alt && /^Digit[0-9]$/.test(input.code)) key = input.code.slice(5);
  return signature(keyToken(key), Boolean(input.meta), Boolean(input.control), Boolean(input.shift), Boolean(input.alt));
};

const reservedQuit = (input, platform) => !input.shift && !input.alt
  && (input.code === 'KeyQ' || input.key?.toLowerCase() === 'q')
  && (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta);

export function isMenuShortcutSender(event, BrowserWindow, origins) {
  try {
    const contents = event.sender;
    const win = BrowserWindow.fromWebContents(contents);
    return Boolean(win && win.webContents === contents && !contents.isDestroyed()
      && event.senderFrame && event.senderFrame === contents.mainFrame
      && event.senderFrame.url === contents.getURL()
      && isGuiPluginUiUrl(contents.getURL(), origins));
  } catch { return false; }
}

const acceleratorSignature = (accelerator, platform) => {
  if (typeof accelerator !== 'string') return null;
  const combo = accelerator.toLowerCase()
    .replace(/commandorcontrol|cmdorctrl/g, 'mod')
    .replace(/command|cmd|super|meta/g, platform === 'darwin' ? 'mod' : 'meta')
    .replace(/control/g, 'ctrl').replace(/option/g, 'alt');
  const aliases = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', return: 'enter' };
  const parts = combo.split('+');
  const key = parts.pop();
  return comboSignature([...parts, aliases[key] ?? key].join('+'), platform);
};

const findMenuItem = (menu, key, platform) => {
  for (const item of menu?.items ?? []) {
    if (item.enabled === false || item.visible === false) continue;
    if (item.submenu) {
      const found = findMenuItem(item.submenu, key, platform);
      if (found) return found;
    } else if ((item.registerAccelerator !== false || (platform === 'darwin' && item.role))
      && acceleratorSignature(item.userAccelerator || item.accelerator, platform) === key) return item;
  }
  return null;
};

const replayMenuItem = (item, win, contents, Menu, platform) => {
  if (!item || item.role === 'quit') return false;
  // Cocoa roles are not executed by MenuItem.click on macOS.
  if (platform === 'darwin' && item.role) {
    if (item.role === 'minimize') {
      if (!win.isMinimizable()) return false;
      win.minimize();
    } else if (item.role === 'togglefullscreen') {
      win.setFullScreen(!win.isFullScreen());
    } else {
      const selector = {
        undo: 'undo:', redo: 'redo:', cut: 'cut:', paste: 'paste:', selectall: 'selectAll:',
        hide: 'hide:', hideothers: 'hideOtherApplications:',
      }[item.role.toLowerCase()];
      if (!selector) return false;
      Menu.sendActionToFirstResponder(selector);
    }
    return true;
  }
  if (typeof item.click !== 'function') return false;
  item.click({ triggeredByAccelerator: true }, win, contents);
  return true;
};

/** Window-scoped menu arbitration. No renderer key is prevented or synthesized. */
export function createMenuShortcuts({ BrowserWindow, Menu, authorize, platform = process.platform, now = () => performance.now() }) {
  const owners = new Map();
  const clear = (owner) => {
    owner.claims.clear();
    owner.pending = null;
    if (!owner.contents.isDestroyed()) owner.contents.setIgnoreMenuShortcuts(false);
  };
  const ownerFor = (contents) => {
    let owner = owners.get(contents);
    if (owner) return owner;
    owner = { contents, claims: new Set(), pending: null, navigating: false };
    const beforeInput = (_event, input) => {
      if (owner.claims.size === 0) return;
      const key = inputSignature(input);
      const claimed = !owner.navigating && !input.isComposing && !reservedQuit(input, platform) && owner.claims.has(key);
      // Always restore false for an unmatched input, even immediately after a match.
      contents.setIgnoreMenuShortcuts(claimed);
      if (input.type === 'keyDown') {
        owner.pending = claimed ? { key, at: now() } : null;
      }
    };
    const blur = () => { owner.pending = null; contents.setIgnoreMenuShortcuts(false); };
    const navigate = (event, _url, inPlace, mainFrame) => {
      if ((event.isMainFrame ?? mainFrame) && !(event.isSameDocument ?? inPlace)) {
        owner.navigating = true;
        clear(owner);
      }
    };
    const committed = () => { owner.navigating = false; };
    const gone = () => { owner.navigating = true; clear(owner); };
    const destroy = () => {
      owners.delete(contents);
      owner.claims.clear();
      owner.pending = null;
      contents.removeListener('before-input-event', beforeInput);
      contents.removeListener('blur', blur);
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('did-navigate', committed);
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('destroyed', destroy);
    };
    owners.set(contents, owner);
    contents.on('before-input-event', beforeInput);
    contents.on('blur', blur);
    contents.on('did-start-navigation', navigate);
    contents.on('did-navigate', committed);
    contents.on('render-process-gone', gone);
    contents.once('destroyed', destroy);
    return owner;
  };
  const requireSender = (event) => {
    if (!authorize(event)) throw new Error('Menu shortcuts require the trusted main application document');
  };
  return {
    track(contents) { ownerFor(contents); },
    claim(event, combos) {
      requireSender(event);
      if (!Array.isArray(combos) || combos.length > MAX_COMBOS) throw new Error('Invalid menu shortcut claims');
      const claims = new Set();
      for (const combo of combos) {
        const key = comboSignature(combo, platform);
        if (!key) throw new Error('Invalid menu shortcut combination');
        claims.add(key);
      }
      const owner = ownerFor(event.sender);
      if (owner.navigating) throw new Error('Menu shortcut document is navigating');
      clear(owner);
      owner.claims = claims;
    },
    fallback(event, combo) {
      requireSender(event);
      const owner = owners.get(event.sender);
      const pending = owner?.pending;
      if (!pending) return false;
      owner.pending = null;
      const key = comboSignature(combo, platform);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (key !== pending.key || !owner.claims.has(key) || now() - pending.at >= FALLBACK_INTERVAL_MS
        || !win?.isFocused() || win.isDestroyed()) return false;
      return replayMenuItem(findMenuItem(Menu.getApplicationMenu(), key, platform), win, event.sender, Menu, platform);
    },
  };
}
