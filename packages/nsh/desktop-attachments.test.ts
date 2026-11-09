import { describe, expect, it } from 'vitest';
import { createDesktopAttachments, desktopAttachmentResult } from './desktop-attachments';
import { assistantAttachmentURI } from './assistant-attachment-model';

const scope = { hostID: 'synthetic-host', lease: 'synthetic-lease' };
const file = { uri: 'file:///synthetic/note.txt', name: 'note.txt', mime: 'text/plain' };
const second = { ...file, uri: 'file:///synthetic/second.txt', name: 'second.txt' };
const receipt = (requestID: string, state = 'ready') => ({ requestID, state, attachments: state === 'ready' ? [file] : [], orphaned: 0 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('desktop attachment draft ownership', () => {
  it('appends multiple real descriptors once, retaining concurrent draft attachments and exact scope', async () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = []; const pending = deferred<unknown>(); let files = [file];
    const native = async (name: string, body: Record<string, unknown>) => { calls.push({ name, body }); return name.endsWith('.pick') ? pending.promise : { ...receipt('pick_1'), attachments: [file, second] }; };
    const controller = createDesktopAttachments({ scope, native, id: () => 'pick_1' });
    const flight = controller.pick('files', { current: () => true, read: () => files, write: value => { files = value; } });
    files = [...files, file]; pending.resolve({ ...receipt('pick_1'), attachments: [file, second] }); await flight;
    expect(files).toHaveLength(4); await controller.reconcile(); expect(files).toHaveLength(4);
    expect(calls.map(c => c.name)).toEqual(['desktop.attachments.pick', 'desktop.attachments.status']);
    expect(calls[0]!.body).toEqual({ kind: 'files', requestID: 'pick_1', expectedHost: scope });
    expect(JSON.stringify(calls)).not.toMatch(/token|bytes|base64|localhost/);
  });
  it('releases a late owner without replacing new chat/new-session drafts', async () => {
    const pending = deferred<unknown>(); const calls: string[] = []; let current = true; let writes = 0;
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => { calls.push(name); return name.endsWith('.pick') ? pending.promise : { ...receipt('pick_1', 'retired'), orphaned: 1 }; } });
    const flight = controller.pick('images', { current: () => current, read: () => [], write: () => { writes++; } });
    current = false; pending.resolve(receipt('pick_1')); const result = await flight;
    expect(writes).toBe(0); expect(result.state).toBe('retired'); expect(result.orphaned).toBe(1); expect(result.attachments).toEqual([]);
    expect(calls).toEqual(['desktop.attachments.pick', 'desktop.attachments.release']);
  });
  it('fences cancellation while a successful upload is in flight', async () => {
    const pending = deferred<unknown>(); let writes = 0;
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => name.endsWith('.pick') ? pending.promise : { ...receipt('pick_1', 'retired'), orphaned: 1 } });
    const flight = controller.pick('files', { current: () => true, read: () => [], write: () => { writes++; } });
    await controller.cancel(); pending.resolve(receipt('pick_1')); expect((await flight).state).toBe('retired'); expect(writes).toBe(0);
  });
  it('interrupted receipt only reads back and never resends unknown bytes', async () => {
    const calls: string[] = []; let writes = 0;
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => { calls.push(name); if (name.endsWith('.pick')) throw new Error('interrupted'); return receipt('pick_1', 'unknown'); } });
    const owner = { current: () => true, read: () => [], write: () => { writes++; } };
    await expect(controller.pick('files', owner)).rejects.toThrow('interrupted');
    await expect(controller.pick('files', owner)).rejects.toThrow('receipt_unresolved');
    expect((await controller.reconcile())!.state).toBe('unknown'); expect(writes).toBe(0);
    expect(calls).toEqual(['desktop.attachments.pick', 'desktop.attachments.status']);
  });
  it('preserves partial success and reports a later file failure instead of clearing the draft', async () => {
    let files = [file];
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async () => ({ ...receipt('pick_1'), state: 'failed', error: 'attachment_upload_rejected' }) });
    expect((await controller.pick('files', { current: () => true, read: () => files, write: value => { files = value; } })).state).toBe('failed');
    expect(files).toHaveLength(2);
  });
  it('validates malformed descriptors and cancellation without guessing success', () => {
    for (const value of [null, { ...receipt('wrong') }, { ...receipt('pick_1'), attachments: [{ ...file, uri: '/host/secret' }] }, { ...receipt('pick_1'), attachments: [{ ...file, name: '../secret' }] }, { ...receipt('pick_1'), state: 'pending' }]) expect(() => desktopAttachmentResult(value, 'pick_1')).toThrow('invalid_receipt');
    expect(desktopAttachmentResult(receipt('pick_1', 'cancelled'), 'pick_1').attachments).toEqual([]);
  });
  it('keeps unknown remainder blocked while later status files are adopted exactly once by bounded identity', async () => {
    const calls: string[] = []; let files = [second]; let snapshot = { ...receipt('pick_1', 'unknown'), attachments: [file, file] };
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => { calls.push(name); return snapshot; } });
    const owner = { current: () => true, read: () => files, write: (value: typeof files) => { files = value; } };
    await controller.pick('files', owner); expect(files).toEqual([second, file]); expect(controller.blocked()).toBe(true);
    await expect(controller.pick('files', owner)).rejects.toThrow('receipt_unresolved');
    snapshot = { ...snapshot, attachments: [file, second] };
    await controller.reconcile(); await controller.reconcile();
    expect(files).toEqual([second, file, second]); expect(controller.receipt()?.adopted).toBe(2); expect(controller.blocked()).toBe(true);
    files = files.filter(item => item.uri !== file.uri); // An explicit user removal must not be undone by readback.
    snapshot = { ...snapshot, state: 'ready' };
    await controller.reconcile(); expect(files).toEqual([second, second]); expect(controller.blocked()).toBe(false);
    expect(calls.filter(name => name.endsWith('.pick'))).toHaveLength(1);
  });
  it('retains receipt after pick/readback/cancel 401 without treating denial as empty or permitting a new pick', async () => {
    let denied = true, files: typeof file[] = []; const calls: string[] = [];
    const controller = createDesktopAttachments({ scope, id: () => 'pick_401', native: async name => { calls.push(name); if (denied) throw Object.assign(new Error('HTTP 401'), { status: 401 }); return receipt('pick_401'); } });
    const owner = { current: () => true, read: () => files, write: (value: typeof files) => { files = value; } };
    await expect(controller.pick('files', owner)).rejects.toMatchObject({ status: 401 });
    await expect(controller.reconcile()).rejects.toMatchObject({ status: 401 });
    expect(controller.receipt()).toMatchObject({ requestID: 'pick_401', state: 'unknown', unresolved: true });
    await expect(controller.pick('files', owner)).rejects.toThrow('receipt_unresolved');
    denied = false; await controller.reconcile(); expect(files).toEqual([file]);
    // Use a separate unresolved receipt to prove a failed cancel also retains its identity.
    denied = true; const failed = createDesktopAttachments({ scope, id: () => 'cancel_401', native: async () => { throw Object.assign(new Error('HTTP 401'), { status: 401 }); } });
    await expect(failed.pick('files', owner)).rejects.toThrow(); await expect(failed.cancel()).rejects.toThrow();
    expect(failed.blocked()).toBe(true); expect(failed.receipt()?.requestID).toBe('cancel_401');
    expect(calls).toEqual(['desktop.attachments.pick', 'desktop.attachments.status', 'desktop.attachments.status']);
  });
  it.each(['pending', 'failed'] as const)('does not unlock a %s receipt merely because a prior partial file was adopted', async state => {
    let snapshot = { ...receipt('pick_1', state), attachments: state === 'failed' ? [file] : [] }; let files: typeof file[] = [];
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async () => snapshot });
    const owner = { current: () => true, read: () => files, write: (value: typeof files) => { files = value; } };
    await controller.pick('files', owner); await expect(controller.pick('files', owner)).rejects.toThrow('receipt_unresolved');
    snapshot = { ...receipt('pick_1', 'ready'), attachments: [file, second] }; await controller.reconcile();
    expect(files).toEqual([file, second]); expect(controller.blocked()).toBe(false);
  });
  it('retired Host only releases metadata; adopted prior files remain and only newly orphaned identities count', async () => {
    let current = true, files: typeof file[] = []; const calls: string[] = [];
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => {
      calls.push(name);
      if (name.endsWith('.release')) return { ...receipt('pick_1', 'retired'), orphaned: 2 };
      return { ...receipt('pick_1', 'unknown'), attachments: name.endsWith('.pick') ? [file] : [file, second] };
    } });
    await controller.pick('files', { current: () => current, read: () => files, write: value => { files = value; } });
    current = false;
    const result = await controller.reconcile(); expect(files).toEqual([file]); expect(result).toMatchObject({ attachments: [], orphaned: 1, state: 'retired' });
    expect(calls).toEqual(['desktop.attachments.pick', 'desktop.attachments.status', 'desktop.attachments.release']);
  });
  it('bounds cumulative identities and cancellation orphan counts rather than adding repeated snapshots', async () => {
    const many = Array.from({ length: 64 }, (_, index) => ({ ...file, uri: `file:///synthetic/${index}` })); let current = true;
    let snapshot = { ...receipt('pick_1', 'unknown'), attachments: many };
    const controller = createDesktopAttachments({ scope, id: () => 'pick_1', native: async name => name.endsWith('.release') ? { ...receipt('pick_1', 'retired'), orphaned: 64 } : snapshot });
    let files: typeof file[] = [];
    await controller.pick('files', { current: () => current, read: () => files, write: value => { files = value; } });
    snapshot = { ...snapshot, attachments: [second] };
    await expect(controller.reconcile()).rejects.toThrow('receipt_limit'); expect(files).toHaveLength(64); expect(controller.blocked()).toBe(true);
    snapshot = { ...snapshot, attachments: many }; current = false;
    expect((await controller.reconcile())?.orphaned).toBe(0); expect(controller.receipt()?.orphaned).toBeLessThanOrEqual(64);
    expect(controller.receipt()?.uncertain).toBe(true);
  });
});

