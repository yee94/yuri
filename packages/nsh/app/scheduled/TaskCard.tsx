import { Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { Spinner, Surface, alpha, fontSize } from '../core/ui';
import { formatRelative, formatSchedule, type TaskEntry } from './data';
import type { IconName } from '../core/Icon';

const statusIcon = (entry: TaskEntry): IconName => {
  if (!entry.task.enabled) return 'pause';
  if (entry.task.lastStatus === 'running') return 'loader-4';
  if (entry.task.lastStatus === 'success') return 'checkbox-circle';
  if (entry.task.lastStatus === 'error') return 'error-warning';
  return 'pulse';
};

const statusTone = (entry: TaskEntry): string => {
  if (!entry.task.enabled) return colors.mutedForeground();
  if (entry.task.lastStatus === 'success') return statusColor('success');
  if (entry.task.lastStatus === 'error') return statusColor('error');
  if (entry.task.lastStatus === 'running') return statusColor('warning');
  return colors.mutedForeground();
};

/** Web `yuri-mobile-scheduled-task-card`: status, name, schedule · next run, history and more. */
export function TaskCard(props: {
  entry: () => TaskEntry;
  busy: () => boolean;
  onOpen: () => void;
  onHistory: () => void;
  onMore: () => void;
}) {
  const task = () => props.entry().task;
  return (
    <Surface style={{ opacity: task().enabled ? 1 : 0.65 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 4 }}>
        <View
          testID={`task-${task().id}`}
          role="button"
          onPress={props.onOpen}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            minHeight: 52,
            paddingVertical: 12,
            paddingLeft: 12,
            paddingRight: 4,
          }}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: alpha(colors.muted(), 0.9),
            }}
          >
            <If when={task().enabled && task().lastStatus === 'running'}>
              <Spinner size={13} />
            </If>
            <If when={!(task().enabled && task().lastStatus === 'running')}>
              <Icon name={statusIcon(props.entry())} size={15} color={() => statusTone(props.entry())} />
            </If>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
              {task().name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1, flexShrink: 1 }}>
                {formatSchedule(task())}
              </Text>
              <Text style={{ fontSize: fontSize.sessionMeta, color: alpha(colors.mutedForeground(), 0.6) }}>·</Text>
              <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {task().nextRunAt ? formatRelative(task().nextRunAt) : '—'}
              </Text>
            </View>
          </View>
        </View>
        <Button
          testID={`task-history-${task().id}`}
          onPress={props.onHistory}
          accessibilityLabel={t('sessions.scheduledTasks.workspace.views.history')}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 20 }}
        >
          <Icon name="history" size={17} tone="muted" />
        </Button>
        <Button
          testID={`task-menu-${task().id}`}
          onPress={props.onMore}
          disabled={props.busy()}
          accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: task().name })}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 20 }}
        >
          <Icon name="more-2" size={18} tone="muted" />
        </Button>
      </View>
    </Surface>
  );
}
