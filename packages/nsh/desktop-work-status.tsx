import { cleanup, colorScheme, computed, createMotion, effect, Image, lifecycle, List, Overlay, reduceMotion, Scroll, signal, Text, token, untracked, View, type Bounds, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { NativeAgentAvatar } from './chat-identity';
import { t } from './i18n';
import type { PageOperation } from './page-operations';
import { createDesktopWorkStatusProjection, createDesktopWorkStatusWindowOwner, desktopWorkStatusGeometry as geometry, type DesktopWorkStatusScope, type DesktopWorkStatusChildRead } from './desktop-work-status-core';

export function createNativeDesktopWorkStatusWindowOwner() {
  const revision = signal(0);
  const owner = createDesktopWorkStatusWindowOwner(() => revision.set(revision() + 1));
  return { ...owner, state: computed(() => { revision(); return owner.state(); }) };
}

export type DesktopWorkStatusAdmission = {
  scope: DesktopWorkStatusScope; current: () => boolean; active: () => boolean; interactive: () => boolean;
  operation: () => PageOperation | null;
};
export function createNativeDesktopWorkStatusOwner(options: DesktopWorkStatusAdmission) {
  const revision = signal(0);
  const projection = createDesktopWorkStatusProjection({ scope: options.scope, current: options.current, changed: () => revision.set(untracked(revision) + 1) });
  const state = computed(() => { revision(); return projection.state(); });
  const todosExpanded = signal(true), agentsExpanded = signal(false);
  let assigned = untracked(options.operation);
  const admitted = () => projection.current() && options.active() && options.interactive() && lifecycle() === 'active';
  const capture = () => {
    const operation = options.operation();
    return admitted() && operation?.current() && operation.scope?.hostID === projection.scope.host.hostID && operation.scope?.lease === projection.scope.host.lease ? operation : null;
  };
  effect(() => {
    const operation = options.operation(), active = options.active(), foreground = lifecycle() === 'active', current = options.current(), laneCurrent = operation?.current();
    if (operation !== assigned || !active || !foreground || !current || !laneCurrent) untracked(() => { assigned = operation; projection.retireLane(); });
  });
  cleanup(projection.dispose);
  return { projection, state, todosExpanded, agentsExpanded, admitted,
    readChildren(read: DesktopWorkStatusChildRead) { const operation = capture(); return operation ? projection.readChildren(operation, read) : Promise.resolve(); },
    capture,
  };
}
export type NativeDesktopWorkStatusOwner = ReturnType<typeof createNativeDesktopWorkStatusOwner>;
export type NativeDesktopWorkStatusActions = {
  copyText: (text: string, scope: DesktopWorkStatusScope) => Promise<void>;
  openGit: (scope: DesktopWorkStatusScope) => void;
  openChild: (target: { scope: DesktopWorkStatusScope; sessionID: string; label: string; readOnly: true }) => void;
  onError: (key: 'gitView.toast.copyFailed') => void;
};

const rowClass = 'w-full min-w-0 flex-row items-center gap-2 px-2';
const actionClass = rowClass + ' rounded-md hover:bg-secondary active:bg-accent focus:bg-secondary disabled:opacity-50';
const textClass = 'text-muted-foreground';
const rowText = { fontSize: 13, lineHeight: 20, numberOfLines: 1 as const };

export type NativeDesktopWorkStatusToggleProps = { selected: boolean; current: () => boolean; active: boolean; interactive: boolean; fits: boolean; owner: ReturnType<typeof createNativeDesktopWorkStatusWindowOwner> };
export function NativeDesktopWorkStatusToggle(props: NativeDesktopWorkStatusToggleProps) {
  return <Button testID="desktop-work-status-toggle" accessibilityLabel={t('header.workStatusPanel.toggleAria')} selected={props.selected}
    disabled={!props.current() || !props.active || !props.interactive || lifecycle() !== 'active'}
    class={'size-7 rounded-md items-center justify-center hover:bg-secondary focus:bg-secondary' + (props.selected ? ' bg-accent' : '')}
    onPress={() => { if (props.current() && props.active && props.interactive && lifecycle() === 'active') props.owner.toggle(props.fits); }}><Icon name="settings-2" size={16} /></Button>;
}

/** Inline is an absolute transparent Chat child, popup is a root-native Overlay. Neither changes the scroller width. */
export type NativeDesktopWorkStatusPanelProps = {
  owner: NativeDesktopWorkStatusOwner; actions: NativeDesktopWorkStatusActions;
  visible: boolean; overlay: boolean; chatBounds: Bounds;
  /** Header's real toggle bounds: outside pointer-down must not double-toggle. */
  toggleBounds?: Bounds; onCloseOverlay: () => void; reducedTransparency?: boolean;
};
export function NativeDesktopWorkStatusPanel(props: NativeDesktopWorkStatusPanelProps) {
  const current = () => props.owner.projection.current();
  const present = signal(props.visible && props.overlay), motion = createMotion();
  let hide: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const open = props.visible && props.overlay, reduced = reduceMotion();
    untracked(() => {
      if (hide) clearTimeout(hide);
      if (!open && !present()) return;
      if (open) present.set(true);
      void motion.play({ keyframes: open ? [{ opacity: 0, translateY: -6 }, { opacity: 1, translateY: 0 }] : [{ opacity: 1, translateY: 0 }, { opacity: 0, translateY: -6 }], duration: reduced ? 0 : 200 });
      if (!open) { if (reduced) present.set(false); else hide = setTimeout(() => present.set(false), 200); }
    });
  });
  cleanup(() => { motion.stop(); if (hide) clearTimeout(hide); });
  const height = (overlay: boolean) => Math.max(0, props.chatBounds.size.height - (overlay ? 24 : 16));
  const contains = (point: { x: number; y: number }, bounds?: Bounds) => !!bounds && point.x >= bounds.origin.x && point.y >= bounds.origin.y && point.x <= bounds.origin.x + bounds.size.width && point.y <= bounds.origin.y + bounds.size.height;
  return <If when={current()}>
    <If when={props.visible && !props.overlay}><View testID="desktop-work-status-inline" accessibilityLabel={t('chat.workStatus.ariaLabel')} class="absolute" style={{ right: geometry.scrollbarLane, top: geometry.inlineTop, width: geometry.inlineWidth, maxHeight: height(false) }}>
      <Scroll testID="desktop-work-status-scroll" style={{ maxHeight: height(false) }}><NativeDesktopWorkStatusCompact owner={props.owner} actions={props.actions} /></Scroll>
    </View></If>
    <If when={present() && !(props.visible && !props.overlay)}>
      <Overlay testID="desktop-work-status-overlay" accessibilityLabel={t('chat.workStatus.ariaLabel')} disabled={!props.visible}
        style={[{ left: props.chatBounds.origin.x + props.chatBounds.size.width - geometry.scrollbarLane - geometry.overlayWidth, top: props.chatBounds.origin.y + geometry.overlayTop, width: geometry.overlayWidth, maxHeight: height(true), padding: geometry.overlayPadding,
          backdropFilter: props.reducedTransparency ? undefined : `blur(20px) saturate(${colorScheme() === 'dark' ? 1.2 : 1.25})`,
          boxShadow: colorScheme() === 'dark' ? '0 2px 4px -1px rgb(0 0 0 / 0.18), 0 8px 20px -6px rgb(0 0 0 / 0.28)' : '0 2px 4px -1px rgb(0 0 0 / 0.06), 0 8px 20px -6px rgb(0 0 0 / 0.12)' }, motion.style]}
        class={'rounded-xl border ' + (colorScheme() === 'dark' ? 'border-foreground/16 ' : 'border-foreground/12 ') + (props.reducedTransparency ? 'bg-popover' : 'bg-popover/50')}
        onPressOutside={event => { if (props.visible && props.owner.admitted() && !contains(event.pagePosition, props.toggleBounds)) props.onCloseOverlay(); }} onCancel={() => { if (props.visible && props.owner.admitted()) props.onCloseOverlay(); }}>
        <Scroll testID="desktop-work-status-scroll" style={{ maxHeight: Math.max(0, height(true) - 16) }}><NativeDesktopWorkStatusCompact owner={props.owner} actions={props.actions} /></Scroll>
      </Overlay>
    </If>
  </If>;
}

