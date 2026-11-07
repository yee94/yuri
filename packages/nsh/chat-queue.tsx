import { cleanup, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { list, record, text } from './model';
import type { createChat } from './state';

type Chat = ReturnType<typeof createChat>;
const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';

/** The server inbox is separate from history; draft changes never enumerate it. */
export function NativeChatQueue(props: { chat: Chat }) {
  const chat = props.chat;
  return <If when={chat.inbox().length > 0 || !!chat.queueError()}>
    <View testID="chat-queue" class="px-4 py-2 gap-2">
      <Text class="text-xs font-semibold text-muted-foreground">{t('chat.queuedMessage.title')}</Text>
      <If when={!!chat.queueError()}><Text role="alert" class="text-xs text-destructive">{chat.queueError()}</Text></If>
      <Scroll class="max-h-48" contentClass="gap-2">
        <Each of={chat.inbox()} key={item => text(item.id)}>{item => <View class="bg-card rounded-2xl p-3 gap-2">
          <Text class="text-sm text-foreground" style={{ numberOfLines: 2 }}>{text(record(item().payload).text) || t('chat.queuedMessage.empty')}</Text>
          <If when={list(record(item().payload).files).length > 0}><Text class="text-xs text-muted-foreground">{t('chat.queuedMessage.attachments', { count: list(record(item().payload).files).length })}</Text></If>
          <Text class="text-xs text-muted-foreground">{t(item().delivery === 'steer' ? 'chat.queuedMessage.sending' : 'chat.queuedMessage.inheritsSessionSelection')}</Text>
          <View class="flex-row gap-2">
            <If when={item().delivery === 'queue'}>
              <Button testID={`queue-edit-${text(item().id)}`} class={action} disabled={!chat.active() || !!chat.queueBusy() || chat.sending()} onPress={() => { void chat.editInbox(text(item().id)); }}><Text class="text-foreground">{t('chat.queuedMessage.edit')}</Text></Button>
              <Button testID={`queue-steer-${text(item().id)}`} class={action} disabled={!chat.active() || !!chat.queueBusy() || chat.sending()} onPress={() => { void chat.steerInbox(text(item().id)); }}><Text class="text-foreground">{t('chat.queuedMessage.send')}</Text></Button>
            </If>
            <Button testID={`queue-remove-${text(item().id)}`} class={action} disabled={!chat.active() || !!chat.queueBusy() || chat.sending()} accessibilityLabel={t('chat.queuedMessage.removeAria')} onPress={() => { void chat.cancelInbox(text(item().id)); }}><Text class="text-foreground">×</Text></Button>
          </View>
        </View>}</Each>
      </Scroll>
    </View>
  </If>;
}

export function NativeDraftFeedback(props: { chat: Chat }) {
  const chat = props.chat, pending = signal(false), error = signal('');
  let alive = true;
  cleanup(() => { alive = false; });
  async function perform(work: () => Promise<unknown>) {
    if (pending() || !chat.active()) return;
    pending.set(true); error.set('');
    try { await work(); }
    catch (cause) { if (alive && chat.active()) error.set(String(cause)); }
    finally { if (alive) pending.set(false); }
  }
  return <View class="gap-2">
    <If when={chat.draftStatus() === 'loading'}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
    <If when={chat.draftStatus() === 'error'}><View testID="draft-storage-error" class="gap-2">
      <Text role="alert" class="text-xs text-destructive">{chat.draftError()}</Text>
      <Button testID="draft-storage-retry" class={action} disabled={pending() || chat.sending() || !chat.active()} onPress={() => { void perform(chat.retryDraft); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    </View></If>
    <If when={!!chat.queueEdit()}><View testID="queue-edit-recovery" class="gap-2">
      <Text role="alert" class="text-xs text-muted-foreground">{t('chat.chatInput.toast.queueOperationStatusUnknown')}</Text>
      <Button testID="queue-edit-retry" class={action} disabled={pending() || !!chat.queueBusy() || chat.sending() || !chat.active()} onPress={() => { const edit = chat.queueEdit(); if (edit) void perform(() => chat.editInbox(edit.id)); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    </View></If>
    <If when={!!error()}><Text role="alert" class="text-xs text-destructive">{error()}</Text></If>
  </View>;
}
