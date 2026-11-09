import { describe, expect, test, vi } from 'vitest';
import { createDesktopHeaderNavigation, type DesktopHeaderNavigationFileReceipt, type DesktopHeaderNavigationGuard, type DesktopHeaderNavigationTarget, type DesktopHeaderNavigationTicket } from './desktop-header-navigation';
import { createDesktopPageDeparture, type DesktopPageDepartureOwner } from './desktop-page-departure';
import type { DesktopHeaderServiceResult } from './desktop-header-services';

const a: DesktopHeaderNavigationTarget = Object.freeze({ id: 'A', url: 'https://a.example', authorizationID: 'auth-A' });
const b: DesktopHeaderNavigationTarget = Object.freeze({ id: 'B', url: 'https://b.example', authorizationID: 'auth-B' });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  const trace: string[] = [];
  let window = {}, route: object | null = {}, runtimeScope = { hostID: 'A', lease: 'lease-A' }, generation = 1;
  let connection: DesktopHeaderNavigationTarget | null = a, connections: readonly DesktopHeaderNavigationTarget[] | null = [a, b];
  let externalRevision = 0, popup = true, start = true, canLeave = true, pageCurrent = true;
  const entry = vi.fn(() => popup), canStart = vi.fn(() => start);
  const intent = { current: entry, from: a };
  const capture = vi.fn((): DesktopHeaderNavigationGuard | null => {
    const revision = externalRevision;
    return { window, route, runtimeScope, generation, connection, connections, valid: () => externalRevision === revision };
  });
  const filesRequest = vi.fn(async (): Promise<DesktopHeaderNavigationFileReceipt> => { trace.push('files'); return true; });
  const filesCanLeave = vi.fn(() => canLeave);
  const onIntent = vi.fn(() => { trace.push('intent'); });
  const onError = vi.fn();
  const leave = vi.fn(async (done: () => void) => { trace.push('page'); done(); });
  const release = vi.fn(() => { trace.push('release'); pageCurrent = false; });
  const pageOwner: DesktopPageDepartureOwner = { current: () => pageCurrent, requestLeave: leave, release, requestClose: async () => true, canClose: () => true };
  const departure = createDesktopPageDeparture({ scope: () => runtimeScope, onIntent, onError });
  const unbindPage = departure.bind(pageOwner);
  const switchCommit = vi.fn(async (target: DesktopHeaderNavigationTarget, ticket: DesktopHeaderNavigationTicket): Promise<DesktopHeaderServiceResult> => {
    expect(ticket.current()).toBe(true); expect(release).toHaveBeenCalledTimes(1); trace.push('switch:' + target.id); return { status: 'accepted' };
  });
  const addCommit = vi.fn(async (ticket: DesktopHeaderNavigationTicket): Promise<DesktopHeaderServiceResult> => {
    expect(ticket.current()).toBe(true); expect(release).toHaveBeenCalledTimes(1); trace.push('add'); return { status: 'accepted' };
  });
  const navigation = createDesktopHeaderNavigation({ canStart, capture, files: { request: filesRequest, canLeave: filesCanLeave }, departure,
    switch: { commit: switchCommit }, add: { commit: addCommit } });
  const change = (kind: string) => {
    if (kind === 'window') window = {};
    else if (kind === 'route') route = {};
    else if (kind === 'host') runtimeScope = { hostID: 'different', lease: 'lease-other' };
    else if (kind === 'lease') runtimeScope = { ...runtimeScope, lease: 'lease-renewed' };
    else if (kind === 'generation') generation++;
    else if (kind === 'from-url') connection = { ...a, url: 'https://a-changed.example' };
    else if (kind === 'from-auth') connection = { ...a, authorizationID: 'new-auth' };
    else if (kind === 'target-url') connections = [a, { ...b, url: 'https://b-changed.example' }];
    else if (kind === 'target-auth') connections = [a, { ...b, authorizationID: 'new-auth' }];
    else if (kind === 'target-missing') connections = [a];
    else if (kind === 'unknown') connections = null;
    else if (kind === 'dirty') canLeave = false;
    else if (kind === 'cancel') navigation.cancel();
    else if (kind === 'dispose') navigation.dispose();
    else externalRevision++; // Settings/Help/Search/close/lifecycle, including ABA.
  };
  return { navigation, intent, entry, canStart, capture, filesRequest, filesCanLeave, departure, leave, release, unbindPage, onIntent, onError, switchCommit, addCommit, trace, change,
    popup: (value: boolean) => { popup = value; }, start: (value: boolean) => { start = value; }, clean: () => { canLeave = true; },
    catalog: (value: readonly DesktopHeaderNavigationTarget[] | null) => { connections = value; },
    selected: (value: DesktopHeaderNavigationTarget | null) => { connection = value; },
  };
}