export function NativeDesktopWorkStatusCompact(props: { owner: NativeDesktopWorkStatusOwner; actions: NativeDesktopWorkStatusActions }) {
  const state = props.owner.state;
  const canAct = () => props.owner.capture() !== null;
  const location = () => state().location;
  const git = () => location().secondaryWorktree?.pending ? undefined : location().git.value;
  const hasDiff = () => git()?.additions != null && git()?.deletions != null && ((git()?.additions ?? 0) > 0 || (git()?.deletions ?? 0) > 0);
  const copied = signal<string | null>(null);
  let alive = true;
  let feedback: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => { alive = false; if (feedback) clearTimeout(feedback); });
  async function copy(key: string, value: string) {
    const operation = props.owner.capture(); if (!operation) return;
    try {
      await props.actions.copyText(value, props.owner.projection.scope);
      if (!alive || !props.owner.admitted() || !operation.current()) return;
      copied.set(key); if (feedback) clearTimeout(feedback);
      feedback = setTimeout(() => copied.set(null), 1500);
    } catch { if (alive && props.owner.admitted() && operation.current()) props.actions.onError('gitView.toast.copyFailed'); }
  }
  const agents = computed(() => state().agents);
  const working = computed(() => agents().filter(agent => agent.phase === 'working'));
  const faces = computed(() => (working().length ? working() : agents()).slice(0, 3));
  const groups = computed(() => (['working', 'done', 'unknown'] as const).map(phase => ({ phase, items: agents().filter(agent => agent.phase === phase) })).filter(group => group.items.length));
  const groupLabel = (phase: 'working' | 'done' | 'unknown', count: number) => phase === 'unknown' ? t('common.unavailable') : t(phase === 'working' ? 'chat.workStatus.subagent.workingCount' : 'chat.workStatus.subagent.doneCount', { count });
  return <View testID="desktop-work-status-compact" class="min-w-0 gap-0.5">
    <If when={!!location().project}><View testID="desktop-work-status-project" class={rowClass} style={{ height: 32 }} tooltip={`${t('chat.workStatus.section.project')}: ${location().project?.path}`} accessibilityLabel={`${t('chat.workStatus.section.project')}: ${location().project?.path}`}><Icon name="folder" size={14} /><Text class={'flex-1 ' + textClass} style={rowText}>{location().project?.label}</Text></View></If>
    <If when={!!git()?.branch}><View testID="desktop-work-status-branch" class={rowClass + ' group'} style={{ height: 32 }} tooltip={`${t('gitView.branch.currentBranchTooltip')}: ${git()?.branch}`} accessibilityLabel={`${t('gitView.branch.currentBranchTooltip')}: ${git()?.branch}`}>
      <Icon name="git-branch" size={14} /><Text class={'flex-1 ' + textClass} style={rowText}>{git()?.branch}</Text>
      <Button testID="desktop-work-status-copy-branch" class="size-5 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" disabled={!canAct()} tooltip={t(copied() === `branch:${git()?.branch}` ? 'contextSidebar.actions.copied' : 'chat.workStatus.action.copyBranch')} accessibilityLabel={t('chat.workStatus.action.copyBranch')} onPress={() => { const branch = git()?.branch; if (branch) void copy(`branch:${branch}`, branch); }}><Icon name={copied() === `branch:${git()?.branch}` ? 'check' : 'file-copy'} size={14} /></Button>
    </View></If>
    <If when={!!location().secondaryWorktree}><View testID="desktop-work-status-worktree" class={rowClass + ' group'} style={{ height: 32 }} tooltip={`${t('sessions.sidebar.sessionDialogs.worktree.label')}: ${location().secondaryWorktree?.path}`} accessibilityLabel={`${t('sessions.sidebar.sessionDialogs.worktree.label')}: ${location().secondaryWorktree?.path}`}>
      <Icon name="node-tree" size={14} /><Text class={'flex-1 ' + textClass} style={rowText}>{location().secondaryWorktree?.label}</Text>
      <Button testID="desktop-work-status-copy-worktree" class="size-5 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" disabled={!canAct()} tooltip={t(copied() === `path:${location().secondaryWorktree?.path}` ? 'contextSidebar.actions.copied' : 'agentManager.detail.actions.copyWorktreePath')} accessibilityLabel={t('agentManager.detail.actions.copyWorktreePath')} onPress={() => { const path = location().secondaryWorktree?.path; if (path) void copy(`path:${path}`, path); }}><Icon name={copied() === `path:${location().secondaryWorktree?.path}` ? 'check' : 'file-copy'} size={14} /></Button>
    </View></If>
    <If when={(git()?.changedFiles ?? 0) > 0}><Button testID="desktop-work-status-changes" class={actionClass} style={{ height: 32 }} tooltip={t(git()?.changedFiles === 1 ? 'chat.workStatus.git.changedFileSingle' : 'chat.workStatus.git.changedFilePlural', { count: git()?.changedFiles ?? 0 })} accessibilityLabel={t('chat.workStatus.action.openGit')} disabled={!canAct()} onPress={() => { if (props.owner.capture()) props.actions.openGit(props.owner.projection.scope); }}>
      <Icon name="changes" size={14} /><Text class={'flex-1 ' + textClass} style={rowText}>{t('chat.workStatus.compact.changes')}</Text>
      <If when={hasDiff()} else={<Text class={textClass} style={rowText}>{git()?.changedFiles}</Text>}><Text style={{ fontSize: 12, color: token('success') }}>+{git()?.additions}</Text><Text class="text-destructive" style={{ fontSize: 12 }}>−{git()?.deletions}</Text></If>
    </Button></If>
    <NativeDesktopWorkStatusTodos owner={props.owner} />
    <If when={agents().length > 0}><View accessibilityLabel={t('chat.workStatus.section.subagents')}>
      <View accessibilityState={{ expanded: props.owner.agentsExpanded() }}><Button testID="desktop-work-status-subagents" class={actionClass} style={{ height: 32 }} disabled={!canAct()} onPress={() => { if (props.owner.capture()) props.owner.agentsExpanded.set(!props.owner.agentsExpanded()); }}>
        <View class="flex-row"><Each of={faces()} key={agent => agent.key}>{(agent, index) => <View testID={`desktop-work-status-face-${agent().key}`} class="bg-background rounded-sm" style={{ marginLeft: index() > 0 ? -4 : 0 }}><NativeAgentAvatar name={agent().seed} size={14} /></View>}</Each></View>
        <Text class={'flex-1 ' + textClass} style={{ fontSize: 11, numberOfLines: 1 }}>{groups().map(group => groupLabel(group.phase, group.items.length)).join(' · ')}</Text><Icon name={props.owner.agentsExpanded() ? 'arrow-down-s' : 'arrow-right-s'} size={14} />
      </Button></View>
      <If when={props.owner.agentsExpanded()}><Each of={groups()} key={group => group.phase}>{group => <View class="gap-1">
        <Text class="px-2 py-1 text-muted-foreground" style={{ fontSize: 11 }}>{groupLabel(group().phase, group().items.length)}</Text>
        <List testID={`desktop-work-status-agents-${group().phase}`} viewport="parent" each={group().items} keyExtractor={agent => agent.key} estimatedItemSize={32}>{agent => <Button testID={`desktop-work-status-agent-${agent().key}`} class={actionClass} style={{ height: 32 }} tooltip={agent().label || t('chat.workStatus.subagent.untitled')} disabled={!canAct() || !agent().sessionID || !props.owner.projection.scope.directory} onPress={() => {
          if (!props.owner.capture() || !agent().sessionID || !props.owner.projection.scope.directory) return;
          props.actions.openChild({ scope: props.owner.projection.scope, sessionID: agent().sessionID!, label: agent().label || t('chat.workStatus.subagent.untitled'), readOnly: true });
        }}><NativeAgentAvatar name={agent().seed} size={14} /><Text class={'flex-1 ' + textClass} style={{ fontSize: 12, numberOfLines: 1 }}>{agent().label || t('chat.workStatus.subagent.untitled')}</Text></Button>}</List>
      </View>}</Each></If>
    </View></If>
  </View>;
}

