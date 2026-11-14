import { Scroll, Text, View, effect, signal, untracked, type JSX } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, actionMenu, alpha, confirm, fontSize } from '../core/ui';
import { showToast } from '../core/toast';
import { activeProjectId, projects } from '../core/store';
import { scheduledTaskRequest, tabBarInset, openAssistant } from '../shell/nav';
import {
  assistantCapability,
  assistantContacts,
  assistantLoading,
  assistantSnapshot,
  assistantTitle,
  loadAssistants,
} from '../assistant/data';
import { AssistantAvatar } from '../assistant/Avatar';
import { TaskCard } from './TaskCard';
import { TaskEditorSheet } from './TaskEditorSheet';
import { RunEmpty, RunRow } from './RunList';
import {
  deleteTask,
  loadRuns,
  loadTasks,
  runTaskNow,
  scheduledError,
  scheduledFailedProjects,
  scheduledLoading,
  scheduledMutating,
  scheduledRuns,
  scheduledRunsComplete,
  scheduledRunsError,
  scheduledRunsLoading,
  scheduledTasks,
  saveTask,
  toggleTask,
  taskKey,
  type ScheduledTask,
  type TaskEntry,
} from './data';

type Filter = 'all' | 'active' | 'paused';
type Screen = 'tasks' | 'history';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Web `yuri-mobile-assistant-state-card`: one dashed card for load errors and empties. */
function DashedCard(props: { children?: JSX.Element }) {
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.border(),
        padding: 16,
        gap: 8,
      }}
    >
      {props.children}
    </View>
  );
}

