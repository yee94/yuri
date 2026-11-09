import { cleanup, computed, effect, lifecycle, locale, safeArea, Scroll, signal, Text, untracked, View, windowSize, type JSX } from "nsh";
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
import { id, list, record, text, unwrap, type Row, type ChatTarget } from "./model";
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
import { FeaturesModelPicker } from './features-model-picker';
import { openFeatureReceipt, type FeatureOperation } from './features-receipt';
import { nativeAppearance, nativeDensity } from './appearance';
import { editorCalendarPreferences, editorDateLabel, editorWeekPreference, localEditorDate, type EditorWeekPreference } from './features-calendar';
import { FeaturesTaskHistory } from './features-history';
import { pickerSheetHeight } from './chat-models-helpers';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';

const action =
  "min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center";
const field = "min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground";

function Group(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2" style={nativeDensity().forms.group}>
      <Text class="px-1 text-xs text-muted-foreground" style={nativeDensity().forms.groupLabel}>{props.title}</Text>
      <View class="rounded-2xl bg-card p-4 gap-3" style={nativeDensity().settings.card}>{props.children}</View>
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
      popupStyle={nativeDensity().settings.popup}
      listClass="bg-card"
      itemClass="min-h-12 p-3 rounded-xl text-foreground selected:bg-accent focus:bg-accent"
      itemStyle={nativeDensity().settings.field}
      searchClass={field}
      onChange={(event) => props.onChange(event.value ?? "")}
      trigger={
        <View class={field} style={nativeDensity().settings.field}>
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

function matchesSubmitted(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => matchesSubmitted(value[index], item));
  if (expected && typeof expected === 'object') return Object.entries(record(expected)).every(([key, item]) => matchesSubmitted(record(value)[key], item));
  return value === expected || (expected === '' && (value === undefined || value === null));
}
function completeEditorRows(value: unknown, key: 'assistants' | 'tasks'): Row[] {
  const body = record(value), rows = body[key];
  if (body.ok === false || body.failed === true || body.partial === true || body.complete === false || !Array.isArray(rows) || rows.some(item => !text(record(item).id)) || new Set(rows.map(item => text(record(item).id))).size !== rows.length) throw new Error(t('chat.questionDelegate.uncertain'));
  return rows.map(record);
}

// The scope fence prevents a page opened on one Host from writing to another.
function editorState(onDone: () => void, identity: string, active: () => boolean = () => true) {
  const request = captureHostRequest();
  const scope = epoch(),
    connectionID = app.connection()?.id;
  const busy = signal(false),
    error = signal(""),
    committed = signal(false),
    restoring = signal(true),
    uncertain = signal(false),
    notice = signal("");
  let reconcile: (() => Promise<void>) | undefined;
  let completion = onDone;
  let retryRestoration: () => Promise<void> = async () => {};
  const journal = openFeatureReceipt(connectionID ?? '', identity);
  let initialization: Promise<void> = journal.ready;
  let alive = true;
  cleanup(() => {
    alive = false;
    void journal.close().catch(() => {});
  });
  const current = () =>
    alive && scope === epoch() && connectionID === app.connection()?.id;
  const interactive = () => current() && active() && lifecycle() === 'active';
  function assertCurrent() {
    if (!current()) throw new Error(t("mobile.notifications.identity"));
  }
  async function finish() {
    assertCurrent();
    await refresh();
    assertCurrent();
    if (!interactive()) throw new Error(t('mobile.notifications.identity'));
    await journal.clear();
    assertCurrent();
    completion();
  }
  async function writeRequest(path: string, method: string, body?: unknown) {
    try { if (!interactive()) throw new Error(t('mobile.notifications.identity')); return await request(path, method, body); }
    catch (failure) {
      const status = record(failure).status;
      if (current() && typeof status === 'number' && status >= 400 && status < 500 && status !== 408) { await journal.clear(); uncertain.set(false); }
      throw failure;
    }
  }
  async function perform(work: () => Promise<void>, allowCommitted = false) {
    if (busy() || committed() && !allowCommitted) return;
    busy.set(true);
    error.set("");
    try {
      assertCurrent();
      await initialization;
      assertCurrent();
      if (!interactive()) throw new Error(t('mobile.notifications.identity'));
      await work();
    } catch (failure) {
      if (alive) error.set(failureMessage(failure));
    } finally {
      if (alive) busy.set(false);
    }
  }
  return {
    request,
    writeRequest,
    busy,
    error,
    committed,
    restoring,
    uncertain,
    setCompletion(next: () => void) { completion = next; },
    retryRestore: () => retryRestoration(),
    initialize(restore: (value: Row, operation: FeatureOperation, ack?: Row) => void, recover: (operation: FeatureOperation) => Promise<void>, onReady?: () => void, syncPendingDescription?: string) {
      const load = async (retry = false) => {
        try {
          if (retry) await journal.retry(); else await journal.ready; assertCurrent();
          const saved = journal.value();
          if (saved) {
            restore(saved.draft, saved.operation, saved.ack);
            committed.set(saved.phase === 'acknowledged');
            uncertain.set(saved.phase === 'unknown');
            reconcile = saved.phase === 'unknown' ? () => recover(saved.operation) : undefined;
            if (saved.phase === 'acknowledged') notice.set(t(saved.operation.action === 'delete' ? identity.startsWith('bot:') ? 'assistants.settings.toast.deleted' : 'sessions.scheduledTasks.dialog.toast.deleted' : saved.operation.action === 'run' ? 'sessions.scheduledTasks.dialog.toast.started' : identity.startsWith('bot:') ? 'assistants.settings.toast.saved' : 'sessions.scheduledTasks.dialog.toast.saved'));
            if (saved.phase === 'acknowledged' && saved.ack?.schedulerSynced === false) notice.set(`${notice()}\n${syncPendingDescription ?? t('sessions.scheduledTasks.dialog.status.error')}`);
          } else { committed.set(false); uncertain.set(false); reconcile = undefined; }
          restoring.set(false);
          onReady?.();
        } catch (failure) { if (alive) error.set(failureMessage(failure)); throw failure; }
      };
      retryRestoration = async () => { if (busy() || !current()) return; busy.set(true); error.set(''); initialization = load(true); try { await initialization; } catch { /* load preserves the restore error and the original journal. */ } finally { if (alive) busy.set(false); } };
      initialization = load(); void initialization.catch(() => {}); return initialization;
    },
    async beginWrite(recover: () => Promise<void>, operation: FeatureOperation, draft: Row) { await journal.prepare(operation, draft); assertCurrent(); reconcile = recover; uncertain.set(true); },
    async confirm(ack: Row = {}) { await journal.confirm(ack); assertCurrent(); uncertain.set(false); committed.set(true); },
    recover: async () => { assertCurrent(); if (uncertain() && reconcile) await reconcile(); },
    notice,
    current,
    interactive,
    assertCurrent,
    finish,
    perform,
  };
}

type EditorState = ReturnType<typeof editorState>;
function editorNavigation(state: EditorState, onDone: () => void, snapshot: () => unknown) {
  let pristine = JSON.stringify(snapshot());
  const confirming = signal(false);
  const dirty = () => !state.committed() && (state.uncertain() || JSON.stringify(snapshot()) !== pristine);
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
  return { blocked, cancel, accept(fields: Row) { pristine = JSON.stringify({ ...record(JSON.parse(pristine)), ...fields }); }, back: () => { if (blocked()) void cancel(); } };
}

function Feedback(props: { state: EditorState }) {
  return (
    <View class="gap-2" style={nativeDensity().forms.compact}>
      <If when={!!props.state.notice()}>
        <Text class="text-sm text-muted-foreground">
          {props.state.notice()}
        </Text>
      </If>
      <If when={!!props.state.error()}>
        <Text class="text-sm text-destructive">{props.state.error()}</Text>
      </If>
      <If when={props.state.restoring() && !!props.state.error()}><Button testID="features-restore-retry" class={action} style={nativeDensity().forms.action} disabled={props.state.busy()} onPress={() => { void props.state.retryRestore(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      <If when={props.state.uncertain() && !props.state.busy()}><Text testID="features-write-uncertain" class="text-sm text-destructive">{t('chat.questionDelegate.uncertain')}</Text></If>
      <If when={props.state.committed()}>
        <Button
          class={action}
          style={nativeDensity().forms.action}
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
        if (includeAgent && body.partial !== true) {
          const provider = list(body.providers).find(item => item.id === providerID());
          const model = Object.values(record(provider?.models)).map(record).find(item => item.id === modelID());
          if (model && variant() && !Object.prototype.hasOwnProperty.call(record(model.variants), variant())) variant.set('');
        }
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
    current: state.interactive,
    request,
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
      <FeaturesModelPicker providers={c.providers()} selected={{ providerID: c.providerID(), modelID: c.modelID(), variant: c.variant() }} disabled={props.disabled} loading={c.loading()} partial={c.partial()} error={c.error()} current={c.current} request={c.request} reload={props.reload} onChange={value => { c.providerID.set(value.providerID); c.modelID.set(value.modelID); c.variant.set(value.variant ?? ''); }} />
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
      <Button
        class={action}
        style={nativeDensity().forms.action}
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

export function BotEditor(props: { bot?: Row; onDone: () => void; children?: JSX.Element; defaultContext?: { directory?: string; selection?: BotDefaultSelection }; active?: boolean; onNavigation?: (requestLeave: ((afterLeave?: () => void) => Promise<void>) | null) => void }) {
  const state = editorState(props.onDone, `bot:${text(props.bot?.id) || 'new'}`, () => props.active !== false),
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
  const disabled = () => !state.interactive() || state.restoring() || state.busy() || state.committed() || state.uncertain() || defaultsLoading();
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
  const draftSnapshot = () => ({ name: name(), prompt: prompt(), workspace: workspace(), avatarSeed: avatarSeed(), providerID: c.providerID(), modelID: c.modelID(), variant: c.variant() });
  void state.initialize((value, _operation, ack) => {
    for (const [key, field] of Object.entries({ name, prompt, workspace, avatarSeed, providerID: c.providerID, modelID: c.modelID, variant: c.variant })) {
      if (typeof value[key] !== 'string') throw new Error('invalid-feature-draft'); field.set(value[key]);
    }
    defaultsApplied = true;
    if (text(ack?.id) && Number.isSafeInteger(ack?.revision)) { botID.set(text(ack?.id)); revision.set(ack?.revision); }
  }, recoverOperation, () => { void c.load(directory()); if (!props.bot && !state.uncertain() && !state.committed()) void loadCreationDefaults(); }).catch(() => {});
  async function recoverOperation(operation: FeatureOperation) {
    const snapshot = record(await request('/api/yuri/assistants/snapshot'));
    state.assertCurrent();
    const bots = completeEditorRows(snapshot, 'assistants');
    if (operation.action === 'delete') {
      if (bots.some(item => item.id === operation.resourceID)) throw new Error(t('chat.questionDelegate.uncertain'));
      await state.confirm(); state.notice.set(t('assistants.settings.toast.deleted')); await state.finish(); return;
    }
    let live = bots.find(item => item.id === operation.resourceID);
    if (!operation.resourceID) {
      const candidates = bots.filter(item => !operation.beforeIDs?.includes(text(item.id)) && matchesSubmitted(item, operation.body));
      if (!candidates.length) throw new Error(t('chat.questionDelegate.uncertain'));
      const answer = await AlertDialog.show({ title: t('chat.questionDelegate.refreshStatus'), description: t('chat.questionDelegate.uncertain'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, ...candidates.map(item => ({ id: text(item.id), label: `${text(item.name)} · ${text(item.id)} · ${text(item.providerID)}/${text(item.modelID)}` }))] });
      state.assertCurrent(); live = candidates.find(item => item.id === answer.action);
      if (live) { const verified = completeEditorRows(await request('/api/yuri/assistants/snapshot'), 'assistants'); state.assertCurrent(); live = verified.find(item => item.id === answer.action); }
    }
    if (!live || !Number.isSafeInteger(live.revision) || typeof operation.expectedRevision === 'number' && Number(live.revision) <= operation.expectedRevision || !matchesSubmitted(live, operation.body)) throw new Error(t('chat.questionDelegate.uncertain'));
    botID.set(text(live.id)); revision.set(live.revision); await state.confirm(live); state.notice.set(t('assistants.settings.toast.saved')); await state.finish();
  }
  async function save() {
    if (state.restoring()) return;
    if (state.uncertain()) { await state.perform(state.recover); return; }
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
      const expectedID = botID(), expectedRevision = revision();
      let beforeIDs: string[] | undefined;
      if (!expectedID) { const before = completeEditorRows(await request('/api/yuri/assistants/snapshot'), 'assistants'); state.assertCurrent(); beforeIDs = before.map(item => text(item.id)); }
      const operation: FeatureOperation = { action: 'save', method: expectedID ? 'PATCH' : 'POST', path: expectedID ? `/api/yuri/assistants/${encodeURIComponent(expectedID)}` : '/api/yuri/assistants', resourceID: expectedID, body, ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}), ...(beforeIDs ? { beforeIDs } : {}) };
      await state.beginWrite(() => recoverOperation(operation), operation, draftSnapshot());
      const response = record(
        await state.writeRequest(
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
        (!!expectedID && response.id !== expectedID) ||
        !Number.isSafeInteger(response.revision) ||
        Number(response.revision) < 1 ||
        (typeof expectedRevision === 'number' && Number(response.revision) <= expectedRevision)
      )
        throw new Error(
          text(response.message) || t("assistants.settings.toast.saveFailed"),
        );
      botID.set(text(response.id));
      revision.set(response.revision);
      await state.confirm(response);
      state.notice.set(t("assistants.settings.toast.saved"));
      await state.finish();
    });
  }
  async function remove() {
    if (state.restoring()) return;
    if (state.uncertain()) return;
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
      const expectedID = botID();
      const operation: FeatureOperation = { action: 'delete', method: 'DELETE', path: `/api/yuri/assistants/${encodeURIComponent(expectedID)}`, resourceID: expectedID };
      await state.beginWrite(() => recoverOperation(operation), operation, draftSnapshot());
      const response = record(
        await state.writeRequest(
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
        typeof response.tombstoneAt !== "number" || !Number.isFinite(response.tombstoneAt)
      )
        throw new Error(t("assistants.settings.toast.deleteFailed"));
      await state.confirm(response);
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
      headerRight={<Button testID="features-bot-save" class={action} style={nativeDensity().forms.action} disabled={state.restoring() || state.busy() || state.committed() || defaultsLoading()} accessibilityLabel={t(state.uncertain() ? 'chat.questionDelegate.refreshStatus' : "assistants.settings.save")} onPress={() => { void save(); }}><Text class="text-foreground">{state.busy() ? t("sessions.scheduledTasks.editor.actions.saving") : t(state.uncertain() ? 'chat.questionDelegate.refreshStatus' : "assistants.settings.save")}</Text></Button>}
      title={
        props.bot
          ? t("assistants.title")
          : t("assistants.settings.create")
      }
      class="flex-1 bg-background"
    >
      <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
        <If when={defaultsLoading()}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={!!defaultsError()}><Text testID="features-bot-defaults-error" class="text-destructive">{defaultsError()}</Text><Button testID="features-bot-defaults-retry" class={action} style={nativeDensity().forms.action} disabled={defaultsLoading()} onPress={() => { void loadCreationDefaults(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
        <AssistantAvatarPicker seed={avatarSeed()} disabled={disabled()} onChange={value => avatarSeed.set(value)} />
        <Group title={t("assistants.settings.name")}>
          <Input
            testID="features-bot-name"
            class={field}
            style={nativeDensity().settings.field}
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
            style={{ ...nativeDensity().settings.field, minHeight: 144 * nativeDensity().scale }}
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
            style={nativeDensity().forms.action}
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
          <If when={!!state.error() && !state.uncertain()}>
            <Button
              class={action}
              style={nativeDensity().forms.action}
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
            style={nativeDensity().forms.action}
            disabled={state.busy() || state.uncertain()}
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
  onOpenSession?: (target: ChatTarget) => void;
  onOpenHistory?: (() => void) | ((identity: { projectId: string; taskId: string }) => void);
};
export function TaskEditor(props: TaskEditorProps) {
  const desktop = props.presentation === 'desktop' ? createTaskEditorOwner(() => props.active !== false, () => props.interactive !== false, props.onDone) : null;
  const state = desktop ?? editorState(props.onDone, `task:${text(props.item?.projectId)}:${text(record(props.item?.task).id) || 'new'}`, () => props.active !== false),
    request = state.request,
    task = record(props.item?.task),
    schedule = record(task.schedule),
    execution = record(task.execution);
  const taskID = signal(text(task.id));
  const savedTask = signal(task);
  const taskAuthority = savedTask, historyOpen = signal(false), historyMounted = signal(false);
  const creationID = `task_${id()}`;
  const creationContext = props.creationContext && { ...props.creationContext, selection: { ...props.creationContext.selection }, ...(props.creationContext.commandContext ? { commandContext: { ...props.creationContext.commandContext } } : {}) };
  const capturedHost = app.connection()?.id || '';
  const calendarLocale = () => language() === 'system' ? locale() : language();
  const weekPreference = signal<EditorWeekPreference | null>(null), calendarError = signal('');
  const appearance = () => { const value = nativeAppearance.current(); return value?.sourceHost && value.sourceHost.hostID !== capturedHost ? null : value; };
  const calendarPreferences = computed(() => editorCalendarPreferences(appearance(), calendarLocale(), weekPreference()));
  async function loadCalendarPreferences() {
    calendarError.set('');
    if (record(appearance()).weekStartPreference !== undefined) return;
    try { const value = editorWeekPreference(await request('/api/config/settings')); if (state.current()) weekPreference.set(value); }
    catch { if (state.current()) calendarError.set(t('common.unavailable')); }
  }
  const projectID = signal(
    taskEditorProject(props.item, creationContext, app.projects()),
  );
  const name = signal(text(task.name)),
    prompt = signal(text(execution.prompt)),
    goalEnabled = signal(execution.goalEnabled === true),
    enabled = signal(task.enabled !== false);
  const kind = signal(text(schedule.kind) || "daily"),
    timezone = signal(text(schedule.timezone) || new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const candidates = Array.isArray(schedule.times) ? schedule.times : [schedule.time];
  const validTimes = [...new Set(candidates.filter((value): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))].sort();
  const initialTimes = validTimes.length ? validTimes : ['09:00'];
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
  const disabled = () => desktop ? state.busy() || state.committed() || !desktop.admitted() || desktop.unknown() : !state.interactive() || state.restoring() || state.busy() || state.committed() || state.uncertain();
  const weekdayItems = () => { const days = [
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.sun"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.mon"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.tue"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.wed"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.thu"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.fri"),
    t("sessions.scheduledTasks.dialog.schedule.weekdayShort.sat"),
  ].map((title, day) => ({ title, day })); const first = calendarPreferences().weekStartsOn; return [...days.slice(first), ...days.slice(0, first)]; };
  if (desktop) {
    const catalogDirectory = computed(directory);
    effect(() => { const available = desktop.current(), value = catalogDirectory(); untracked(() => { if (available && value) void c.load(value); }); });
  }
  const draftSnapshot = () => ({ projectID: projectID(), name: name(), prompt: prompt(), enabled: enabled(), goalEnabled: goalEnabled(), kind: kind(), timezone: timezone(), times: times(), time: time(), date: date(), cron: cron(), weekdays: weekdays(), providerID: c.providerID(), modelID: c.modelID(), agent: c.agent(), variant: c.variant() });
  if (!desktop) void state.initialize((value, operation, ack) => {
    for (const [key, field] of Object.entries({ projectID, name, prompt, kind, timezone, time, date, cron, providerID: c.providerID, modelID: c.modelID, agent: c.agent, variant: c.variant })) {
      if (typeof value[key] !== 'string') throw new Error('invalid-feature-draft'); field.set(value[key]);
    }
    if (typeof value.enabled !== 'boolean' || typeof value.goalEnabled !== 'boolean' || !Array.isArray(value.times) || value.times.some(item => typeof item !== 'string') || !Array.isArray(value.weekdays) || value.weekdays.some(item => typeof item !== 'number')) throw new Error('invalid-feature-draft');
    enabled.set(value.enabled); goalEnabled.set(value.goalEnabled); times.set(value.times as string[]); weekdays.set(value.weekdays as number[]);
    if (operation.resourceID) taskID.set(operation.resourceID);
    if (operation.action === 'run' || operation.action === 'toggle') {
      state.setCompletion(finishAction);
      if (record(ack?.task).id === operation.resourceID) {
        taskAuthority.set(record(ack?.task));
        if (operation.action === 'toggle') { enabled.set(record(ack?.task).enabled === true); navigation.accept({ enabled: enabled() }); }
      }
    }
  }, recoverOperation, () => { if (directory()) void c.load(directory()); void loadCalendarPreferences(); }, props.syncPendingDescription).catch(() => {});
  async function recoverOperation(operation: FeatureOperation) {
    const collection = /^(\/api\/projects\/[^/]+\/scheduled-tasks)(?:\/[^/]+(?:\/run)?)?$/.exec(operation.path)?.[1];
    if (!collection) throw new Error('invalid-feature-operation');
    const snapshot = record(await request(collection));
    state.assertCurrent();
    const tasks = completeEditorRows(snapshot, 'tasks');
    if (operation.action === 'delete') { if (tasks.some(item => item.id === operation.resourceID)) throw new Error(t('chat.questionDelegate.uncertain')); await saved({ tasks }, true); return; }
    const live = tasks.find(item => item.id === operation.resourceID), expected = record(operation.body?.task), expectedExecution = record(expected.execution);
    if (operation.action === 'toggle') {
      if (!live || live.enabled !== expected.enabled) throw new Error(t('chat.questionDelegate.uncertain'));
      await acceptAction(live, 'toggle'); return;
    }
    if (operation.action === 'run') {
      const after = record(live?.state), before = record(operation.body);
      if (!live || typeof after.lastRunAt !== 'number' || after.lastRunAt <= Number(before.lastRunAt ?? 0) || !text(after.lastSessionId)) throw new Error(t('chat.questionDelegate.uncertain'));
      const answer = await AlertDialog.show({ title: t('chat.questionDelegate.refreshStatus'), description: `${t('chat.questionDelegate.uncertain')}\n${text(after.lastSessionId)}\n${new Date(after.lastRunAt).toLocaleString()}`, actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'confirm', label: t('gitView.common.done') }] });
      state.assertCurrent(); if (answer.action !== 'confirm') return;
      await acceptAction(live, 'run'); return;
    }
    const liveValue = live && { ...live, execution: { ...record(live.execution), goalEnabled: record(live.execution).goalEnabled === true } };
    const expectedValue = { ...expected, execution: { prompt: text(expectedExecution.prompt).trim(), providerID: text(expectedExecution.providerID).trim(), modelID: text(expectedExecution.modelID).trim(), agent: text(expectedExecution.agent).trim(), variant: text(expectedExecution.variant).trim(), goalEnabled: expectedExecution.goalEnabled === true } };
    if (!liveValue || !matchesSubmitted(liveValue, expectedValue)) throw new Error(t('chat.questionDelegate.uncertain'));
    await saved({ task: live });
  }
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
      ...(kind() === "weekly" ? { weekdays: [...new Set(weekdays())].sort((a, b) => a - b) } : {}),
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
    if (!deleted) savedTask.set(record(response.task));
    if (desktop) state.committed.set(true);
    else await state.confirm(response);
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
    if (!desktop && state.restoring()) return;
    if (!desktop && state.uncertain()) { await state.perform(state.recover); return; }
    await state.perform(async () => {
      if (!desktop) state.setCompletion(props.onDone);
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
      if (!desktop) {
        const capturedBase = base();
        const operation: FeatureOperation = { action: 'save', method: taskID() ? 'PATCH' : 'PUT', path: capturedBase, resourceID: value.id, body: { task: value } };
        await state.beginWrite(() => recoverOperation(operation), operation, draftSnapshot());
      }
      await saved(record(await (desktop ? state.request : state.writeRequest)(base(), taskID() ? 'PATCH' : 'PUT', { task: value })));
    });
  }
  async function remove() {
    if (!desktop && (state.restoring() || state.uncertain())) return;
    await state.perform(async () => {
      if (!desktop) state.setCompletion(props.onDone);
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
      if (!desktop) {
        const capturedBase = base(), expectedID = taskID();
        const operation: FeatureOperation = { action: 'delete', method: 'DELETE', path: `${capturedBase}/${encodeURIComponent(expectedID)}`, resourceID: expectedID };
        await state.beginWrite(() => recoverOperation(operation), operation, draftSnapshot());
      }
      await saved(
        record(await (desktop ? state.request : state.writeRequest)(`${base()}/${encodeURIComponent(taskID())}`, 'DELETE')),
        true,
      );
    });
  }
  async function desktopTaskAction(kind: 'run' | 'toggle') {
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
  function finishAction() { state.committed.set(false); }
  async function acceptAction(live: Row, action: 'run' | 'toggle', response: Row = { task: live }) {
    state.assertCurrent(); noteScheduledCatalogWrite();
    taskAuthority.set(live);
    if (action === 'toggle') { enabled.set(live.enabled === true); navigation.accept({ enabled: enabled() }); }
    await state.confirm(response);
    state.notice.set(t(action === 'run' ? 'sessions.scheduledTasks.dialog.toast.started' : 'sessions.scheduledTasks.dialog.toast.saved'));
    if (response.schedulerSynced === false) { state.notice.set(`${state.notice()}\n${props.syncPendingDescription ?? t('sessions.scheduledTasks.dialog.status.error')}`); await refresh(); return; }
    await state.finish();
  }
  async function taskAction(action: 'run' | 'toggle') {
    if (desktop || disabled() || props.active === false || !taskID()) return;
    await state.perform(async () => {
      state.setCompletion(finishAction);
      const capturedBase = base(), snapshot = record(await request(capturedBase)); state.assertCurrent();
      const live = completeEditorRows(snapshot, 'tasks').find(item => item.id === taskID());
      if (!live) throw new Error(t('sessions.scheduledTasks.dialog.empty.noTasks'));
      if (action === 'run' && (live.enabled !== true || record(live.state).lastStatus === 'running')) throw new Error(t('sessions.scheduledTasks.dialog.toast.runFailed'));
      const operation: FeatureOperation = { action, method: action === 'run' ? 'POST' : 'PATCH', path: action === 'run' ? `${capturedBase}/${encodeURIComponent(taskID())}/run` : capturedBase, resourceID: taskID(), body: action === 'toggle' ? { task: { id: taskID(), enabled: !live.enabled } } : { lastRunAt: record(live.state).lastRunAt ?? 0 } };
      await state.beginWrite(() => recoverOperation(operation), operation, draftSnapshot());
      const response = record(await state.writeRequest(operation.path, operation.method, action === 'toggle' ? operation.body : undefined)); state.assertCurrent();
      const updated = record(response.task);
      if (response.ok === false || response.failed === true || response.partial === true || updated.id !== taskID() || action === 'run' && response.ok !== true || action === 'toggle' && updated.enabled !== record(operation.body?.task).enabled) throw new Error(t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      await acceptAction(updated, action, response);
    });
  }
  async function menu() {
    if (disabled() || props.active === false || !taskID()) return;
    let choice = '';
    await state.perform(async () => { const answer = await AlertDialog.show({ title: text(taskAuthority().name), presentation: 'actionSheet', actions: [
      { id: 'run', label: t('sessions.scheduledTasks.dialog.actions.runNow') },
      { id: 'history', label: t('sessions.scheduledTasks.workspace.views.history') },
      { id: 'toggle', label: t(taskAuthority().enabled ? 'sessions.scheduledTasks.dialog.actions.pause' : 'sessions.scheduledTasks.dialog.actions.resume') },
      { id: 'delete', label: t('sessions.scheduledTasks.dialog.actions.delete'), role: 'destructive' },
      { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
    ] }); state.assertCurrent(); choice = text(answer.action); });
    if (!state.current()) return;
    if (choice === 'delete') await remove();
    if (choice === 'run' || choice === 'toggle') await taskAction(choice);
    if (choice === 'history') {
      const identity = { projectId: projectID(), taskId: taskID() };
      if (props.onOpenHistory) await navigation.cancel(() => { const open = props.onOpenHistory!; if (open.length) (open as (identity: { projectId: string; taskId: string }) => void)(identity); else (open as () => void)(); });
      else { historyMounted.set(true); historyOpen.set(true); }
    }
  }
  if (desktop) return <TaskEditorDesktop form={{ taskID, name, prompt, goalEnabled, enabled, projectID, kind, timezone, times, time, date, cron, weekdays }} catalog={c} owner={desktop} savedTask={savedTask()} disabled={disabled()} creationContext={creationContext} directory={directory()} capturedHost={capturedHost} creationID={creationID}
    active={props.active !== false} onClose={() => { void navigation.cancel(); }} onSave={() => { void save(); }} onDelete={() => { void remove(); }} onRun={() => { void desktopTaskAction('run'); }} onToggle={() => { void desktopTaskAction('toggle'); }} onHistory={props.onOpenHistory ? () => { void navigation.cancel(() => { const open = props.onOpenHistory!; if (open.length === 0) (open as () => void)(); }); } : undefined}
    onRecover={() => { void recover(); }} onFinish={() => { void state.perform(state.finish, true); }} onReload={() => { if (desktop.admitted() && directory()) void c.load(directory()); }}
    preview={{ runs: formattedRuns(), loading: previewLoading(), error: previewError(), valid: cronValidation()?.valid !== false }} />;
  return (
    <NavPage
      headerBackTitle=""
      popOnBack={!navigation.blocked()}
      popOnSwipe={!navigation.blocked()}
      onBackPress={navigation.back}
      headerRight={<View class="flex-row gap-2 items-center" style={nativeDensity().forms.inline}><If when={!!taskID()}><Button testID="features-task-more" class="min-h-11 min-w-11 items-center justify-center" disabled={disabled()} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: name() })} onPress={() => { void menu(); }}><Icon name="more" size={20} /></Button></If><Button testID="features-task-save" class={action} style={nativeDensity().forms.action} disabled={state.restoring() || state.busy() || state.committed()} accessibilityLabel={t(state.uncertain() ? 'chat.questionDelegate.refreshStatus' : "sessions.scheduledTasks.editor.actions.save")} onPress={() => { void save(); }}><Text class="text-foreground">{t(state.busy() ? "sessions.scheduledTasks.editor.actions.saving" : state.uncertain() ? 'chat.questionDelegate.refreshStatus' : "sessions.scheduledTasks.editor.actions.save")}</Text></Button></View>}
      title={t(
        props.item
          ? "sessions.scheduledTasks.editor.title.edit"
          : "sessions.scheduledTasks.editor.title.new",
      )}
      class="flex-1 bg-background"
    >
      <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.editor}>
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
            style={nativeDensity().settings.field}
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
          <If when={!!calendarError()}><Text testID="features-calendar-error" class="text-destructive">{calendarError()}</Text><Button class={action} style={nativeDensity().forms.action} onPress={() => { void loadCalendarPreferences(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
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
            testID="features-timezone"
            class={field}
            style={nativeDensity().settings.field}
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
              style={nativeDensity().settings.field}
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
            <Each of={CRON_EXAMPLES}>{example => <Button class={action} style={nativeDensity().forms.action} selected={cron().trim() === example().expression} disabled={disabled()} onPress={() => cron.set(example().expression)}><Text class="text-foreground">{t(example().labelKey as Parameters<typeof t>[0])}</Text><Text class="text-xs text-muted-foreground">{example().expression}</Text></Button>}</Each>
          </If>
          <If when={kind() === "once"}>
            <Text class="text-xs text-muted-foreground">
              {t("sessions.scheduledTasks.editor.date.label")}
            </Text>
            <DatePicker
              testID="features-date"
              value={date()}
              firstDayOfWeek={calendarPreferences().weekStartsOn}
              disabledMatcher={{ before: localEditorDate(today) }}
              disabled={disabled()}
              onChange={(event) => { if (typeof event.value === "string" && event.value >= localEditorDate(today)) date.set(event.value); }}
              popupClass="bg-card rounded-2xl p-3"
              calendarClass="gap-2"
              headerClass="flex-row items-center justify-between min-h-11"
              bodyClass="gap-1"
              rowClass="flex-row gap-1"
              itemClass="min-h-11 min-w-9 items-center justify-center rounded-lg text-foreground selected:bg-accent disabled:opacity-40"
              trigger={<View class={field} style={nativeDensity().settings.field}><Text class="text-foreground">{editorDateLabel(date(), calendarLocale())}</Text></View>}
              accessibilityLabel={t(
                "sessions.scheduledTasks.editor.date.label",
              )}
            />
            <TimeField
              testID="features-once-time"
              class={field}
              style={nativeDensity().settings.field}
              value={time()}
              disabled={disabled()}
              onChange={(event) => time.set(event.value)}
              precision="minute"
              hourCycle={calendarPreferences().hourCycle}
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
                <View class="flex-row gap-2 items-center" style={nativeDensity().forms.inline}>
                  <TimeField
                    testID="features-daily-time"
                    class={field + " flex-1"}
                    style={nativeDensity().settings.field}
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
                    hourCycle={calendarPreferences().hourCycle}
                    segmentClass="min-h-11 min-w-9 text-foreground focus:bg-accent"
                    separatorClass="text-foreground"
                    accessibilityLabel={t(
                      "sessions.scheduledTasks.editor.time.label",
                    )}
                  />
                  <Button
                    testID="features-time-remove"
                    class={action}
                    style={nativeDensity().forms.action}
                    disabled={disabled()}
                    accessibilityLabel={t(
                      "sessions.scheduledTasks.editor.times.removeAria",
                    )}
                    onPress={() =>
                      times.set(times().length === 1 ? ['09:00'] : times().filter((_, i) => i !== index()))
                    }
                  >
                    <Text class="text-foreground">−</Text>
                  </Button>
                </View>
              )}
            </Each>
            <Button
              testID="features-time-add"
              class={action}
              style={nativeDensity().forms.action}
              disabled={disabled()}
              onPress={() => times.set([...times(), "12:00"])}
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
            <View class="flex-row flex-wrap gap-2" style={nativeDensity().forms.inline}>
              <Each of={weekdayItems()}>
                {(item) => (
                  <Button
                    class={action}
                    style={nativeDensity().forms.action}
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
            style={{ minHeight: 44, gap: 12 * nativeDensity().scale }}
            trackClass="w-11 h-6 rounded-full bg-secondary checked:bg-foreground"
            thumbClass="w-5 h-5 rounded-full bg-background checked:translate-x-5"
            onChange={event => goalEnabled.set(event.checked)}
          ><Text class="text-foreground">{t("sessions.scheduledTasks.editor.goal.label")}</Text></Switch>
        </Group>
        <Button
          class={action}
          style={nativeDensity().forms.action}
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
            style={nativeDensity().forms.action}
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
            style={nativeDensity().forms.action}
            disabled={state.busy() || state.uncertain()}
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
      <NativeSheet open={historyOpen()} closeOnSwipe closeOnBackdropPress closeOnEscape detents={[.72, .98]} popupClass="h-full bg-background" popupStyle={{ height: pickerSheetHeight(windowSize().height, safeArea()) }} onOpenChange={event => historyOpen.set(event.open)} onClose={() => historyMounted.set(false)}><If when={historyMounted()}><FeaturesTaskHistory identity={{ projectId: projectID(), taskId: taskID() }} active={historyOpen() && props.active !== false} close={() => historyOpen.set(false)} onOpenSession={props.onOpenSession ? target => { historyOpen.set(false); void navigation.cancel(() => props.onOpenSession?.(target)); } : undefined} /></If></NativeSheet>
    </NavPage>
  );
}
