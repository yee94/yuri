/** Native desktop bridge contract. Credentials, socket bytes and reconnects stay in Swift. */
export type RemoteDesktopInput =
  | { type: 'pointer'; action: 'down' | 'up' | 'move' | 'click' | 'right'; x: number; y: number }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'release' };
export type RemoteDesktopFrame = { owner: string; id: number; source: string; width: number; height: number };
export type RemoteDesktopState = {
  phase: 'connecting' | 'live' | 'closed' | 'paused';
  code?: string;
  frame?: RemoteDesktopFrame;
};
export type RemoteDesktopCall = (name: string, body: Record<string, unknown>) => Promise<unknown>;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const keys = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
const terminalCodes = new Set(['disabled', 'unsupported', 'helper_unavailable', 'authentication_required', 'permission_denied', 'runtime_changed']);

/** Same bounded input vocabulary as the authenticated Host's protocol.js, checked again by Swift. */
export function validRemoteDesktopInput(input: RemoteDesktopInput): boolean {
  if (input.type === 'release') return true;
  if (input.type === 'pointer') return ['down', 'up', 'move', 'click', 'right'].includes(input.action) && unit(input.x) && unit(input.y);
  if (input.type === 'scroll') return Number.isFinite(input.dx) && Number.isFinite(input.dy) && Math.abs(input.dx) <= 1000 && Math.abs(input.dy) <= 1000;
  if (input.type === 'text') return input.text.length > 0 && input.text.length <= 1024;
  if (input.type === 'key') return keys.has(input.key);
  return false;
}

let nextOwner = 0;
/** Page-local owner fence; never opens a socket or retains an endpoint in QuickJS. */
export function createRemoteDesktopSession(options: {
  scopeKey: string;
  call: RemoteDesktopCall;
  subscribe: (listener: (event: unknown) => void) => () => void;
  changed: (state: RemoteDesktopState) => void;
}) {
  let owner: string | undefined, active = false, disposed = false, changedHost = false, terminal = false, zoomed = false, acknowledged: string | undefined;
  let state: RemoteDesktopState = { phase: 'paused' };
  const publish = (value: RemoteDesktopState) => { state = value; options.changed(value); };
  const current = (id: string) => !disposed && active && owner === id && !changedHost;
  const stop = () => {
    const previous = owner;
    owner = undefined;
    if (previous) void options.call('remoteDesktop.close', { owner: previous }).catch(() => {
      // Swift independently stops on background, Host invalidation and socket liveness failure.
      // A rejected close is observable; it must not report a successful closed session.
      if (!disposed && !owner && !changedHost) publish({ phase: 'closed', code: 'connection_failed' });
    });
  };
  const start = () => {
    if (disposed || changedHost || terminal || !active || owner) return;
    const id = `desktop-${++nextOwner}`;
    owner = id;
    publish({ phase: 'connecting' });
    void options.call('remoteDesktop.open', { owner: id, zoomed }).catch(() => {
      if (current(id)) { stop(); publish({ phase: 'closed', code: 'connection_failed' }); }
    });
  };
  const unsubscribe = options.subscribe(value => {
    const event = object(value);
    if (typeof event.owner !== 'string' || !current(event.owner)) return;
    if (event.type === 'frame') {
      if (!Number.isSafeInteger(event.frame) || Number(event.frame) <= 0 || typeof event.source !== 'string'
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(event.source) || event.source.length > 700_000
        || !Number.isInteger(event.width) || !Number.isInteger(event.height)
        || Number(event.width) <= 0 || Number(event.height) <= 0 || Number(event.width) > 2560 || Number(event.height) > 2560
        || Number(event.width) * Number(event.height) > 2560 * 1440) {
        stop(); publish({ phase: 'closed', code: 'connection_failed' }); return;
      }
      if (state.frame && Number(event.frame) <= state.frame.id) return;
      publish({ ...state, frame: { owner: event.owner, id: Number(event.frame), source: event.source, width: Number(event.width), height: Number(event.height) } });
    } else if (event.type === 'state' && ['connecting', 'live', 'closed', 'paused'].includes(String(event.phase))) {
      const phase = event.phase as RemoteDesktopState['phase'];
      if (phase === 'closed' && typeof event.code === 'string' && terminalCodes.has(event.code)) {
        terminal = true;
        if (event.code === 'runtime_changed') { changedHost = true; stop(); }
      }
      // Never keep a stale screen visible/interactive during reconnect, revocation or background.
      publish({ phase, ...(typeof event.code === 'string' ? { code: event.code } : {}), ...(phase === 'live' ? { frame: state.frame } : {}) });
    }
  });
  return {
    setActive(value: boolean, scopeKey = options.scopeKey) {
      if (disposed) return;
      if (scopeKey !== options.scopeKey) {
        changedHost = true; active = false; stop(); publish({ phase: 'closed', code: 'runtime_changed' }); return;
      }
      active = value;
      if (!value) { stop(); if (!terminal) publish({ phase: 'paused' }); } else start();
    },
    retry() { if (active && !changedHost && !disposed) { terminal = false; stop(); start(); } },
    setZoomed(value: boolean) {
      if (zoomed === value) return;
      zoomed = value;
      if (owner && current(owner)) {
        const id = owner;
        void options.call('remoteDesktop.view', { owner: id, zoomed: value }).catch(() => {
          if (current(id)) { stop(); publish({ phase: 'closed', code: 'connection_failed' }); }
        });
      }
    },
    async send(input: RemoteDesktopInput): Promise<boolean> {
      const id = owner;
      if (!id || !current(id) || state.phase !== 'live' || !validRemoteDesktopInput(input)) return false;
      try {
        const result = await options.call('remoteDesktop.input', { owner: id, input });
        return current(id) && state.phase === 'live' && result === true;
      } catch {
        if (current(id)) { stop(); publish({ phase: 'closed', code: 'connection_failed' }); }
        return false;
      }
    },
    async decoded(frame: RemoteDesktopFrame): Promise<void> {
      if (!current(frame.owner) || state.frame !== frame) return;
      const key = `${frame.owner}:${frame.id}`;
      if (acknowledged === key) return;
      acknowledged = key;
      try { await options.call('remoteDesktop.ack', { owner: frame.owner, frame: frame.id }); }
      catch { if (current(frame.owner)) { stop(); publish({ phase: 'closed', code: 'connection_failed' }); } }
    },
    decodeFailed(frame: RemoteDesktopFrame) {
      if (current(frame.owner) && state.frame === frame) { stop(); publish({ phase: 'closed', code: 'connection_failed' }); }
    },
    dispose() { if (disposed) return; disposed = true; active = false; unsubscribe(); stop(); },
  };
}

export function remoteDesktopMessageKey(code?: string) {
  if (code === 'unsupported' || code === 'helper_unavailable') return 'remoteDesktop.unsupported' as const;
  if (code === 'disabled') return 'settings.remoteDesktop.disabled' as const;
  if (code === 'permission_required') return 'remoteDesktop.permissions' as const;
  if (code === 'permission_denied') return 'remoteDesktop.denied' as const;
  if (code === 'runtime_changed') return 'remoteDesktop.runtimeChanged' as const;
  return code ? 'remoteDesktop.failed' as const : 'remoteDesktop.connecting' as const;
}
