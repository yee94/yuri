import { expect, test } from 'vitest';
import { createDesktopAssistantAttachmentDownload, createDesktopFileDownload } from './desktop-files-download';

const host = { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' };
const descriptor = () => ({ type: 'file' as const, assistantID: 'bot.A', attachmentID: 'att.1', sha256: 'a'.repeat(64), size: 6, mime: 'application/octet-stream', filename: '附件.bin' });
const capability = { version: 2, save: true, maxBytes: 2 ** 40, windowID: 'native_window', assistantAttachment: { supported: true, maxBytes: 25 * 1024 * 1024, integrity: 'sha256' } };
const clock = { after: () => () => {} };
type NativeCall = Parameters<typeof createDesktopAssistantAttachmentDownload>[2];
type Body = Record<string, unknown>;
const receipt = (body: Body, state = 'pending', extra: Body = {}, attachment: object = descriptor()) => ({ requestID: body.requestID, windowID: body.windowID, state,
  received: state === 'saved' ? 6 : 0, total: state === 'saved' ? 6 : null, resumable: false, error: null, source: 'assistantAttachment', attachment, ...extra });
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

test('two thin factories retain exact independent capability/save/receipt shapes on the same native methods', async () => {
  const calls: Array<{ name: string; body: Body }> = [];
  const native: NativeCall = async <T>(name: string, body: Body) => {
    calls.push({ name, body });
    if (name.endsWith('capabilities')) return (body.source ? capability : { version: 2, save: true, maxBytes: 2 ** 40, windowID: 'native_window' }) as T;
    if (body.source) return receipt(body, 'saved') as T;
    return { requestID: body.requestID, windowID: body.windowID, state: 'saved', received: 0, total: null, resumable: false, error: null } as T;
  };
  const fs = createDesktopFileDownload({ host, directory: '/workspace', authorityKey: 'authority', sessionID: 'session' }, native, () => true, () => {}, clock);
  const assistant = createDesktopAssistantAttachmentDownload(host, descriptor(), native, () => true, () => {}, clock);
  expect(calls).toHaveLength(0);
  await fs.probe(); expect(await fs.save('a.bin')).toBe(true);
  await assistant.probe(); expect(await assistant.save()).toBe(true);
  expect(calls[0].body).toEqual({}); expect(calls[2].body).toEqual({ source: 'assistantAttachment' });
  expect(Object.keys(calls[1].body).sort()).toEqual(['directory', 'expectedHost', 'ownerID', 'path', 'requestID', 'windowID']);
  expect(Object.keys(calls[3].body).sort()).toEqual(['attachment', 'expectedHost', 'ownerID', 'requestID', 'source', 'windowID']);
  expect(calls[3].body.attachment).toEqual(descriptor()); expect(calls[3].body.expectedHost).toEqual(host);
  expect(assistant.state()).toMatchObject({ phase: 'saved', path: '附件.bin', received: 6, total: 6 });
  expect(fs.state().path).toBe('/workspace/a.bin');
});

test('construction strictly validates and freezes an independent descriptor and captured Host, without a directory or URL', async () => {
  const attachment = descriptor(), capturedHost = { ...host }, original = { ...attachment };
  const calls: Body[] = [];
  const native: NativeCall = async <T>(name: string, body: Body) => {
    calls.push(body); return (name.endsWith('capabilities') ? capability : receipt(body, 'saved', {}, original)) as T;
  };
  const owner = createDesktopAssistantAttachmentDownload(capturedHost, attachment, native, () => true, () => {}, clock);
  attachment.assistantID = 'bot.B'; attachment.size = 1; attachment.filename = 'changed.bin'; capturedHost.hostID = 'other-host'; capturedHost.lease = 'other-lease';
  await owner.probe(); expect(await owner.save()).toBe(true);
  expect(calls[1].attachment).toEqual(original); expect(Object.isFrozen(calls[1].attachment)).toBe(true);
  expect(calls[1].expectedHost).toEqual(host); expect(Object.keys(calls[1])).not.toContain('path');
  for (const patch of [{ assistantID: '../bot' }, { attachmentID: '%61' }, { sha256: 'A'.repeat(64) }, { size: 0 }, { size: 26214401 }, { mime: 'text/plain;fake' }, { filename: '../file' }, { url: 'https://outside.invalid' }]) {
    expect(() => createDesktopAssistantAttachmentDownload(host, { ...descriptor(), ...patch }, native, () => true, () => {}, clock)).toThrow('attachment_invalid_receipt');
  }
});

test('Assistant capability requires the full explicit strict native declaration and never falls back to FS', async () => {
  const bad = [null, {}, { save: true }, { ...capability, assistantAttachment: undefined },
    { ...capability, version: 1 }, { ...capability, save: false }, { ...capability, windowID: '../window' }, { ...capability, maxBytes: 25 * 1024 * 1024 },
    { ...capability, extra: true }, ...[{ supported: false }, { maxBytes: 1 }, { integrity: 'etag' }, { extra: true }].map(patch => ({ ...capability, assistantAttachment: { ...capability.assistantAttachment, ...patch } }))];
  for (const response of bad) {
    const calls: Array<{ name: string; body: Body }> = [];
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) => { calls.push({ name, body }); return response as T; }, () => true, () => {}, clock);
    await owner.probe(); expect(owner.state().available).toBe(false); expect(await owner.save()).toBe(false);
    expect(calls).toEqual([{ name: 'desktop.files.download.capabilities', body: { source: 'assistantAttachment' } }]);
  }
});

