import { Text, View, signal } from 'nsh';
import { Button, Input, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { ChoiceSheet, PrimaryButton, QuietButton, actionMenu, alpha, fontSize } from '../core/ui';
import { agents, defaultModel, loadCatalog, providers } from '../core/models';
import type { ScheduledTask, TaskEntry } from './data';

type Picker = 'schedule' | 'model' | 'agent' | null;
type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const popup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;
const field = {
  minHeight: 46,
  borderRadius: 12,
  paddingHorizontal: 12,
  fontSize: 15,
  color: colors.foreground(),
  backgroundColor: colors.muted(),
  placeholderColor: colors.mutedForeground(),
} as const;

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const weekdays: { value: number; key: DayKey }[] = [
  { value: 0, key: 'sun' },
  { value: 1, key: 'mon' },
  { value: 2, key: 'tue' },
  { value: 3, key: 'wed' },
  { value: 4, key: 'thu' },
  { value: 5, key: 'fri' },
  { value: 6, key: 'sat' },
];

const weekdayLabel = (day: number): string => {
  const key = weekdays.find((entry) => entry.value === day)?.key ?? 'sun';
  if (key === 'mon') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
  if (key === 'tue') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
  if (key === 'wed') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
  if (key === 'thu') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
  if (key === 'fri') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
  if (key === 'sat') return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
  return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
};

/** Create or edit one scheduled task; the app's own fields in the system's sheet. */
export function TaskEditorSheet(props: {
  entry: () => TaskEntry | null;
  onClose: () => void;
  onSave: (draft: ScheduledTask) => Promise<void>;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const editing = props.entry();
  const fallback = defaultModel();
  if (providers().length === 0) void loadCatalog();

  const name = signal(editing?.task.name ?? '');
  const prompt = signal(editing?.task.prompt ?? '');
  const enabled = signal(editing?.task.enabled ?? true);
  const kind = signal<'daily' | 'weekly' | 'once' | 'cron'>(editing?.task.schedule.kind ?? 'daily');
  const times = signal(editing?.task.schedule.times.join(', ') || editing?.task.schedule.time || '09:00');
  const date = signal(editing?.task.schedule.date ?? '');
  const days = signal<number[]>(editing?.task.schedule.weekdays ?? []);
  const cron = signal(editing?.task.schedule.cron ?? '');
  const providerID = signal(editing?.task.providerID ?? fallback?.providerID ?? providers()[0]?.id ?? '');
  const modelID = signal(editing?.task.modelID ?? fallback?.modelID ?? providers()[0]?.models[0]?.id ?? '');
  const agent = signal(editing?.task.agent ?? '');
  const busy = signal(false);
  const failure = signal('');
  const picker = signal<Picker>(null);

  const toggleDay = (day: number) => {
    const current = days();
    days.set(current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  };

  const validTimes = () =>
    times()
      .split(',')
      .map((value) => value.trim())
      .filter((value) => timePattern.test(value));

  const submit = async () => {
    if (busy()) return;
    if (!name().trim()) return failure.set(t('sessions.scheduledTasks.editor.validation.taskNameRequired'));
    if (!prompt().trim()) return failure.set(t('sessions.scheduledTasks.editor.validation.promptRequired'));
    if (!providerID() || !modelID()) return failure.set(t('sessions.scheduledTasks.editor.validation.modelRequired'));
    if ((kind() === 'daily' || kind() === 'weekly' || kind() === 'once') && validTimes().length === 0) {
      return failure.set(t('sessions.scheduledTasks.editor.validation.atLeastOneTime'));
    }
    if (kind() === 'weekly' && days().length === 0) {
      return failure.set(t('sessions.scheduledTasks.editor.validation.atLeastOneWeekday'));
    }
    if (kind() === 'once' && date().trim() && !/^\d{4}-\d{2}-\d{2}$/.test(date().trim())) {
      return failure.set(t('sessions.scheduledTasks.editor.validation.dateFormat'));
    }
    if (kind() === 'cron' && !cron().trim()) {
      return failure.set(t('sessions.scheduledTasks.editor.validation.cronRequired'));
    }
    busy.set(true);
    failure.set('');
    const nextTimes = validTimes();
    try {
      await props.onSave({
        id: editing?.task.id ?? '',
        name: name().trim(),
        enabled: enabled(),
        schedule: {
          kind: kind(),
          times: nextTimes,
          time: nextTimes[0] ?? '',
          date: kind() === 'once' ? date().trim() : '',
          weekdays: kind() === 'weekly' ? days() : [],
          cron: kind() === 'cron' ? cron().trim() : '',
          timezone: editing?.task.schedule.timezone ?? '',
        },
        prompt: prompt().trim(),
        providerID: providerID(),
        modelID: modelID(),
        agent: agent(),
        lastStatus: editing?.task.lastStatus ?? 'idle',
        lastError: '',
        lastDurationMs: 0,
        nextRunAt: 0,
        updatedAt: editing?.task.updatedAt ?? 0,
      });
    } catch (error) {
      failure.set(error instanceof Error ? error.message : t('sessions.scheduledTasks.editor.toast.saveFailed'));
    } finally {
      busy.set(false);
    }
  };

  const more = async () => {
    const action = await actionMenu({
      actions: [
        { id: 'history', label: t('sessions.scheduledTasks.workspace.views.history') },
        { id: 'delete', label: t('sessions.scheduledTasks.dialog.actions.delete'), destructive: true },
      ],
    });
    if (action === 'history') props.onHistory();
    if (action === 'delete') props.onDelete();
  };

  const modelLabel = () => {
    const provider = providers().find((entry) => entry.id === providerID());
    const model = provider?.models.find((entry) => entry.id === modelID());
    return provider ? `${provider.name} · ${model?.name ?? modelID()}` : '';
  };

  const draftScheduleLabel = (): string => {
    const listed = times().trim() || '--:--';
    if (kind() === 'daily') return t('sessions.scheduledTasks.dialog.schedule.daily', { time: listed });
    if (kind() === 'weekly') {
      return t('sessions.scheduledTasks.dialog.schedule.weekly', {
        days: days().map(weekdayLabel).join(', '),
        time: listed,
      });
    }
    if (kind() === 'once') {
      return t('sessions.scheduledTasks.dialog.schedule.once', {
        date: date().trim() || t('sessions.scheduledTasks.dialog.schedule.unknownDate'),
        time: listed,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: cron().trim() });
  };

  return (
    <Sheet
      open
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      popupStyle={popup}
      backdropStyle={backdrop}
    >
      <View style={{ padding: 18, gap: 12, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ flex: 1, fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
            {t(editing ? 'sessions.scheduledTasks.editor.title.edit' : 'sessions.scheduledTasks.editor.title.new')}
          </Text>
          <If when={!!editing}>
            <Button
              onPress={() => void more()}
              accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: name() })}
              style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="more-2" size={18} tone="muted" />
            </Button>
          </If>
        </View>

        <Input
          testID="task-name"
          value={name()}
          onChange={(event) => name.set(event.value)}
          placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
          accessibilityLabel={t('sessions.scheduledTasks.editor.taskName.label')}
          style={field}
        />
        <Input
          testID="task-prompt"
          value={prompt()}
          onChange={(event) => prompt.set(event.value)}
          placeholder={t('sessions.scheduledTasks.editor.prompt.placeholder')}
          accessibilityLabel={t('sessions.scheduledTasks.editor.prompt.label')}
          multiline
          style={{ ...field, minHeight: 96, padding: 12 }}
        />

        <View style={{ borderRadius: radius.inset, overflow: 'hidden', borderWidth: 1, borderColor: colors.border() }}>
          <View
            testID="task-schedule"
            role="button"
            onPress={() => picker.set('schedule')}
            activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
            style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}
          >
            <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.foreground() }}>
              {t('sessions.scheduledTasks.editor.scheduleType.label')}
            </Text>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
              {draftScheduleLabel()}
            </Text>
            <Icon name="arrow-right-s" size={16} tone="muted" />
          </View>
          <View
            testID="task-model"
            role="button"
            onPress={() => picker.set('model')}
            activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
            style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}
          >
            <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.foreground() }}>
              {t('sessions.scheduledTasks.editor.model.label')}
            </Text>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
              {modelLabel()}
            </Text>
            <Icon name="arrow-right-s" size={16} tone="muted" />
          </View>
          <View
            role="button"
            onPress={() => picker.set('agent')}
            activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
            style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}
          >
            <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.foreground() }}>
              {t('sessions.scheduledTasks.editor.agent.label')}
            </Text>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
              {agent() || t('settings.switch.off')}
            </Text>
            <Icon name="arrow-right-s" size={16} tone="muted" />
          </View>
        </View>

        <If when={kind() === 'daily' || kind() === 'weekly' || kind() === 'once'}>
          <Input
            testID="task-times"
            value={times()}
            onChange={(event) => times.set(event.value)}
            placeholder={t('sessions.scheduledTasks.editor.times.label')}
            accessibilityLabel={t('sessions.scheduledTasks.editor.times.label')}
            style={field}
          />
        </If>
        <If when={kind() === 'weekly'}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Each of={weekdays} key={(day) => String(day.value)}>
              {(day) => (
                <Button
                  onPress={() => toggleDay(day().value)}
                  style={{
                    minWidth: 38,
                    height: 38,
                    borderRadius: 19,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: days().includes(day().value) ? colors.foreground() : alpha(colors.muted(), 0.9),
                  }}
                >
                  <Text
                    style={{
                      fontSize: fontSize.entityMeta,
                      color: days().includes(day().value) ? colors.background() : colors.foreground(),
                    }}
                  >
                    {weekdayLabel(day().value)}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </If>
        <If when={kind() === 'once'}>
          <Input
            value={date()}
            onChange={(event) => date.set(event.value)}
            placeholder={t('sessions.scheduledTasks.editor.date.placeholder')}
            accessibilityLabel={t('sessions.scheduledTasks.editor.date.label')}
            style={field}
          />
        </If>
        <If when={kind() === 'cron'}>
          <Input
            value={cron()}
            onChange={(event) => cron.set(event.value)}
            placeholder={t('sessions.scheduledTasks.editor.cronExpression.placeholder')}
            accessibilityLabel={t('sessions.scheduledTasks.editor.cronExpression.label')}
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
        </If>

        <View
          role="button"
          onPress={() => enabled.set(!enabled())}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <Text style={{ flex: 1, fontSize: fontSize.label, color: colors.foreground() }}>
            {t('sessions.scheduledTasks.editor.enabled.label')}
          </Text>
          <Icon name={enabled() ? 'play' : 'pause'} size={16} tone="muted" />
        </View>

        <If when={!!failure()}>
          <Text style={{ fontSize: fontSize.entityMeta, color: colors.destructive() }}>{failure()}</Text>
        </If>

        <PrimaryButton
          label={() => t('sessions.scheduledTasks.editor.actions.save')}
          busy={busy}
          onPress={() => void submit()}
        />
        <QuietButton label={() => t('sessions.scheduledTasks.editor.actions.cancel')} onPress={props.onClose} />
      </View>

      <ChoiceSheet
        open={() => picker() === 'schedule'}
        title={t('sessions.scheduledTasks.editor.scheduleType.label')}
        options={() => [
          { value: 'daily', label: t('sessions.scheduledTasks.editor.scheduleType.daily') },
          { value: 'weekly', label: t('sessions.scheduledTasks.editor.scheduleType.weekly') },
          { value: 'once', label: t('sessions.scheduledTasks.editor.scheduleType.once') },
          { value: 'cron', label: t('sessions.scheduledTasks.editor.scheduleType.cron') },
        ]}
        value={() => kind()}
        onSelect={(value) => kind.set(value)}
        onClose={() => picker.set(null)}
      />
      <ChoiceSheet
        open={() => picker() === 'model'}
        title={t('sessions.scheduledTasks.editor.model.label')}
        options={() =>
          providers().flatMap((provider) =>
            provider.models.map((model) => ({
              value: `${provider.id}/${model.id}`,
              label: model.name,
              description: provider.name,
            })),
          )
        }
        value={() => `${providerID()}/${modelID()}`}
        onSelect={(value) => {
          const at = value.indexOf('/');
          providerID.set(value.slice(0, at));
          modelID.set(value.slice(at + 1));
        }}
        onClose={() => picker.set(null)}
      />
      <ChoiceSheet
        open={() => picker() === 'agent'}
        title={t('sessions.scheduledTasks.editor.agent.label')}
        options={() => [
          { value: '', label: t('settings.switch.off') },
          ...agents().map((agent) => ({ value: agent.name, label: agent.name, description: agent.description })),
        ]}
        value={() => agent()}
        onSelect={(value) => agent.set(value)}
        onClose={() => picker.set(null)}
      />
    </Sheet>
  );
}
