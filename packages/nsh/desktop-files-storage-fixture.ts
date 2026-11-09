/** Synthetic Engine entrypoint only; no App/window, real Host or NSH Storage. */
import { host } from 'nsh';
import { createDesktopFileJournalStorage } from './desktop-files-storage';
import { createDesktopEditorJournal } from './desktop-files-journal';
import { createDesktopEditors, type DesktopEditorOperation } from './desktop-files-editor-model';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createDesktopFileOperationJournal } from './desktop-files-operation-journal';
import { createDesktopFileOperations } from './desktop-files-operations';

void (async () => {
  const phase = await host.call('test.phase', {});
  const storage = createDesktopFileJournalStorage(async <T>(name: string, body: Record<string, unknown>) => await host.call(name, body) as T);
  let journal: ReturnType<typeof createDesktopEditorJournal>;
  const model = createDesktopEditors({ onChange: doc => journal?.queue(doc), persist: (doc, next) => journal.checkpoint(doc, next) });
  journal = createDesktopEditorJournal(storage, model); await journal.ready;
  const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'never-stored' }, authorityKey: 'synthetic-authority', sessionID: 'session', directory: '/workspace' };
  const operationsJournal = createDesktopFileOperationJournal(storage, () => {}); await operationsJournal.ready;
  const operations = createDesktopFileOperations(scope, { guard: async () => () => true, confirmed() {}, persistence: operationsJournal.bind(scope), restoreLock: path => model.beginMutation(scope, path, true) });
  let operationRestored = false;
  for (const record of operationsJournal.records()) operationRestored = operations.restore(record.command, record.phase);
  const document = model.acquire(scope, 'source.ts')!.document;
  const operation: DesktopEditorOperation = { scope, current: () => true, request: async (path, method = 'GET', body) => {
    const value = await host.call('test.document', { path, method, body: body ?? null }) as { error?: string };
    if (value && typeof value === 'object' && value.error) throw new Error(value.error);
    return value;
  } };
  if (phase === 1) {
    await model.load(document, operation);
    model.edit(document, 'SAVED_NATIVE');
    const saved = await model.save(document, operation);
    model.edit(document, 'EXPLICIT_DISCARD');
    const discarded = await model.discard(document);
    const clean = document.state().text;
    await operationsJournal.bind(scope).start({ kind: 'delete', path: '/workspace/unresolved.bin' });
    model.edit(document, 'UNKNOWN_NATIVE');
    const uncertain = await model.save(document, operation);
    model.edit(document, 'LATER_NATIVE_INPUT'); await journal.flush();
    journal.stop(); host.post('test.result', { saved, discarded, clean, uncertain, pending: !!document.state().pending, journal: journal.state() });
  } else {
    const restored = { text: document.state().text, pending: !!document.state().pending };
    const verified = await model.save(document, operation);
    await operations.inspect(operation);
    journal.stop(); host.post('test.result', { restored, verified, text: document.state().text, pending: !!document.state().pending, operationRestored, operationProtected: operations.protected() });
  }
})().catch(error => host.post('test.result', { error: String(error) }));