/** The schedule tab: task cards with enable/run/edit, and the run history. */
export function ScheduledPage() {
  const view = signal<Screen>('tasks');
  const filter = signal<Filter>('all');
  const historyTask = signal<TaskEntry | null>(null);
  const editing = signal<TaskEntry | null>(null);
  const editorOpen = signal(false);
  let runsRequested = false;

  loadTasks();
  if (!assistantCapability() && !assistantLoading()) void loadAssistants();

  const preferredProjectID = () => activeProjectId() || projects()[0]?.id || '';

  // A bot's scheduled-task row asks this tab to open one task's editor.
  effect(() => {
    const request = scheduledTaskRequest();
    const tasks = scheduledTasks();
    if (!request || tasks.length === 0) return;
    untracked(() => {
      const entry = tasks.find((row) => row.projectId === request.projectId && row.task.id === request.taskId);
      scheduledTaskRequest.set(null);
      if (!entry) return;
      view.set('tasks');
      editing.set(entry);
      editorOpen.set(true);
    });
  });

  const filtered = () =>
    scheduledTasks().filter((entry) => {
      if (filter() === 'active') return entry.task.enabled;
      if (filter() === 'paused') return !entry.task.enabled;
      return true;
    });

  const closeEditor = () => {
    editorOpen.set(false);
    editing.set(null);
  };

  const create = () => {
    if (!preferredProjectID()) {
      showToast({ message: t('sessions.scheduledTasks.dialog.empty.selectProject') });
      return;
    }
    editing.set(null);
    editorOpen.set(true);
  };

  const edit = (entry: TaskEntry) => {
    editing.set(entry);
    editorOpen.set(true);
  };

  const save = async (draft: ScheduledTask) => {
    const projectId = editing()?.projectId || preferredProjectID();
    if (!projectId) throw new Error(t('sessions.scheduledTasks.dialog.error.chooseProjectFirst'));
    const before = new Set(scheduledTasks().filter((entry) => entry.projectId === projectId).map((entry) => entry.task.id));
    const tasks = await saveTask(projectId, draft);
    const saved = draft.id ? tasks.find((task) => task.id === draft.id) : tasks.find((task) => !before.has(task.id));
    closeEditor();
    if (saved) editing.set({ projectId, task: saved });
    await loadTasks(true);
  };

  const remove = async (entry: TaskEntry) => {
    const confirmed = await confirm({
      title: t('sessions.scheduledTasks.dialog.actions.delete'),
      message: t('sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: entry.task.name }),
      confirmLabel: t('sessions.scheduledTasks.dialog.actions.delete'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deleteTask(entry.projectId, entry.task.id);
    } catch {
      showToast({ message: t('sessions.scheduledTasks.dialog.toast.deleteFailed') });
    }
  };

  const openRuns = (entry: TaskEntry) => {
    historyTask.set(entry);
    if (view() !== 'history') {
      view.set('history');
      runsRequested = true;
      void loadRuns({ projectId: entry.projectId, taskId: entry.task.id }, true);
    } else {
      void loadRuns({ projectId: entry.projectId, taskId: entry.task.id }, true);
    }
  };

  const runNow = async (entry: TaskEntry) => {
    try {
      await runTaskNow(entry);
    } catch {
      showToast({ message: t('sessions.scheduledTasks.dialog.toast.runFailed') });
    }
  };

  const toggle = async (entry: TaskEntry) => {
    try {
      await toggleTask(entry);
    } catch {
      showToast({ message: t('sessions.scheduledTasks.dialog.toast.updateFailed') });
    }
  };

  const openMenu = async (entry: TaskEntry) => {
    const action = await actionMenuFor(entry);
    if (action === 'run') void runNow(entry);
    if (action === 'history') openRuns(entry);
    if (action === 'toggle') void toggle(entry);
    if (action === 'edit') edit(entry);
    if (action === 'delete') void remove(entry);
  };

  const switchView = (next: Screen) => {
    if (view() === next) return;
    view.set(next);
    if (next === 'history' && !runsRequested) {
      runsRequested = true;
      void loadRuns({}, true);
    }
  };

  const clearHistoryFilter = () => {
    historyTask.set(null);
    void loadRuns({}, true);
  };

  const loadMore = () => {
    if (scheduledRunsLoading() || scheduledRunsComplete() || scheduledRunsError()) return;
    void loadRuns(historyTask() ? { projectId: historyTask()!.projectId, taskId: historyTask()!.task.id } : {});
  };

  const trackStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 4,
    borderRadius: 24,
    minHeight: 48,
    backgroundColor: alpha(colors.card(), 0.88),
    backdropFilter: 'blur(22px) saturate(1.35)',
    boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.12)',
  } as const;

  const segment = (selected: boolean) =>
    ({
      flex: 1,
      minWidth: 0,
      height: 40,
      borderRadius: 20,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 8,
      backgroundColor: selected ? colors.background() : 'transparent',
    }) as const;

  const assistant = () => {
    if (assistantCapability()?.supported !== true || assistantCapability()?.enabled === false) return null;
    if (assistantSnapshot()?.enabled !== true) return null;
    const contacts = assistantContacts();
    return contacts.pinned[0] ?? contacts.unpinned[0] ?? null;
  };

  const assistantName = () => {
    const entry = assistant();
    return entry ? assistantTitle(entry) : '';
  };

  const headerRight = (
    <If when={!!assistant()}>
      <Button
        testID="schedule-assistant"
        onPress={() => {
          const entry = assistant();
          if (entry) openAssistant({ assistantID: entry.id, title: assistantTitle(entry) });
        }}
        accessibilityLabel={t('sessions.scheduledTasks.assistant.openAria', { name: assistantName() })}
        style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
      >
        <AssistantAvatar seed={assistant()?.avatarSeed ?? assistant()?.id} size={40} label={assistantName()} />
      </Button>
    </If>
  );

  return (
    <NavPage
      title={t('sessions.scheduledTasks.dialog.title')}
      headerLargeTitle
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={headerRight}
    >
      <Scroll
        class="flex-1"
        contentStyle={{ paddingBottom: tabBarInset() + 28 }}
        onScroll={(event) => {
          if (view() !== 'history') return;
          const remaining = event.contentSize.height - (event.offset.y + event.size.height);
          if (remaining < 240) loadMore();
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: space.pageGap,
          }}
        >
          <View role="tablist" accessibilityLabel={t('sessions.scheduledTasks.workspace.views.aria')} style={trackStyle}>
            <Each of={['tasks', 'history'] as Screen[]} key="index">
              {(entry) => (
                <Button
                  onPress={() => switchView(entry())}
                  style={segment(view() === entry())}
                  accessibilityLabel={t(
                    entry() === 'tasks'
                      ? 'sessions.scheduledTasks.workspace.views.tasks'
                      : 'sessions.scheduledTasks.workspace.views.history',
                  )}
                >
                  <Icon name={entry() === 'tasks' ? 'calendar-schedule' : 'history'} size={16} />
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: '500',
                      color: view() === entry() ? colors.foreground() : colors.mutedForeground(),
                    }}
                  >
                    {t(
                      entry() === 'tasks'
                        ? 'sessions.scheduledTasks.workspace.views.tasks'
                        : 'sessions.scheduledTasks.workspace.views.history',
                    )}
                  </Text>
                </Button>
              )}
            </Each>
          </View>

          <If when={view() === 'tasks'}>
            <View style={{ gap: space.pageGap }}>
              <View style={trackStyle}>
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Each of={['all', 'active', 'paused'] as Filter[]} key="index">
                    {(entry) => (
                      <Button
                        onPress={() => filter.set(entry())}
                        style={segment(filter() === entry())}
                        accessibilityLabel={t(
                          entry() === 'all'
                            ? 'sessions.scheduledTasks.workspace.filters.all'
                            : entry() === 'active'
                              ? 'sessions.scheduledTasks.workspace.filters.active'
                              : 'sessions.scheduledTasks.workspace.filters.paused',
                        )}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: '500',
                            color: filter() === entry() ? colors.foreground() : colors.mutedForeground(),
                          }}
                        >
                          {t(
                            entry() === 'all'
                              ? 'sessions.scheduledTasks.workspace.filters.all'
                              : entry() === 'active'
                                ? 'sessions.scheduledTasks.workspace.filters.active'
                                : 'sessions.scheduledTasks.workspace.filters.paused',
                          )}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
                <Button
                  testID="schedule-create"
                  onPress={create}
                  accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.create')}
                  disabled={!preferredProjectID()}
                  style={{
                    width: 40,
                    height: 40,
                    minWidth: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="add" size={20} />
                </Button>
              </View>

              <If when={scheduledFailedProjects().length > 0}>
                <View
                  style={{
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.border(),
                    padding: 12,
                  }}
                >
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {t('sessions.scheduledTasks.workspace.partialLoadWarning')}
                  </Text>
                </View>
              </If>

              <If when={scheduledLoading() && scheduledTasks().length === 0}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 12 }}>
                  <Icon name="loader-4" size={16} tone="muted" />
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {t('sessions.scheduledTasks.dialog.loading')}
                  </Text>
                </View>
              </If>

              <If when={!scheduledLoading() && !!scheduledError() && scheduledTasks().length === 0}>
                <DashedCard>
                  <Text style={{ fontSize: fontSize.entityMeta, lineHeight: 18, color: colors.mutedForeground() }}>
                    {scheduledError()}
                  </Text>
                  <QuietButton label={() => t('sessions.scheduledTasks.history.retry')} onPress={() => void loadTasks(true)} />
                </DashedCard>
              </If>

              <If when={!scheduledLoading() && filtered().length === 0 && !scheduledError()}>
                <DashedCard>
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {scheduledTasks().length > 0
                      ? t('sessions.scheduledTasks.workspace.search.noResults')
                      : t('sessions.scheduledTasks.dialog.empty.noTasks')}
                  </Text>
                </DashedCard>
              </If>

              <View style={{ gap: 16 }}>
                <Each of={filtered()} key={(entry) => taskKey(entry.projectId, entry.task.id)}>
                  {(entry) => (
                    <TaskCard
                      entry={entry}
                      busy={() => scheduledMutating() === taskKey(entry().projectId, entry().task.id)}
                      onOpen={() => edit(entry())}
                      onHistory={() => openRuns(entry())}
                      onMore={() => void openMenu(entry())}
                    />
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={view() === 'history'}>
            <View style={{ gap: 12 }}>
              <If when={!!historyTask()}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      maxWidth: '100%',
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: colors.border(),
                      backgroundColor: alpha(colors.muted(), 0.9),
                      paddingLeft: 12,
                      paddingRight: 4,
                      paddingVertical: 4,
                    }}
                  >
                    <Text style={{ fontSize: fontSize.entityMeta, color: colors.foreground(), numberOfLines: 1 }}>
                      {historyTask()?.task.name ?? ''}
                    </Text>
                    <Button
                      testID="history-clear-filter"
                      onPress={clearHistoryFilter}
                      accessibilityLabel={t('sessions.scheduledTasks.history.filter.clearAria')}
                      style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="close" size={14} tone="muted" />
                    </Button>
                  </View>
                </View>
              </If>

              <If when={scheduledRunsLoading() && scheduledRuns().length === 0}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 12 }}>
                  <Icon name="loader-4" size={16} tone="muted" />
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {t('sessions.scheduledTasks.history.loading')}
                  </Text>
                </View>
              </If>

              <If when={!!scheduledRunsError() && scheduledRuns().length === 0}>
                <DashedCard>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    <Icon name="error-warning" size={16} color={() => colors.destructive()} />
                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                      <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground() }}>
                        {t('sessions.scheduledTasks.history.error.title')}
                      </Text>
                      <Text style={{ fontSize: fontSize.entityMeta, lineHeight: 18, color: colors.mutedForeground() }}>
                        {scheduledRunsError()}
                      </Text>
                    </View>
                    <QuietButton
                      label={() => t('sessions.scheduledTasks.history.retry')}
                      onPress={() => void loadRuns(historyTask() ? { projectId: historyTask()!.projectId, taskId: historyTask()!.task.id } : {}, true)}
                    />
                  </View>
                </DashedCard>
              </If>

              <If when={!scheduledRunsLoading() && scheduledRuns().length === 0 && !scheduledRunsError()}>
                <RunEmpty
                  title={t('sessions.scheduledTasks.history.empty.title')}
                  description={t('sessions.scheduledTasks.history.empty.description')}
                />
              </If>

              <View style={{ gap: 16 }}>
                <Each of={scheduledRuns()} key={(run) => run.id}>
                  {(run) => <RunRow run={run} />}
                </Each>
              </View>

              <If when={!!scheduledRunsError() && scheduledRuns().length > 0}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    borderRadius: 12,
                    padding: 12,
                    backgroundColor: alpha(colors.destructive(), 0.08),
                  }}
                >
                  <Text style={{ flex: 1, fontSize: fontSize.entityMeta, color: colors.destructive() }}>
                    {t('sessions.scheduledTasks.history.error.more')}
                  </Text>
                  <QuietButton
                    label={() => t('sessions.scheduledTasks.history.retry')}
                    onPress={() => void loadRuns(historyTask() ? { projectId: historyTask()!.projectId, taskId: historyTask()!.task.id } : {})}
                  />
                </View>
              </If>

              <If when={scheduledRunsLoading() && scheduledRuns().length > 0}>
                <View style={{ paddingVertical: 4, alignItems: 'center' }}>
                  <Icon name="loader-4" size={16} tone="muted" />
                </View>
              </If>
            </View>
          </If>
        </View>
      </Scroll>

      <If when={editorOpen()}>
        <TaskEditorSheet
          entry={editing}
          onClose={closeEditor}
          onSave={save}
          onHistory={() => {
            const target = editing();
            closeEditor();
            if (target) openRuns(target);
          }}
          onDelete={() => {
            const target = editing();
            if (!target) return;
            closeEditor();
            void remove(target);
          }}
        />
      </If>
    </NavPage>
  );
}

/** Web `TaskCard` menu order: run, history, pause/resume, edit, delete. */
async function actionMenuFor(entry: TaskEntry): Promise<string | null> {
  return actionMenu({
    title: entry.task.name,
    actions: [
      { id: 'run', label: t('sessions.scheduledTasks.dialog.actions.runNow') },
      { id: 'history', label: t('sessions.scheduledTasks.workspace.views.history') },
      {
        id: 'toggle',
        label: entry.task.enabled
          ? t('sessions.scheduledTasks.dialog.actions.pause')
          : t('sessions.scheduledTasks.dialog.actions.resume'),
      },
      { id: 'edit', label: t('sessions.scheduledTasks.dialog.actions.edit') },
      { id: 'delete', label: t('sessions.scheduledTasks.dialog.actions.delete'), destructive: true },
    ],
  });
}
