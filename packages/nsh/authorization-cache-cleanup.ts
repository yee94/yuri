export type CleanupBridge = {
  ready(): Promise<{ owner: string; tickets: string[] }>;
  list(owner: string): Promise<string[]>;
  claim(owner: string, ticket: string): Promise<{ connectionID: string; authorizationID: string }>;
  ack(owner: string, ticket: string): Promise<void>;
};

/** Validate the untyped host boundary; absent handlers/responses are never success. */
export function authorizationCacheCleanupBridge(call: (name: string, body: Record<string, unknown>) => Promise<unknown>): CleanupBridge & { retry(): Promise<void> } {
  const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw Error('authorization-cache-invalid-response');
    return value as Record<string, unknown>;
  }
  function tickets(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(identifier) || new Set(value).size !== value.length) throw Error('authorization-cache-invalid-tickets');
    return value;
  }
  async function confirmed(name: string, body: Record<string, unknown>) {
    if (await call(name, body) !== true) throw Error('authorization-cache-unconfirmed');
  }
  return {
    async ready() {
      const value = object(await call('authorization.cache.ready', {}), ['owner', 'tickets']);
      if (!identifier(value.owner)) throw Error('authorization-cache-invalid-owner');
      return { owner: value.owner, tickets: tickets(value.tickets) };
    },
    async list(owner) { return tickets(await call('authorization.cache.list', { owner })); },
    async claim(owner, ticket) {
      const value = object(await call('authorization.cache.claim', { owner, ticket }), ['connectionID', 'authorizationID']);
      if (!identifier(value.connectionID) || !identifier(value.authorizationID)) throw Error('authorization-cache-invalid-identity');
      return { connectionID: value.connectionID, authorizationID: value.authorizationID };
    },
    ack: (owner, ticket) => confirmed('authorization.cache.ack', { owner, ticket }),
    retry: () => confirmed('authorization.cache.retry', {}),
  };
}

/** Install once beside the singleton history cache. Native issues all identities and tickets. */
export function createAuthorizationCacheCleanup(bridge: CleanupBridge, retire: (connectionID: string, authorizationID: string) => Promise<void>, alive = () => true) {
  let owner: string | undefined, flight: Promise<{ completed: string[]; failed: string[] }> | undefined;
  async function sweep() {
    let tickets: string[];
    if (owner === undefined) { const ready = await bridge.ready(); owner = ready.owner; tickets = ready.tickets; }
    else tickets = await bridge.list(owner);
    const completed: string[] = [], failed: string[] = [];
    for (const ticket of tickets) {
      if (!alive()) break;
      try {
        const identity = await bridge.claim(owner, ticket);
        if (!alive()) break;
        await retire(identity.connectionID, identity.authorizationID);
        if (!alive()) break;
        await bridge.ack(owner, ticket);
        completed.push(ticket);
      } catch { failed.push(ticket); }
    }
    return { completed, failed };
  }
  return { run() { return flight ??= sweep().finally(() => { flight = undefined; }); } };
}

export type AuthorizationCacheCleanupState = { ready: boolean; busy: boolean; failed: boolean };
export type AuthorizationCacheCleanupRootOptions = {
  bridge: CleanupBridge & { retry(): Promise<void> };
  retire(connectionID: string, authorizationID: string): Promise<void>;
  subscribe(callback: () => void): () => void;
  onReady(): void;
  onState(state: AuthorizationCacheCleanupState): void;
};

/** Pure lifecycle owner: tips coalesce into one extra pass, failures never start a timer. */
export function createAuthorizationCacheCleanupRoot(options: AuthorizationCacheCleanupRootOptions) {
  let alive = true, ready = false, dirty = false, started = false, retryNative = false, nativeFailed = false;
  let stop: (() => void) | undefined, flight: Promise<void> | undefined;
  const cleanup = createAuthorizationCacheCleanup(options.bridge, options.retire, () => alive);
  function publish(busy: boolean, failed: boolean) { if (alive) options.onState({ ready, busy, failed: failed || nativeFailed }); }
  async function drain() {
    publish(true, false);
    let failed = false;
    do {
      dirty = false;
      try {
        const result = await cleanup.run();
        if (!alive) return;
        failed = result.failed.length > 0;
        // An empty follow-up pass must not request another native retry/event forever.
        if (result.completed.length || retryNative) {
          retryNative = false;
          try { await options.bridge.retry(); nativeFailed = false; } catch { nativeFailed = true; }
        }
      } catch { failed = true; }
    } while (alive && dirty);
    if (!alive) return;
    if (!failed && !ready) { ready = true; options.onReady(); }
    publish(false, failed);
  }
  function request(nativeRetry = false): Promise<void> {
    if (!alive) return Promise.resolve();
    retryNative ||= nativeRetry;
    dirty = true;
    if (flight) return flight;
    // Reserve the flight before running user callbacks or bridge functions.
    const work = Promise.resolve().then(drain);
    flight = work.finally(() => {
      flight = undefined;
      // A tip can arrive after drain's final synchronous check but before finally.
      if (alive && dirty) return request();
    });
    return flight;
  }
  return {
    start() {
      if (!alive) return Promise.resolve();
      if (!started) { started = true; stop = options.subscribe(() => { void request(); }); }
      return request(true);
    },
    retry: () => request(true),
    dispose() { alive = false; dirty = false; stop?.(); stop = undefined; },
  };
}
