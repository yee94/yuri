import { expect, open, test } from 'nsh/test';
import { createHost } from './host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';

const attachment = { type: 'file', attachmentID: 'file.1', sha256: 'a'.repeat(64), size: 6, mime: 'application/octet-stream', filename: 'original.bin' };
type Call = { name: string; body: Record<string, unknown> };
function contactFixture(options: { unknown?: boolean; unsupported?: boolean; invalid?: boolean } = {}) {
  const original = createHost(), calls: Call[] = [], rejected: string[] = [];
  let state = 'selecting', received = 0, total: number | null = null;
  const metrics: string[] = [];
  const names = [...desktopJournalMethods, ...Object.keys(original.writer.handlers), 'appearance.reset', 'appearance.apply',
    'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select',
    'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision',
    ...['capabilities', 'save', 'status', 'cancel', 'resume'].map(method => 'desktop.files.download.' + method)];
  const handlers = Object.fromEntries(names.map(name => [name, async (body: Record<string, unknown> = {}) => {
    if (name.startsWith('desktop.files.download.')) {
      calls.push({ name, body });
      if (name.endsWith('.capabilities')) return options.unsupported ? { version: 2, save: true, maxBytes: 2 ** 40, windowID: 'attachment_window' }
        : { version: 2, save: true, maxBytes: 2 ** 40, windowID: 'attachment_window', assistantAttachment: { supported: true, maxBytes: 26214400, integrity: 'sha256' } };
      if (name.endsWith('.save')) {
        expect(Object.keys(body).sort()).toEqual(['attachment', 'expectedHost', 'ownerID', 'requestID', 'source', 'windowID']);
        expect(body.source).toBe('assistantAttachment');
        expect(body.attachment).toEqual({ ...attachment, assistantID: 'alpha' });
        expect(body.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
        if (options.unknown) { state = 'unknown'; throw new Error('Synthetic lost native save receipt'); }
      } else {
        expect(Object.keys(body).sort()).toEqual(['expectedHost', 'ownerID', 'requestID', 'windowID']);
        if (name.endsWith('.cancel')) state = 'cancelled';
      }
      const receipt = { requestID: body.requestID, windowID: body.windowID, state, received, total, resumable: false, error: null,
        source: 'assistantAttachment', attachment: { ...attachment, assistantID: 'alpha' } };
      return receipt;
    }
    if (name === 'runtime.request') {
      const actual = await original.call('connection.list');
      if (JSON.stringify(body.expectedHost) !== JSON.stringify(actual.runtimeScope)) throw new Error('Wrong captured contact attachment authority');
      if (actual.runtimeScope.hostID !== 'desktop-fixture') return original.call(name, body);
      const path = String(body.path).split('?')[0], ok = (value: unknown) => ({ status: 200, body: value });
      if (path === '/api/yuri/assistants/alpha/contact/read' && body.method === 'POST') {
        original.writer.assertWrite(body, { kind: 'assistant', id: 'alpha' });
        return ok({ assistantID: 'alpha', changed: true, unreadCount: 0, readWatermark: body.body, readTip: body.body, revision: 2 });
      }
      if (path === '/api/yuri/assistants/capability') return ok({ enabled: true, supported: true });
      if (path === '/api/yuri/assistants/snapshot') return ok({ enabled: true, revision: 1, assistants: ['alpha', 'beta'].map(id => ({ id,
        name: 'Attachment contact ' + id, revision: 1, enabled: true, pinnedAt: null, unreadCount: 0,
        effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build' })) });
      if (path === '/api/yuri/assistants/alpha/contact/messages') return ok({ generation: 1, revision: 1, complete: true, messages: [{
        messageID: 'attachment-message', assistantID: 'alpha', ordinal: 1, turnID: 'attachment-turn', bubbleIndex: 0,
        role: 'assistant', status: 'complete', createdAt: 1, parts: [{ ...attachment, ...(options.invalid ? { sha256: 'invalid' } : {}) }],
      }] });
      if (path === '/api/yuri/assistants/beta/contact/messages') return ok({ generation: 1, revision: 1, complete: true, messages: [] });
      if (path.includes('/contact/attachments/')) { rejected.push(path); throw new Error('Attachment body must never enter TS HTTP'); }
    }
    return original.call(name, body);
  }]));
  handlers['contact-attachment.test.audit'] = async (body: Record<string, unknown> = {}) => { metrics.push(String(body.phase)); };
  return { ...original, handlers, calls, rejected, metrics,
    progress(next: string) { state = next; received = next === 'saved' ? 6 : 3; total = 6; },
  };
}
async function launch(platform: 'macos' | 'windows', options: Parameters<typeof contactFixture>[0] = {}, instrument = false) {
  const fixture = contactFixture(options);
  const app = await open(instrument ? '../../ContactAttachmentRoot.tsx' : '../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers: fixture.handlers } });
  await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
  await app.waitUntil(() => app.enabled('id:composer'));
  await app.waitFor(options.invalid ? 'id:desktop-assistant-attachment-unavailable' : 'id:desktop-assistant-attachment-file.1');
  return { app, fixture };
}
const named = (fixture: ReturnType<typeof contactFixture>, suffix: string) => fixture.calls.filter(call => call.name.endsWith('.' + suffix));

for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual App keeps attachment mount and 50 draft updates native-I/O free until explicit download', async () => {
    const { app, fixture } = await launch(platform);
    for (let index = 0; index < 50; index++) await app.type('id:composer', 'a');
    expect(fixture.calls).toEqual([]);
    await app.press('id:desktop-assistant-attachment-download');
    await app.waitUntil(() => named(fixture, 'save').length === 1);
    expect(named(fixture, 'capabilities').map(call => call.body)).toEqual([{ source: 'assistantAttachment' }]);
    expect(app.enabled('id:composer')).toBe(false);
    expect(app.enabled('id:desktop-assistant-beta')).toBe(false);
    await app.host.send('desktop.window.closeRequested', { ticket: 'attachment:selecting', windowID: 'synthetic-writer-window', generation: 1, reason: 'close' });
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'desktop.window.closeDecision'));
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1)?.data).toEqual({ ticket: 'attachment:selecting', approved: false });
    await app.press('id:desktop-new-session'); await app.wait(20);
    expect(app.shows('id:desktop-assistant-chat')).toBe(true);
    expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual([]);
    fixture.progress('saved'); await app.clock!.fastForward(300);
    await app.waitUntil(() => app.enabled('id:composer'));
    expect(app.value('id:composer')).toBe('a'.repeat(50));
    expect(app.shows('id:desktop-assistant-attachment-progress')).toBe(true);
    expect(named(fixture, 'save')).toHaveLength(1);
    expect(named(fixture, 'capabilities')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual App lost native save ACK is status-only and does not replay the chooser or descriptor', async () => {
    const { app, fixture } = await launch(platform, { unknown: true });
    await app.press('id:desktop-assistant-attachment-download');
    await app.waitFor('id:desktop-assistant-attachment-inspect');
    expect(app.shows('id:desktop-assistant-attachment-download')).toBe(false);
    expect(app.shows('id:desktop-assistant-attachment-resume')).toBe(false);
    await app.clock!.fastForward(10_000);
    expect(named(fixture, 'status')).toEqual([]);
    fixture.progress('saved'); await app.press('id:desktop-assistant-attachment-inspect');
    await app.waitFor('id:desktop-assistant-attachment-download');
    expect(named(fixture, 'save')).toHaveLength(1); expect(named(fixture, 'status')).toHaveLength(1);
    expect(named(fixture, 'status')[0].body.requestID).toBe(named(fixture, 'save')[0].body.requestID);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual App missing canonical capability never downgrades a contact reference to a Host path', async () => {
    const { app, fixture } = await launch(platform, { unsupported: true });
    await app.press('id:desktop-assistant-attachment-download');
    await app.waitUntil(() => !app.enabled('id:desktop-assistant-attachment-download'));
    expect(named(fixture, 'capabilities').map(call => call.body)).toEqual([{ source: 'assistantAttachment' }]);
    expect(named(fixture, 'save')).toEqual([]);
    expect(app.enabled('id:composer')).toBe(true);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual App malformed historical descriptor remains unavailable with zero native calls', async () => {
    const { app, fixture } = await launch(platform, { invalid: true });
    expect(app.shows('id:desktop-assistant-attachment-download')).toBe(false);
    expect(fixture.calls).toEqual([]); expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual App selecting contact while a save is pending cancels only the retired native owner', async () => {
    const { app, fixture } = await launch(platform);
    await app.press('id:desktop-assistant-attachment-download');
    fixture.progress('pending'); await app.clock!.fastForward(300);
    await app.waitUntil(() => app.enabled('id:composer'));
    await app.press('id:desktop-assistant-beta');
    await app.waitFor('id:desktop-assistant-conversation-beta');
    await app.waitFor('id:desktop-assistant-attachment-file.1', { state: 'gone' });
    await app.waitUntil(() => named(fixture, 'cancel').length === 1);
    expect(named(fixture, 'cancel')[0].body).toEqual({
      ownerID: named(fixture, 'save')[0].body.ownerID, requestID: named(fixture, 'save')[0].body.requestID,
      windowID: 'attachment_window', expectedHost: { hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' },
    });
    const count = fixture.calls.length; await app.clock!.fastForward(5000);
    expect(fixture.calls).toHaveLength(count); expect(named(fixture, 'save')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual App late status after Host change cannot republish old contact progress or authorize a new save', async () => {
    const { app, fixture } = await launch(platform, {}, true);
    await app.press('id:desktop-assistant-attachment-download');
    fixture.progress('pending'); await app.clock!.fastForward(300);
    await app.waitUntil(() => app.enabled('id:composer'));
    fixture.progress('saved'); await app.host.send('contact-attachment.test.control', { action: 'hold-status' });
    await app.clock!.fastForward(300);
    await app.waitUntil(() => fixture.metrics.includes('status-held'));
    await app.press('id:desktop-connections'); await app.press('text:Other synthetic Host');
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'connection.select' && (call.data as { id?: string }).id === 'other-fixture'));
    await app.waitFor('id:desktop-assistant-chat', { state: 'gone' });
    await app.host.send('contact-attachment.test.control', { action: 'release-status' });
    await app.waitUntil(() => fixture.metrics.includes('status-delivered')); await app.wait(30); await app.clock!.fastForward(5000);
    expect(app.shows('id:desktop-assistant-attachment-progress')).toBe(false);
    expect(named(fixture, 'save')).toHaveLength(1); expect(named(fixture, 'capabilities')).toHaveLength(1);
    expect(named(fixture, 'cancel')).toHaveLength(1);
    expect(fixture.calls.every(call => call.name.endsWith('.capabilities') || (call.body.expectedHost as { hostID: string }).hostID === 'desktop-fixture')).toBe(true);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
}