const statusLabel = { pending: 'chat.statusRow.todo.status.pending', in_progress: 'chat.statusRow.todo.status.inProgress', completed: 'chat.statusRow.todo.status.completed', cancelled: 'chat.statusRow.todo.status.cancelled' } as const;
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${token('foreground')}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)}`;
function TaskGlyph(props: { status: keyof typeof statusLabel }) {
  const motion = createMotion(); cleanup(motion.stop);
  effect(() => { const status = props.status; if (!reduceMotion()) untracked(() => { void motion.play({ keyframes: [{ scale: .72, opacity: .6 }, { scale: 1, opacity: 1 }], duration: 240 }); }); });
  return <View style={motion.style}><Image accessibilityLabel={t(statusLabel[props.status])} style={{ width: 14, height: 14 }} src={svg(props.status === 'pending' ? '<circle cx="8" cy="8" r="6.5" stroke-width="1.2" pathLength="24" stroke-dasharray="1 1"/>' : `<circle cx="8" cy="8" r="6.5"/>${props.status === 'completed' ? '<path d="M5 8 7.5 11 11 5.5"/>' : props.status === 'cancelled' ? '<path d="M3.5 12.5 12.5 3.5"/>' : '<path d="M4.8 8h6.4M8.6 5.4 11.2 8l-2.6 2.6"/>'}`)} /></View>;
}
function TaskCount(props: { completed: number; total: number }) {
  const motion = createMotion(); let previous = props.completed;
  effect(() => {
    const completed = props.completed;
    if (completed !== previous && !reduceMotion()) untracked(() => { void motion.play({ keyframes: [{ translateY: 5.4, opacity: 0 }, { translateY: 0, opacity: 1 }], duration: 240, easing: [0.22, 1, 0.36, 1] }); });
    previous = completed;
  });
  cleanup(motion.stop);
  return <View testID="desktop-work-status-todo-count" class="flex-row"><View style={motion.style}><Text class={textClass} style={{ fontSize: 12 }}>{props.completed}</Text></View><Text class={textClass} style={{ fontSize: 12 }}>/{props.total}</Text></View>;
}
export function NativeDesktopWorkStatusTodos(props: { owner: NativeDesktopWorkStatusOwner }) {
  const summary = () => props.owner.state().todos;
  let list: ListRef | undefined;
  const revealProgress = () => { const index = summary().inProgressIndex; if (props.owner.todosExpanded() && index >= 0) list?.scrollToIndex({ index, animated: false, viewPosition: .5 }); };
  effect(() => { summary().inProgressIndex; props.owner.todosExpanded(); untracked(revealProgress); });
  return <If when={summary().total > 0}><View class="mt-2 min-w-0" accessibilityLabel={t('chat.workStatus.todos.title')}>
    <View accessibilityState={{ expanded: props.owner.todosExpanded() }}><Button testID="desktop-work-status-todos" class={actionClass} style={{ height: 32 }} disabled={!props.owner.capture()} onPress={() => { if (props.owner.capture()) props.owner.todosExpanded.set(!props.owner.todosExpanded()); }}>
      <If when={summary().allDone} else={<View style={{ width: 14, height: 14 }}>
        <Image testID="desktop-work-status-todo-ring" src={svg('<circle cx="8" cy="8" r="6.5" stroke-width="1.2" pathLength="24" stroke-dasharray="1 1"/>')} style={{ width: 14, height: 14, animationName: summary().spinning && props.owner.admitted() && !reduceMotion() ? 'spin' : 'none', animationDuration: 2400, animationIterationCount: 'infinite', animationTimingFunction: 'linear' }} />
        <If when={summary().completed > 0}><Image src={svg(`<path d="M8 8L8 4.8A3.2 3.2 0 ${summary().completed / summary().total > .5 ? 1 : 0} 1 ${8 + 3.2 * Math.sin(2 * Math.PI * summary().completed / summary().total)} ${8 - 3.2 * Math.cos(2 * Math.PI * summary().completed / summary().total)}Z" fill="${token('foreground')}" stroke="none"/>`)} style={{ width: 14, height: 14, position: 'absolute', top: 0, left: 0 }} /></If>
      </View>}><View testID="desktop-work-status-todos-complete" class="rounded-full items-center justify-center" style={{ width: 15, height: 15, backgroundColor: token('success') }}><Icon name="check" size={11} color={String(token('background'))} /></View></If>
      <Text class="flex-1 text-foreground" style={rowText}>{t('chat.workStatus.todos.title')}</Text><TaskCount completed={summary().completed} total={summary().total} />
    </Button></View>
    <If when={props.owner.todosExpanded()}><List testID="desktop-work-status-todo-list" ref={ref => { list = ref; }} onLayout={revealProgress} each={summary().rows} keyExtractor={row => row.key} estimatedItemSize={40} style={{ height: Math.min(geometry.todoMaxHeight, summary().rows.length * 40), maxHeight: geometry.todoMaxHeight }}>{row => <View testID={`desktop-work-status-todo-${row().key}`} class={rowClass + ' py-1 items-start'} accessibilityLabel={`${t(statusLabel[row().status])}: ${row().task.content}`}>
      <TaskGlyph status={row().status} /><Text class={'flex-1 ' + (row().status === 'in_progress' ? 'text-foreground' : textClass) + (row().status === 'completed' || row().status === 'cancelled' ? ' line-through opacity-60' : '')} style={{ fontSize: 11.44, lineHeight: 17.16, numberOfLines: 3 }}>{row().task.content}</Text>
    </View>}</List></If>
  </View></If>;
}
