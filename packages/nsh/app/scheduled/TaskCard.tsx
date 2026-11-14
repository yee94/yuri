import { Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { Surface, alpha } from '../core/ui';
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
  const disc = {
    backgroundColor: alpha(colors.card(), 0.9),
    boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 6px 18px -6px rgba(0,0,0,0.12)',
  } as const;
  return (
    <Surface
      style={{
        minHeight: 74,
        overflow: 'hidden',
        opacity: task().enabled ? 1 : 0.65,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
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
            gap: 7,
            minHeight: 74,
            padding: 10,
          }}
        >
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              ...disc,
            }}
          >
            <Icon
              name={task().enabled && task().lastStatus === 'running' ? 'loader-4' : statusIcon(props.entry())}
              size={18}
              color={() => statusTone(props.entry())}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                fontSize: 14,
                lineHeight: 18,
                fontWeight: '600',
                letterSpacing: -0.34,
                color: colors.foreground(),
                numberOfLines: 1,
              }}
            >
              {task().name}
            </Text>
            <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text
                style={{
                  fontSize: 12,
                  lineHeight: 15,
                  color: colors.mutedForeground(),
                  numberOfLines: 1,
                  flexShrink: 1,
                }}
              >
                {formatSchedule(task())}
              </Text>
              <Text style={{ fontSize: 12, lineHeight: 15, color: alpha(colors.mutedForeground(), 0.5) }}>·</Text>
              <Text
                style={{
                  fontSize: 12,
                  lineHeight: 15,
                  color: colors.mutedForeground(),
                  numberOfLines: 1,
                  flexShrink: 0,
                }}
              >
                {task().nextRunAt ? formatRelative(task().nextRunAt) : '—'}
              </Text>
            </View>
          </View>
        </View>
        <Button
          testID={`task-history-${task().id}`}
          onPress={props.onHistory}
          accessibilityLabel={t('sessions.scheduledTasks.workspace.views.history')}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 22 }}
        >
          <Icon name="history" size={16} tone="muted" />
        </Button>
        <Button
          testID={`task-menu-${task().id}`}
          onPress={props.onMore}
          disabled={props.busy()}
          accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: task().name })}
          style={{ width: 44, height: 44, borderRadius: 22, marginRight: 6, alignItems: 'center', justifyContent: 'center' }}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 22 }}
        >
          <Icon name="more-2" size={20} tone="muted" />
        </Button>
      </View>
    </Surface>
  );
}
