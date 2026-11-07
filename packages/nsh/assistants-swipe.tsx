import { cleanup, effect, PanResponder, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { createAssistantSwipe } from './assistants-swipe-core';

export function AssistantSwipeRow(props: {
  id: string;
  name: string;
  pinned: boolean;
  disabled: boolean;
  revealed: string | null;
  onReveal: (id: string) => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMenu: () => void;
  children?: JSX.Element;
}) {
  const offset = signal(0);
  const swipe = createAssistantSwipe({ read: offset, write: value => offset.set(value), enabled: () => !props.disabled, reveal: () => props.onReveal(props.id) });
  effect(() => {
    props.id;
    if (props.disabled || props.pinned || props.revealed !== props.id) swipe.close();
  });
  cleanup(swipe.close);
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => { swipe.begin(); return false; },
    onMoveShouldSetPanResponder: (_, gesture) => !props.pinned && swipe.claim(gesture.dx, gesture.dy, gesture.numberActiveTouches),
    onPanResponderGrant: () => swipe.grant(),
    onPanResponderMove: (_, gesture) => { if (gesture.numberActiveTouches !== 1) swipe.cancel(); else swipe.move(gesture.dx); },
    onPanResponderRelease: () => swipe.release(),
    onPanResponderTerminate: () => swipe.cancel(),
    onPanResponderTerminationRequest: () => true,
    onShouldBlockNativeResponder: () => !props.pinned && !props.disabled,
  });
  return <View class={props.pinned ? 'w-28 items-center gap-1 pt-1 pb-3' : 'overflow-hidden rounded-3xl border border-border'} testID={`assistant-row-${props.id}`}>
    <If when={offset() < 0 && !props.pinned}>
      <View class="absolute right-0 top-0 bottom-0 flex-row" style={{ width: 128 }}>
        <Button testID={`assistant-swipe-edit-${props.id}`} class="flex-1 bg-secondary items-center justify-center gap-1" disabled={props.disabled} onPress={() => { swipe.close(); props.onEdit(); }}><Icon name="edit" size={18} /><Text class="text-xs text-foreground">{t('assistants.menu.edit')}</Text></Button>
        <Button testID={`assistant-swipe-delete-${props.id}`} class="flex-1 bg-muted items-center justify-center gap-1" disabled={props.disabled} onPress={() => { swipe.close(); props.onDelete(); }}><Icon name="delete-bin" size={18} /><Text class="text-xs text-destructive">{t('assistants.settings.delete')}</Text></Button>
      </View>
    </If>
    <View {...pan.panHandlers} class={props.pinned ? 'items-center gap-1' : 'flex-row items-center bg-card min-h-19 px-4 py-3 gap-3'} style={{ transform: [{ translateX: offset() }] }} onLongPress={() => { swipe.suppress(); props.onMenu(); }}>
      <Button testID={`assistant-open-${props.id}`} class={props.pinned ? 'items-center gap-2 flex-1' : 'flex-row items-center gap-3 flex-1'} accessibilityLabel={props.name} onPress={() => {
        if (swipe.select()) props.onOpen();
      }}>{props.children}</Button>
      <Button testID={`assistant-menu-${props.id}`} class="w-7 h-9 items-center justify-center" accessibilityLabel={t('assistants.conversation.openSettings')} onPress={() => { swipe.close(); props.onMenu(); }} disabled={props.disabled}><Icon name="more-2" size={16} /></Button>
    </View>
  </View>;
}