test('every descriptor field, optional filename presence and source are checked on all native receipts', async () => {
  const changes = [{ type: 'image' }, { assistantID: 'bot.B' }, { attachmentID: 'att.2' }, { sha256: 'b'.repeat(64) },
    { size: 5 }, { mime: 'text/plain' }, { filename: 'other.bin' }, { filename: undefined }, { path: '/workspace/x' }];
  for (const state of ['selecting', 'pending', 'error', 'unknown', 'cancelled', 'saved']) {
    for (const patch of changes) {
      const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) =>
        (name.endsWith('capabilities') ? capability : receipt(body, state, {}, { ...descriptor(), ...patch })) as T, () => true, () => {}, clock);
      await owner.probe(); expect(await owner.save()).toBe(false); expect(owner.state().phase).toBe('unknown');
    }
  }
  for (const extra of [{ source: 'file' }, { source: undefined }, { attachment: undefined }, { windowID: 'other_window' }, { requestID: 'other_request' }, { expectedHost: { ...host, hostID: 'other-host' } }, { ownerID: 'other_owner' }, { url: 'https://outside.invalid' }, { bytes: [0, 1] }]) {
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) =>
      (name.endsWith('capabilities') ? capability : receipt(body, 'saved', extra)) as T, () => true, () => {}, clock);
    await owner.probe(); expect(await owner.save()).toBe(false); expect(owner.state().phase).toBe('unknown');
  }
  const { filename: _filename, ...unnamed } = descriptor();
  const owner = createDesktopAssistantAttachmentDownload(host, unnamed, async <T>(name: string, body: Body) =>
    (name.endsWith('capabilities') ? capability : receipt(body, 'saved', {}, unnamed)) as T, () => true, () => {}, clock);
  await owner.probe(); expect(await owner.save()).toBe(true); expect(owner.state().path).toBe('attachment');
  const addedFilename = createDesktopAssistantAttachmentDownload(host, unnamed, async <T>(name: string, body: Body) =>
    (name.endsWith('capabilities') ? capability : receipt(body, 'saved')) as T, () => true, () => {}, clock);
  await addedFilename.probe(); expect(await addedFilename.save()).toBe(false); expect(addedFilename.state().phase).toBe('unknown');
});

test('actual counts stay inside descriptor size and saved requires the complete known total', async () => {
  for (const extra of [{ received: 7, total: 7 }, { received: 0, total: 7 }, { received: 5, total: 6 }, { received: 6, total: null },
    { received: 0, total: null }, { received: -1, total: 6 }, { received: 6, total: 5 }, { received: 6, total: 6.5 }]) {
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) =>
      (name.endsWith('capabilities') ? capability : receipt(body, 'saved', extra)) as T, () => true, () => {}, clock);
    await owner.probe(); expect(await owner.save()).toBe(false); expect(owner.state().phase).toBe('unknown');
  }
});

test('explicit native resumable errors alone allow resume using only the original identity, not descriptor retransmission', async () => {
  for (const resumable of [false, true]) {
    const calls: Array<{ name: string; body: Body }> = [];
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) => {
      calls.push({ name, body }); return (name.endsWith('capabilities') ? capability : name.endsWith('save')
        ? receipt(body, 'error', { received: 3, total: 6, resumable, error: 'download_connection_failed' }) : receipt(body, 'saved')) as T;
    }, () => true, () => {}, clock);
    await owner.probe(); await owner.save(); expect(await owner.save()).toBe(false);
    expect(await owner.resume()).toBe(resumable);
    const resumes = calls.filter(call => call.name.endsWith('resume')); expect(resumes).toHaveLength(resumable ? 1 : 0);
    if (resumable) {
      expect(Object.keys(resumes[0].body).sort()).toEqual(['expectedHost', 'ownerID', 'requestID', 'windowID']);
      expect(resumes[0].body.requestID).toBe(calls[1].body.requestID); expect(owner.state().received).toBe(6);
    }
  }
});

