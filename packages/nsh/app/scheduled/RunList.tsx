import { Text, View } from 'nsh';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { Spinner, Surface, alpha, fontSize } from '../core/ui';
import { openSession } from '../shell/nav';
import { formatDuration, formatRunTime, type Run } from './data';

const runStatusColor = (run: Run): string => {
  if (run.status === 'success') return statusColor('success');
  if (run.status === 'error') return statusColor('error');
  return statusColor('warning');
};

/** One Web history card: status, task, location, duration + status, time + trigger. */
export function RunRow(props: { run: () => Run }) {
  const run = () => props.run();
  const openable = () => !!run().sessionId && !!run().directory;
  return (
    <Surface style={{ padding: 12 }}>
      <View
        testID={`run-${run().id}`}
        role={openable() ? 'button' : undefined}
        onPress={
          openable()
            ? () =>
                openSession({
                  id: run().sessionId ?? '',
                  title: run().taskName,
                  directory: run().directory ?? '',
                })
            : undefined
        }
        activeStyle={openable() ? { backgroundColor: alpha(colors.mutedForeground(), 0.05) } : undefined}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(colors.muted(), 0.9),
            marginTop: 1,
          }}
        >
          <If when={run().status === 'running'}>
            <Spinner size={13} />
          </If>
          <If when={run().status !== 'running'}>
            <Icon
              name={run().status === 'success' ? 'checkbox-circle' : 'error-warning'}
              size={14}
              color={() => runStatusColor(run())}
            />
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.foreground(), numberOfLines: 3 }}>
              {run().taskName}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <If when={!!formatDuration(run().durationMs ?? 0)}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>
                  {formatDuration(run().durationMs ?? 0)}
                </Text>
              </If>
              <Text style={{ fontSize: 12, lineHeight: 15, fontWeight: '500', color: runStatusColor(run()) }}>
                {run().status === 'running'
                  ? t('sessions.scheduledTasks.dialog.status.running')
                  : run().status === 'success'
                    ? t('sessions.scheduledTasks.dialog.status.success')
                    : t('sessions.scheduledTasks.dialog.status.error')}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="folder" size={12} tone="muted" />
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.mutedForeground(), numberOfLines: 2, flexShrink: 1 }}>
              {run().directory || run().projectId}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Icon name="time" size={12} tone="muted" />
              <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{formatRunTime(run().startedAt)}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Icon name={run().trigger === 'manual' ? 'play' : 'calendar-schedule'} size={12} tone="muted" />
              <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>
                {run().trigger === 'manual'
                  ? t('sessions.scheduledTasks.history.trigger.manual')
                  : t('sessions.scheduledTasks.history.trigger.scheduled')}
              </Text>
            </View>
          </View>
          <If when={!!run().error}>
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.mutedForeground(), numberOfLines: 3, marginTop: 6 }}>
              {run().error ?? ''}
            </Text>
          </If>
        </View>
      </View>
    </Surface>
  );
}

export function RunEmpty(props: { title: string; description: string }) {
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.border(),
        padding: 20,
        alignItems: 'center',
        gap: 4,
      }}
    >
      <Icon name="history" size={20} tone="muted" />
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.foreground() }}>{props.title}</Text>
      <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), textAlign: 'center' }}>
        {props.description}
      </Text>
    </View>
  );
}