describe('desktop assistant attachment captured target', () => {
  const target = { kind: 'assistant' as const, assistantID: 'asst_a' };
  const contact = { type: 'file' as const, assistantID: 'asst_a', attachmentID: 'att_a', sha256: 'a'.repeat(64), size: 5, mime: 'text/plain', filename: 'note.txt' };
  const attachment = { ...file, uri: assistantAttachmentURI('asst_a', 'att_a'), contact };
  const assistantReceipt = (state = 'ready', files = state === 'ready' ? [attachment] : []) => ({ ...receipt('assistant_pick', state), target, attachments: files });

  it('captures exact assistant for pick and every readback, preserving frozen contact metadata', async () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const input = { ...target }; let files: typeof attachment[] = [];
    const controller = createDesktopAttachments({ scope, target: input, id: () => 'assistant_pick', native: async (name, body) => { calls.push({ name, body }); return assistantReceipt(); } });
    input.assistantID = 'asst_b';
    await controller.pick('files', { current: () => true, read: () => files, write: value => { files = value as typeof files; } });
    await controller.reconcile(); expect(files).toEqual([attachment]); expect(Object.isFrozen(files[0]!.contact)).toBe(true);
    expect(calls).toEqual(['pick', 'status'].map(method => ({ name: `desktop.attachments.${method}`, body: { requestID: 'assistant_pick', expectedHost: scope, target, ...(method === 'pick' ? { kind: 'files' } : {}) } })));
  });
  it.each([
    { ...assistantReceipt(), target: { kind: 'assistant', assistantID: 'asst_b' } },
    { ...assistantReceipt(), target: undefined }, { ...assistantReceipt('pending'), target: undefined },
    { ...assistantReceipt(), attachments: [file] },
    { ...assistantReceipt(), attachments: [{ ...attachment, contact: { ...contact, assistantID: 'asst_b' } }] },
    { ...assistantReceipt(), attachments: [{ ...attachment, uri: 'file:///note.txt' }] },
  ])('rejects wrong target or legacy receipts in assistant operations (%#)', value => {
    expect(() => desktopAttachmentResult(value, 'assistant_pick', target)).toThrow();
    expect(() => desktopAttachmentResult(assistantReceipt(), 'assistant_pick')).toThrow();
  });
  it('keeps an interrupted/unknown upload fenced and reads only the same target; cancel is metadata only', async () => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const controller = createDesktopAttachments({ scope, target, id: () => 'assistant_pick', native: async (name, body) => {
      calls.push({ name, body });
      if (name.endsWith('.pick')) throw new Error('interrupted');
      return assistantReceipt(name.endsWith('.cancel') ? 'retired' : 'unknown');
    } });
    const owner = { current: () => true, read: () => [], write: () => { throw new Error('must_not_write'); } };
    await expect(controller.pick('files', owner)).rejects.toThrow('interrupted');
    await controller.reconcile(); await controller.reconcile(); expect(controller.receipt()?.uncertain).toBe(true);
    await expect(controller.pick('files', owner)).rejects.toThrow('receipt_unresolved');
    await controller.cancel(); expect(calls.map(call => call.name)).toEqual(['pick', 'status', 'status', 'cancel'].map(method => `desktop.attachments.${method}`));
    expect(calls.every(call => JSON.stringify(call.body.target) === JSON.stringify(target))).toBe(true);
  });
  it('releases a late assistant result without adopting it into the new contact', async () => {
    let current = true; const pending = deferred<unknown>(); const calls: Array<Record<string, unknown>> = []; let writes = 0;
    const controller = createDesktopAttachments({ scope, target, id: () => 'assistant_pick', native: async (name, body) => {
      calls.push(body); return name.endsWith('.pick') ? pending.promise : { ...assistantReceipt('retired'), orphaned: 1 };
    } });
    const flight = controller.pick('images', { current: () => current, read: () => [], write: () => { writes++; } });
    current = false; pending.resolve(assistantReceipt()); expect(await flight).toMatchObject({ state: 'retired', attachments: [], orphaned: 1 });
    expect(writes).toBe(0); expect(calls).toHaveLength(2); expect(calls[1]!.target).toEqual(target);
  });
  it('rejects descriptor changes for one identity instead of re-adopting forged metadata', async () => {
    let snapshot = assistantReceipt('unknown', [attachment]); let files: typeof attachment[] = [];
    const controller = createDesktopAttachments({ scope, target, id: () => 'assistant_pick', native: async () => snapshot });
    await controller.pick('files', { current: () => true, read: () => files, write: value => { files = value as typeof files; } });
    snapshot = assistantReceipt('ready', [{ ...attachment, contact: { ...contact, sha256: 'b'.repeat(64) } }]);
    await expect(controller.reconcile()).rejects.toThrow('attachment_identity_conflict'); expect(files).toEqual([attachment]); expect(controller.blocked()).toBe(true);
  });
  it.each(['count', 'bytes', 'foreign'] as const)('checks entire assistant draft %s before writing, retaining receipt for cleanup', async limit => {
    const existing = limit === 'count' ? Array.from({ length: 64 }, () => attachment)
      : limit === 'bytes' ? Array.from({ length: 2 }, () => ({ ...attachment, contact: { ...contact, size: 25 * 1024 * 1024 } }))
        : [{ ...attachment, contact: { ...contact, assistantID: 'asst_b' } }];
    let writes = 0;
    const controller = createDesktopAttachments({ scope, target, id: () => 'assistant_pick', native: async () => assistantReceipt() });
    await expect(controller.pick('files', { current: () => true, read: () => existing, write: () => { writes++; } })).rejects.toThrow();
    expect(writes).toBe(0); expect(controller.blocked()).toBe(true);
  });
  it('adopts the exact 64-file and 50MiB boundaries', async () => {
    for (const files of [Array.from({ length: 64 }, (_, index) => {
      const attachmentID = `att_${index}`; return { ...attachment, uri: assistantAttachmentURI('asst_a', attachmentID), contact: { ...contact, attachmentID } };
    }), [0, 1].map(index => { const attachmentID = `att_${index}`; return { ...attachment, uri: assistantAttachmentURI('asst_a', attachmentID), contact: { ...contact, attachmentID, size: 25 * 1024 * 1024 } }; })]) {
      let adopted: typeof attachment[] = [];
      const controller = createDesktopAttachments({ scope, target, id: () => 'assistant_pick', native: async () => assistantReceipt('ready', files) });
      await controller.pick('files', { current: () => true, read: () => [], write: value => { adopted = value as typeof adopted; } });
      expect(adopted).toEqual(files); expect(controller.blocked()).toBe(false);
    }
  });
});
