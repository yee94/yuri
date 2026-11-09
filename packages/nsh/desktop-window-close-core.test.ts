import { describe, expect, it, vi } from 'vitest';
import { createDesktopWindowCloseOwner } from './desktop-window-close-core';

const request = (generation = 1) => ({ ticket: `window:${generation}:nonce`, windowID: 'window', generation, reason: 'close' });
function setup() {
  let scope = 'authority-a', canClose = true;
  const files = vi.fn(async () => true), settings = vi.fn(async () => true), decide = vi.fn(async (_decision: { ticket: string; approved: boolean }): Promise<unknown> => true), error = vi.fn();
  const committing = vi.fn();
  const owner = createDesktopWindowCloseOwner({ scope: () => scope, requestFiles: files, requestSettings: settings, canCloseFiles: () => canClose, decide, onCommitting: committing, onError: error });
  return { owner, files, settings, decide, committing, error, changeScope: () => { scope = 'authority-b'; }, editFile: () => { canClose = false; } };
}
describe('native window close approval', () => {
  it('holds a commit lock before native delivery until teardown, but releases a rejected decision', async () => {
    const s = setup(); let finish!: (value: unknown) => void;
    s.decide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const closing = s.owner.request(request());
    await vi.waitFor(() => expect(s.decide).toHaveBeenCalledOnce());
    expect(s.committing).toHaveBeenLastCalledWith(true);
    finish(true); expect(await closing).toBe(true);
    expect(s.committing).not.toHaveBeenCalledWith(false);
    const rejected = setup(); rejected.decide.mockRejectedValueOnce(new Error('expired ticket'));
    expect(await rejected.owner.request(request())).toBe(false);
    expect(rejected.committing.mock.calls.map(([locked]) => locked)).toEqual([true, false]);
  });
  it('requires both real guards and acknowledges only the native ticket', async () => {
    const s = setup();
    expect(await s.owner.request(request())).toBe(true);
    expect(s.files).toHaveBeenCalledOnce(); expect(s.settings).toHaveBeenCalledOnce();
    expect(s.decide).toHaveBeenCalledExactlyOnceWith({ ticket: request().ticket, approved: true });
    expect(await s.owner.request(request())).toBe(false);
    expect(s.decide).toHaveBeenCalledOnce();
  });
  it('fails closed and releases the commit lock when the final file recheck throws', async () => {
    const decide = vi.fn(async () => true), locked = vi.fn(), error = vi.fn();
    const owner = createDesktopWindowCloseOwner({ scope: () => 'authority', requestFiles: async () => true, requestSettings: async () => true,
      canCloseFiles: () => { throw new Error('file owner unavailable'); }, decide, onCommitting: locked, onError: error });
    expect(await owner.request(request())).toBe(false);
    expect(decide).toHaveBeenCalledExactlyOnceWith({ ticket: request().ticket, approved: false });
    expect(locked.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(error).toHaveBeenCalledOnce();
  });
  it('denial and decision transport failure keep the owner available for retry', async () => {
    const s = setup(); s.files.mockResolvedValueOnce(false);
    expect(await s.owner.request(request())).toBe(false); expect(s.settings).not.toHaveBeenCalled();
    expect(s.decide).toHaveBeenLastCalledWith({ ticket: request().ticket, approved: false });
    s.decide.mockRejectedValueOnce(new Error('native unavailable'));
    expect(await s.owner.request(request(2))).toBe(false); expect(s.error).toHaveBeenCalledOnce();
    expect(await s.owner.request(request(3))).toBe(true);
  });
  it('deduplicates prompts and rejects a new ticket while an old confirmation is pending', async () => {
    const s = setup(); let finish!: (value: boolean) => void;
    s.files.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = s.owner.request(request());
    expect(s.owner.request(request())).toBe(first);
    expect(await s.owner.request(request(2))).toBe(false);
    finish(true); expect(await first).toBe(false);
    expect(s.decide).toHaveBeenCalledExactlyOnceWith({ ticket: request(2).ticket, approved: false });
    expect(await s.owner.request(request(3))).toBe(true);
  });
  it.each(['scope', 'edit', 'dispose'] as const)('fences %s changes during Settings confirmation', async kind => {
    const s = setup(); let finish!: (value: boolean) => void;
    s.settings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const closing = s.owner.request(request()); await Promise.resolve();
    if (kind === 'scope') s.changeScope(); else if (kind === 'edit') s.editFile(); else s.owner.dispose();
    finish(true); expect(await closing).toBe(false);
    if (kind === 'dispose') expect(s.decide).not.toHaveBeenCalled();
    else expect(s.decide).toHaveBeenCalledExactlyOnceWith({ ticket: request().ticket, approved: false });
  });
  it('never approves malformed or another window events, or unconfirmed native replies', async () => {
    const s = setup();
    for (const event of [null, {}, { ...request(), generation: 0 }, { ...request(), reason: 'other' }]) expect(await s.owner.request(event)).toBe(false);
    expect(s.files).not.toHaveBeenCalled();
    s.decide.mockResolvedValueOnce(null); expect(await s.owner.request(request())).toBe(false);
    expect(await s.owner.request({ ...request(2), windowID: 'other' })).toBe(false);
    expect(s.files).toHaveBeenCalledOnce(); expect(s.error).toHaveBeenCalledOnce();
  });
});
