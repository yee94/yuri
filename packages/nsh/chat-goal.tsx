import { cleanup, computed, keyboardFrame, safeArea, signal, Scroll, Text, View, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { sessionGoalStatusLabelKey } from '../ui/src/lib/sessionGoalPresentation';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { Icon } from './Icon';
import { t } from './i18n';
import { createGoalController, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT, type GoalController, type GoalScope, type GoalState, type GoalTransport } from './chat-goal-model';

const action = 'min-h-11 px-3 flex-row items-center justify-center gap-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40';

/** Parent forwards existing events/reconnect and cancels on hide/Host replacement. */
export function createNativeGoalOwner(scope: GoalScope, transport: GoalTransport, current: () => boolean) {
  const revision = signal(0);
  let serial = 0;
  const controller = createGoalController(scope, transport, current, () => revision.set(++serial));
  cleanup(controller.cancel);
  return { controller, state: computed(() => { revision(); return controller.state(); }) };
}
export type NativeGoalOwner = { state: () => GoalState; controller: Pick<GoalController, 'scope' | 'refresh' | 'setArmed' | 'captureArm' | 'toggle' | 'clear'> };

function statusLabel(status: 'active' | 'paused' | 'complete') { return t(sessionGoalStatusLabelKey[status] as I18nKey); }

export function NativeGoalChip(props: { owner: NativeGoalOwner; enabled: boolean; draftOpen?: boolean }) {
  const state = props.owner.state;
  return <If when={props.enabled && (!!props.owner.controller.scope.sessionID || props.draftOpen === true) && (state().armed || !!state().goal)}>
    <View testID="chat-goal-chip" class="flex-row items-center gap-1 rounded-full bg-secondary pl-2 pr-1">
      <Icon name="target" size={16} /><Text class={state().goal?.status === 'complete' ? 'text-xs text-success' : 'text-xs text-foreground'}>{t('chat.goal.chip.label')}</Text>
      <Button testID="chat-goal-remove" class="min-h-7 min-w-7 items-center justify-center rounded-full active:bg-accent disabled:opacity-40" disabled={state().busy} accessibilityLabel={t(state().armed ? 'chat.goal.button.disarmAria' : 'chat.goal.action.clear')} onPress={() => {
        if (state().armed) props.owner.controller.setArmed(false);
        else void props.owner.controller.clear();
      }}><Icon name="close" size={12} /></Button>
    </View>
  </If>;
}

/** Tiny typing leaf: no history traversal, requests, subscriptions or formatting of catalogs. */
export function NativeGoalObjectiveCounter(props: { armed: boolean; length: number }) {
  return <If when={props.armed && props.length > 0}><Text testID="chat-goal-counter" accessibilityLabel={t('chat.goal.counter.aria')} class={props.length > SESSION_GOAL_OBJECTIVE_CHAR_LIMIT ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{props.length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}</Text></If>;
}

export function NativeGoalRow(props: { owner: NativeGoalOwner; enabled: boolean; active: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const state = props.owner.state;
  return <If when={props.enabled}>
    <If when={!!state().goal}>
      <View testID="chat-goal-row" class="min-h-7 flex-row items-center gap-1 px-3" accessibilityLabel={t('chat.goal.row.aria')}>
        <Icon name="target" size={14} />
        <Button testID="chat-goal-details" class="flex-1 min-w-0 py-1" accessibilityLabel={t('chat.goal.row.aria')} onPress={() => { if (props.active) props.onOpenChange(true); }}><Text class="text-xs text-foreground" style={{ numberOfLines: 1 }}>{state().goal?.objective}</Text></Button>
        <Text class="text-xs text-muted-foreground">{state().goal ? statusLabel(state().goal!.status) : ''}</Text>
        <Text class="text-xs text-muted-foreground">{state().goal?.rounds}/{state().goal?.maxRounds}</Text>
        <If when={state().goal?.status !== 'complete'}><Button testID="chat-goal-toggle" class="min-h-7 px-1 flex-row items-center gap-1 disabled:opacity-40" disabled={state().busy || !props.active} onPress={() => { void props.owner.controller.toggle(); }}><Icon name={state().goal?.status === 'active' ? 'pause' : 'play'} size={14} /><Text class="text-xs text-foreground">{t(state().goal?.status === 'active' ? 'chat.goal.action.pause' : 'chat.goal.action.resume')}</Text></Button></If>
      </View>
    </If>
    <If when={state().readError || state().actionError}>
      <View class="px-3 flex-row items-center gap-2"><Text role="alert" class="flex-1 text-xs text-destructive">{t('chat.goal.toast.actionFailed')}</Text><Button testID="chat-goal-retry-read" class={action} disabled={state().loading || !props.active} onPress={() => { void props.owner.controller.refresh(); }}><Text>{t('diffView.actions.retry')}</Text></Button></View>
    </If>
    <NativeGoalPanel owner={props.owner} open={props.open} active={props.active} onClose={() => props.onOpenChange(false)} />
  </If>;
}

export function NativeGoalPanel(props: { owner: NativeGoalOwner; open: boolean; active: boolean; onClose: () => void }) {
  const state = props.owner.state;
  const run = async (operation: () => Promise<string>) => { if (await operation() === 'acknowledged') props.onClose(); };
  return <Sheet open={props.open && props.active} closeOnSwipe onOpenChange={event => { if (!event.open) props.onClose(); }} popupClass="bg-background rounded-t-3xl" popupStyle={{ maxHeight: windowSize().height - safeArea().top - keyboardFrame().height - 12, marginBottom: keyboardFrame().height }} backdropClass="bg-background/50">
    <If when={props.open && props.active}><Scroll testID="chat-goal-panel" contentClass="p-4 gap-3" contentStyle={{ paddingBottom: Math.max(16, safeArea().bottom) }}>
      <View class="flex-row items-center gap-2"><Text class="flex-1 text-base font-semibold text-foreground">{t('chat.goal.dialog.titleManage')}</Text><Button testID="chat-goal-panel-close" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={props.onClose}><Icon name="close" size={20} /></Button></View>
      <If when={state().readError || state().actionError}><Text role="alert" class="text-sm text-destructive">{t('chat.goal.toast.actionFailed')}</Text><Button class={action} disabled={state().loading} onPress={() => { void props.owner.controller.refresh(); }}><Text>{t('diffView.actions.retry')}</Text></Button></If>
      <If when={!!state().goal}>
        <Scroll class="max-h-48"><View selectable><Text class="text-sm text-foreground">{state().goal?.objective}</Text></View></Scroll>
        <Text class="text-xs text-muted-foreground">{state().goal ? statusLabel(state().goal!.status) : ''} · {state().goal?.rounds}/{state().goal?.maxRounds}</Text>
        <If when={!!state().goal?.reason}><View selectable><Text class="text-xs text-muted-foreground">{state().goal?.reason}</Text></View></If>
        <View class="flex-row justify-end gap-2">
          <If when={state().goal?.status !== 'complete'}><Button testID="chat-goal-panel-toggle" class={action} disabled={state().busy} onPress={() => { void run(props.owner.controller.toggle); }}><Text>{t(state().goal?.status === 'active' ? 'chat.goal.action.pause' : 'chat.goal.action.resume')}</Text></Button></If>
          <Button testID="chat-goal-panel-clear" class="min-h-11 px-3 rounded-xl bg-destructive/10 active:bg-destructive/20 disabled:opacity-40" disabled={state().busy} onPress={() => { void run(props.owner.controller.clear); }}><Text class="text-destructive">{t('chat.goal.action.clear')}</Text></Button>
        </View>
      </If>
    </Scroll></If>
  </Sheet>;
}
