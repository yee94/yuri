import { beginDesktopWriterDispatch, type DesktopWriterClaim, type DesktopWriterClient, type DesktopWriterPhase, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type DesktopChatWriterTarget = Readonly<{ kind: 'session' | 'assistant'; id: string }>;
export type DesktopChatWriterPhase = DesktopWriterPhase | 'capabilities-loading' | 'unsupported' | 'waiting-scope';
export type DesktopChatWriterRetirement = {
  prepareWriterRetirement(): Promise<boolean>;
  canReleaseWriter(): boolean;
  cancelWriterRetirement(): void;
};
const safe = (check: () => boolean) => { try { return check() === true; } catch { return false; } };

/** One retained primary Chat, not a draft, transport, registry or read-only panel owner. */
export function createDesktopChatWriter<Child>(options: {
  client(): DesktopWriterClient | undefined;
  capabilitiesReady(): boolean;
  target: DesktopChatWriterTarget;
  committedRuntimeScope(): RuntimeScope | null;
  stableAuthorityIdentity(): string | null;
  current(): boolean;
  handoff?: DesktopWriterClaim;
  renderChild(grant: () => VerifiedDesktopWriterGrant | null, markUnknown: (cause?: unknown) => void): Child;
  scopeReady?(scope: RuntimeScope): void;
  changed?(): void;
}) {
  const target = Object.freeze({ kind: options.target.kind, id: options.target.id });
  let phase: DesktopChatWriterPhase = 'capabilities-loading', claim: DesktopWriterClaim | undefined;
  let client: DesktopWriterClient | undefined, authority: string | undefined, boundScope: RuntimeScope | null = null;
  let retired = false, attempted = false, constructed = false, child: Child | undefined;
  let flight: Promise<VerifiedDesktopWriterGrant | null> | undefined, releaseFlight: Promise<boolean> | undefined;
  let stop: (() => void) | undefined;
  type Retirement = { chat: DesktopChatWriterRetirement; additional(): boolean; scope: RuntimeScope; prepared: boolean };
  let retirement: Retirement | undefined, preparation: Promise<boolean> | undefined;
  let business: { chat: DesktopChatWriterRetirement; additional(): boolean } | undefined;
  const changed = () => { try { options.changed?.(); } catch { /* Presentation cannot change native custody. */ } };
  const scope = () => { try { return runtimeScopeFrom(options.committedRuntimeScope()); } catch { return null; } };
  const identity = () => !retired && safe(() => options.current() && target.kind === options.target.kind && target.id === options.target.id
    && (!client || options.client() === client) && (authority === undefined || options.stableAuthorityIdentity() === authority)
    && (!claim || !scope() || scope()!.hostID === claim.expectedHost.hostID));
  function retire() {
    if (retired) return;
    retired = true; phase = 'retired'; claim?.retire(); stop?.(); stop = undefined; changed();
  }
  function current() { if (!identity()) { retire(); return false; } return true; }
  function grant(): VerifiedDesktopWriterGrant | null {
    if (!current() || retirement || !sameRuntimeScope(scope(), boundScope)) return null;
    const value = claim?.grant();
    return value && sameRuntimeScope(value.expectedHost, boundScope) ? value : null;
  }
  function markUnknown(cause?: unknown) { attempted = true; claim?.markUnknown(cause); phase = 'unknown'; changed(); }
  function status() {
    current();
    return Object.freeze({ phase: claim?.status().unknown ? 'unknown' as const : retired ? 'retired' as const : claim?.phase() ?? phase,
      constructed, writable: !!grant(), pending: claim?.status().pending ?? 0 });
  }
  function verifyHandoff(value: DesktopWriterClaim, expected: RuntimeScope) {
    if (value.windowID !== client!.windowID || value.target.kind !== target.kind || value.target.id !== target.id || !sameRuntimeScope(value.expectedHost, expected)) return false;
    const verified = value.grant();
    if (!verified || verified.ownerID !== value.ownerID || verified.windowID !== value.windowID) return false;
    // Validate the producer's opaque receipt, not a copied metadata lookalike. No native dispatch.
    try {
      const proof = beginDesktopWriterDispatch({ writer: () => verified, expectedHost: expected, windowID: client!.windowID,
        path: target.kind === 'session' ? `/api/session/${encodeURIComponent(target.id)}/prompt` : `/api/yuri/assistants/${encodeURIComponent(target.id)}/messages`, method: 'POST' });
      if (!proof) return false;
      proof.finish('not-dispatched'); return true;
    } catch { return false; }
  }
  function reconcile(): Promise<VerifiedDesktopWriterGrant | null> {
    if (flight) return flight;
    flight = Promise.resolve().then(async () => {
      if (!current()) return null;
      if (!claim) {
        if (attempted) return null;
        if (!options.capabilitiesReady()) { phase = 'capabilities-loading'; changed(); return null; }
        const rootClient = options.client(), expected = scope(), stable = options.stableAuthorityIdentity();
        if (!rootClient) { phase = 'unsupported'; changed(); return null; }
        if (!expected || !stable) { phase = 'waiting-scope'; changed(); return null; }
        attempted = true; client = rootClient; authority = stable;
        if (!client.current()) { phase = 'denied'; changed(); return null; }
        try {
          if (options.handoff) {
            if (!verifyHandoff(options.handoff, expected)) { phase = 'denied'; changed(); return null; }
            claim = options.handoff;
          } else claim = client.claim({ target, expectedHost: expected, current: identity });
          stop = claim.subscribe(changed);
          phase = 'acquiring'; changed();
          await claim.ready();
        } catch (cause) { phase = 'unknown'; claim?.markUnknown(cause); changed(); return null; }
      }
      if (!current() || retirement || claim.status().unknown || ['denied', 'released', 'retired'].includes(claim.phase())) return null;
      const expected = scope();
      if (!expected) return null;
      if (!sameRuntimeScope(claim.expectedHost, expected)) {
        phase = 'renewing'; changed();
        const renewed = await claim.renew({ expectedHost: expected });
        if (!renewed) return null;
      }
      if (!current() || !sameRuntimeScope(scope(), expected)) return null;
      const verified = claim.grant();
      if (!verified || !sameRuntimeScope(verified.expectedHost, expected)) return null;
      try {
        if (!sameRuntimeScope(boundScope, expected)) {
          boundScope = expected;
          options.scopeReady?.(expected);
        }
        if (!current() || !grant()) return null;
        if (!constructed) { constructed = true; child = options.renderChild(grant, markUnknown); }
        phase = 'ready'; changed(); return grant();
      } catch (cause) { markUnknown(cause); return null; }
    }).catch(cause => { markUnknown(cause); return null; });
    const pending = flight;
    void pending.finally(() => { if (flight === pending) flight = undefined; });
    return pending;
  }
  function businessAllowed(ticket: Retirement) {
    return retirement === ticket && ticket.prepared && current() && sameRuntimeScope(scope(), ticket.scope)
      && sameRuntimeScope(claim?.expectedHost ?? null, ticket.scope) && safe(ticket.chat.canReleaseWriter)
      && safe(ticket.additional) && !!claim && ['ready', 'releasing'].includes(claim.phase()) && !claim.status().unknown && claim.status().pending === 0;
  }
  function canClose() { return !!retirement && businessAllowed(retirement) && !!claim?.canRelease(); }
  function cancel() {
    // Once native release is dispatched only its exact ACK can settle custody.
    if (releaseFlight) return false;
    const original = retirement; retirement = undefined; preparation = undefined;
    original?.chat.cancelWriterRetirement(); changed(); return true;
  }
  function prepareRetirement(chat = business?.chat, additionalCanClose: () => boolean = business?.additional ?? (() => true)): Promise<boolean> {
    if (preparation) return preparation;
    const expected = scope();
    if (!chat || !current() || !constructed || !expected || !grant() || !safe(additionalCanClose) || !claim?.canRelease()) return Promise.resolve(false);
    const ticket: Retirement = { chat, additional: additionalCanClose, scope: expected, prepared: false };
    retirement = ticket;
    preparation = Promise.resolve().then(async () => {
      try {
        if (retirement !== ticket || !current()) return false;
        ticket.prepared = await chat.prepareWriterRetirement();
        return canClose();
      } catch { return false; }
    }).then(accepted => {
      if (!accepted && retirement === ticket) cancel();
      changed(); return accepted;
    });
    changed(); return preparation;
  }
  function release(): Promise<boolean> {
    if (releaseFlight) return releaseFlight;
    if (!canClose()) return Promise.resolve(false);
    const ticket = retirement!, owner = claim!;
    releaseFlight = owner.release({ allowed: () => businessAllowed(ticket) });
    const pending = releaseFlight;
    void pending.then(accepted => { if (releaseFlight === pending) releaseFlight = undefined; if (accepted) { phase = 'released'; stop?.(); stop = undefined; } changed(); });
    return pending;
  }
  return {
    reconcile, ready: reconcile, grant, markUnknown, status, child: () => child,
    prepareRetirement, canClose, cancel, release, retire,
    bindBusiness(chat: DesktopChatWriterRetirement, additionalCanClose: () => boolean = () => true) {
      if (business) throw new Error('desktop-chat-writer-business-already-bound');
      const binding = { chat, additional: additionalCanClose }; business = binding;
      return () => { if (business === binding) { business = undefined; cancel(); } };
    },
    // Explicit late-acquire cleanup only. Constructed Chat must use its original business guard above.
    async close(permission: { allowed(): boolean }) {
      if (constructed) return false;
      retire(); if (flight) await flight;
      return claim ? claim.close({ allowed: () => safe(permission.allowed) && options.client() === client && client!.current()
        && options.stableAuthorityIdentity() === authority && sameRuntimeScope(scope(), claim!.expectedHost) }) : false;
    },
  };
}
