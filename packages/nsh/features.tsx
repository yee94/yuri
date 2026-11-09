import { cleanup, computed, effect, locale, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import {
  AlertDialog,
  Button,
  Input,
  NavPage,
  Switch,
  TimeField,
  type SelectItem,
} from "nsh/base";
import { NativeSelect as Select } from './native-select';
import { NativeDatePicker as DatePicker } from './native-date-picker';
import { language, t } from "./i18n";
import { id, list, record, text, unwrap, type Row } from "./model";
import { native, query } from "./runtime";
import { app, captureHostRequest, epoch, refresh } from "./state";
import { admitAssistantMutation } from "./assistants-core";
import { AssistantAvatarPicker } from "./assistants-avatar";
import { noteScheduledCatalogWrite } from "./schedules-state";
import { CRON_EXAMPLES, cronFailureText, cronPreview, isValidCronExpression, type CronPreview } from "./features-cron";
import { foundationCronPreview } from "./features-schedule-date";
import { readBotCreationDefaults, type BotDefaultSelection } from './features-bot-defaults';
import { taskEditorDirectory, taskEditorProject, taskEditorSelection, type TaskEditorCreationContext } from './task-editor-defaults';
import { TaskEditorPrompt } from './task-editor-prompt';
import { createTaskEditorOwner, type TaskEditorLeave, type TaskEditorWindowGuard } from './task-editor-owner';
import { TaskEditorDesktop } from './task-editor-desktop';

const action =
  "min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center";
const field = "min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground";

function Group(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      <Text class="px-1 text-xs text-muted-foreground">{props.title}</Text>
      <View class="rounded-2xl bg-card p-4 gap-3">{props.children}</View>
    </View>
  );
}

