import { cleanup, computed, createMotion, effect, Image, lifecycle, List, Overlay, reduceMotion, signal, Text, token, View, windowSize, type ListRef, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { type TodoStatus } from '../ui/src/components/chat/todo/todoStatus';
import { Icon } from './Icon';
import { t } from './i18n';
import { createChatStatusPopovers, summarizeTasks, type NativeTask, type TasksSummary } from './chat-tasks-model';

const labels = { in_progress: 'chat.statusRow.todo.status.inProgress', pending: 'chat.statusRow.todo.status.pending', completed: 'chat.statusRow.todo.status.completed', cancelled: 'chat.statusRow.todo.status.cancelled' } as const;
const svg = (content: string, color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`)}`;

export function createNativeChatStatusPopovers() {
  const revision = signal(0); let serial = 0;
  const controller = createChatStatusPopovers(() => revision.set(++serial));
  return { ...controller, opened: computed(() => { revision(); return controller.opened(); }) };
}

function NativeTaskGlyph(props: { status: TodoStatus }) {
  const motion = createMotion({ enter: { keyframes: [{ scale: .55, opacity: 0 }, { scale: 1, opacity: 1 }], duration: 260, easing: [0.22, 1, 0.36, 1] } });
  cleanup(motion.stop);
  const source = () => {
    const color = String(token(props.status === 'in_progress' ? 'foreground' : 'muted-foreground'));
    const dash = props.status === 'pending' ? ' stroke-width="1.2" pathLength="24" stroke-dasharray="1 1"' : '';
    const path = props.status === 'in_progress' ? 'M4.8 8h6.4M8.6 5.4 11.2 8l-2.6 2.6' : props.status === 'completed' ? 'M5 8 7.5 11 11 5.5' : props.status === 'cancelled' ? 'M3.5 12.5 12.5 3.5' : '';
    return svg(`<circle cx="8" cy="8" r="6.5"${dash}/>${path ? `<path d="${path}"/>` : ''}`, color);
  };
  return <View style={motion.style}><Image src={source()} accessibilityLabel={t(labels[props.status])} style={{ width: 14, height: 14, opacity: props.status === 'pending' || props.status === 'cancelled' ? .6 : 1 }} /></View>;
}

function NativeTaskCount(props: { completed: number; total: number }) {
  const motion = createMotion(); let previous = props.completed;
  effect(() => {
    const completed = props.completed;
    if (completed !== previous) void motion.play({ keyframes: [{ translateY: 5.4, opacity: 0 }, { translateY: 0, opacity: 1 }], duration: 240, easing: [0.22, 1, 0.36, 1] });
    previous = completed;
  });
  cleanup(motion.stop);
  return <View class="flex-row"><View style={motion.style}><Text class="text-xs text-muted-foreground">{props.completed}</Text></View><Text class="text-xs text-muted-foreground">/{props.total}</Text></View>;
}

/** Dashed ring + completed-share pie match TodoProgressMark, not a guessed percentage. */
function NativeTaskProgress(props: { summary: TasksSummary; active: boolean }) {
  const ring = () => svg('<circle cx="8" cy="8" r="6.5" stroke-width="1.2" pathLength="24" stroke-dasharray="1 1"/>', String(token('foreground')));
  const pie = () => {
    const fraction = props.summary.total ? Math.min(1, props.summary.completed / props.summary.total) : 0;
    if (fraction >= 1) return svg('<circle cx="8" cy="8" r="3.2" fill="currentColor"/>'.replace('currentColor', String(token('foreground'))), String(token('foreground')));
    const angle = 2 * Math.PI * fraction;
    return svg(`<path d="M8 8 L8 4.8 A3.2 3.2 0 ${fraction > .5 ? 1 : 0} 1 ${(8 + 3.2 * Math.sin(angle)).toFixed(3)} ${(8 - 3.2 * Math.cos(angle)).toFixed(3)} Z" fill="${token('foreground')}" stroke="none"/>`, String(token('foreground')));
  };
  return <View style={{ width: 16, height: 16 }}>
    <Image src={ring()} style={{ width: 16, height: 16, animationName: props.active && lifecycle() === 'active' && props.summary.spinning && !reduceMotion() ? 'spin' : 'none', animationDuration: 2400, animationTimingFunction: 'linear', animationIterationCount: 'infinite' }} />
    <If when={props.summary.completed > 0}><Image src={pie()} style={{ width: 16, height: 16, position: 'absolute', top: 0, left: 0 }} /></If>
  </View>;
}

/** Controlled phone overlay: parent shares its owner with Changes; closed means zero list rows. */
export function NativeComposerTasks(props: { todos: readonly NativeTask[]; liveWorking: boolean; active: boolean; expanded: boolean; onExpandedChange: (open: boolean) => void }) {
  const summary = computed(() => summarizeTasks(props.todos, props.liveWorking));
  const anchor = signal<ViewRef | null>(null);
  return <If when={summary().show}>
    <View ref={ref => anchor.set(ref)} accessibilityState={{ expanded: props.expanded }}><Button testID="composer-tasks" class="min-h-6 px-3 flex-row items-center gap-1" accessibilityLabel={t('chat.statusRow.summary.activeLeft', { active: summary().active, left: summary().left })} onPress={() => { if (props.active) props.onExpandedChange(!props.expanded); }}>
      <NativeTaskProgress summary={summary()} active={props.active} /><Text class="text-xs text-muted-foreground">{t('chat.statusRow.tasksTitle')}</Text><Text class="text-xs text-muted-foreground">{summary().completed}/{summary().total}</Text><Icon name={props.expanded ? 'arrow-up-s' : 'arrow-down-s'} size={12} />
    </Button></View>
    <If when={props.expanded && props.active && !!anchor()}><Overlay anchor={anchor()} placement="top" align="end" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={() => props.onExpandedChange(false)} onCancel={() => props.onExpandedChange(false)} testID="composer-tasks-popover" class="bg-card rounded-2xl border border-border/30 p-2 gap-2">
      <View class="px-1 flex-row items-center gap-2"><NativeTaskProgress summary={summary()} active={props.active} /><Text class="flex-1 text-xs text-foreground">{t('chat.workStatus.todos.title')}</Text><NativeTaskCount completed={summary().completed} total={summary().total} /></View>
      <NativeTaskList summary={summary()} />
    </Overlay></If>
  </If>;
}

function NativeTaskList(props: { summary: TasksSummary }) {
  const rows = computed(() => props.summary.rows());
  let list: ListRef | undefined, centered = false;
  function center() {
    if (centered || !list || props.summary.activeIndex < 0) return;
    centered = true;
    list.scrollToIndex({ index: props.summary.activeIndex, animated: false, viewPosition: .5 });
  }
  return <List testID="composer-tasks-list" ref={ref => { list = ref; }} onLayout={center} each={rows()} keyExtractor={row => row.key} style={{ maxHeight: Math.min(352, windowSize().height * .5), height: Math.min(rows().length * 48, 352, windowSize().height * .5) }}>
    {row => <NativeTaskRow row={row()} />}
  </List>;
}

function NativeTaskRow(props: { row: ReturnType<TasksSummary['rows']>[number] }) {
  const motion = createMotion({ enter: { keyframes: [{ translateY: -4, opacity: 0 }, { translateY: 0, opacity: 1 }], duration: 240, easing: [0.22, 1, 0.36, 1] } });
  cleanup(motion.stop);
  return <View testID={`composer-task-${props.row.key}`} class="px-1 py-1 flex-row items-start gap-2" style={motion.style} accessibilityLabel={`${t(labels[props.row.status])}: ${props.row.todo.content}`} accessibilityState={{ selected: props.row.current }}>
    <View class="pt-0.5"><Each of={[props.row.status]} key={status => status}>{status => <NativeTaskGlyph status={status()} />}</Each></View><Text class={props.row.status === 'in_progress' ? 'flex-1 text-xs text-foreground' : props.row.status === 'completed' || props.row.status === 'cancelled' ? 'flex-1 text-xs text-muted-foreground line-through' : 'flex-1 text-xs text-muted-foreground'} style={{ numberOfLines: 3, opacity: props.row.status === 'completed' || props.row.status === 'cancelled' ? .6 : 1 }}>{props.row.todo.content}</Text>
  </View>;
}
