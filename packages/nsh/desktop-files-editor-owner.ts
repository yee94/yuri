import { AlertDialog } from 'nsh/base';
import { native } from './runtime';
import { createDesktopFileJournalStorage } from './desktop-files-storage';
import { t } from './i18n';
import { createDesktopEditors, type DesktopEditorDocument, type DesktopEditorOperation } from './desktop-files-editor-model';
import { desktopPanelScopeKey } from './desktop-panel-model';
import { createDesktopEditorJournal, type DesktopJournalStorage } from './desktop-files-journal';

/** Native confirmation belongs to the window owner, not a particular close
 * button/view. The shell may call guardAll() before destroying this owner. */
export function createNativeDesktopEditors(onProtectionChange: () => void, options: { storage?: DesktopJournalStorage | false; onModalChange?: (delta: number) => void } = {}) {
  const listeners = new Set<() => void>();
  const notify = () => { onProtectionChange(); listeners.forEach(listener => listener()); };
  let journal: ReturnType<typeof createDesktopEditorJournal> | undefined;
  const model = createDesktopEditors({ onProtectionChange, onChange: document => journal?.queue(document), persist: (document, next) => journal ? journal.checkpoint(document, next) : Promise.resolve(true) });
  if (options.storage !== false) journal = createDesktopEditorJournal(options.storage ?? createDesktopFileJournalStorage(native), model, notify);
  const bindings = new Map<string, { document: DesktopEditorDocument; operation: () => DesktopEditorOperation }>();
  const guards = new Map<string, Promise<boolean>>();
  const operation = (document: DesktopEditorDocument) => bindings.get(document.key)?.operation();
  async function show(dialog: Parameters<typeof AlertDialog.show>[0]) {
    options.onModalChange?.(1);
    try { return await AlertDialog.show(dialog); }
    finally { options.onModalChange?.(-1); }
  }
  function checkpoint(document: DesktopEditorDocument) {
    const binding = bindings.get(document.key), captured = binding?.operation();
    return { binding, scopeKey: captured ? desktopPanelScopeKey(captured.scope) : null, lease: captured?.scope.host.lease, current: captured?.current() };
  }
  function unchanged(document: DesktopEditorDocument, prior: ReturnType<typeof checkpoint>) {
    const next = checkpoint(document);
    return next.binding === prior.binding && next.scopeKey === prior.scopeKey && next.lease === prior.lease && next.current === prior.current && (next.scopeKey === null || next.scopeKey === document.scopeKey);
  }
  const save = async (document: DesktopEditorDocument) => {
    const captured = operation(document);
    return captured?.current() === true ? model.save(document, captured) : false;
  };
  async function confirm(document: DesktopEditorDocument) {
    if (!model.protected(document)) return true;
    if (document.state().saving) return false;
    const revision = model.revision(document), captured = operation(document), authority = checkpoint(document);
    const result = await show({ title: t('filesView.unsaved.title'), description: document.path + '\n' + t('filesView.unsaved.description'), actions: [
      { id: 'save', label: t(document.state().pending ? 'diffView.actions.retry' : 'filesView.unsaved.saveChanges') },
      ...(document.state().pending ? [] : [{ id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' as const }]),
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    // A later edit (including edit then undo) revokes this exact close intent.
    if (revision !== model.revision(document) || document.state().saving || !unchanged(document, authority)) return false;
    if (result.action === 'discard') return await model.discard(document) && !model.protected(document);
    if (result.action === 'save' && captured && model.admitted(document, captured)) return await model.save(document, captured) && revision === model.revision(document) && unchanged(document, authority) && !model.protected(document);
    return false;
  }
  function guard(document: DesktopEditorDocument) {
    const pending = guards.get(document.key);
    if (pending) return pending;
    const flight = confirm(document).catch(() => false).finally(() => { if (guards.get(document.key) === flight) guards.delete(document.key); });
    guards.set(document.key, flight); return flight;
  }
  return { model, save, guard, journal,
    journalState: () => journal?.state() ?? { hydrated: true, error: '', pending: 0, records: 0, bytes: 0 },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    bind(document: DesktopEditorDocument, value: () => DesktopEditorOperation) {
      const binding = { document, operation: value }; bindings.set(document.key, binding);
      return () => { if (bindings.get(document.key) === binding) bindings.delete(document.key); };
    },
    async refresh(document: DesktopEditorDocument) {
      const captured = operation(document);
      if (!captured?.current() || document.state().saving || document.state().pending) return false;
      if (model.protected(document)) {
        const revision = model.revision(document);
        const result = await show({ title: t('filesView.unsaved.title'), description: document.path + '\n' + t('filesView.unsaved.description'), actions: [
          { id: 'save', label: t('filesView.unsaved.saveChanges') },
          { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
          { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
        ] });
        if (!captured.current() || revision !== model.revision(document)) return false;
        if (result.action === 'save') { if (!await model.save(document, captured)) return false; }
        else if (result.action !== 'discard') return false;
        // Discard is only applied when the replacement GET succeeds and the
        // revision is unchanged; a failed refresh never erases the local draft.
        return model.load(document, captured, true);
      }
      return model.load(document, captured);
    },
    async guardAll() {
      try {
        if (journal) { await journal.ready; if (!journal.state().hydrated || !await journal.flush()) return false; }
        const documents = model.documents();
        const checked = new Map<DesktopEditorDocument, { revision: number; authority: ReturnType<typeof checkpoint> }>();
        for (const document of documents) {
          const authority = checkpoint(document);
          if (model.protected(document) && !await guard(document)) return false;
          if (!unchanged(document, authority)) return false;
          checked.set(document, { revision: model.revision(document), authority });
        }
        // A previous document (or a new one) may have changed while a later native
        // dialog/GET was awaiting. Approval is a fresh whole-owner decision.
        return (!journal || journal.state().hydrated && !journal.state().error && !journal.state().pending) && model.documents().every(document => {
          const prior = checked.get(document);
          return !!prior && !model.protected(document) && model.revision(document) === prior.revision && unchanged(document, prior.authority);
        });
      } catch { return false; }
    },
  };
}
export type NativeDesktopEditors = ReturnType<typeof createNativeDesktopEditors>;
