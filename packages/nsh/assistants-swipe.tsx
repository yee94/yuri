import { cleanup, effect, PanResponder, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { createAssistantSwipe } from './assistants-swipe-core';

export function AssistantSwipeRow(props: {
  binding: unknown;
  generation: number;
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
  const pressToken = signal(0);
  let pressSequence = 0;
  let binding = props.binding, generation = props.generation, pinned = props.pinned, disabled = props.disabled, cancelled = false, touching = false, panned = false;
  function current() {
    const nextBinding = props.binding, nextGeneration = props.generation, nextPinned = props.pinned, nextDisabled = props.disabled;
    if (binding !== nextBinding || generation !== nextGeneration || pinned !== nextPinned || disabled !== nextDisabled) {
      binding = nextBinding; generation = nextGeneration; pinned = nextPinned; disabled = nextDisabled;
      cancelled ||= touching; touching = false;
      pressToken.set(++pressSequence);
      swipe.cancel(); swipe.close(); if (cancelled) swipe.suppress(); else swipe.begin();
    }
    return !nextDisabled && !cancelled;
  }
  function press(action: () => void) {
    const token = pressToken();
    return () => { if (current() && token === pressToken()) action(); };
  }
  function accessibilityAction() {
    const token = pressToken();
    return (event: { actionName: string }) => {
      current();
      if (props.disabled || token !== pressToken() || !['activate', 'menu'].includes(event.actionName)) return;
      pressToken.set(++pressSequence);
      touching = false; cancelled = true; swipe.close(); swipe.suppress();
      if (event.actionName === 'menu') props.onMenu(); else props.onOpen();
    };
  }
  const swipe = createAssistantSwipe({ read: offset, write: value => offset.set(value), enabled: current, reveal: () => props.onReveal(props.id) });
  function endGesture(terminated: boolean) {
    if (current()) { if (terminated) swipe.cancel(); else swipe.release(); }
    touching = false;
    if (cancelled) { cancelled = false; swipe.begin(); }
  }
  effect(() => {
    current();
    if (props.disabled || props.pinned || props.revealed !== props.id) swipe.close();
  });
  cleanup(swipe.close);
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => { current(); if (!props.disabled) { pressToken.set(++pressSequence); cancelled = false; touching = true; panned = false; swipe.begin(); } return false; },
    onMoveShouldSetPanResponder: (_, gesture) => current() && !props.pinned && swipe.claim(gesture.dx, gesture.dy, gesture.numberActiveTouches),
    onPanResponderGrant: () => { if (current()) { panned = true; swipe.grant(); } },
    onPanResponderMove: (_, gesture) => { if (!current()) return; if (gesture.numberActiveTouches !== 1) swipe.cancel(); else swipe.move(gesture.dx); },
    onPanResponderRelease: () => endGesture(false),
    onPanResponderTerminate: () => endGesture(true),
    onPanResponderTerminationRequest: () => true,
    onShouldBlockNativeResponder: () => current() && !props.pinned,
  });
  return <View class={props.pinned ? 'w-28 items-center gap-1 pt-1 pb-3' : 'overflow-hidden rounded-3xl border border-border'} testID={`assistant-row-${props.id}`} accessible role="button" accessibilityLabel={props.name} accessibilityState={{ disabled: props.disabled }} accessibilityActions={[{ name: 'activate' }, { name: 'menu', label: t('chat.timeline.actions.title') }]} onAccessibilityAction={accessibilityAction()}>
    <If when={offset() < 0 && !props.pinned}>
      <View class="absolute right-0 top-0 bottom-0 flex-row" style={{ width: 128 }}>
        <Button testID={`assistant-swipe-edit-${props.id}`} class="flex-1 bg-secondary items-center justify-center gap-1" disabled={props.disabled} onPress={press(() => { if (props.pinned) return; touching = false; swipe.close(); props.onEdit(); })}><Icon name="edit" size={18} /><Text class="text-xs text-foreground">{t('assistants.menu.edit')}</Text></Button>
        <Button testID={`assistant-swipe-delete-${props.id}`} class="flex-1 bg-muted items-center justify-center gap-1" disabled={props.disabled} onPress={press(() => { if (props.pinned) return; touching = false; swipe.close(); props.onDelete(); })}><Icon name="delete-bin" size={18} /><Text class="text-xs text-destructive">{t('assistants.settings.delete')}</Text></Button>
      </View>
    </If>
    <View {...pan.panHandlers} class={props.pinned ? 'items-center gap-1' : 'flex-row items-center bg-card min-h-19 px-4 py-3 gap-3'} style={{ transform: [{ translateX: offset() }] }}>
      <View testID={`assistant-open-${props.id}`} class={props.pinned ? 'items-center gap-2 flex-1' : 'flex-row items-center gap-3 flex-1'} role="button" disabled={props.disabled} accessibilityLabel={props.name} onLongPress={press(() => { if (!touching || panned) return; swipe.suppress(); props.onMenu(); })} onPress={press(() => {
        const select = swipe.select(); touching = false;
        if (select) props.onOpen();
      })}>{props.children}</View>
    </View>
  </View>;
}
