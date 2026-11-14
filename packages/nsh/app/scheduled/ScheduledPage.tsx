import { Scroll, Text, View, signal } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { PrimaryButton, QuietButton, Surface, actionMenu, alpha, confirm, fontSize } from '../core/ui';
import { activeProjectId, projects } from '../core/store';
import { openScheduledRuns, tabBarInset } from '../shell/nav';
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

/** The schedule tab: task cards with enable/run/edit, and the run history. */
export function ScheduledPage() {
  const view = signal<Screen>('tasks');
  const filter = signal<Filter>('all');
  const failure = signal('');
  const editing = signal<TaskEntry | null>(null);
  const editorOpen = signal(false);
  let runsRequested = false;

  loadTasks();

  const preferredProjectID = () => activeProjectId() || projects()[0]?.id || '';

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
      failure.set(t('sessions.scheduledTasks.dialog.empty.selectProject'));
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
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const openMenu = async (entry: TaskEntry) => {
    const action = await actionMenu({
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
    if (action === 'run') {
      try {
        await runTaskNow(entry);
      } catch (error) {
        failure.set(errorText(error));
      }
    }
    if (action === 'history') openRuns(entry);
    if (action === 'toggle') {
      try {
        await toggleTask(entry);
      } catch (error) {
        failure.set(errorText(error));
      }
    }
    if (action === 'edit') edit(entry);
    if (action === 'delete') void remove(entry);
  };

  const openRuns = (entry: TaskEntry) => {
    openScheduledRuns({ projectId: entry.projectId, taskId: entry.task.id, title: entry.task.name });
  };

  const switchView = (next: Screen) => {
    if (view() === next) return;
    view.set(next);
    if (next === 'history' && !runsRequested) {
      runsRequested = true;
      void loadRuns({}, true);
    }
  };

  const headerRight = (
    <Button
      testID="schedule-create"
      onPress={create}
      accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.newTask')}
      style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name="add" size={22} />
    </Button>
  );

  return (
    <NavPage
      title={t('sessions.scheduledTasks.dialog.title')}
      headerLargeTitle
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={headerRight}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: space.pageGap,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              padding: 4,
              gap: 4,
              borderRadius: 20,
              backgroundColor: alpha(colors.muted(), 0.9),
              backdropFilter: 'blur(18px) saturate(1.3)',
              glassEffect: 'regular',
            }}
          >
            <Each of={['tasks', 'history'] as Screen[]} key="index">
              {(entry) => (
                <Button
                  onPress={() => switchView(entry())}
                  style={{
                    flex: 1,
                    minHeight: 36,
                    borderRadius: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: view() === entry() ? colors.background() : 'transparent',
                  }}
                >
                  <Icon name={entry() === 'tasks' ? 'calendar-schedule' : 'history'} size={15} tone="muted" />
                  <Text style={{ fontSize: fontSize.entityTitle, color: colors.foreground() }}>
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Each of={['all', 'active', 'paused'] as Filter[]} key="index">
                  {(entry) => (
                    <Button
                      onPress={() => filter.set(entry())}
                      style={{
                        minHeight: 34,
                        paddingHorizontal: 14,
                        borderRadius: 17,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: filter() === entry() ? colors.foreground() : alpha(colors.muted(), 0.9),
                      }}
                    >
                      <Text
                        style={{
                          fontSize: fontSize.entityMeta,
                          fontWeight: '500',
                          color: filter() === entry() ? colors.background() : colors.foreground(),
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

              <If when={scheduledFailedProjects().length > 0}>
                <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                  {t('sessions.scheduledTasks.workspace.partialLoadWarning')}
                </Text>
              </If>

              <If when={!!(failure() || scheduledError())}>
                <Surface style={{ padding: 14, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: colors.destructive() }}>{failure() || scheduledError()}</Text>
                  <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void loadTasks(true)} />
                </Surface>
              </If>

              <If when={scheduledLoading() && scheduledTasks().length === 0}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
                  <Icon name="loader-4" size={16} tone="muted" />
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {t('sessions.scheduledTasks.dialog.loading')}
                  </Text>
                </View>
              </If>

              <If when={!scheduledLoading() && filtered().length === 0}>
                <View
                  style={{
                    borderRadius: 14,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: colors.border(),
                    padding: 18,
                  }}
                >
                  <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                    {scheduledTasks().length > 0
                      ? t('sessions.scheduledTasks.workspace.search.noResults')
                      : t('sessions.scheduledTasks.dialog.empty.noTasks')}
                  </Text>
                </View>
              </If>

              <View style={{ gap: 12 }}>
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

              <If when={scheduledTasks().length === 0}>
                <PrimaryButton
                  label={() => t('sessions.scheduledTasks.dialog.actions.newTask')}
                  icon="add"
                  onPress={create}
                />
              </If>
            </View>
          </If>

          <If when={view() === 'history'}>
            <View style={{ gap: 12 }}>
              <If when={!!scheduledRunsError()}>
                <Surface style={{ padding: 14, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: colors.destructive() }}>{scheduledRunsError()}</Text>
                  <QuietButton label={() => t('sessions.scheduledTasks.history.retry')} onPress={() => void loadRuns({}, true)} />
                </Surface>
              </If>
              <If when={scheduledRunsLoading() && scheduledRuns().length === 0}>
                <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
                  {t('sessions.scheduledTasks.history.loading')}
                </Text>
              </If>
              <If when={!scheduledRunsLoading() && scheduledRuns().length === 0 && !scheduledRunsError()}>
                <RunEmpty
                  title={t('sessions.scheduledTasks.history.empty.title')}
                  description={t('sessions.scheduledTasks.history.empty.description')}
                />
              </If>
              <View style={{ gap: 12 }}>
                <Each of={scheduledRuns()} key={(run) => run.id}>
                  {(run) => <RunRow run={run} />}
                </Each>
              </View>
              <If when={!scheduledRunsComplete()}>
                <QuietButton
                  label={() => t('sessions.scheduledTasks.history.retry')}
                  busy={scheduledRunsLoading}
                  onPress={() => void loadRuns({})}
                />
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
