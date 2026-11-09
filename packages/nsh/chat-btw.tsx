import { cleanup, computed, effect, Scroll, signal, Text, untracked, View } from 'nsh';
import { Button, Input, TextView } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { nativeChatTextStyle, nativeCodeTextViewStyles, nativeDensity } from './appearance';
import { t } from './i18n';
import { bindRequest } from './runtime';
import { createBtwGenerate, createBtwOwner, type BtwScope, type BtwOwner } from './chat-btw-model';
import { createBtwPresentation } from './chat-btw-presentation';

export function createNativeBtwOwner(scope: BtwScope, current: () => boolean) {
  const revision = signal(0);
  let serial = 0;
  const owner = createBtwOwner(scope, createBtwGenerate(scope, bindRequest(scope.runtime)), current, () => revision.set(++serial));
  effect(() => { const active = current(); if (!active) untracked(owner.close); });
  cleanup(owner.retire);
  return { owner, state: computed(() => { revision(); return owner.snapshot(); }) };
}

const action = 'min-h-11 px-4 items-center justify-center rounded-xl bg-secondary active:bg-accent disabled:opacity-40';

/** Independent system Sheet: no main transcript layout or scroll writer. */
export function NativeBtwSheet(props: { owner: BtwOwner; state: () => ReturnType<BtwOwner['snapshot']>; active: boolean }) {
  const revision = signal(0);
  let serial = 0;
  const presentation = createBtwPresentation(() => revision.set(++serial));
  const surface = computed(() => { revision(); const ticket = presentation.current(); return ticket ? { ...ticket } : null; });
  const sync = () => {
    const owner = props.owner, state = props.state(), active = props.active;
    untracked(() => presentation.sync(owner, state, active));
  };
  effect(sync);
  cleanup(presentation.dispose);
  return <Each of={surface() ? [surface()!.id] : []}>{id => {
    const ticket = presentation.current()!;
    const state = () => { surface(); return ticket.state; };
    const active = () => props.active && surface()?.id === id() && ticket.open;
    const diagnostic = () => {
      props.state();
      const value = ticket.owner.snapshot();
      return { owner: ticket.owner.diagnosticID, ticket: ticket.id, intent: ticket.closeTicket.generation, ownerGeneration: value.presentationGeneration,
        revision: value.revision, open: value.open, active: props.active, current: ticket.owner.isCurrent(), status: value.turns.at(-1)?.status ?? 'none' as const };
    };
    return <NativeSheet testID="chat-btw-sheet" open={surface()?.id === id() && ticket.open} detents={[.72, .98]} initialDetent={1}
      diagnostic={diagnostic()}
      onOpenChange={event => { sync(); presentation.change(ticket, event); }} onClose={() => { sync(); presentation.closed(ticket); }} popupClass="bg-background gap-3 pb-4">
      <NativeBtwContent owner={ticket.owner} state={state} active={active()} />
    </NativeSheet>;
  }}</Each>;
}

function NativeBtwContent(props: { owner: BtwOwner; state: () => ReturnType<BtwOwner['snapshot']>; active: boolean }) {
  const state = props.state;
  const pending = () => state().turns.some(turn => turn.status === 'pending');
  const latest = () => state().turns.at(-1);
  const actionStyle = () => nativeDensity().forms.action;
  const press = (name: 'close' | 'cancel' | 'retry' | 'submit') => {
    state();
    const owner = props.owner, action = owner.capture();
    return () => { if (props.active) owner[name](action); };
  };
  const edit = () => {
    state();
    const owner = props.owner, action = owner.capture();
    return (event: { value: string }) => { if (props.active) owner.edit(event.value, action); };
  };
  return <View class="flex-1 gap-3">
    <View class="flex-row items-center px-4 gap-2"><Text class="flex-1 text-foreground" style={nativeChatTextStyle('uiLabel')}>{t('chat.btw.title')}</Text><Button class={action} style={actionStyle()} accessibilityLabel={t('mobile.surface.closeAria')} onPress={press('close')}><Text>{t('gitView.common.close')}</Text></Button></View>
    <Text class="px-4 text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.btw.description')}</Text>
    <Scroll testID="chat-btw-history" class="flex-1" contentClass="px-4 gap-3">
      <Each of={state().turns}>{turn => <View class="gap-2"><Text class="text-foreground" style={nativeChatTextStyle('markdown')}>{turn().question}</Text>
        <If when={turn().answer}><TextView class="text-foreground" markdown={turn().answer} styles={nativeCodeTextViewStyles()} selectable links="open" /></If>
        <If when={turn().status === 'pending'}><Text class="text-muted-foreground">{t('chat.btw.pending')}</Text></If>
        <If when={turn().status === 'failed'}><Text role="alert" class="text-destructive">{t('chat.btw.failed')}</Text></If>
        <If when={turn().status === 'cancelled'}><Text class="text-muted-foreground">{t('chat.btw.cancelled')}</Text></If>
      </View>}</Each>
    </Scroll>
    <View class="px-4 gap-2" style={nativeDensity().forms.stack}>
      <Input testID="chat-btw-input" multiline value={state().draft} placeholder={t('chat.btw.placeholder')} onChange={edit()} class="min-h-11 p-3 rounded-xl bg-secondary text-foreground" style={nativeChatTextStyle('composer')} />
      <View class="flex-row justify-end gap-2">
        <If when={pending()}><Button class={action} style={actionStyle()} onPress={press('cancel')}><Text>{t('gitView.common.cancel')}</Text></Button></If>
        <If when={latest()?.status === 'failed' || latest()?.status === 'cancelled'}><Button class={action} style={actionStyle()} disabled={!props.active || pending()} onPress={press('retry')}><Text>{t('diffView.actions.retry')}</Text></Button></If>
        <Button testID="chat-btw-send" class={action} style={actionStyle()} disabled={!props.active || pending() || !state().draft.trim()} onPress={press('submit')}><Text>{t('chat.chatInput.actions.sendMessageAria')}</Text></Button>
      </View>
    </View>
  </View>;
}
