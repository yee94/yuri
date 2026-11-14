import { Clipboard } from 'nsh';
import { t } from '../core/i18n';
import { showToast } from '../core/toast';
import { actionMenu } from '../core/ui';
import { addReference, forkFromMessage, retryMessage, revertToMessage, type Conversation, type MessageEntry } from './store';

const preview = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || t('chat.timeline.noTextContent');
};

function copyText(text: string): void {
  void Clipboard.writeText(text)
    .then(() => showToast({ message: t('chat.messageBody.actions.copyMessage') }))
    .catch(() => showToast({ message: t('common.unavailable') }));
}

/**
 * The long-press menu of one message, matching Web's message action row:
 * copy, retry a failed prompt, quote, and the user-turn revert/fork pair.
 */
export async function openMessageMenu(conversation: Conversation, entry: MessageEntry): Promise<void> {
  const text = entry.text();
  const error = String(entry.info().error ?? '');
  const isUser = entry.role === 'user';
  const canRewrite = isUser && !!conversation.sessionID() && !conversation.busy();
  const actions: { id: string; label: string; destructive?: boolean }[] = [];
  if (text.trim()) actions.push({ id: 'copy', label: t('chat.messageBody.actions.copyMessage') });
  if (isUser && error) actions.push({ id: 'retry', label: t('chat.history.retry') });
  if (text.trim()) actions.push({ id: 'quote', label: t('chat.textSelection.actions.addToChat') });
  if (canRewrite) {
    actions.push({ id: 'revert', label: t('chat.messageBody.actions.revert') });
    actions.push({ id: 'fork', label: t('chat.messageBody.actions.fork') });
  }
  if (actions.length === 0) return;
  const choice = await actionMenu({ actions });
  if (!choice) return;
  if (choice === 'copy') {
    copyText(text);
    return;
  }
  if (choice === 'quote') {
    addReference(conversation, { kind: 'quote', value: text });
    return;
  }
  if (choice === 'retry') {
    await retryMessage(conversation, entry);
    const failure = String(conversation.error() ?? '');
    if (failure) showToast({ message: failure });
    return;
  }
  if (choice === 'revert') {
    try {
      await revertToMessage(conversation, entry.id);
      showToast({ message: t('chat.revert.toast.undo', { preview: preview(text) }) });
    } catch (failure) {
      showToast({ message: failure instanceof Error && failure.message === 'busy' ? t('chat.revert.toast.busy') : t('chat.revert.toast.failed') });
    }
    return;
  }
  if (choice === 'fork') {
    try {
      await forkFromMessage(conversation, entry.id);
    } catch (failure) {
      showToast({ message: failure instanceof Error ? failure.message : t('chat.revert.toast.failed') });
    }
  }
}