describe('Header entry intent transfers to one exact root ticket', () => {
  test('construction and idle pending reads perform zero source reads, confirmations or IO', () => {
    const f = fixture(); for (let i = 0; i < 50; i++) expect(f.navigation.pending()).toBe(false);
    expect(f.capture).not.toHaveBeenCalled(); expect(f.canStart).not.toHaveBeenCalled(); expect(f.filesRequest).not.toHaveBeenCalled(); expect(f.leave).not.toHaveBeenCalled();
    expect(f.switchCommit).not.toHaveBeenCalled(); expect(f.addCommit).not.toHaveBeenCalled();
  });
  test.each(['switch', 'add'] as const)('%s runs original file guard, original page departure, release then one commit', async action => {
    const f = fixture();
    const receipt = await (action === 'switch' ? f.navigation.switch(b, f.intent) : f.navigation.add(f.intent));
    expect(receipt).toEqual({ status: 'accepted', phase: 'commit', reason: 'committed' });
    expect(f.trace).toEqual(['files', 'intent', 'page', 'release', action === 'switch' ? 'switch:B' : 'add']);
    expect(f.navigation.pending()).toBe(false); expect(f.onIntent).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  test('same exact current target is a no-op: no confirmation, select, stream stop or page release', async () => {
    const f = fixture();
    expect(await f.navigation.switch({ ...a }, f.intent)).toEqual({ status: 'accepted', phase: 'entry', reason: 'unchanged' });
    expect(f.trace).toEqual([]); expect(f.filesRequest).not.toHaveBeenCalled(); expect(f.leave).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('entry rejects a closed popup, blocked root, stale from and non-exact target without touching guards', async () => {
    for (const kind of ['entry', 'blocked', 'from-url', 'target-url', 'target-auth', 'target-missing', 'duplicate']) {
      const f = fixture(); if (kind === 'entry') f.popup(false); else if (kind === 'blocked') f.start(false); else if (kind === 'duplicate') f.catalog([a, b, { ...b }]); else f.change(kind);
      const receipt = await f.navigation.switch(b, f.intent);
      expect(receipt.status).toBe(kind === 'blocked' ? 'unsupported' : 'stale'); expect(receipt.phase).toBe('entry');
      expect(f.filesRequest).not.toHaveBeenCalled(); expect(f.leave).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
    }
  });
  test('unknown committed metadata is not an empty successful source', async () => {
    const f = fixture(); f.catalog(null);
    expect(await f.navigation.add(f.intent)).toEqual({ status: 'unknown', phase: 'entry', reason: 'unavailable' });
    expect(f.filesRequest).not.toHaveBeenCalled(); expect(f.addCommit).not.toHaveBeenCalled();
    f.capture.mockReturnValue(null); expect((await f.navigation.add(f.intent)).status).toBe('unknown'); expect(f.filesRequest).not.toHaveBeenCalled();
  });
  test('a known empty catalog with no selected connection can explicitly Add without inventing a Host', async () => {
    const f = fixture(), window = {};
    f.capture.mockReturnValue({ window, route: null, runtimeScope: null, connection: null, connections: [], generation: 0, valid: () => true });
    expect((await f.navigation.add({ current: f.entry, from: null })).status).toBe('accepted');
    expect(f.addCommit.mock.calls[0][0].snapshot.connection).toBeNull(); expect(f.addCommit.mock.calls[0][0].snapshot.runtimeScope).toBeNull(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('irrelevant catalog reorder/label-object replacements do not retire an exact source or target', async () => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(); f.filesRequest.mockReturnValue(files.promise);
    const pending = f.navigation.switch(b, f.intent); f.catalog([{ ...b }, { ...a }]); f.selected({ ...a }); files.resolve(true);
    expect((await pending).status).toBe('accepted'); expect(f.switchCommit.mock.calls[0][0]).toEqual(b);
  });
  test('malformed empty target and unreadable root metadata fail closed before any confirmation', async () => {
    const f = fixture(); expect((await f.navigation.switch({ ...b, url: '' }, f.intent)).reason).toBe('invalid-target');
    f.capture.mockImplementation(() => { throw new Error('synthetic metadata unavailable'); });
    expect((await f.navigation.add(f.intent)).status).toBe('unknown'); expect(f.filesRequest).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  test('own files/page modal may close popup and revoke Header/services without revoking the admitted navigation', async () => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(), page = deferred<void>(); let finish!: () => void;
    f.filesRequest.mockImplementation(() => { f.popup(false); f.start(false); return files.promise; });
    f.leave.mockImplementation(done => { finish = () => { done(); page.resolve(); }; return page.promise; });
    const pending = f.navigation.switch(b, f.intent); expect(f.navigation.pending()).toBe(true);
    const entryReads = f.entry.mock.calls.length, canStartReads = f.canStart.mock.calls.length;
    files.resolve(true); await vi.waitFor(() => expect(f.leave).toHaveBeenCalledTimes(1)); finish();
    expect((await pending).status).toBe('accepted'); expect(f.entry).toHaveBeenCalledTimes(entryReads); expect(f.canStart).toHaveBeenCalledTimes(canStartReads);
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.switchCommit).toHaveBeenCalledTimes(1);
  });
  test('only one pending job: second action is rejected, cancel retains the original lane until its await settles', async () => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(); f.filesRequest.mockReturnValueOnce(files.promise);
    const first = f.navigation.switch(b, f.intent);
    expect(await f.navigation.add(f.intent)).toEqual({ status: 'unsupported', phase: 'entry', reason: 'pending' });
    f.navigation.cancel(); expect(f.navigation.pending()).toBe(true);
    expect((await f.navigation.switch(b, f.intent)).reason).toBe('pending'); expect(f.filesRequest).toHaveBeenCalledTimes(1);
    files.resolve(true); expect((await first).reason).toBe('retired'); expect(f.navigation.pending()).toBe(false);
    expect(f.release).not.toHaveBeenCalled(); expect((await f.navigation.add(f.intent)).status).toBe('accepted');
  });
  test('dispose is permanent; cancel/dispose never release pages or close the file guard themselves', async () => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(); f.filesRequest.mockReturnValue(files.promise);
    const pending = f.navigation.switch(b, f.intent); f.navigation.dispose(); f.navigation.dispose();
    expect(f.release).not.toHaveBeenCalled(); expect((await f.navigation.add(f.intent)).reason).toBe('disposed');
    files.resolve(true); expect((await pending).reason).toBe('disposed'); expect(f.switchCommit).not.toHaveBeenCalled();
  });
});

describe('file and retained page confirmations never grant stale release', () => {
  test.each([
    [false, 'stale', 'files-denied'], [{ status: 'cancelled' }, 'stale', 'cancelled'],
    [{ status: 'failed' }, 'failed', 'failed'], [{ status: 'unknown' }, 'unknown', 'unknown'],
  ] as const)('file receipt %j preserves page and does not auto-confirm/replay', async (files, status, reason) => {
    const f = fixture(); f.filesRequest.mockResolvedValue(files);
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status, phase: 'files', reason });
    await Promise.resolve(); expect(f.filesRequest).toHaveBeenCalledTimes(1); expect(f.leave).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('a thrown file save/unknown guard is not accepted or replaced with another confirmation', async () => {
    const f = fixture(); f.filesRequest.mockRejectedValue(new Error('synthetic lost file receipt'));
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'unknown', phase: 'files', reason: 'unknown' });
    expect(f.leave).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.filesRequest).toHaveBeenCalledTimes(1);
  });
  test('page Cancel and a late callback after its original request ended never release or switch', async () => {
    const f = fixture(); let late!: () => void;
    f.leave.mockImplementation(async done => { late = done; });
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'stale', phase: 'departure', reason: 'departure-denied' });
    expect(f.onIntent).toHaveBeenCalledTimes(1); late(); late();
    expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('the no-page-owner path still validates root after startup onIntent, before committing', async () => {
    const f = fixture(); f.unbindPage(); f.onIntent.mockImplementation(() => { f.change('Settings'); });
    expect((await f.navigation.add(f.intent)).reason).toBe('retired');
    expect(f.onIntent).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled(); expect(f.addCommit).not.toHaveBeenCalled();
  });
  const retirements = ['window', 'route', 'host', 'lease', 'generation', 'from-url', 'from-auth', 'target-url', 'target-auth', 'target-missing', 'Settings', 'Help', 'Search', 'close', 'lifecycle', 'cancel', 'dispose', 'unknown', 'dirty'];
  test.each(retirements)('retiring %s while files await prevents even page departure', async kind => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(); f.filesRequest.mockReturnValue(files.promise);
    const pending = f.navigation.switch(b, f.intent); f.change(kind); files.resolve(true);
    expect((await pending).status).not.toBe('accepted'); expect(f.leave).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test.each(retirements)('retiring %s while page confirmation awaits is checked BEFORE original release', async kind => {
    const f = fixture(), page = deferred<void>(); let finish!: () => void;
    f.leave.mockImplementation(done => { finish = () => { done(); page.resolve(); }; return page.promise; });
    const pending = f.navigation.switch(b, f.intent); await vi.waitFor(() => expect(f.leave).toHaveBeenCalledTimes(1));
    f.change(kind); finish(); expect((await pending).status).not.toBe('accepted');
    f.clean(); finish(); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('external modal open/close ABA does not revive a ticket, even though its popup was already closed by the own guard', async () => {
    const f = fixture(), page = deferred<void>(); let finish!: () => void;
    f.leave.mockImplementation(done => { f.popup(false); f.start(false); finish = () => { done(); page.resolve(); }; return page.promise; });
    const pending = f.navigation.add(f.intent); await vi.waitFor(() => expect(f.leave).toHaveBeenCalledTimes(1));
    f.change('Settings'); f.change('Settings-close'); finish();
    expect((await pending).reason).toBe('retired'); expect(f.release).not.toHaveBeenCalled(); expect(f.addCommit).not.toHaveBeenCalled();
  });
  test('dirty edits during page await veto release, even if requestLeave calls the commit again after cleaning', async () => {
    const f = fixture(), page = deferred<void>(); let attempt!: () => void;
    f.leave.mockImplementation(done => { attempt = done; return page.promise; });
    const pending = f.navigation.switch(b, f.intent); await vi.waitFor(() => expect(f.leave).toHaveBeenCalledTimes(1));
    f.change('dirty'); attempt(); f.clean(); attempt(); page.resolve();
    expect((await pending).reason).toBe('files-changed'); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
  test('page requestLeave errors do not release and remain in the original page error owner', async () => {
    const f = fixture(); f.leave.mockRejectedValue(new Error('synthetic page confirmation failure'));
    expect((await f.navigation.switch(b, f.intent)).status).not.toBe('accepted');
    expect(f.onError).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled(); expect(f.switchCommit).not.toHaveBeenCalled();
  });
});

describe('commit belongs to original native/settings owner, never an inferred ACK', () => {
  test('freezes supplied target and source identity; does not rebind an in-place caller mutation', async () => {
    const f = fixture(), files = deferred<DesktopHeaderNavigationFileReceipt>(), mutable = { ...b };
    f.filesRequest.mockReturnValue(files.promise); const pending = f.navigation.switch(mutable, f.intent);
    mutable.url = 'https://not-the-selected-target.example'; files.resolve(true);
    expect((await pending).status).toBe('accepted'); const [target, ticket] = f.switchCommit.mock.calls[0];
    expect(target).toEqual(b); expect(Object.isFrozen(target)).toBe(true); expect(ticket.snapshot.connection).toEqual(a); expect(Object.isFrozen(ticket.snapshot.runtimeScope)).toBe(true);
  });
  test.each(['route', 'host', 'lease', 'target-url', 'Settings', 'cancel', 'dispose', 'dirty'])('late native gate after %s change receives revoked ticket and cannot select the target', async kind => {
    const f = fixture(), gate = deferred<void>(), select = vi.fn();
    f.switchCommit.mockImplementation(async (_target, ticket) => { await gate.promise; if (!ticket.current()) return { status: 'stale' }; select(); return { status: 'accepted' }; });
    const pending = f.navigation.switch(b, f.intent); await vi.waitFor(() => expect(f.switchCommit).toHaveBeenCalledTimes(1));
    f.change(kind); gate.resolve(); expect((await pending).status).toBe('stale'); expect(select).not.toHaveBeenCalled(); expect(f.filesRequest).toHaveBeenCalledTimes(1);
  });
  test('accepted native ACK stays accepted after intentional Host change and failed catalog refresh', async () => {
    const f = fixture();
    f.switchCommit.mockImplementation(async (target, ticket) => { expect(ticket.current()).toBe(true); f.selected(target); f.change('host'); f.catalog(null); return { status: 'accepted' }; });
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'accepted', phase: 'commit', reason: 'committed' });
    expect(f.switchCommit).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  test('Add accepted by original settings-open owner is not vetoed by the modal that this commit intentionally opens', async () => {
    const f = fixture();
    f.addCommit.mockImplementation(async ticket => { expect(ticket.current()).toBe(true); f.change('Settings'); return { status: 'accepted' }; });
    expect(await f.navigation.add(f.intent)).toEqual({ status: 'accepted', phase: 'commit', reason: 'committed' }); expect(f.addCommit).toHaveBeenCalledTimes(1);
  });
  test('selected target without an ACK does not prove success; thrown post-select receipt stays unknown with no replay', async () => {
    const f = fixture();
    f.switchCommit.mockImplementation(async target => { f.selected(target); throw new Error('synthetic lost native ACK'); });
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'unknown', phase: 'commit', reason: 'unknown' });
    await Promise.resolve(); expect(f.switchCommit).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  test('a synchronous native commit throw is unknown after the one authorized release, never an automatic retry', async () => {
    const f = fixture(); f.switchCommit.mockImplementation(() => { throw new Error('synthetic native dispatch error'); });
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'unknown', phase: 'commit', reason: 'unknown' });
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.switchCommit).toHaveBeenCalledTimes(1); expect(f.onError).not.toHaveBeenCalled();
  });
  test.each([undefined, null, {}, { status: 'unexpected' }])('an untyped/malformed native receipt %j cannot imply accepted', async value => {
    const f = fixture(); f.switchCommit.mockResolvedValue(value as DesktopHeaderServiceResult);
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'unknown', phase: 'commit', reason: 'unknown' });
    expect(f.switchCommit).toHaveBeenCalledTimes(1);
  });
  test('a receipt getter failure is unknown rather than escaping as a rejected navigation promise', async () => {
    const f = fixture(); f.switchCommit.mockResolvedValue({ get status(): 'accepted' { throw new Error('synthetic receipt unavailable'); } });
    expect(await f.navigation.switch(b, f.intent)).toEqual({ status: 'unknown', phase: 'commit', reason: 'unknown' });
  });
  test('repeated original page callbacks cannot duplicate a pending native commit or its release', async () => {
    const f = fixture(), ack = deferred<DesktopHeaderServiceResult>(); let done!: () => void;
    f.leave.mockImplementation(async commit => { done = commit; commit(); commit(); }); f.switchCommit.mockReturnValue(ack.promise);
    const pending = f.navigation.switch(b, f.intent); await vi.waitFor(() => expect(f.switchCommit).toHaveBeenCalledTimes(1));
    done(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.navigation.pending()).toBe(true);
    ack.resolve({ status: 'accepted' }); expect((await pending).status).toBe('accepted'); expect(f.switchCommit).toHaveBeenCalledTimes(1);
  });
  test.each(['failed', 'unknown', 'unsupported', 'stale'] as const)('explicit native %s receipt is not guessed to be accepted or replayed', async status => {
    const f = fixture(); f.switchCommit.mockResolvedValue({ status });
    expect((await f.navigation.switch(b, f.intent)).status).toBe(status); expect(f.switchCommit).toHaveBeenCalledTimes(1); expect(f.filesRequest).toHaveBeenCalledTimes(1);
  });
  test('unknown original native lane blocks a later explicit entry through main canStart, not a second journal', async () => {
    const f = fixture(); f.switchCommit.mockImplementation(async () => { f.start(false); return { status: 'unknown' }; });
    expect((await f.navigation.switch(b, f.intent)).status).toBe('unknown');
    expect((await f.navigation.switch(b, f.intent)).reason).toBe('blocked'); expect(f.switchCommit).toHaveBeenCalledTimes(1);
  });
});
