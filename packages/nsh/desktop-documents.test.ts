import { describe, expect, it, vi } from 'vitest';
import { createDesktopDocuments, desktopDocumentBytes, desktopDocumentReceipt, DESKTOP_MARKDOWN_LIMIT, type DesktopDocumentState } from './desktop-documents';
const scope = { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' };
const document = { filename: 'synthetic.md', content: '# 合成 Markdown\n' };
function fixture() {
  let current = true, sequence = 0;
  const native = vi.fn(async (_method: string, payload: Record<string, unknown>): Promise<unknown> => ({ requestID: payload.requestID, state: 'saved' }));
  const changed = vi.fn((_state: DesktopDocumentState) => {});
  const owner = createDesktopDocuments({ scope, document, native, id: () => `synthetic_${++sequence}`, current: () => current, changed });
  return { owner, native, changed, retire: () => { current = false; owner.dispose(); } };
}
describe('local desktop Markdown save owner (synthetic HostChannel only)', () => {
  it('does no work until explicit Save, passes only bounded verified export metadata/content, and never returns a local path', async () => {
    const f = fixture(); expect(f.native).not.toHaveBeenCalled();
    await f.owner.save();
    expect(f.native.mock.calls[0]).toEqual(['desktop.documents.save', { requestID: 'synthetic_2', ownerID: 'synthetic_1', expectedHost: scope, format: 'markdown', ...document }]);
    expect(f.owner.snapshot().phase).toBe('saved'); await f.owner.save(); expect(f.native).toHaveBeenCalledOnce();
  });
  it('unknown/lost ACK retry performs only exact status; no second save, no second target chooser', async () => {
    const f = fixture(); f.native.mockImplementation(async (method, payload) => { if (method.endsWith('.save')) throw new Error('lost ACK /never-display-this-path'); return { requestID: payload.requestID, state: 'saved' }; });
    await f.owner.save(); expect(f.owner.snapshot()).toEqual({ phase: 'unknown', error: 'documents_result_unconfirmed' });
    await f.owner.save();
    expect(f.native.mock.calls[1]).toEqual(['desktop.documents.status', { requestID: 'synthetic_2', ownerID: 'synthetic_1', expectedHost: scope }]);
    expect(f.native.mock.calls.filter(([method]) => method.endsWith('.save'))).toHaveLength(1);
    expect(f.owner.snapshot().phase).toBe('saved');
  });
  it('an uncertain filesystem commit and failed status remain unknown without resending even after repeated clicks', async () => {
    const f = fixture(); f.native.mockImplementation(async (method, payload) => { if (method.endsWith('.status')) throw new Error('offline'); return { requestID: payload.requestID, state: 'error', error: 'documents_write_unknown' }; });
    await f.owner.save(); for (let i = 0; i < 4; i++) await f.owner.save();
    expect(f.owner.snapshot().phase).toBe('unknown'); expect(f.native.mock.calls.filter(([method]) => method.endsWith('.save'))).toHaveLength(1);
  });
  it('cancellation is not successful export; an explicit new Save uses a new exact ID', async () => {
    const f = fixture(); f.native.mockImplementation(async (_method, payload) => ({ requestID: payload.requestID, state: 'cancelled' }));
    await f.owner.save(); expect(f.owner.snapshot().phase).toBe('cancelled'); await f.owner.save();
    expect(f.native.mock.calls[1]?.[1].requestID).toBe('synthetic_3');
  });
  it('serializes pending clicks and sends owner cancellation on hidden/Host retirement; late receipts do not publish', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.native.mockImplementation((method) => method.endsWith('.save') ? new Promise(done => { resolve = done; }) : Promise.resolve({}));
    const saving = f.owner.save(); await f.owner.save(); expect(f.native).toHaveBeenCalledOnce();
    f.changed.mockClear(); f.retire();
    expect(f.native.mock.calls[1]).toEqual(['desktop.documents.cancel', { requestID: 'synthetic_2', ownerID: 'synthetic_1', expectedHost: scope }]);
    resolve({ requestID: 'synthetic_2', state: 'saved' }); await saving;
    expect(f.changed).not.toHaveBeenCalled(); await f.owner.save(); expect(f.native).toHaveBeenCalledTimes(2);
  });
  it('validates UTF-8 byte boundaries without a content-sized allocation or lossy surrogate replacement', async () => {
    expect(desktopDocumentBytes('界😀')).toBe(7); expect(desktopDocumentBytes('x'.repeat(DESKTOP_MARKDOWN_LIMIT))).toBe(DESKTOP_MARKDOWN_LIMIT);
    for (const content of ['界'.repeat(Math.floor(DESKTOP_MARKDOWN_LIMIT / 3) + 1), '\ud800', '\udc00', '\0']) expect(() => desktopDocumentBytes(content)).toThrow();
    const native = vi.fn(); const owner = createDesktopDocuments({ scope, document: { ...document, content: 'x'.repeat(DESKTOP_MARKDOWN_LIMIT + 1) }, native, id: () => 'synthetic', current: () => true, changed: vi.fn() });
    await owner.save(); expect(native).not.toHaveBeenCalled(); expect(owner.snapshot().phase).toBe('error');
  });
  it('rejects receipt identity mismatch, leaked local paths/content, malformed states and raw errors', () => {
    for (const value of [{ requestID: 'other', state: 'saved' }, { requestID: 'save', state: 'saved', path: '/private/path' }, { requestID: 'save', state: 'saved', content: 'body' }, { requestID: 'save', state: 'done' }, { requestID: 'save', state: 'error', error: '/private/path' }]) expect(() => desktopDocumentReceipt(value, 'save')).toThrow('documents_invalid_receipt');
  });
});
