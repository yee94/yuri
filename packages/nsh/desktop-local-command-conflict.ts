import { AlertDialog } from 'nsh/base';
import { t } from './i18n';
import type { NativeLocalCommandConflict, NativeLocalCommandSnapshot } from './composer-local-commands';

export type NativeLocalCommandConflictResult = { status: 'applied' | 'cancelled' | 'stale' | 'rejected'; submitted?: boolean };

/** Applied acknowledges only the exact document CAS; business admission still belongs to the registry/writer. */
export async function confirmNativeLocalCommandConflict(conflict: NativeLocalCommandConflict, options: {
  /** Captured owner/scope/operation and current presentation, not merely a global active flag. */
  current: () => boolean;
  /** Must compare scope, authority, monotonic revision and text before changing only document text. */
  replace: (expectedSnapshot: NativeLocalCommandSnapshot, text: string) => boolean;
  submit: () => void;
  focus: () => void;
}): Promise<NativeLocalCommandConflictResult> {
  if (!options.current()) return { status: 'stale' };
  try {
    const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
      { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
    ] });
    if (!options.current()) return { status: 'stale' };
    if (answer.action !== 'discard') { if (options.current()) options.focus(); return { status: 'cancelled' }; }
    const shouldSubmit = conflict.phase === 'submit' || conflict.presetText !== undefined;
    const value = conflict.phase === 'submit' ? `/${conflict.command}` : conflict.presetText ?? conflict.webText;
    if (!options.replace(conflict.snapshot, value)) return { status: 'stale' };
    let submitted = false;
    if (shouldSubmit && options.current()) { submitted = true; options.submit(); }
    if (options.current()) options.focus();
    return { status: 'applied', submitted };
  } catch { return { status: 'rejected' }; }
}
