import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createDesktopChatAttachments, type DesktopChatAttachmentOptions } from './desktop-chat-attachments';
import { language } from './i18n';
import type { Attachment } from './model';
import type { PageOperation } from './page-operations';

function AttachmentOwner(props: { options: DesktopChatAttachmentOptions; onReady: (adapter: ReturnType<typeof createDesktopChatAttachments>) => void }) {
  const adapter = createDesktopChatAttachments(props.options);
  props.onReady(adapter);
  const Recovery = adapter.Recovery;
  return <Recovery />;
}

/** No runtime.request, connection store, filesystem, model, picker or native window calls. */
function Fixture() {
  language.set('en');
  const shown = signal(true), files = signal<Attachment[]>([{ uri: 'file:///synthetic/prior.txt', name: 'prior.txt', mime: 'text/plain' }]);
  const mounted = signal(true), draft = signal('');
  const calls = signal<string[]>([]), errors = signal<string[]>([]), closeDenied = signal(false), lateSettled = signal(false);
  const audit = signal(''), mode = signal<'unknown' | 'ready' | 'late' | 'unauthorized'>('unknown');
  let nextID = 0, late: (() => void) | undefined;
  let currentReads = 0, operationReads = 0;
  const scope = { hostID: 'synthetic-chat', lease: '00000000-0000-4000-8000-000000000001' };
  const makeAuthority = (): PageOperation => {
    const captured: PageOperation = { scope: { ...scope }, generation: 1, current: () => shown() && authority() === captured, request: async () => { throw new Error('synthetic_no_http'); } };
    return captured;
  };
  const authority = signal<PageOperation | null>(null);
  authority.set(makeAuthority());
  const records = new Map<string, { files: Attachment[]; reads: number }>();
  const file = (requestID: string, index: number): Attachment => ({ uri: `file:///synthetic/${requestID}-${index}.txt`, name: `${index}.txt`, mime: 'text/plain' });
  let adapter: ReturnType<typeof createDesktopChatAttachments>;
  const options: DesktopChatAttachmentOptions = {
    key: 'synthetic-authorization/session/directory', current: () => { currentReads++; return shown(); }, operation: () => { operationReads++; return authority(); },
    captureOperation: () => authority()!, read: files, write: value => files.set(value),
    id: () => `pick_${++nextID}`, onError: summary => errors.set([...errors(), summary]),
    native: async (name, body) => {
      calls.set([...calls(), name]);
      const requestID = String(body.requestID), record = records.get(requestID);
      if (JSON.stringify(body.expectedHost) !== JSON.stringify(scope)) throw new Error('synthetic_scope_mismatch');
      const reply = (state: string, attachments: Attachment[], orphaned = 0) => ({ requestID, state, attachments, orphaned });
      if (name === 'desktop.attachments.pick') {
        records.set(requestID, { files: [file(requestID, 1)], reads: 0 });
        if (mode() === 'late') return await new Promise(resolve => { late = () => {
          const attachments = [file(requestID, 1), file(requestID, 2)]; records.set(requestID, { files: attachments, reads: 0 });
          resolve(reply('ready', attachments)); lateSettled.set(true);
        }; });
        return reply(mode() === 'ready' ? 'ready' : 'unknown', [file(requestID, 1)]);
      }
      if (!record) throw new Error('synthetic_receipt_missing');
      if (name === 'desktop.attachments.status') {
        if (mode() === 'unauthorized') throw new Error('HTTP 401 synthetic-private-path-must-not-render');
        record.reads++;
        record.files = [file(requestID, 1), file(requestID, 2), ...(record.reads > 1 ? [file(requestID, 3)] : [])];
        return reply(record.reads > 1 ? 'ready' : 'unknown', record.files);
      }
      if (name === 'desktop.attachments.cancel' || name === 'desktop.attachments.release') return reply('retired', [], record.files.length);
      throw new Error('synthetic_unexpected_capability');
    },
  };
  const inspect = () => audit.set(JSON.stringify({ files: files().map(file => file.uri), blocked: mounted() && adapter.blocked(), receipt: mounted() ? adapter.receipt() : null, calls: calls(), errors: errors(), closeDenied: closeDenied(), shown: shown(), currentReads, operationReads }));
  async function failedClose() {
    shown.set(false); adapter.retire();
    try { await Promise.reject(new Error('synthetic_native_close_denied')); }
    catch { closeDenied.set(true); }
    finally { shown.set(true); }
  }
  return <View class="flex-1 bg-background p-4 gap-2">
    <Input testID="fixture-draft" value={draft()} onChange={event => draft.set(event.value)} />
    <Button testID="fixture-attach" onPress={() => { const lane = authority()!; void adapter.attach('files', lane); }}><Text>Attach synthetic files</Text></Button>
    <Button testID="fixture-unknown" onPress={() => mode.set('unknown')}><Text>Unknown response</Text></Button>
    <Button testID="fixture-ready" onPress={() => mode.set('ready')}><Text>Ready response</Text></Button>
    <Button testID="fixture-unauthorized" onPress={() => mode.set('unauthorized')}><Text>Unauthorized response</Text></Button>
    <Button testID="fixture-late" onPress={() => mode.set('late')}><Text>Deferred response</Text></Button>
    <Button testID="fixture-renew" onPress={() => authority.set(makeAuthority())}><Text>Renew same lease authority</Text></Button>
    <Button testID="fixture-cover" onPress={() => shown.set(false)}><Text>Cover Chat</Text></Button>
    <Button testID="fixture-show" onPress={() => shown.set(true)}><Text>Show Chat</Text></Button>
    <Button testID="fixture-settle-late" onPress={() => late?.()}><Text>Resolve deferred response</Text></Button>
    <Button testID="fixture-failed-close" onPress={() => { void failedClose(); }}><Text>Reject native close admission</Text></Button>
    <Button testID="fixture-dispose" onPress={() => mounted.set(false)}><Text>Dispose actual NSH child owner</Text></Button>
    <If when={mounted()}><AttachmentOwner options={options} onReady={value => { adapter = value; }} /></If>
    <If when={lateSettled()}><Text>late settled</Text></If>
    <Button testID="fixture-audit" onPress={inspect}><Text>Inspect synthetic metadata</Text></Button>
    <Text testID="fixture-audit-result">{audit()}</Text>
  </View>;
}
mount(Fixture);