test('unknown is status/cancel only, verifying remains single-flight, and a fresh save requires idle or saved', async () => {
  const calls: Array<{ name: string; body: Body }> = []; let statuses = 0;
  const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) => {
    calls.push({ name, body }); if (name.endsWith('capabilities')) return capability as T;
    return receipt(body, name.endsWith('save') ? 'unknown' : name.endsWith('cancel') ? 'unknown' : ++statuses === 1 ? 'verifying' : 'saved', { received: 6, total: 6 }) as T;
  }, () => true, () => {}, clock);
  await owner.probe(); await owner.save(); expect(owner.state().phase).toBe('unknown');
  expect(await owner.save()).toBe(false); expect(await owner.resume()).toBe(false);
  await Promise.all([owner.inspect(), owner.inspect(), owner.inspect()]); expect(statuses).toBe(1); expect(owner.state().phase).toBe('checking');
  expect(await owner.save()).toBe(false); expect(await owner.resume()).toBe(false);
  await owner.inspect(); expect(owner.state().phase).toBe('saved'); expect(await owner.save()).toBe(false);
  expect(calls.filter(call => call.name.endsWith('save'))).toHaveLength(2);
  const saves = calls.filter(call => call.name.endsWith('save')); expect(saves[0].body.requestID).not.toBe(saves[1].body.requestID);
  await owner.cancel(); expect(owner.state().phase).toBe('unknown');
  expect(calls.some(call => call.name.endsWith('resume'))).toBe(false);
});

test('late cancel epochs, retirement and disposal reject stale Assistant success without cross-owner publication', async () => {
  const pending = deferred(); let saveBody: Body = {}, current = true, notifications = 0;
  const calls: Array<{ name: string; body: Body }> = [];
  const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, body: Body) => {
    calls.push({ name, body });
    if (name.endsWith('capabilities')) return capability as T;
    if (name.endsWith('save')) { saveBody = body; return await pending.promise as T; }
    return receipt(body, 'cancelled') as T;
  }, () => current, () => { notifications++; }, clock);
  await owner.probe(); const saved = owner.save(); expect(await owner.save()).toBe(false); await owner.cancel();
  pending.resolve(receipt(saveBody, 'saved')); expect(await saved).toBe(false); expect(owner.state().phase).toBe('idle');
  current = false; const before = notifications; expect(await owner.save()).toBe(false); expect(notifications).toBe(before);
  owner.dispose(); expect(calls.filter(call => call.name.endsWith('save'))).toHaveLength(1);
  for (const retired of ['scope', 'dispose']) {
    const pending = deferred(); let body: Body = {}, live = true, changes = 0;
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>(name: string, input: Body) => {
      if (name.endsWith('capabilities')) return capability as T;
      body = input; if (name.endsWith('save')) return await pending.promise as T;
      return receipt(input, 'cancelled') as T;
    }, () => live, () => { changes++; }, clock);
    await owner.probe(); const flight = owner.save(); const before = changes;
    if (retired === 'dispose') owner.dispose(); else live = false;
    pending.resolve(receipt(body, 'saved')); expect(await flight).toBe(false); expect(changes).toBe(before);
  }
});

test('inactive or transiently missing native capability can be explicitly retried, not globally cached or FS-probed', async () => {
  for (const inactive of [false, true]) {
    const pending = deferred(); let live = true, calls = 0;
    const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>() => {
      calls++; if (calls === 1) return await pending.promise as T; return capability as T;
    }, () => live, () => {}, clock);
    const first = owner.probe(); if (inactive) live = false;
    pending.resolve(inactive ? capability : null); await first;
    expect(owner.state().available).toBe(false); live = true; await owner.probe();
    expect(owner.state().available).toBe(true); expect(calls).toBe(2); await owner.probe(); expect(calls).toBe(2);
  }
  let calls = 0;
  const owner = createDesktopAssistantAttachmentDownload(host, descriptor(), async <T>() => { if (++calls === 1) throw new Error('download_scope_stale'); return capability as T; }, () => true, () => {}, clock);
  await owner.probe(); expect(owner.state().available).toBe(false); await owner.probe(); expect(owner.state().available).toBe(true);
});

test('50 untouched history rows and input updates perform zero native calls; equal progress never notifies or multiplies polling', async () => {
  const calls: string[] = []; let notifications = 0, live = true; const queued: Array<() => void> = [];
  const native: NativeCall = async <T>(name: string, body: Body) => { calls.push(name); return (name.endsWith('capabilities') ? capability : receipt(body, 'pending', { received: 3, total: 6 })) as T; };
  const rows = Array.from({ length: 50 }, () => createDesktopAssistantAttachmentDownload(host, descriptor(), native, () => live, () => { notifications++; }, { after(callback) { queued.push(callback); return () => {}; } }));
  for (let input = 0; input < 50; input++) for (const row of rows) row.state();
  expect(calls).toHaveLength(0); expect(queued).toHaveLength(0);
  const owner = rows[0]; await owner.probe(); await owner.save(); const before = notifications;
  await Promise.all([owner.inspect(), owner.inspect(), owner.inspect()]); expect(calls.filter(name => name.endsWith('status'))).toHaveLength(1);
  for (let count = 0; count < 50; count++) owner.state();
  expect(notifications).toBe(before); expect(calls).toHaveLength(3);
  live = false; for (const callback of queued) callback(); expect(calls).toHaveLength(3);
  live = true; for (const row of rows) row.dispose(); const afterDispose = calls.length;
  for (const callback of queued) callback(); expect(calls).toHaveLength(afterDispose);
});
