import { Scroll, Text, View } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { QuietButton, Surface, fontSize } from '../core/ui';
import { tabBarInset } from '../shell/nav';
import { RunEmpty, RunRow } from './RunList';
import {
  loadRuns,
  scheduledRuns,
  scheduledRunsComplete,
  scheduledRunsError,
  scheduledRunsLoading,
  type RunsFilter,
} from './data';

/** One schedule's runs (`/schedule/{project}/{task}`), the phone's pushed history page. */
export function ScheduledRunsPage(props: { projectId: string; taskId: string; title: string }) {
  const filter: RunsFilter = { projectId: props.projectId, taskId: props.taskId };
  void loadRuns(filter, true);

  return (
    <NavPage
      title={props.title}
      headerBackTitle={t('sessions.scheduledTasks.dialog.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            paddingTop: 8,
            gap: 12,
          }}
        >
          <If when={!!scheduledRunsError()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{scheduledRunsError()}</Text>
              <QuietButton label={() => t('sessions.scheduledTasks.history.retry')} onPress={() => void loadRuns(filter, true)} />
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
          <Each of={scheduledRuns()} key={(run) => run.id}>
            {(run) => <RunRow run={run} />}
          </Each>
          <If when={!scheduledRunsComplete()}>
            <QuietButton
              label={() => t('sessions.scheduledTasks.history.retry')}
              busy={scheduledRunsLoading}
              onPress={() => void loadRuns(filter)}
            />
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
