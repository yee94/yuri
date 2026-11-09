import { cleanup, colorScheme, lifecycle, reduceMotion, Scroll, signal, Text, token, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { list, record, text } from './model';
import type { createChat } from './state';
import { Icon } from './Icon';

type Chat = ReturnType<typeof createChat>;
type QueueChat = Pick<Chat, 'inbox' | 'queueError' | 'active' | 'queueBusy' | 'sending' | 'editInbox' | 'steerInbox' | 'cancelInbox'>;
const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';

/** The server inbox is separate from history; draft changes never enumerate it. */
export function NativeChatQueue(props: { chat: QueueChat; trailing?: JSX.Element; trailingVisible?: boolean }) {
  const chat = props.chat;
  const hasQueue = () => chat.inbox().length > 0 || !!chat.queueError();
  const disabled = () => !chat.active() || !!chat.queueBusy() || chat.sending();
  return <If when={hasQueue() || props.trailingVisible}>
    <View testID="chat-queue-shell" class="relative overflow-hidden rounded-[20px] bg-background border border-border/50" style={{ borderColor: colorScheme() === 'dark' ? 'transparent' : undefined, marginBottom: 4 }}>
      <If when={colorScheme() === 'dark'}><View accessible={false} class="absolute inset-0 bg-foreground" style={{ opacity: .04, pointerEvents: 'none' }} /></If>
      <View class="px-1.5 py-1.5">
      <If when={hasQueue()}><View testID="chat-queue">
        <If when={!!chat.queueError()}><Text role="alert" class="px-1 text-xs text-destructive">{chat.queueError()}</Text></If>
        <Scroll testID="chat-queue-list" class="max-h-48">
          <Each of={chat.inbox()} key={item => text(item.id)}>{item => <View testID={`queue-row-${text(item().id)}`} class="flex-row items-center gap-1 py-0.5">
            <View testID={`queue-reorder-disabled-${text(item().id)}`} accessible={false} class="items-center justify-center" style={{ width: 12, height: 28, opacity: .5 }}><Icon name="draggable" size={12} color={token('muted-foreground')} /></View>
            <Button testID={`queue-remove-${text(item().id)}`} class="items-center justify-center disabled:opacity-50" style={{ width: 20, height: 28, flexShrink: 0 }} disabled={disabled()} accessibilityLabel={t('chat.queuedMessage.removeAria')} onPress={() => { void chat.cancelInbox(text(item().id)); }}><Icon name="delete-bin" size={12} color={token('muted-foreground')} /></Button>
            <View class="flex-1 min-w-0 flex-row items-center gap-1" accessibilityLabel={text(record(item().payload).text) || t('chat.queuedMessage.empty')}>
              <Text testID={`queue-preview-${text(item().id)}`} class="flex-1 min-w-0 text-xs text-foreground" style={{ numberOfLines: 1, lineHeight: 20 }}>{text(record(item().payload).text) ? text(record(item().payload).text).split('\n')[0] + (text(record(item().payload).text).includes('\n') ? '...' : '') : t('chat.queuedMessage.empty')}</Text>
              <If when={list(record(item().payload).files).length > 0}><View class="flex-row items-center gap-0.5" accessibilityLabel={t('chat.queuedMessage.attachments', { count: list(record(item().payload).files).length })}><Icon name="attachment-2" size={12} color={token('muted-foreground')} /><Text class="text-xs text-muted-foreground">{list(record(item().payload).files).length}</Text></View></If>
            </View>
            <If when={item().delivery === 'queue'} else={<View testID={`queue-steering-${text(item().id)}`} class="flex-row items-center gap-1" style={{ height: 28, flexShrink: 0 }} accessibilityLabel={t('chat.queuedMessage.sendingAria')}><View style={{ animationName: chat.active() && lifecycle() === 'active' && !reduceMotion() ? 'spin' : 'none', animationDuration: 1000, animationTimingFunction: 'linear', animationIterationCount: 'infinite' }}><Icon name="loader-4" size={12} color={token('muted-foreground')} /></View><Text class="text-muted-foreground" style={{ fontSize: 11 }}>{t('chat.queuedMessage.sending')}</Text></View>}>
              <View class="flex-row items-center gap-1.5" style={{ flexShrink: 0 }}>
                <Button testID={`queue-edit-${text(item().id)}`} class="flex-row items-center gap-1.5 disabled:opacity-50" style={{ height: 28 }} disabled={disabled()} accessibilityLabel={t('chat.queuedMessage.edit')} onPress={() => { void chat.editInbox(text(item().id)); }}><Icon name="pencil" size={12} color={token('muted-foreground')} /><Text class="text-muted-foreground" style={{ fontSize: 11 }}>{t('chat.queuedMessage.edit')}</Text></Button>
                <Button testID={`queue-steer-${text(item().id)}`} class="flex-row items-center gap-1.5 disabled:opacity-50" style={{ height: 28 }} disabled={disabled()} accessibilityLabel={t('chat.queuedMessage.send')} onPress={() => { void chat.steerInbox(text(item().id)); }}><Icon name="corner-down-left" size={12} color={token('muted-foreground')} /><Text class="text-muted-foreground" style={{ fontSize: 11 }}>{t('chat.queuedMessage.send')}</Text></Button>
              </View>
            </If>
          </View>}</Each>
        </Scroll>
      </View></If>
      <If when={hasQueue() && props.trailingVisible}><View testID="chat-queue-goal-divider" class="my-0.5 border-t border-border/40" /></If>
      <If when={props.trailingVisible}>{props.trailing}</If>
      </View>
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