function Choice(props: {
  title: string;
  value: string;
  items: SelectItem[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value || null}
      items={props.items}
      disabled={props.disabled}
      searchable
      accessibilityLabel={props.title}
      searchAccessibilityLabel={props.title}
      searchPlaceholder={props.title}
      popupClass="bg-card rounded-2xl p-3"
      listClass="bg-card"
      itemClass="min-h-12 p-3 rounded-xl text-foreground selected:bg-accent focus:bg-accent"
      searchClass={field}
      onChange={(event) => props.onChange(event.value ?? "")}
      trigger={
        <View class={field}>
          <Text class="text-foreground">
            {props.items.find((item) => item.value === props.value)?.title ||
              props.value ||
              props.title}
          </Text>
        </View>
      }
    />
  );
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// The scope fence prevents a page opened on one Host from writing to another.
function editorState(onDone: () => void) {
  const request = captureHostRequest();
  const scope = epoch(),
    connectionID = app.connection()?.id;
  const busy = signal(false),
    error = signal(""),
    committed = signal(false),
    notice = signal("");
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const current = () =>
    alive && scope === epoch() && connectionID === app.connection()?.id;
  function assertCurrent() {
    if (!current()) throw new Error(t("mobile.notifications.identity"));
  }
  async function finish() {
    assertCurrent();
    await refresh();
    assertCurrent();
    onDone();
  }
  async function perform(work: () => Promise<void>, allowCommitted = false) {
    if (busy() || committed() && !allowCommitted) return;
    busy.set(true);
    error.set("");
    try {
      assertCurrent();
      await work();
    } catch (failure) {
      if (alive) error.set(failureMessage(failure));
    } finally {
      if (alive) busy.set(false);
    }
  }
  return {
    request,
    busy,
    error,
    committed,
    notice,
    current,
    assertCurrent,
    finish,
    perform,
  };
}

type EditorState = ReturnType<typeof editorState>;
function editorNavigation(state: EditorState, onDone: () => void, snapshot: () => unknown) {
  const pristine = JSON.stringify(snapshot());
  const confirming = signal(false);
  const dirty = () => !state.committed() && JSON.stringify(snapshot()) !== pristine;
  const blocked = () => state.busy() || confirming() || dirty();
  async function cancel(afterLeave: () => void = onDone) {
    if (state.busy() || confirming()) return;
    if (!dirty()) { if (state.current()) afterLeave(); return; }
    confirming.set(true);
    try {
      const answer = await AlertDialog.show({
        title: t("filesView.unsaved.title"),
        description: t("sessions.scheduledTasks.workspace.confirm.discardChanges"),
        actions: [
          { id: "cancel", label: t("settings.common.actions.cancel"), role: "cancel" },
          { id: "discard", label: t("filesView.unsaved.discard"), role: "destructive" },
        ],
      });
      if (state.current() && answer.action === "discard") afterLeave();
    } finally { confirming.set(false); }
  }
  return { blocked, cancel, back: () => { if (blocked()) void cancel(); } };
}

function Feedback(props: { state: EditorState }) {
  return (
    <View class="gap-2">
      <If when={!!props.state.notice()}>
        <Text class="text-sm text-muted-foreground">
          {props.state.notice()}
        </Text>
      </If>
      <If when={!!props.state.error()}>
        <Text class="text-sm text-destructive">{props.state.error()}</Text>
      </If>
      <If when={props.state.committed()}>
        <Button
          class={action}
          disabled={props.state.busy()}
          onPress={() => {
            // A committed write is never replayed: Done retries only the read.
            void props.state.perform(props.state.finish, true);
          }}
        >
          <Text class="text-foreground">{t("gitView.common.done")}</Text>
        </Button>
      </If>
    </View>
  );
}

function modelCatalog(state: EditorState, initial: Row, includeAgent = true) {
  const request = state.request;
  const providers = signal<Row[]>([]),
    agents = signal<Row[]>([]),
    partial = signal(false),
    loading = signal(false),
    error = signal("");
  const providerID = signal(text(initial.providerID)),
    modelID = signal(text(initial.modelID));
  const agent = signal(text(initial.agent)),
    variant = signal(text(initial.variant));
  let sequence = 0;
  async function load(directory: string | null) {
    const attempt = ++sequence;
    error.set("");
    loading.set(true);
    const results = await Promise.allSettled([
      request(`/api/config/catalog/providers${directory === null ? "" : `?${query(directory)}`}`),
      includeAgent ? request(
        `/api/agent${directory === null ? "" : `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`}`,
      ) : Promise.resolve(undefined),
    ]);
    if (!state.current() || sequence !== attempt) return;
    const catalog = results[0],
      agentResult = results[1];
    const failures: string[] = [];
    if (catalog.status === "fulfilled") {
      const body = record(catalog.value);
      if (
        body.ok === false ||
        body.failed === true ||
        body.schemaVersion !== 1 ||
        !Array.isArray(body.providers)
      )
        failures.push(t("assistants.state.invalidConfiguration"));
      else {
        providers.set(list(body.providers));
        partial.set(body.partial === true);
      }
    } else failures.push(failureMessage(catalog.reason));
    if (includeAgent && agentResult.status === "fulfilled") {
      const envelope = record(agentResult.value);
      const body = unwrap(agentResult.value);
      if (envelope.ok !== false && envelope.failed !== true && envelope.partial !== true && Array.isArray(body))
        agents.set(
          list(body)
            .filter((item) => item.hidden !== true && item.mode !== "subagent")
            .map((item) => ({ ...item, id: text(item.id) || text(item.name) })),
        );
      else failures.push(t("assistants.composer.selectionSaveFailed"));
    } else if (agentResult.status === "rejected") failures.push(failureMessage(agentResult.reason));
    error.set(failures.join("\n"));
    loading.set(false);
  }
  const models = () =>
    Object.values(
      record(providers().find((item) => item.id === providerID())?.models),
    ).map(record);
  const variants = () =>
    Object.keys(
      record(models().find((item) => item.id === modelID())?.variants),
    );
  function selectProvider(value: string) {
    if (value === providerID()) return;
    providerID.set(value);
    modelID.set("");
    variant.set("");
  }
  function selectModel(value: string) {
    if (value === modelID()) return;
    modelID.set(value);
    variant.set("");
  }
  return {
    providers,
    agents,
    partial,
    loading,
    error,
    providerID,
    modelID,
    agent,
    variant,
    models,
    variants,
    selectProvider,
    selectModel,
    load,
  };
}

function CatalogFields(props: {
  catalog: ReturnType<typeof modelCatalog>;
  disabled: boolean;
  reload: () => void;
  includeAgent?: boolean;
}) {
  const c = props.catalog;
  return (
    <Group title={t("assistants.settings.model")}>
      <If when={c.loading()}>
        <Text class="text-muted-foreground">{t("common.loading")}</Text>
      </If>
      <If when={!!c.error()}>
        <Text class="text-destructive">{c.error()}</Text>
      </If>
      <If when={c.partial()}>
        <Text class="text-destructive">
          {t("assistants.settings.model")} ·{" "}
          {t("sessions.scheduledTasks.dialog.status.error")}
        </Text>
      </If>
      <Choice
        title={t("assistants.settings.model")}
        value={c.providerID()}
        items={c
          .providers()
          .map((item) => ({
            value: text(item.id),
            title: text(item.name) || text(item.id),
          }))}
        disabled={props.disabled || c.loading()}
        onChange={c.selectProvider}
      />
      <Choice
        title={t("sessions.scheduledTasks.editor.model.label")}
        value={c.modelID()}
        items={c
          .models()
          .map((item) => ({
            value: text(item.id),
            title: text(item.name) || text(item.id),
          }))}
        disabled={props.disabled || c.loading()}
        onChange={c.selectModel}
      />
      <If when={!c.loading() && c.providers().length === 0 && !c.error()}>
        <Text class="text-muted-foreground">
          {t("assistants.contact.noProvider")}
        </Text>
      </If>
      <If when={props.includeAgent !== false}><Choice
        title={t("assistants.settings.agent")}
        value={c.agent()}
        items={[
          {
            value: "",
            title: t("sessions.scheduledTasks.editor.thinkingLevel.default"),
          },
          ...c
            .agents()
            .map((item) => ({
              value: text(item.id),
              title: text(item.name) || text(item.id),
            })),
        ]}
        disabled={props.disabled || c.loading()}
        onChange={(value) => c.agent.set(value)}
      /></If>
      <Choice
        title={t("sessions.scheduledTasks.editor.thinkingLevel.label")}
        value={c.variant()}
        items={[
          {
            value: "",
            title: t("sessions.scheduledTasks.editor.thinkingLevel.default"),
          },
          ...c.variants().map((value) => ({ value, title: value })),
        ]}
        disabled={props.disabled || c.loading()}
        onChange={(value) => c.variant.set(value)}
      />
      <Button
        class={action}
        disabled={props.disabled || c.loading()}
        onPress={props.reload}
      >
        <Text class="text-foreground">{t("chat.questionDelegate.retry")}</Text>
      </Button>
    </Group>
  );
}

async function confirmDelete(title: string, description: string) {
  const result = await AlertDialog.show({
    title,
    description,
    actions: [
      {
        id: "cancel",
        label: t("settings.common.actions.cancel"),
        role: "cancel",
      },
      {
        id: "delete",
        label: t("settings.common.actions.delete"),
        role: "destructive",
      },
    ],
  });
  return result.action === "delete";
}

export function BotEditor(props: { bot?: Row; onDone: () => void; children?: JSX.Element; defaultContext?: { directory?: string; selection?: BotDefaultSelection }; onNavigation?: (requestLeave: ((afterLeave?: () => void) => Promise<void>) | null) => void }) {
  const state = editorState(props.onDone),
    request = state.request,
    original = props.bot ?? {};
  const botID = signal(text(original.id)),
    revision = signal(original.revision);
  const name = signal(text(original.name)),
    prompt = signal(text(original.defaultPrompt));
  const workspace = signal(text(original.workspacePath));
  const avatarSeed = signal(text(original.avatarSeed) || text(original.id));
  const c = modelCatalog(state, original, false);
  const defaultsLoading = signal(false), defaultsError = signal('');
  const baseline = { name: name(), providerID: c.providerID(), modelID: c.modelID(), variant: c.variant() };
  const initialValue = (key: keyof typeof baseline, value: string) => value === baseline[key] ? null : value;
  const directory = () =>
    workspace() || text(original.managedWorkspacePath) || null;
  const navigation = editorNavigation(state, props.onDone, () => ({
    name: initialValue('name', name()), prompt: prompt(), workspace: workspace(), avatarSeed: avatarSeed(),
    providerID: initialValue('providerID', c.providerID()), modelID: initialValue('modelID', c.modelID()), variant: initialValue('variant', c.variant()),
  }));
  props.onNavigation?.(navigation.cancel);
  cleanup(() => props.onNavigation?.(null));
  const disabled = () => state.busy() || state.committed() || defaultsLoading();
  let defaultsApplied = !!props.bot;
  async function loadCreationDefaults() {
    if (defaultsApplied || defaultsLoading() || !state.current()) return;
    defaultsLoading.set(true); defaultsError.set('');
    const captured = { name: name(), providerID: c.providerID(), modelID: c.modelID(), variant: c.variant() };
    try {
      const result = await readBotCreationDefaults(request, props.defaultContext);
      if (!state.current()) return;
      if (captured.name === baseline.name && name() === captured.name) { name.set(result.name); baseline.name = result.name; }
      if (captured.providerID === baseline.providerID && captured.modelID === baseline.modelID && captured.variant === baseline.variant && c.providerID() === captured.providerID && c.modelID() === captured.modelID && c.variant() === captured.variant && result.model) {
        c.providerID.set(result.model.providerID); c.modelID.set(result.model.modelID); c.variant.set(result.model.variant ?? '');
        baseline.providerID = c.providerID(); baseline.modelID = c.modelID(); baseline.variant = c.variant();
      }
      defaultsApplied = true;
    } catch { if (state.current()) defaultsError.set(t('assistants.state.invalidConfiguration')); }
    finally { if (state.current()) defaultsLoading.set(false); }
  }
  const projectItems = () => [
    { value: "", title: t("assistants.settings.workspacePlaceholder") },
    ...app
      .projects()
      .map((project) => ({ value: project.path, title: project.name })),
    ...(workspace() &&
    !app.projects().some((project) => project.path === workspace())
      ? [{ value: workspace(), title: workspace() }]
      : []),
  ];
  void c.load(directory());
  if (!props.bot) void loadCreationDefaults();
  async function save() {
    await state.perform(async () => {
      if (!name().trim() || !c.providerID() || !c.modelID())
        throw new Error(t("assistants.settings.validation.required"));
      await admitAssistantMutation({ current: state.current, request });
      state.assertCurrent();
      const body = {
        name: name().trim(),
        ...(avatarSeed() ? { avatarSeed: avatarSeed() } : {}),
        defaultPrompt: prompt(),
        workspacePath: workspace() || null,
        providerID: c.providerID(),
        modelID: c.modelID(),
        variant: c.variant() || null,
      };
      const response = record(
        await request(
          botID()
            ? `/api/yuri/assistants/${encodeURIComponent(botID())}`
            : "/api/yuri/assistants",
          botID() ? "PATCH" : "POST",
          botID()
            ? { ...body, expectedRevision: revision() }
            : {
                ...body,
                language: language() === "system" ? locale() : language(),
              },
        ),
      );
      state.assertCurrent();
      if (
        response.ok === false ||
        response.failed === true ||
        response.partial === true ||
        !text(response.id) ||
        typeof response.revision !== "number"
      )
        throw new Error(
          text(response.message) || t("assistants.settings.toast.saveFailed"),
        );
      botID.set(text(response.id));
      revision.set(response.revision);
      state.committed.set(true);
      state.notice.set(t("assistants.settings.toast.saved"));
      await state.finish();
    });
  }
  async function remove() {
    await state.perform(async () => {
      if (
        !(await confirmDelete(
          t("assistants.settings.delete"),
          t("assistants.settings.deleteConfirm", { name: name() }),
        ))
      )
        return;
      state.assertCurrent();
      await admitAssistantMutation({ current: state.current, request });
      state.assertCurrent();
      const response = record(
        await request(
          `/api/yuri/assistants/${encodeURIComponent(botID())}`,
          "DELETE",
          { expectedRevision: revision() },
        ),
      );
      state.assertCurrent();
      if (
        response.ok === false ||
        response.failed === true ||
        response.partial === true ||
        response.assistantID !== botID() ||
        typeof response.tombstoneAt !== "number"
      )
        throw new Error(t("assistants.settings.toast.deleteFailed"));
      state.committed.set(true);
      state.notice.set(t("assistants.settings.toast.deleted"));
      await state.finish();
    });
  }
  async function reloadRevision() {
    await state.perform(async () => {
      const snapshot = record(await request("/api/yuri/assistants/snapshot"));
      state.assertCurrent();
      if (
        !Array.isArray(snapshot.assistants) ||
        snapshot.partial === true ||
        snapshot.failed === true
      )
        throw new Error(t("assistants.settings.toast.saveFailed"));
      const live = list(snapshot.assistants).find(
        (item) => item.id === botID(),
      );
      if (!live || typeof live.revision !== "number")
        throw new Error(t("assistants.settings.toast.saveFailed"));
      const answer = await AlertDialog.show({
        title: t("assistants.settings.name"),
        description: [
          t("assistants.composer.selectionConflict"),
          text(live.name),
          `${text(live.providerID)}/${text(live.modelID)}`,
          text(live.defaultPrompt),
        ]
          .filter(Boolean)
          .join("\n\n"),
        actions: [
          {
            id: "cancel",
            label: t("settings.common.actions.cancel"),
            role: "cancel",
          },
          { id: "retry", label: t("chat.questionDelegate.retry") },
        ],
      });
      state.assertCurrent();
      if (answer.action === "retry") revision.set(live.revision);
    });
  }
  return (
    <NavPage
      headerBackTitle=""
      popOnBack={!navigation.blocked()}
      popOnSwipe={!navigation.blocked()}
      onBackPress={navigation.back}
      headerRight={<Button testID="features-bot-save" class={action} disabled={disabled()} accessibilityLabel={t("assistants.settings.save")} onPress={() => { void save(); }}><Text class="text-foreground">{state.busy() ? t("sessions.scheduledTasks.editor.actions.saving") : t("assistants.settings.save")}</Text></Button>}
      title={
        props.bot
          ? t("assistants.title")
          : t("assistants.settings.create")
      }
      class="flex-1 bg-background"
    >
      <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
        <If when={defaultsLoading()}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={!!defaultsError()}><Text testID="features-bot-defaults-error" class="text-destructive">{defaultsError()}</Text><Button testID="features-bot-defaults-retry" class={action} disabled={defaultsLoading()} onPress={() => { void loadCreationDefaults(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
        <AssistantAvatarPicker seed={avatarSeed()} disabled={disabled()} onChange={value => avatarSeed.set(value)} />
        <Group title={t("assistants.settings.name")}>
          <Input
            testID="features-bot-name"
            class={field}
            value={name()}
            disabled={disabled()}
            onChange={(event) => name.set(event.value)}
            accessibilityLabel={t("assistants.settings.name")}
          />
        </Group>
        <Group title={t("assistants.settings.workspace")}>
          <Choice
            title={t("assistants.settings.workspace")}
            value={workspace()}
            items={projectItems()}
            disabled={disabled()}
            onChange={(value) => {
              workspace.set(value);
              void c.load(directory());
            }}
          />
          <Text class="text-xs text-muted-foreground">
            {t("assistants.settings.workspaceChangeHint")}
          </Text>
        </Group>
        <CatalogFields
          catalog={c}
          includeAgent={false}
          disabled={disabled()}
          reload={() => {
            void c.load(directory());
          }}
        />
        <Group title={t("assistants.settings.defaultPrompt")}>
          <Input
            class={field + " min-h-36"}
            multiline
            value={prompt()}
            disabled={disabled()}
            onChange={(event) => prompt.set(event.value)}
            placeholder={t("assistants.settings.defaultPromptPlaceholder")}
            accessibilityLabel={t("assistants.settings.defaultPrompt")}
          />
        </Group>
        {props.children}
        <Feedback state={state} />
        <If when={!state.committed()}>
          <Button
            testID="features-bot-cancel"
            class={action}
            disabled={state.busy()}
            onPress={() => {
              void navigation.cancel();
            }}
          >
            <Text class="text-foreground">
              {t("settings.common.actions.cancel")}
            </Text>
          </Button>
        </If>
        <If when={!!botID() && !state.committed()}>
          <If when={!!state.error()}>
            <Button
              class={action}
              disabled={state.busy()}
              onPress={() => {
                void reloadRevision();
              }}
            >
              <Text class="text-foreground">
                {t("chat.questionDelegate.refreshStatus")}
              </Text>
            </Button>
          </If>
          <Button
            class={action}
            disabled={state.busy()}
            onPress={() => {
              void remove();
            }}
          >
            <Text class="text-destructive">
              {t("assistants.settings.delete")}
            </Text>
          </Button>
        </If>
      </Scroll>
    </NavPage>
  );
}

export type TaskEditorProps = {
  item?: Row; onDone: () => void; syncPendingDescription?: string; creationContext?: TaskEditorCreationContext; active?: boolean;
  presentation?: 'mobile' | 'desktop'; interactive?: boolean; onClose?: () => void;
  onNavigation?: (requestLeave: TaskEditorLeave | null) => void;
  onWindowGuard?: (registration: TaskEditorWindowGuard | null) => void;
  onOpenHistory?: () => void;
};
export function TaskEditor(props: TaskEditorProps) {
  const desktop = props.presentation === 'desktop' ? createTaskEditorOwner(() => props.active !== false, () => props.interactive !== false, props.onDone) : null;
  const state = desktop ?? editorState(props.onDone),
    request = state.request,
    task = record(props.item?.task),
    schedule = record(task.schedule),
    execution = record(task.execution);
  const taskID = signal(text(task.id));
  const savedTask = signal(task);
  const creationID = `task_${id()}`;
  const creationContext = props.creationContext && { ...props.creationContext, selection: { ...props.creationContext.selection }, ...(props.creationContext.commandContext ? { commandContext: { ...props.creationContext.commandContext } } : {}) };
  const capturedHost = app.connection()?.id || '';
  const projectID = signal(
    taskEditorProject(props.item, creationContext, app.projects()),
  );
  const name = signal(text(task.name)),
    prompt = signal(text(execution.prompt)),
    goalEnabled = signal(execution.goalEnabled === true),
    enabled = signal(task.enabled !== false);
  const kind = signal(text(schedule.kind) || "daily"),
    timezone = signal(text(schedule.timezone) || new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const initialTimes = Array.isArray(schedule.times)
    ? schedule.times.filter(
        (value): value is string => typeof value === "string",
      )
    : [text(schedule.time) || "09:00"];
  const times = signal(initialTimes),
    time = signal(text(schedule.time) || initialTimes[0] || "09:00");
  const today = new Date();
  const date = signal(text(schedule.date) || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`),
    cron = signal(text(schedule.cron));
  const weekdays = signal<number[]>(
    Array.isArray(schedule.weekdays)
      ? schedule.weekdays.filter(
          (value): value is number => typeof value === "number",
        )
      : [1],
  );
  const c = modelCatalog(state, { ...execution, ...taskEditorSelection(props.item, creationContext) });
  const snapshot = () => ({
    projectID: projectID(), name: name(), prompt: prompt(), enabled: desktop && enabled() === savedTask().enabled ? null : enabled(), goalEnabled: goalEnabled(),
    kind: kind(), timezone: timezone(), times: times(), time: time(), date: date(), cron: cron(), weekdays: weekdays(),
    providerID: c.providerID(), modelID: c.modelID(), agent: c.agent(), variant: c.variant(),
  });
  const desktopNavigation = desktop?.navigation(snapshot, () => props.onClose?.());
  const navigation = desktopNavigation ?? editorNavigation(state, props.onDone, snapshot);
  if (desktopNavigation) {
    props.onNavigation?.(desktopNavigation.cancel); props.onWindowGuard?.(desktopNavigation.windowGuard);
    cleanup(() => { props.onNavigation?.(null); props.onWindowGuard?.(null); });
  }
  const cronValidation = computed(() => cron().trim() ? isValidCronExpression(cron()) : null);
  const nextPreview = signal<CronPreview | null>(null), previewLoading = signal(false);
  let previewSequence = 0;
  effect(() => {
    const expression = cron(), timeZone = timezone(), formatLocale = language() === "system" ? locale() : language();
    const hostID = app.connection()?.id, attempt = ++previewSequence;
    if (kind() !== "cron" || !cronValidation()?.valid || !state.current() || !hostID) {
      nextPreview.set(null); previewLoading.set(false); return;
    }
    const currentDate = new Date(), direct = cronPreview(expression, timeZone, formatLocale, currentDate);
    const fixedUTC = ["UTC", "GMT", "Etc/UTC", "Etc/GMT"].includes(timeZone);
    // Accepting the device's zone does not prove Intl owns an IANA database.
    // Named schedules always use Foundation authority, even if direct parsing works.
    if (direct.ok && fixedUTC) { nextPreview.set(direct); previewLoading.set(false); return; }
    nextPreview.set(null); previewLoading.set(true);
    void foundationCronPreview({ expression, timeZone, locale: formatLocale, hostID, currentDate, previous: direct.ok ? undefined : direct.error,
      read: input => native("schedule.dateContext", input),
    }).then(result => {
      if (!state.current() || previewSequence !== attempt) return;
      nextPreview.set(result); previewLoading.set(false);
    });
    return () => { previewSequence++; };
  });
  const formattedRuns = computed(() => {
    const result = nextPreview();
    return result?.ok ? result.formatted : [];
  });
  const previewError = computed(() => {
    const result = nextPreview();
    return result && !result.ok ? cronFailureText(result.error) : "";
  });
  const directory = () =>
    taskEditorDirectory(projectID(), creationContext, app.projects());
  const base = () =>
    `/api/projects/${encodeURIComponent(projectID())}/scheduled-tasks`;
  const disabled = () => state.busy() || state.committed() || !!desktop && (!desktop.admitted() || desktop.unknown());
  const weekdayItems = () => [
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.sun"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.mon"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.tue"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.wed"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.thu"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.fri"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.sat"),
  ];
  if (desktop) {
    const catalogDirectory = computed(directory);
    effect(() => { const available = desktop.current(), value = catalogDirectory(); untracked(() => { if (available && value) void c.load(value); }); });
  } else if (directory()) void c.load(directory());
  function buildSchedule() {
    if (!timezone().trim())
      throw new Error(
        t("sessions.scheduledTasks.editor.validation.timezoneRequired"),
      );
    const common = { kind: kind(), timezone: timezone().trim() };
    if (kind() === "cron") {
      if (!cron().trim())
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.cronRequired"),
        );
      // The Host's cron-parser is authoritative, including ranges and named days.
      if (!isValidCronExpression(cron()).valid)
        throw new Error(t("sessions.scheduledTasks.editor.validation.cronInvalid"));
      return { ...common, cron: cron().trim() };
    }
    if (kind() === "once") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date()))
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.dateFormat"),
        );
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time()))
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.timeFormat"),
        );
      return { ...common, date: date(), time: time() };
    }
    if (
      !times().length ||
      times().some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    )
      throw new Error(
        t("sessions.scheduledTasks.editor.validation.atLeastOneTime"),
      );
    if (kind() === "weekly" && !weekdays().length)
      throw new Error(
        t("sessions.scheduledTasks.editor.validation.atLeastOneWeekday"),
      );
    return {
      ...common,
      times: [...new Set(times())].sort(),
      ...(kind() === "weekly" ? { weekdays: weekdays() } : {}),
    };
  }
  async function saved(response: Row, deleted = false) {
    if (
      response.ok === false ||
      response.failed === true ||
      response.partial === true ||
      (!deleted && (!text(record(response.task).id) || record(response.task).id !== (taskID() || creationID))) ||
      (deleted && (!Array.isArray(response.tasks) || list(response.tasks).some(item => item.id === taskID())))
    )
      throw new Error(
        text(response.error) ||
          t("sessions.scheduledTasks.editor.toast.saveFailed"),
      );
    state.assertCurrent();
    desktop?.acknowledge();
    noteScheduledCatalogWrite();
    if (!deleted) taskID.set(text(record(response.task).id));
    if (desktop && !deleted) savedTask.set(record(response.task));
    state.committed.set(true);
    state.notice.set(
      t(
        deleted
          ? "sessions.scheduledTasks.dialog.toast.deleted"
          : "sessions.scheduledTasks.dialog.toast.saved",
      ),
    );
    if (response.schedulerSynced === false) {
      // This is committed success. Never offer a second create after a sync failure.
      state.notice.set(
        state.notice() +
          "\n" +
          (props.syncPendingDescription || t("mobile.tabs.scheduled") + " · " + t("sessions.scheduledTasks.dialog.status.error")),
      );
      await refresh();
      return;
    }
    await state.finish();
    if (desktop && state.current() && !deleted) { state.committed.set(false); desktopNavigation?.pristine(); }
  }
  async function save() {
    await state.perform(async () => {
      if (!projectID())
        throw new Error(
          t("sessions.scheduledTasks.dialog.error.chooseProjectFirst"),
        );
      if (!name().trim())
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.taskNameRequired"),
        );
      if (!prompt().trim())
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.promptRequired"),
        );
      if (!c.providerID() || !c.modelID())
        throw new Error(
          t("sessions.scheduledTasks.editor.validation.modelRequired"),
        );
      const nextExecution = {
        ...execution,
        prompt: prompt(),
        providerID: c.providerID(),
        modelID: c.modelID(),
        agent: c.agent(),
        variant: c.variant(),
        goalEnabled: goalEnabled(),
      };
      const value = {
        id: taskID() || creationID,
        name: name().trim(),
        enabled: enabled(),
        schedule: buildSchedule(),
        execution: nextExecution,
      };
      await saved(
        record(
          await request(base(), taskID() ? "PATCH" : "PUT", { task: value }),
        ),
      );
    });
  }
  async function remove() {
    await state.perform(async () => {
      if (
        !(await confirmDelete(
          t("settings.common.actions.delete"),
          t("sessions.scheduledTasks.dialog.confirm.deleteTask", {
            taskName: name(),
          }),
        ))
      )
        return;
      state.assertCurrent();
      await saved(
        record(
          await request(`${base()}/${encodeURIComponent(taskID())}`, "DELETE"),
        ),
        true,
      );
    });
  }
  async function taskAction(kind: 'run' | 'toggle') {
    if (!desktop) return;
    await state.perform(async () => {
      const previous = savedTask();
      if (!taskID() || kind === 'run' && (previous.enabled !== true || record(previous.state).lastStatus === 'running')) throw new Error(t('sessions.scheduledTasks.dialog.toast.runFailed'));
      const response = record(await request(kind === 'run' ? `${base()}/${encodeURIComponent(taskID())}/run` : base(), kind === 'run' ? 'POST' : 'PATCH', kind === 'toggle' ? { task: { id: taskID(), enabled: previous.enabled !== true } } : undefined));
      const confirmed = record(response.task);
      if (response.ok === false || response.failed === true || response.partial === true || text(confirmed.id) !== taskID() || kind === 'run' && response.ok !== true || kind === 'toggle' && confirmed.enabled !== (previous.enabled !== true)) throw new Error(t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      state.assertCurrent(); desktop.acknowledge(); noteScheduledCatalogWrite(); savedTask.set(confirmed);
      state.notice.set(t(kind === 'run' ? 'sessions.scheduledTasks.dialog.toast.started' : 'sessions.scheduledTasks.dialog.toast.saved'));
      if (kind === 'toggle') {
        enabled.set(confirmed.enabled === true);
        if (response.schedulerSynced === false) { state.committed.set(true); state.notice.set(state.notice() + ' · ' + (props.syncPendingDescription || t('common.unavailable'))); }
      }
      await refresh();
    });
  }
  async function recover() {
    if (!desktop) return;
    await state.perform(async () => {
      const receipt = desktop.receipt();
      if (!receipt) return;
      // Run history has no operation receipt/correlation ID. Never infer that an
      // unknown run succeeded (or failed) from a nearby historical run.
      if (receipt.path.endsWith('/run')) throw new Error(t('common.unavailable'));
      const response = record(await request(base()));
      if (response.ok === false || response.failed === true || response.partial === true || response.complete === false || !Array.isArray(response.tasks) || list(response.tasks).some(value => !text(value.id)) || new Set(list(response.tasks).map(value => value.id)).size !== list(response.tasks).length) throw new Error(t('common.unavailable'));
      const expected = record(record(receipt.body).task), identity = text(expected.id) || taskID();
      const found = list(response.tasks).find(value => value.id === identity);
      if (receipt.method === 'DELETE') {
        if (found) throw new Error(t('common.unavailable'));
        await saved({ tasks: response.tasks, schedulerSynced: false }, true); return;
      }
      const matches = (actual: unknown, wanted: unknown, field = ''): boolean => {
        // project-config.normalizeExecution omits empty variant/agent and false
        // goalEnabled. These are schema defaults, not missing receipt evidence.
        if (actual === undefined && (wanted === '' && ['variant', 'agent'].includes(field) || wanted === false && field === 'goalEnabled')) return true;
        if (wanted && typeof wanted === 'object') return Array.isArray(wanted) ? Array.isArray(actual) && actual.length === wanted.length && wanted.every((value, index) => matches(actual[index], value)) : Object.entries(record(wanted)).every(([key, value]) => matches(record(actual)[key], value, key));
        return actual === wanted;
      };
      if (!found || !matches(found, expected)) throw new Error(t('common.unavailable'));
      if (Object.keys(expected).length === 2 && typeof expected.enabled === 'boolean') {
        desktop.acknowledge(); noteScheduledCatalogWrite(); savedTask.set(found); enabled.set(found.enabled === true); state.committed.set(true); state.notice.set(t('sessions.scheduledTasks.dialog.toast.saved') + ' · ' + t('common.unavailable')); return;
      }
      await saved({ task: found, schedulerSynced: false });
    }, true);
  }
  if (desktop) return <TaskEditorDesktop form={{ taskID, name, prompt, goalEnabled, enabled, projectID, kind, timezone, times, time, date, cron, weekdays }} catalog={c} owner={desktop} savedTask={savedTask()} disabled={disabled()} creationContext={creationContext} directory={directory()} capturedHost={capturedHost} creationID={creationID}
    active={props.active !== false} onClose={() => { void navigation.cancel(); }} onSave={() => { void save(); }} onDelete={() => { void remove(); }} onRun={() => { void taskAction('run'); }} onToggle={() => { void taskAction('toggle'); }} onHistory={props.onOpenHistory ? () => { void navigation.cancel(props.onOpenHistory); } : undefined}
    onRecover={() => { void recover(); }} onFinish={() => { void state.perform(state.finish, true); }} onReload={() => { if (desktop.admitted() && directory()) void c.load(directory()); }}
    preview={{ runs: formattedRuns(), loading: previewLoading(), error: previewError(), valid: cronValidation()?.valid !== false }} />;
  return (
    <NavPage
      headerBackTitle=""
      popOnBack={!navigation.blocked()}
      popOnSwipe={!navigation.blocked()}
      onBackPress={navigation.back}
      headerRight={<Button testID="features-task-save" class={action} disabled={disabled()} accessibilityLabel={t("sessions.scheduledTasks.editor.actions.save")} onPress={() => { void save(); }}><Text class="text-foreground">{t(state.busy() ? "sessions.scheduledTasks.editor.actions.saving" : "sessions.scheduledTasks.editor.actions.save")}</Text></Button>}
      title={t(
        props.item
          ? "sessions.scheduledTasks.editor.title.edit"
          : "sessions.scheduledTasks.editor.title.new",
      )}
      class="flex-1 bg-background"
    >
      <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10">
        <Group title={t("mobile.tabs.projects")}>
          <Choice
            title={t("mobile.tabs.projects")}
            value={projectID()}
            items={app
              .projects()
              .map((project) => ({ value: project.id, title: project.name }))}
            disabled={disabled() || !!taskID()}
            onChange={(value) => {
              projectID.set(value);
              if (directory()) void c.load(directory());
            }}
          />
        </Group>
        <Group title={t("sessions.scheduledTasks.editor.taskName.label")}>
          <Input
            testID="features-task-name"
            class={field}
            value={name()}
            disabled={disabled()}
            onChange={(event) => name.set(event.value)}
            placeholder={t(
              "sessions.scheduledTasks.editor.taskName.placeholder",
            )}
            accessibilityLabel={t(
              "sessions.scheduledTasks.editor.taskName.label",
            )}
          />
        </Group>
        <Group title={t("sessions.scheduledTasks.editor.scheduleType.label")}>
          <Choice
            title={t("sessions.scheduledTasks.editor.scheduleType.label")}
            value={kind()}
            disabled={disabled()}
            items={[
              {
                value: "daily",
                title: t("sessions.scheduledTasks.editor.scheduleType.daily"),
              },
              {
                value: "weekly",
                title: t("sessions.scheduledTasks.editor.scheduleType.weekly"),
              },
              {
                value: "once",
                title: t("sessions.scheduledTasks.editor.scheduleType.once"),
              },
              {
                value: "cron",
                title: t("sessions.scheduledTasks.editor.scheduleType.cron"),
              },
            ]}
            onChange={(value) => { kind.set(value); if (value === "cron" && !cron()) cron.set("0 * * * *"); }}
          />
          <Text class="text-xs text-muted-foreground">
            {t("sessions.scheduledTasks.editor.timezone.label")}
          </Text>
          <Input
            class={field}
            value={timezone()}
            disabled={disabled()}
            onChange={(event) => timezone.set(event.value)}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t(
              "sessions.scheduledTasks.editor.timezone.label",
            )}
          />
          <If when={kind() === "cron"}>
            <Input
              testID="features-cron"
              class={field}
              value={cron()}
              disabled={disabled()}
              onChange={(event) => cron.set(event.value)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t(
                "sessions.scheduledTasks.editor.cronExpression.placeholder",
              )}
              accessibilityLabel={t(
                "sessions.scheduledTasks.editor.cronExpression.label",
              )}
            />
            <If when={cronValidation() !== null && !cronValidation()?.valid}>
              <Text class="text-sm text-destructive">{t("sessions.scheduledTasks.editor.validation.cronInvalid")}</Text>
            </If>
            <If when={formattedRuns().length > 0}>
              <Text testID="features-cron-next-runs" class="text-xs text-muted-foreground">{t("sessions.scheduledTasks.editor.cronExpression.nextRuns")}</Text>
              <Each of={formattedRuns()}>{value => <Text testID="features-cron-next-run" class="text-sm text-muted-foreground">{value()}</Text>}</Each>
            </If>
            <If when={previewLoading()}><Text class="text-sm text-muted-foreground">{t("common.loading")}</Text></If>
            <If when={!!previewError()}>
              <Text testID="features-cron-preview-error" class="text-sm text-destructive">{previewError()}</Text>
            </If>
            <Text class="text-xs text-muted-foreground">{t("sessions.scheduledTasks.editor.cronExpression.examples")}</Text>
            <Each of={CRON_EXAMPLES}>{example => <Button class={action} selected={cron().trim() === example().expression} disabled={disabled()} onPress={() => cron.set(example().expression)}><Text class="text-foreground">{t(example().labelKey as Parameters<typeof t>[0])}</Text><Text class="text-xs text-muted-foreground">{example().expression}</Text></Button>}</Each>
          </If>
          <If when={kind() === "once"}>
            <Text class="text-xs text-muted-foreground">
              {t("sessions.scheduledTasks.editor.date.label")}
            </Text>
            <DatePicker
              testID="features-date"
              value={date()}
              disabled={disabled()}
              onChange={(event) => { if (typeof event.value === "string") date.set(event.value); }}
              popupClass="bg-card rounded-2xl p-3"
              calendarClass="gap-2"
              headerClass="flex-row items-center justify-between min-h-11"
              bodyClass="gap-1"
              rowClass="flex-row gap-1"
              itemClass="min-h-11 min-w-9 items-center justify-center rounded-lg text-foreground selected:bg-accent disabled:opacity-40"
              trigger={<View class={field}><Text class="text-foreground">{date()}</Text></View>}
              accessibilityLabel={t(
                "sessions.scheduledTasks.editor.date.label",
              )}
            />
            <TimeField
              class={field}
              value={time()}
              disabled={disabled()}
              onChange={(event) => time.set(event.value)}
              precision="minute"
              hourCycle="h23"
              segmentClass="min-h-11 min-w-9 text-foreground focus:bg-accent"
              separatorClass="text-foreground"
              accessibilityLabel={t(
                "sessions.scheduledTasks.editor.time.label",
              )}
            />
          </If>
          <If when={kind() === "daily" || kind() === "weekly"}>
            <Text class="text-xs text-muted-foreground">
              {t("sessions.scheduledTasks.editor.times.label")}
            </Text>
            <Each of={times().map((_, index) => index)}>
              {(index) => (
                <View class="flex-row gap-2 items-center">
                  <TimeField
                    class={field + " flex-1"}
                    value={times()[index()] || ""}
                    disabled={disabled()}
                    onChange={(event) =>
                      times.set(
                        times().map((value, i) =>
                          i === index() ? event.value : value,
                        ),
                      )
                    }
                    precision="minute"
                    hourCycle="h23"
                    segmentClass="min-h-11 min-w-9 text-foreground focus:bg-accent"
                    separatorClass="text-foreground"
                    accessibilityLabel={t(
                      "sessions.scheduledTasks.editor.time.label",
                    )}
                  />
                  <Button
                    class={action}
                    disabled={disabled()}
                    accessibilityLabel={t(
                      "sessions.scheduledTasks.editor.times.removeAria",
                    )}
                    onPress={() =>
                      times.set(times().filter((_, i) => i !== index()))
                    }
                  >
                    <Text class="text-foreground">−</Text>
                  </Button>
                </View>
              )}
            </Each>
            <Button
              class={action}
              disabled={disabled()}
              onPress={() => times.set([...times(), "09:00"])}
            >
              <Text class="text-foreground">
                {t("sessions.scheduledTasks.editor.times.add")}
              </Text>
            </Button>
          </If>
          <If when={kind() === "weekly"}>
            <Text class="text-xs text-muted-foreground">
              {t("sessions.scheduledTasks.editor.weekdays.label")}
            </Text>
            <View class="flex-row flex-wrap gap-2">
              <Each of={weekdayItems().map((title, day) => ({ title, day }))}>
                {(item) => (
                  <Button
                    class={action}
                    selected={weekdays().includes(item().day)}
                    disabled={disabled()}
                    onPress={() =>
                      weekdays.set(
                        weekdays().includes(item().day)
                          ? weekdays().filter((day) => day !== item().day)
                          : [...weekdays(), item().day],
                      )
                    }
                  >
                    <Text class="text-foreground">
                      {weekdays().includes(item().day) ? "✓ " : ""}
                      {item().title}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
        </Group>
        <CatalogFields
          catalog={c}
          disabled={disabled()}
          reload={() => {
            if (directory()) void c.load(directory());
            else c.error.set(t('sessions.scheduledTasks.dialog.error.chooseProjectFirst'));
          }}
        />
        <Group title={t("sessions.scheduledTasks.editor.prompt.label")}>
          <TaskEditorPrompt
            fieldClass={field}
            value={prompt()}
            disabled={disabled()}
            onChange={(value) => prompt.set(value)}
            scope={{ host: capturedHost, draft: `task-editor:${projectID()}:${taskID() || creationID}`, directory: directory() }}
            active={props.active}
            current={state.current}
            commandContext={creationContext?.commandContext}
          />
        </Group>
        <Group title={t("sessions.scheduledTasks.editor.goal.label")}>
          <Switch
            testID="features-goal"
            checked={goalEnabled()}
            disabled={disabled()}
            accessibilityLabel={t("sessions.scheduledTasks.editor.goal.aria")}
            class="min-h-11 flex-row items-center gap-3"
            trackClass="w-11 h-6 rounded-full bg-secondary checked:bg-foreground"
            thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-5"
            onChange={event => goalEnabled.set(event.checked)}
          ><Text class="text-foreground">{t("sessions.scheduledTasks.editor.goal.label")}</Text></Switch>
        </Group>
        <Button
          class={action}
          selected={enabled()}
          disabled={disabled()}
          onPress={() => enabled.set(!enabled())}
        >
          <Text class="text-foreground">
            {t("sessions.scheduledTasks.editor.enabled.label")} ·{" "}
            {t(
              enabled()
                ? "sessions.scheduledTasks.dialog.taskToggle.enabled"
                : "sessions.scheduledTasks.dialog.taskToggle.paused",
            )}
          </Text>
        </Button>
        <Feedback state={state} />
        <If when={!state.committed()}>
          <Button
            testID="features-task-cancel"
            class={action}
            disabled={state.busy()}
            onPress={() => {
              void navigation.cancel();
            }}
          >
            <Text class="text-foreground">
              {t("settings.common.actions.cancel")}
            </Text>
          </Button>
        </If>
        <If when={!!taskID() && !state.committed()}>
          <Button
            class={action}
            disabled={state.busy()}
            onPress={() => {
              void remove();
            }}
          >
            <Text class="text-destructive">
              {t("settings.common.actions.delete")}
            </Text>
          </Button>
        </If>
      </Scroll>
    </NavPage>
  );
}
