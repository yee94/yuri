import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeGoalOwner, NativeGoalChip, NativeGoalObjectiveCounter, NativeGoalRow } from './chat-goal';
import { NativeComposerTasks, createNativeChatStatusPopovers } from './chat-tasks';
import type { NativeGoal } from './chat-goal-model';
import type { NativeTask } from './chat-tasks-model';
import { t } from './i18n';

/** Offline mount target only: no application/state/runtime/Host bridge imports. */
function GoalTasksFixture() {
  const scope = { sessionID: 'goal-fixture', directory: '/workspace/fixture' };
  const open = signal(false), fail = signal(false), live = signal(false);
  let goal: NativeGoal | null = { id: 'g', objective: 'Verify the complete goal and task interactions.\nKeep the full objective readable.', status: 'active', rounds: 2, maxRounds: 20, reason: 'Fixture reason', boot: 'fixture', updatedAt: 1 };
  const owner = createNativeGoalOwner(scope, {
    async get() { if (fail()) throw new Error('Fixture read failure'); return goal; },
    async command(_scope, command) {
      if (fail()) throw new Error('Fixture command failure');
      goal = command.text === 'clear' ? null : goal ? { ...goal, status: command.text === 'pause' ? 'paused' : 'active', updatedAt: goal.updatedAt + 1 } : null;
    },
  }, () => true);
  void owner.controller.refresh();
  const popovers = createNativeChatStatusPopovers();
  const tasks: NativeTask[] = Array.from({ length: 300 }, (_, index) => ({ id: `task-${index}`, content: `Fixture task ${index + 1}: preserve source order and allow long content to wrap without changing the transcript viewport.`, priority: 'medium', status: index < 120 ? 'completed' : index === 120 ? 'in_progress' : index === 130 ? 'cancelled' : 'pending' }));
  return <View class="flex-1 bg-background p-3 gap-3">
    <Text testID="goal-fixture-title" class="text-foreground">Goal / Tasks offline fixture</Text>
    <NativeGoalRow owner={owner} enabled active open={open()} onOpenChange={value => open.set(value)} />
    <View class="flex-row gap-2"><NativeGoalChip owner={owner} enabled /><NativeGoalObjectiveCounter armed={owner.state().armed} length={4001} /></View>
    <View class="flex-row gap-2"><Button testID="goal-fixture-arm" onPress={() => owner.controller.setArmed(!owner.state().armed)}><Text>{t('chat.goal.button.armAria')}</Text></Button><Button testID="goal-fixture-fail" onPress={() => fail.set(!fail())}><Text>Failure: {String(fail())}</Text></Button><Button testID="goal-fixture-live" onPress={() => live.set(!live())}><Text>Live: {String(live())}</Text></Button></View>
    <View class="flex-1"><Text class="text-muted-foreground">Fixed transcript area — opening Tasks must not reflow this view.</Text></View>
    <View class="flex-row justify-between">
      <Button testID="goal-fixture-changes" onPress={() => popovers.changes(popovers.opened() !== 'changes')}><Text>{t('mobile.menu.changes')} {String(popovers.opened() === 'changes')}</Text></Button>
      <NativeComposerTasks todos={tasks} active liveWorking={live()} expanded={popovers.opened() === 'tasks'} onExpandedChange={popovers.tasks} />
    </View>
    <View style={{ height: 100 }}><Text class="text-muted-foreground">Fixture composer</Text></View>
  </View>;
}
mount(GoalTasksFixture);
