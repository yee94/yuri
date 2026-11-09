import {
  batch,
  cleanup,
  computed,
  effect,
  host,
  Image,
  keymap,
  Keyboard,
  keyboardFrame,
  openUrl,
  lifecycle,
  List,
  Overlay,
  safeArea,
  Scroll,
  setColorScheme,
  signal,
  Speech,
  Storage,
  Text,
  untracked,
  View,
  windowSize,
  type JSX,
  type ViewRef,
  type ListRef,
  type SpeechSession,
  type InputRef,
} from "nsh";
import {
  AlertDialog,
  Button,
  createNavStack,
  Input,
  NavPage,
  NavStack,
  TextView,
} from "nsh/base";
import { NativeSelect as Select } from './native-select';
import { createChatChromeState, createNativeChatChrome } from './chat-chrome';
import { NativeChatHeaderCollapse } from './chat-chrome-native';
import { NativeComposerChrome } from './chat-chrome-surfaces';
import { TabBar } from "nsh/mobile";
import { language, t } from "./i18n";
import {
  id,
  list,
  nameOf,
  record,
  text,
  unwrap,
  type ChatTarget,
  type ContactAttachment,
  type Project,
  type Row,
} from "./model";
import { assistantPath, connectionSnapshotFrom, native, query, request, sessionPath } from "./runtime";
import { createPageOperations } from './page-operations';
import { attachmentFrom } from './attachments';
import {
  app,
  createChat,
  captureHostRequest,
  captureHostOperation,
  awaitNotificationCatalogReady,
  epoch,
  loadConnections,
  observeRuntime,
  refresh,
  report,
  reportOwnedError,
  registerFeedbackPageOwner,
  run,
  runtimeLifecycle,
  switchConnection,
} from "./state";
import { assistantAvatarSvg } from "../ui/src/lib/assistant-avatar/engine";
import { BotEditor, TaskEditor } from "./features";
import { createBotCreationContext, type BotDefaultContext } from './features-bot-defaults';
import type { TaskEditorCreationContext } from './task-editor-defaults';
import type { ConnectionEditorMutation, ConnectionEditorSnapshot } from './connection-editor-core';
import { NativeConnectionEditor, type ConnectionEditorNavigation } from './connection-editor';
import { BlockingRequests } from "./blocking";
import { Icon } from './Icon';
import { YuriMark, YuriWordmark } from './branding';
import { ChatModels } from './chat-models';
import { ChatHeaderActions, NativeChatHeader, type ChatHeaderOption } from './chat-header';
import { compileNativePrompt, magicCommand } from './composer';
import { NativeCommandSuggestions } from './composer-controls';
import { NativeComposerPress } from './native-composer-press';
import { nativeComposerSurface } from './composer-surface';
import { NativeInputMetadata } from './native-input-metadata';
import { NativeComposerSpellcheck } from './native-composer-spellcheck';
import { createChatComposerCommands } from './chat-composer-commands';
import { isNativeBtwCommand, type NativeCommandIntent } from './composer-command-router';
import { createNativeBtwOwner, NativeBtwSheet } from './chat-btw';
import { NativeChatTimeline } from './chat-timeline';
import { ContactAttachmentPreview, resolveResourceLink } from './resources';
import { ResourceFilesPage, ResourcePreviewPage } from './resource-navigation';
import { createResourceConnectionClear } from './resource-retirement';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { resourcePath, resourceWithin } from './resources-model';
import { NativeChatQueue, NativeDraftFeedback } from './chat-queue';
import { NativeChatMcp } from './chat-mcp';
import { NativeChangesSheet, NativeComposerChanges } from './chat-changes';
import type { ChangesSource } from './chat-changes-model';
import { NativeComposerSelection } from './chat-composer-selection';
import { NativeComposerSend } from './composer-send';
import { nativeDensity } from './appearance';
import { NativeReferencePicker } from './composer-references-controls';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { nativeAppearance, nativeChatTextStyle, nativeCodeTextViewStyles } from './appearance';
import { createNativeTranscriptHistory, NativeMessageActions } from './transcript-actions';
import { NativeTranscriptBody } from './transcript-body';
import { createNativeHistoryRows } from './history-rows';
import { createNativeHistoryScroll } from './history-scroll';
import { createNativeHistoryFocus, type NativeHistoryFocusState } from './history-focus';
import { createNativeHistoryFooterController } from './history-footer-controller';
import { createNativePendingHeaders, nativeTurnHeaderMessage, nativeTurnPresentation, nativeUserActionsVisible } from './transcript-tools-turn-model';
import { createNativeTurnModelNames, NativeTurnError, NativeTurnHeader } from './transcript-tools-turn';
import { ProjectsHome, ProjectDetail, type ProjectsNavigation } from './projects';
import { ProjectsHomeSheet, type ProjectHomeSheetIntent } from './projects-home-sheet';
import { ProjectDirectoryPage } from './projects-directory';
import { ProjectsSearchPage, type ProjectSearchCommand } from './projects-search';
import { NativeSessionSwitcherPage } from './session-switcher';
import { projectsAttention } from './projects-attention';
import { ScheduledHome, ScheduledTaskDetail } from './schedules';
import { AssistantHome, AssistantDetails, AssistantSettings, assistantChatTarget } from './assistants';
import { SETTINGS_ENTRIES, SettingsHome, SettingsPage, type SettingsRoute, type SettingsCallbacks } from './settings';
import { SettingsQuotaCredentialsPage } from './settings-quota-credentials';
import type { QuotaCredentialProvider } from './settings-quota-credentials-core';
import { ContextUsageRoute } from './context-usage-route';
import { createNativeRetentionOwner } from './settings-retention';
import type { RetentionController } from './settings-retention-controller';
import { NativeAppearanceSync } from './appearance';
import { NativeAppearanceFeedback } from './appearance-feedback';
import { NativeFeedbackLayer } from './error-notice';
import { NativeRootErrorFeedback, rootErrorVisible } from './root-error-feedback';
import { NativeDeviceChatPreferences } from './device-chat-preferences-root';
import { deviceChatPreferences } from './settings-preferences-device';
import { createAttachmentPick } from './attachment-pick';
import { createNativeSpeech, NativeSpeechSettingsError } from './speech';
import { createNativeAutoRead } from './native-auto-read';
import { NativeRemoteDesktopPage } from './remote-desktop';
import { NativeNewSessionPage } from './new-session-page';
import type { NativeNewSessionPageHandoff } from './new-session';
import { createNewSessionAdmission, type NewSessionAdmissionState } from './new-session-admission';
import { NativeGoalChip, NativeGoalObjectiveCounter, NativeGoalRow } from './chat-goal';
import { createNativeChatStatusPopovers, NativeComposerTasks } from './chat-tasks';
import { createNativeNotificationRoot, nativeNotificationScope } from './notification-root';
import { nativeNotificationAuthorization } from './notification-runtime';
import { createNativeAboutDiagnosticsRoot } from './settings-about-root';
import { createNativeSetupTour, NativeSetupTourPage, type SetupTourDetail } from './setup-tour';
import { NativeSetupTourDetailPage } from './setup-tour-details';
import { createNativeHistoryImport, NativeHistoryImportTaskEntry, NativeHistoryImportTasksPage } from './history-import';
import { createSetupTourProgress } from './setup-tour-progress';
import type { HistoryImportController } from './history-import-core';
import { createSettingsVoiceRecognitionAdapter } from './settings-voice-recognition';
import type { VoiceTestAsrAdapter } from './settings-voice-test-core';

const action =
  "min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center";
const quiet =
  "min-h-11 px-3 py-2 rounded-xl active:bg-accent items-center justify-center";
const field = "min-h-12 px-3 py-3 rounded-xl bg-card text-foreground";
const appearancePreference = signal<"system" | "light" | "dark">("system");
type TourOwner = { id: string; hostID: string; identity: string; directory?: string; controller: ReturnType<typeof createNativeSetupTour> };
type Route =
  | { kind: "root" }
  | { kind: "connect"; link?: string; edit?: ConnectionEditorMutation }
  | { kind: 'connection-editor'; id: string; mode: 'rename' | 'edit' }
  | { kind: "project"; project: Project; createWorktree?: boolean }
  | { kind: "chat"; target: ChatTarget; messageID?: string; handoff?: NativeNewSessionPageHandoff }
  | { kind: 'new-session'; project?: Project; directory?: string }
  | { kind: 'project-directory' }
  | { kind: 'remote-desktop' }
  | { kind: 'project-search'; directory?: string }
  | { kind: 'session-switcher'; source?: ChatTarget }
  | { kind: "files"; directory: string; path: string; registering?: boolean; sessionId?: string }
  | { kind: "preview"; title: string; content: string }
  | { kind: 'resource-preview'; directory: string; path: string; targetLine?: number; expectedHost?: RuntimeScope | null; tourOwner?: TourOwner; sessionId?: string }
  | { kind: 'contact-attachment-preview'; file: ContactAttachment; expectedHost: RuntimeScope }
  | { kind: "task"; item: Row }
  | { kind: "bot-editor"; bot?: Row; defaultContext?: BotDefaultContext }
  | { kind: 'assistant-details'; bot: Row }
  | { kind: 'settings'; route: SettingsRoute; tourOwner?: TourOwner }
  | { kind: 'setup-tour'; owner: TourOwner }
  | { kind: 'setup-tour-detail'; owner: TourOwner; detail: SetupTourDetail }
  | { kind: 'history-import-tasks'; history: HistoryImportController; owner?: TourOwner }
  | { kind: 'settings-home'; directory?: string }
  | { kind: 'settings-quota'; provider: QuotaCredentialProvider; providerName: string; directory?: string; hostID: string; generation: number }
  | { kind: 'context-usage'; source: Extract<Route, { kind: 'chat' }>; chat: ReturnType<typeof createChat>; current: () => boolean }
  | { kind: "task-editor"; item?: Row; creationContext?: TaskEditorCreationContext }
  | { kind: "models"; target: ChatTarget };
const nav = createNavStack<Route>([{ kind: "root" }]);
const resourceConnectionClear = createResourceConnectionClear(nav);
const tourProgress = createSetupTourProgress(Storage);
const tourHistoryOwners = new Map<string, ReturnType<typeof createNativeHistoryImport>>();
const tourOwners = new Set<TourOwner>();
const tourRootOperation = signal<ReturnType<typeof captureHostOperation> | null>(null);
const tourHistoryMonitor = signal<ReturnType<typeof createNativeHistoryImport> | null>(null);
function closeTour(owner: TourOwner) {
  nav.setRoutes(nav.routes().filter(route => !(route.kind === 'setup-tour' || route.kind === 'setup-tour-detail' || route.kind === 'history-import-tasks') || route.owner !== owner).filter(route => !(route.kind === 'settings' || route.kind === 'resource-preview') || route.tourOwner !== owner));
}
function setupHistory(directory: string | undefined, operation: ReturnType<typeof captureHostOperation>) {
  const connection = app.connection();
  if (!connection || !operation.current()) throw new Error('host_operation_stale');
  const key = JSON.stringify([connection.id, connection.url, connection.authorizationID, directory ?? null]);
  let owner = tourHistoryOwners.get(key);
  if (!owner) {
    owner = createNativeHistoryImport({ directory, operation, onJobsSettled: () => {
      const admitted = tourRootOperation(), selected = app.connection();
      if (admitted?.current() && selected?.id === connection.id && selected.url === connection.url && selected.authorizationID === connection.authorizationID) return refresh();
    } });
    tourHistoryOwners.set(key, owner);
  } else if (!owner.current()) void owner.replaceLane(operation).then(adopted => { if (adopted) return owner?.ensureDiscovery(); }).catch(report);
  tourHistoryMonitor.set(owner);
  return owner;
}
async function openSetupTour(directory?: string) {
  const operation = tourRootOperation(), hostID = app.connection()?.id;
  if (!operation?.current() || !hostID) return;
  const saved = await tourProgress.read(hostID);
  if (!operation.current()) return;
  const connection = app.connection(), identity = JSON.stringify([connection?.id, connection?.url, connection?.authorizationID]);
  const retained = [...tourOwners].find(owner => owner.identity === identity && owner.directory === directory);
  if (retained) {
    if (nav.routes().some(route => route.kind === 'setup-tour' && route.owner === retained)) return;
    if (retained.controller.reopen()) nav.push({ kind: 'setup-tour', owner: retained });
    return;
  }
  const historyImport = setupHistory(directory, operation);
  let owner: TourOwner;
  const controller = createNativeSetupTour({ directory, historyImport, operation, step: saved?.step,
    onMove: step => { void tourProgress.save(hostID, { step, dismissed: false }).catch(report); },
    onClose: () => { void tourProgress.save(hostID, { step: owner.controller.snapshot().step, dismissed: true }).catch(report); closeTour(owner); },
  });
  owner = { id: id(), hostID, identity, directory, controller };
  tourOwners.add(owner); nav.push({ kind: 'setup-tour', owner });
}
const mountedChats = new WeakMap<Extract<Route, { kind: 'chat' }>, ReturnType<typeof createChat>>();
function retainedChatRoute(): Extract<Route, { kind: 'chat' }> | undefined {
  const routes = nav.routes(), top = routes.at(-1);
  if (top?.kind === 'chat') return top;
  if (top?.kind === 'context-usage') return top.source;
  const source = top?.kind === 'project-search' ? routes.at(-2) : top;
  if (source?.kind === 'chat') return source;
  if (source?.kind === 'session-switcher') {
    const chat = routes.at(top?.kind === 'project-search' ? -3 : -2);
    if (chat?.kind === 'chat' && chat.target === source.source) return chat;
  }
}
const retentionController = signal<RetentionController | undefined>(undefined);
const botCreationContext = createBotCreationContext(epoch);
const openBotEditor = (bot?: Row) => nav.push({ kind: 'bot-editor', bot, defaultContext: bot ? undefined : botCreationContext.snapshot() });
function openTaskEditor(item?: Row) {
  const context = item ? undefined : botCreationContext.snapshot();
  const project = context?.directory ? app.projects().filter(project => resourceWithin(context.directory!, project.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  nav.push({ kind: 'task-editor', item, creationContext: context?.directory && context.selection && project ? {
    projectID: project.id, directory: context.directory, selection: { ...context.selection, ...(context.agent ? { agent: context.agent } : {}) },
  } : undefined });
}
const projectChangesSource = signal<Extract<ChangesSource, { kind: 'workspace' }> | null>(null);
const openChat = (target: ChatTarget, options?: { messageID?: string }) => nav.push({ kind: "chat", target, messageID: options?.messageID });
function openResourceFile(path: string, directory: string, targetLine?: number) {
  const root = resourcePath(directory), absolute = resourcePath(path.startsWith('/') ? path : root + '/' + path);
  if (!resourceWithin(absolute, root)) throw new Error(t('mobile.files.error.readUnavailable'));
  const source = nav.routes().at(-1);
  const sessionId = source?.kind === 'chat' && source.target.kind === 'session' && resourcePath(source.target.directory) === root ? source.target.id
    : (source?.kind === 'resource-preview' || source?.kind === 'files') && resourcePath(source.directory) === root ? source.sessionId : undefined;
  nav.push({ kind: 'resource-preview', directory: root, path: absolute, targetLine, ...(sessionId ? { sessionId } : {}) });
}
function replaceCollectionDirectory(directory: string | undefined, route: SettingsRoute) {
  const source = nav.routes().at(-1);
  if (source?.kind !== 'settings' || source.route.page !== route.page) return;
  nav.replace({ ...source, route: { ...route, directory } });
}
const settingsCallbacks: SettingsCallbacks = {
  onOpen: route => {
    const source = nav.routes().at(-1);
    const directory = route.directory ?? (source?.kind === 'settings' ? source.route.directory
      : source?.kind === 'settings-home' || source?.kind === 'project-search' ? source.directory
      : source?.kind === 'chat' ? source.target.directory
      : source?.kind === 'new-session' ? source.directory ?? source.project?.path
       : source?.kind === 'project' ? source.project.path
       : source?.kind === 'setup-tour' || source?.kind === 'setup-tour-detail' ? source.owner.directory : undefined);
    const tourOwner = source?.kind === 'setup-tour' || source?.kind === 'setup-tour-detail' ? source.owner : source?.kind === 'settings' ? source.tourOwner : undefined;
    nav.push({ kind: 'settings', route: { ...route, ...(directory ? { directory } : {}) }, ...(tourOwner ? { tourOwner } : {}) });
  },
  onBack: () => nav.pop(),
  onCollectionDirectory: replaceCollectionDirectory,
  onConnect: () => nav.push({ kind: 'connect' }),
  onEditConnection: (id, mode) => nav.push({ kind: 'connection-editor', id, mode }),
  onAssistants: () => settingsCallbacks.onOpen({ page: 'assistants' }),
  onManageQuotaCredentials: (provider, providerName, directory) => {
    const source = nav.routes().at(-1), hostID = app.connection()?.id;
    if (!hostID || source?.kind !== 'settings' || source.route.page !== 'providers' || source.route.directory !== directory) return;
    nav.push({ kind: 'settings-quota', provider, providerName, directory, hostID, generation: epoch() });
  },
};
const projectsNavigation: ProjectsNavigation = {
  onOpenChat: openChat,
  onOpenProject: project => nav.push({ kind: 'project', project }),
  onOpenFiles: directory => nav.push({ kind: 'files', directory, path: directory }),
  onOpenChanges: directory => projectChangesSource.set({ kind: 'workspace', directory }),
  onEditProject: project => nav.push({ kind: 'settings', route: { page: 'projects', entity: project.id, directory: project.path } }),
  onAddProject: () => nav.push({ kind: 'project-directory' }),
  onOpenSearch: () => nav.push({ kind: 'project-search' }),
  onNewWorktree: project => nav.push({ kind: 'project', project, createWorktree: true }),
  onOpenArchivedSessions: () => nav.push({ kind: 'settings', route: { page: 'archived-sessions' } }),
  onRemoteDesktop: () => nav.push({ kind: 'remote-desktop' }),
  onNewSession: project => nav.push({ kind: 'new-session', project }),
  onWorktreeCreated: (project, directory) => nav.push({ kind: 'new-session', project, directory }),
  onScanQr: () => {
    const generation = epoch();
    void run(async () => { const link = await native<string>('camera.scan'); if (generation === epoch() && link) nav.push({ kind: 'connect', link }); });
  },
  onSwitchInstance: id => { if (id) void run(() => switchConnection(id)); else nav.push({ kind: 'settings', route: { page: 'instances' } }); },
};
function pageScope() {
  return createPageOperations().displayCurrent;
}
function projectSearchCommands(directory?: string): ProjectSearchCommand[] {
  const project = directory ? app.projects().filter(project => resourceWithin(directory, project.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  const previous = nav.routes().at(-2);
  const source = previous?.kind === 'chat' ? previous.target : undefined;
  const sourceRoute = retainedChatRoute();
  const sourceChat = sourceRoute ? mountedChats.get(sourceRoute) : undefined;
  const closeAndOpen = (route: Route) => { batch(() => { nav.pop(); nav.push(route); }); };
  return [
    ...SETTINGS_ENTRIES.map(entry => ({ id: `settings:${entry.page}`, title: t(entry.title), group: 'settings' as const, onSelect: () => closeAndOpen({ kind: 'settings', route: { page: entry.page, directory } }) })),
    { id: 'new-session', title: t('commandPalette.item.newSession'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'new-session', project, directory }) },
    { id: 'setup-tour', title: t('tour.open'), group: 'commands', onSelect: () => { nav.pop(); void run(() => openSetupTour(directory)); } },
    { id: 'toggle-sidebar', title: t('commandPalette.item.showSessionSwitcher'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'session-switcher', source }) },
    ...(sourceRoute?.target.kind === 'session' && sourceChat ? [{ id: 'show-context-usage', title: t('commandPalette.item.showContextUsage'), group: 'commands' as const, onSelect: () => {
      if (mountedChats.get(sourceRoute) !== sourceChat || epoch() !== sourceChat.messageScope.generation || app.connection()?.id !== sourceChat.messageScope.hostID) return;
      closeAndOpen({ kind: 'context-usage', source: sourceRoute, chat: sourceChat, current: () => mountedChats.get(sourceRoute) === sourceChat && epoch() === sourceChat.messageScope.generation && app.connection()?.id === sourceChat.messageScope.hostID });
    } }] : []),
    ...(project ? [{ id: 'new-worktree', title: t('commandPalette.item.newWorktreeDraft'), group: 'commands' as const, onSelect: () => closeAndOpen({ kind: 'project', project, createWorktree: true }) }] : []),
    { id: 'project:add', title: t('commandPalette.item.addProject'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'project-directory' }) },
    { id: 'connect', title: t('mobile.connect.connectButton'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'connect' }) },
    { id: 'open-settings', title: t('commandPalette.item.openSettings'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'settings-home', directory }) },
  ];
}
function Group(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      <Text class="text-xs text-muted-foreground px-1">{props.title}</Text>
      <View class="rounded-2xl bg-card p-3 gap-3">{props.children}</View>
    </View>
  );
}
function Hint(props: { value: string }) {
  return <Text class="text-sm text-muted-foreground py-4">{props.value}</Text>;
}

function Connect(props: { link?: string; edit?: ConnectionEditorMutation }) {
  const link = signal(props.link || ""),
    url = signal(props.edit?.url || ""),
    password = signal(""),
    credential = signal(""),
    label = signal(props.edit?.label || ""),
    pending = signal(false);
  const advanced = signal(!!props.edit?.url);
  async function connect() {
    if (pending()) return;
    pending.set(true);
    await run(async () => {
      const snapshot = await native<ConnectionEditorSnapshot>("connection.connect", {
        ...(props.edit ? { id: props.edit.id, version: props.edit.version } : {}),
        pairingLink: link(),
        url: url(),
        password: password(),
        token: credential(),
        label: label(),
      });
      snapshot.connections = connectionSnapshotFrom(snapshot).connections;
      link.set("");
      password.set("");
      credential.set("");
      if (!props.edit || snapshot.runtimeInvalidated === true) {
        await loadConnections({ forceReconnect: true });
        await refresh();
      } else app.connections.set(snapshot.connections);
      if (props.edit && snapshot.runtimeInvalidated !== true) nav.pop(2); else nav.popToRoot();
    });
    pending.set(false);
  }
  return (
    <NavPage
      title={t("mobile.connect.welcome.title")}
      class="flex-1 bg-background"
    >
      <Scroll class="flex-1" contentClass="p-5 gap-6 pb-10">
        <View class="py-8 gap-3">
          <YuriMark size="hero" decorative />
          <YuriWordmark size="hero" />
          <Hint value={t("mobile.connect.welcome.pairingHint")} />
        </View>
        <Button
          class={action}
          onPress={() => {
            void run(async () => {
              link.set(await native<string>("camera.scan"));
            });
          }}
        >
          <Text class="text-foreground">{t("mobile.connect.scanQr")}</Text>
        </Button>
        <Group title={t("mobile.connect.link.label")}>
          <Input
            testID="pairing-link"
            class={field}
            value={link()}
            onChange={(e) => link.set(e.value)}
            placeholder={t("mobile.connect.link.placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text class="text-xs text-muted-foreground">
            {t("mobile.connect.link.help")}
          </Text>
        </Group>
        <Button
          class={action}
          disabled={pending()}
          onPress={() => {
            void connect();
          }}
        >
          <Text class="text-foreground">
            {pending()
              ? t("mobile.connect.connecting")
              : t("mobile.connect.connectButton")}
          </Text>
        </Button>
        <Button class={quiet} onPress={() => advanced.set(!advanced())}>
          <Text class="text-muted-foreground">
            {t("mobile.connect.manual.toggle")}
          </Text>
        </Button>
        <If when={advanced()}>
          <Group title={t("mobile.connect.advanced")}>
            <Input
              testID="server-url"
              class={field}
              value={url()}
              onChange={(e) => url.set(e.value)}
              placeholder={t("mobile.connect.url.label")}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              class={field}
              value={label()}
              onChange={(e) => label.set(e.value)}
              placeholder={t("mobile.instances.label.placeholder")}
            />
            <Input
              class={field}
              masked
              value={password()}
              onChange={(e) => password.set(e.value)}
              placeholder={t("mobile.connect.password.label")}
            />
            <Input
              class={field}
              masked
              value={credential()}
              onChange={(e) => credential.set(e.value)}
              placeholder={t("mobile.connect.token.label")}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Group>
        </If>
        <If when={app.connections().length > 0}>
          <Group title={t("mobile.connect.saved.title")}>
            <Each of={app.connections()}>
              {(connection) => (
                <Button
                  class={quiet}
                  onPress={() => {
                    void run(async () => {
                      await switchConnection(connection().id);
                      nav.popToRoot();
                    });
                  }}
                >
                  <Text class="text-foreground">{connection().label}</Text>
                  <Text class="text-xs text-muted-foreground">
                    {connection().url}
                  </Text>
                </Button>
              )}
            </Each>
          </Group>
        </If>
      </Scroll>
    </NavPage>
  );
}

function Projects() {
  const current = pageScope();
  const request = captureHostRequest();
  const search = signal("");
  return (
    <View class="flex-1 gap-2">
      <View class="px-5 gap-2">
        <Input
          class={field}
          value={search()}
          onChange={(e) => search.set(e.value)}
          placeholder={t("mobile.sessions.search.placeholder")}
        />
        <Button
          class={quiet}
          onPress={() => {
            void run(async () => {
              const home = record(await request("/api/fs/home"));
              const path = text(home.home);
              nav.push({
                kind: "files",
                directory: path,
                path,
                registering: true,
              });
            });
          }}
        >
          <Text class="text-foreground">
            {t("sessions.sidebar.header.actions.addProject")}
          </Text>
        </Button>
      </View>
      <Scroll class="flex-1" contentClass="p-5 gap-4">
        <If when={app.projects().length === 0}>
          <Hint value={t("mobile.sessions.empty.noProjectsTitle")} />
        </If>
        <Each of={app.projects()}>
          {(project) => (
            <View class="bg-card rounded-2xl p-4 gap-3">
              <Button
                class="min-h-11 gap-1"
                onPress={() =>
                  nav.push({ kind: "project", project: project() })
                }
              >
                <Text class="text-xl font-semibold text-foreground">
                  {project().name}
                </Text>
                <Text class="text-xs text-muted-foreground">
                  {project().path}
                </Text>
              </Button>
              <Each
                of={app
                  .sessions()
                  .filter(
                    (s) =>
                      s.directory === project().path &&
                      (!search() ||
                        s.title.toLowerCase().includes(search().toLowerCase())),
                  )
                  .slice(0, 12)}
              >
                {(session) => (
                  <Button
                    class="min-h-12 py-2 border-t border-border"
                    onPress={() => openChat({ kind: "session", ...session() })}
                  >
                    <Text class="text-base text-foreground">
                      {session().title}
                    </Text>
                  </Button>
                )}
              </Each>
              <Button
                class={action}
                onPress={() => {
                  if (current()) nav.push({ kind: 'new-session', project: project() });
                }}
              >
                <Text class="text-foreground">
                  {t("sessions.switcher.draftTitle")}
                </Text>
              </Button>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}
function ProjectPage(props: { project: Project }) {
  const current = pageScope();
  return (
    <NavPage
      title={props.project.name}
      class="flex-1 bg-background"
      headerRight={
        <Button
          class={quiet}
          onPress={() => {
            if (current()) nav.push({ kind: 'new-session', project: props.project });
          }}
        >
          <Text>＋</Text>
        </Button>
      }
      ios={{ headerRightSystemItem: "add" }}
    >
      <View class="flex-row px-4 gap-2">
        <Button
          class={action}
          onPress={() =>
            nav.push({
              kind: "files",
              directory: props.project.path,
              path: props.project.path,
            })
          }
        >
          <Text class="text-foreground">{t("mobile.menu.files")}</Text>
        </Button>
        <Button
          class={action}
          onPress={() =>
            projectChangesSource.set({ kind: 'workspace', directory: props.project.path })
          }
        >
          <Text class="text-foreground">{t("mobile.menu.changes")}</Text>
        </Button>
      </View>
      <List
        class="flex-1"
        contentClass="p-5 gap-2"
        each={app.sessions().filter((s) => s.directory === props.project.path)}
        keyExtractor={(s) => s.id}
      >
        {(item) => (
          <Button
            class="min-h-14 py-3 border-b border-border"
            onPress={() => openChat({ kind: "session", ...item() })}
          >
            <Text class="text-foreground">{item().title}</Text>
          </Button>
        )}
      </List>
    </NavPage>
  );
}
function Bots() {
  return (
    <Scroll class="flex-1" contentClass="p-5 gap-3">
      <Button class={action} onPress={() => openBotEditor()}>
        <Text class="text-foreground">{t("assistants.settings.create")}</Text>
      </Button>
      <Each of={app.bots()}>
        {(bot) => (
          <Button
            class="bg-card rounded-2xl p-4 min-h-20 flex-row gap-4 items-center"
            onPress={() =>
              openChat({
                kind: "assistant",
                id: text(bot().id),
                title: text(bot().name),
                directory: text(bot().effectiveWorkspacePath),
              })
            }
          >
            <Image
              src={
                "data:image/svg+xml," +
                encodeURIComponent(
                  assistantAvatarSvg(text(bot().avatarSeed) || text(bot().id)),
                )
              }
              style={{ width: 48, height: 48 }}
            />
            <View class="flex-1 gap-1">
              <Text class="text-lg font-semibold text-foreground">
                {text(bot().name)}
              </Text>
              <Text class="text-sm text-muted-foreground">
                {text(record(bot().latestMessagePreview).text) ||
                  text(bot().modelID)}
              </Text>
            </View>
            <If when={bot().working === true}>
              <Text class="text-muted-foreground">
                {t("mobile.tabs.activity.loading")}
              </Text>
            </If>
          </Button>
        )}
      </Each>
    </Scroll>
  );
}

function Schedules() {
  return (
    <Scroll class="flex-1" contentClass="p-5 gap-3">
      <Button class={action} onPress={() => openTaskEditor()}>
        <Text class="text-foreground">
          {t("sessions.scheduledTasks.dialog.actions.create")}
        </Text>
      </Button>
      <Each of={app.tasks()}>
        {(item) => (
          <Button
            class="bg-card rounded-2xl p-4 gap-2 min-h-20"
            onPress={() => nav.push({ kind: "task", item: item() })}
          >
            <Text class="text-lg text-foreground">
              {text(record(item().task).name)}
            </Text>
            <Text class="text-sm text-muted-foreground">
              {record(item().task).enabled
                ? t("sessions.scheduledTasks.editor.enabled.label")
                : t("sessions.scheduledTasks.dialog.taskToggle.paused")}
            </Text>
          </Button>
        )}
      </Each>
    </Scroll>
  );
}
function SchedulePage(props: { item: Row }) {
  const current = pageScope();
  const request = captureHostRequest();
  const fallback = signal(record(props.item.task));
  const task = () =>
    record(
      app
        .tasks()
        .find(
          (item) =>
            item.projectId === props.item.projectId &&
            record(item.task).id === fallback().id,
        )?.task ?? fallback(),
    );
  const pending = signal(false);
  const notice = signal("");
  const base = `/api/projects/${encodeURIComponent(text(props.item.projectId))}/scheduled-tasks`;
  async function mutate(work: () => Promise<unknown>) {
    if (pending() || !current()) return;
    pending.set(true);
    await run(async () => {
      await work();
      if (current()) await refresh();
    });
    pending.set(false);
  }
  return (
    <NavPage
      title={text(task().name)}
      class="flex-1 bg-background"
      headerRight={
        <Button
          class={quiet}
          onPress={() =>
            nav.push({
              kind: "task-editor",
              item: { ...props.item, task: task() },
            })
          }
        >
          <Text class="text-foreground">{t("mobile.instances.edit")}</Text>
        </Button>
      }
      ios={{ headerRightSymbol: "pencil" }}
    >
      <Scroll class="flex-1" contentClass="p-5 gap-5">
        <Group title={t("sessions.scheduledTasks.editor.prompt.label")}>
          <TextView
            markdown={text(record(task().execution).prompt)}
            styles={nativeCodeTextViewStyles()}
            selectable
            class="text-foreground"
          />
        </Group>
        <Group title={t("sessions.scheduledTasks.editor.scheduleType.label")}>
          <Text class="text-foreground">
            {scheduleSummary(record(task().schedule))}
          </Text>
        </Group>
        <If when={notice()}>
          <Text class="text-sm text-muted-foreground">{notice()}</Text>
        </If>
        <Button
          class={action}
          disabled={pending()}
          onPress={() => {
            void mutate(async () => {
              const enabled = !task().enabled;
              const response = record(
                await request(base, "PATCH", {
                  task: { id: task().id, enabled },
                }),
              );
              if (current()) fallback.set({ ...task(), enabled });
              if (current())
                notice.set(
                  response.schedulerSynced === false
                    ? t("sessions.scheduledTasks.dialog.toast.saved") +
                        " · " +
                        t("sessions.scheduledTasks.dialog.status.error")
                    : "",
                );
            });
          }}
        >
          <Text class="text-foreground">
            {task().enabled
              ? t("sessions.scheduledTasks.dialog.actions.pause")
              : t("sessions.scheduledTasks.dialog.actions.resume")}
          </Text>
        </Button>
        <Button
          class={action}
          disabled={pending() || !task().enabled}
          onPress={() => {
            void mutate(() =>
              request(
                `${base}/${encodeURIComponent(text(task().id))}/run`,
                "POST",
                {},
              ),
            );
          }}
        >
          <Text class="text-foreground">
            {t("sessions.scheduledTasks.dialog.actions.runNow")}
          </Text>
        </Button>
      </Scroll>
    </NavPage>
  );
}

function scheduleSummary(schedule: Row): string {
  const kind = text(schedule.kind);
  const label =
    kind === "daily"
      ? t("sessions.scheduledTasks.editor.scheduleType.daily")
      : kind === "weekly"
        ? t("sessions.scheduledTasks.editor.scheduleType.weekly")
        : kind === "once"
          ? t("sessions.scheduledTasks.editor.scheduleType.once")
          : t("sessions.scheduledTasks.editor.scheduleType.cron");
  const times = Array.isArray(schedule.times)
    ? schedule.times.filter((value) => typeof value === "string").join(", ")
    : text(schedule.time);
  return [
    label,
    text(schedule.date),
    kind === "cron" ? text(schedule.cron) : times,
    text(schedule.timezone),
  ]
    .filter(Boolean)
    .join(" · ");
}

function Settings() {
  const appearance = appearancePreference;
  const filter = signal("");
  function setAppearance(value: "system" | "light" | "dark") {
    appearance.set(value);
    setColorScheme(value);
    void Storage.setItem("appearance", value).catch(report);
  }
  return (
    <Scroll class="flex-1" contentClass="p-5 gap-5">
      <Input
        class={field}
        value={filter()}
        onChange={(e) => filter.set(e.value)}
        placeholder={t("mobile.connect.saved.title")}
      />
      <Group title={t("mobile.connect.saved.title")}>
        <Each of={app.connections().filter((c) => c.label.includes(filter()))}>
          {(connection) => (
            <View class="gap-1">
              <Button
                class={quiet}
                onPress={() => {
                  void run(() => switchConnection(connection().id));
                }}
              >
                <Text class="text-foreground">{connection().label}</Text>
                <Text class="text-xs text-muted-foreground">
                  {connection().url}
                </Text>
              </Button>
              <Button
                class={quiet}
                onPress={() => {
                  void run(async () => {
                    const answer = await AlertDialog.show({
                      title: t("mobile.connect.history.remove"),
                      description: t("mobile.connect.history.removeHint", {
                        name: connection().label,
                      }),
                      actions: [
                        {
                          id: "cancel",
                          label: t("mobile.instances.cancelEdit"),
                          role: "cancel",
                        },
                        {
                          id: "delete",
                          label: t("mobile.instances.delete"),
                          role: "destructive",
                        },
                      ],
                    });
                    if (answer.action === "delete") {
                      await native("connection.remove", {
                        id: connection().id,
                      });
                      await loadConnections();
                    }
                  });
                }}
              >
                <Text class="text-destructive">
                  {t("mobile.instances.delete")}
                </Text>
              </Button>
            </View>
          )}
        </Each>
        <Button class={action} onPress={() => nav.push({ kind: "connect" })}>
          <Text class="text-foreground">{t("mobile.instances.addTitle")}</Text>
        </Button>
      </Group>
      <Group title={t("settings.page.appearance.title")}>
        <View class="flex-row gap-2">
          <Each of={["system", "light", "dark"] as const}>
            {(value) => (
              <Button
                class={action + " selected:bg-accent"}
                selected={appearance() === value()}
                onPress={() => setAppearance(value())}
              >
                <Text class="text-foreground">
                  {t(`settings.yuri.visual.option.themeMode.${value()}`)}
                </Text>
              </Button>
            )}
          </Each>
        </View>
      </Group>
      <Group title={t("settings.appearance.language.label")}>
        <Select
          value={language()}
          accessibilityLabel={t("settings.appearance.language.label")}
          items={[
            {
              value: "system",
              title: t("settings.yuri.visual.option.themeMode.system"),
            },
            { value: "en", title: t("common.language.english") },
            { value: "zh-CN", title: t("common.language.simplifiedChinese") },
            { value: "zh-TW", title: t("common.language.traditionalChinese") },
            { value: "ja", title: t("common.language.japanese") },
            { value: "ko", title: t("common.language.korean") },
            { value: "fr", title: t("common.language.french") },
            { value: "es", title: t("common.language.spanish") },
            { value: "pl", title: t("common.language.polish") },
            { value: "pt-BR", title: t("common.language.brazilianPortuguese") },
            { value: "uk", title: t("common.language.ukrainian") },
          ]}
          onChange={(event) => {
            if (event.value) {
              language.set(event.value);
              void Storage.setItem("language", event.value).catch(report);
            }
          }}
          popupClass="bg-card p-3 rounded-2xl"
          itemClass="min-h-12 p-3 text-foreground selected:bg-accent"
          trigger={
            <View class={field}>
              <Text class="text-foreground">
                {language() === "system"
                  ? t("settings.yuri.visual.option.themeMode.system")
                  : language()}
              </Text>
            </View>
          }
        />
      </Group>
      <Group title={t("sessions.sidebar.footer.actions.aboutYuri")}>
        <YuriMark size="standard" decorative />
        <YuriWordmark size="standard" />
        <Text class="text-foreground">Yuri Native · 0.1.0</Text>
        <Text class="text-sm text-muted-foreground">NSH 0.4 · iOS</Text>
      </Group>
    </Scroll>
  );
}

function Chat(props: { route: Extract<Route, { kind: 'chat' }>; target: ChatTarget; messageID?: string; handoff?: NativeNewSessionPageHandoff }) {
  const operations = createPageOperations(() => nav.routes().at(-1) === props.route);
  const current = operations.displayCurrent;
  const footerExperiment = signal(false);
  const footer = createNativeHistoryFooterController({
    current: () => current() && nav.routes().at(-1) === props.route && lifecycle() === 'active',
    changed: value => footerState.set(value),
  });
  const footerState = signal(footer.snapshot());
  cleanup(footer.dispose);
  const chat = createChat(props.target, { deviceChatPreferences, messageStreamTransport: () => nativeAppearance.current()?.messageStreamTransport ?? null, followUpBehavior: () => nativeAppearance.current()?.followUpBehavior ?? null, beforeHistoryPresentationFlush: footer.beforeHistoryPresentationFlush });
  effect(() => {
    current(); nav.routes(); lifecycle();
    untracked(footer.syncActivity);
  });
  effect(() => {
    const enabled = footerExperiment();
    untracked(() => { footer.setEnabled(enabled); });
  });
  effect(() => {
    const appearance = nativeAppearance.current();
    const contentKey = JSON.stringify([chat.olderLoading(), language(), windowSize().width, appearance?.fontSize, appearance?.fonts]);
    untracked(() => footer.setContentKey(contentKey));
  });
  mountedChats.set(props.route, chat);
  cleanup(() => mountedChats.delete(props.route));
  const admissionState = signal<NewSessionAdmissionState>(props.handoff ? 'idle' : 'complete');
  const admission = props.handoff ? createNewSessionAdmission({ chat, handoff: props.handoff,
    operation: operations.operation, current: () => current() && chat.active() && lifecycle() === 'active', changed: value => admissionState.set(value) }) : undefined;
  let admissionAttempted = false;
  let admissionOperation: ReturnType<typeof operations.operation> = null;
  effect(() => {
    const operation = operations.operation(), active = chat.active() && lifecycle() === 'active';
    untracked(() => {
      if (!admission || !active || !operation?.current() || admissionOperation === operation) return;
      admissionOperation = operation;
      admission.replaceOperation(operation);
      if (!admissionAttempted) { admissionAttempted = true; void admission.run(); }
      else void admission.reconcile();
    });
  });
  cleanup(() => { void admission?.close().catch(() => {}); });
  operations.onRetire(() => { if (admissionAttempted && admissionState() === 'sending') admissionState.set('unconfirmed'); });
  const messageSpeech = createNativeSpeech({ current: () => current() && chat.active(), operation: operations.operation });
  const history = createNativeTranscriptHistory({ chat, target: props.target, current, operation: operations.operation,
    key: `${epoch()}:${props.target.kind}:${props.target.directory}:${props.target.id}`,
    storageKey: encodeURIComponent(JSON.stringify([app.connection()?.id, props.target.directory, props.target.kind, props.target.id])),
    onOpenChat: target => { if (current() && chat.active()) openChat(target); },
  });
  const projectHistoryRows = createNativeHistoryRows();
  const bodyRows = computed(() => projectHistoryRows(chat.visibleMessages()));
  // NSH matches List items by ===; keyExtractor only labels viewability tokens.
  const bodyRowKeys = computed(() => bodyRows().map(row => row.key));
  const bodyRowsByKey = computed(() => new Map(bodyRows().map(row => [row.key, row])));
  const transcriptRef = signal<ListRef | null>(null);
  const focusState = signal<Readonly<NativeHistoryFocusState> | null>(null);
  const focusScope = () => JSON.stringify([app.connection()?.id, epoch(), props.target.kind, props.target.directory, props.target.id, chat.historyGeneration()]);
  const messageFocus = createNativeHistoryFocus({
    current: () => current() && chat.active() && lifecycle() === 'active' && chat.messagesResolved(),
    scope: focusScope,
    hasMessage: id => bodyRows().some(row => row.messages.some(message => message.id === id)),
    isHidden: id => {
      const boundary = chat.revert()?.messageID;
      if (!boundary) return false;
      const messages = chat.messages(), cut = messages.findIndex(message => message.id === boundary), index = messages.findIndex(message => message.id === id);
      return cut >= 0 && index >= cut;
    },
    more: chat.more, olderLoading: chat.olderLoading, historyError: chat.historyError,
    loadOlder: () => chat.loadOlder(),
    reveal: id => {
      const list = transcriptRef(), index = bodyRows().findIndex(row => row.messages.some(message => message.id === id));
      if (!list || index < 0) return false;
      list.scrollToIndex({ index, animated: false, viewPosition: .5 });
      return true;
    },
    changed: value => focusState.set(value),
  });
  let focusedScope: string | undefined;
  effect(() => {
    const scope = focusScope(), active = current() && chat.active() && lifecycle() === 'active';
    if (!active || focusedScope && focusedScope !== scope) { messageFocus.cancel(); return; }
    if (!props.messageID || !chat.messagesResolved() || !transcriptRef() || chat.historyRepairPending()) return;
    bodyRows();
    if (focusedScope) return;
    focusedScope = scope;
    void messageFocus.focus(props.messageID);
  });
  cleanup(() => messageFocus.cancel());
  const turns = computed(() => nativeTurnPresentation(chat.visibleMessages(), chat.busy(), bodyRows().slice().reverse()));
  const projectPendingHeaders = createNativePendingHeaders();
  const pendingHeaders = computed(() => projectPendingHeaders(bodyRows(), chat.busy(), chat.streamingMessageIDs().size > 0));
  const activityChoices = signal<Record<string, boolean>>({});
  const headerSelection = signal<Row>({});
  const changesGenerationContext = () => {
    const selection = headerSelection(), model = record(selection.model);
    return {
      ...(props.target.kind === 'session' ? { sessionID: props.target.id } : {}),
      preferredProviderID: text(model.providerID) || text(selection.providerID) || undefined,
      preferredModelID: text(model.id) || text(model.modelID) || text(selection.modelID) || undefined,
    };
  };
  function turnHeader(row: ReturnType<typeof projectHistoryRows>[number]) {
    const selection = headerSelection(), model = record(selection.model);
    const selected = { providerId: text(model.providerID) || text(selection.providerID), modelId: text(model.id) || text(model.modelID) || text(selection.modelID) };
    return nativeTurnHeaderMessage(row, { active: row.isLastTurn && (chat.busy() || row.turn?.completionDisposition === 'active'), composer: selected, session: selected, agent: text(selection.agent) || undefined });
  }
  const historyScroll = createNativeHistoryScroll({
    current: () => current() && chat.active() && lifecycle() === 'active',
    loading: () => chat.loading() || chat.olderLoading(),
    more: chat.more, error: chat.historyError, loadOlder: chat.loadOlder,
    loadLatest: () => { footerEvents().onLatest(); return chat.load(false, ['messages']); },
  });
  effect(() => { if (!chat.active() || lifecycle() !== 'active') historyScroll.reset(); });
  cleanup(historyScroll.reset);
  const turnModelName = createNativeTurnModelNames(() => current() && chat.active(), props.target.directory);
  const recording = signal(false),
    attaching = signal(false);
  const chromeState = signal(createChatChromeState()), editorFocused = signal(false), composerHeight = signal(160);
  const chrome = createNativeChatChrome(value => chromeState.set(value));
  let footerEventGeneration = -1, footerEventSource: ReturnType<typeof footer.captureEvents> | undefined;
  const footerEvents = computed(() => {
    const generation = footerState().eventGeneration;
    return untracked(() => {
      if (!footerEventSource || generation !== footerEventGeneration) {
        footerEventGeneration = generation;
        footerEventSource = footer.captureEvents();
      }
      return footerEventSource;
    });
  });
  const listHistoryEvents = computed(() => {
    const events = footerEvents(), generation = footerState().eventGeneration;
    const admitted = () => generation === footerState().eventGeneration && current() && chat.active() && lifecycle() === 'active';
    return {
      onScrollDragStart: (event: Parameters<typeof historyScroll.onScrollDragStart>[0]) => { if (!admitted()) return; events.onScrollDragStart(event); historyScroll.onScrollDragStart(event); chrome.begin(event); },
      onScroll: (event: Parameters<typeof historyScroll.onScroll>[0]) => { if (!admitted()) return; events.onScroll(event); historyScroll.onScroll(event); chrome.scroll(event); },
      onScrollEnd: (event: Parameters<typeof events.onScrollEnd>[0]) => { if (!admitted()) return; events.onScrollEnd(event); historyScroll.onScrollEnd(); chrome.end(); },
      onScrollDragEnd: () => { if (admitted()) chrome.release(); },
      onMomentumEnd: () => { if (admitted()) chrome.end(); },
      onLoadMore: () => { if (admitted()) historyScroll.onLoadMore(); },
      onLoadMoreAtStart: () => { if (admitted()) historyScroll.onLoadMoreAtStart(); },
    };
  });
  let editor: InputRef | undefined;
  cleanup(chrome.dispose);
  effect(() => { if (!current() || !chat.active() || lifecycle() !== 'active') untracked(chrome.reset); });
  const autoReadScope = () => JSON.stringify([app.connection()?.id, epoch(), props.target.kind, props.target.directory, props.target.id, chat.historyGeneration()]);
  const autoRead = createNativeAutoRead({ speech: messageSpeech, snapshot: () => ({
    scope: autoReadScope(), sessionID: props.target.id, active: props.target.kind === 'session' && current() && chat.active(),
    resolved: chat.messagesResolved() && !chat.historyRepairPending(), recognizing: recording(), messages: chat.visibleMessages(),
  }), onError: key => chat.error.set(t(key)), onWarning: key => chat.error.set(t(key)) });
  const autoReadHeader = () => props.target.kind === 'session' ? { preferred: autoRead.state().preferred, available: autoRead.state().available, onToggle: () => { void autoRead.toggle(); } } : undefined;
  const inputMode = signal<'normal' | 'shell'>('normal');
  const goalPanel = signal(false);
  const statusPopovers = createNativeChatStatusPopovers();
  const goalEnabled = () => props.target.kind === 'session' && nativeAppearance.current()?.sessionGoalEnabled === true;
  effect(() => {
    if (!goalEnabled()) { goalPanel.set(false); chat.goal.controller.setArmed(false); return; }
    if (!current() || !chat.active() || lifecycle() !== 'active') return;
    return chat.goal.observe();
  });
  effect(() => {
    if (!chat.active() || lifecycle() !== 'active') { goalPanel.set(false); statusPopovers.close(); }
  });
  const modelPicker = signal<'model' | 'agent' | null>(null);
  const timelineOpen = signal(false);
  const btw = signal<(ReturnType<typeof createNativeBtwOwner> & { operation: NonNullable<ReturnType<typeof operations.operation>> }) | null>(null);
  const btwOperation = computed(() => {
    const operation = operations.operation(), runtime = app.runtimeScope();
    const active = props.target.kind === 'session' && chat.active() && lifecycle() === 'active' && nav.routes().at(-1) === props.route;
    return active && operation?.current() && runtime && sameRuntimeScope(operation.scope, runtime) ? operation : null;
  });
  effect(() => {
    const operation = btwOperation();
    if (!operation?.scope) { untracked(() => timelineOpen.set(false)); return; }
    untracked(() => timelineOpen.set(false));
    const capturedRuntime = Object.freeze({ ...operation.scope });
    const binding = createNativeBtwOwner({ runtime: capturedRuntime, sessionID: props.target.id, directory: props.target.directory },
      () => operation === operations.operation() && operation.current() && sameRuntimeScope(capturedRuntime, app.runtimeScope()) && chat.active() && lifecycle() === 'active' && nav.routes().at(-1) === props.route);
    untracked(() => btw.set({ ...binding, operation }));
    cleanup(binding.owner.retire);
  });
  const commandContext = () => ({ hasSession: props.target.kind === 'session', hasMessages: chat.messages().length > 0, hasNewDraft: false });
  const commandRouter = createChatComposerCommands({
    read: () => {
      const operation = operations.operation();
      if (props.target.kind !== 'session' || !operation?.current() || !chat.active() || lifecycle() !== 'active' || nav.routes().at(-1) !== props.route || chat.draftStatus() !== 'ready' || admissionState() !== 'complete') return null;
      return { owner: operation, revision: chat.draftRevision(), document: chat.referenceDocument(), inputMode: inputMode(), context: commandContext() };
    },
    write: (document, expected) => operations.operation() === expected.owner && chat.draftRevision() === expected.revision && chat.setReferenceDocument(document, expected.document),
    btw: () => { const binding = btw(); return binding?.operation === operations.operation() && binding.operation.current() ? binding.owner : null; },
    openNewDraft: openNewSessionDraft,
    openModel: () => { Keyboard.dismiss(); openSelection(); },
    openTimeline: () => timelineOpen.set(true),
    actions: {
      undo: intent => runLocalCommand(intent, history.sessionActions.undo),
      redo: intent => runLocalCommand(intent, history.sessionActions.redo),
      fork: intent => runLocalCommand(intent, history.sessionActions.fork),
      compact: intent => runLocalCommand(intent, chat.compact, true),
    },
    notify: key => chat.error.set(t(key)),
  });
  function runLocalCommand(intent: NativeCommandIntent, work: () => Promise<boolean | void>, compact = false) {
    if (!intent.current()) return;
    const failed = (failure?: unknown) => {
      if (!intent.current()) return;
      if (failure instanceof Error) chat.error.set(failure.message);
      else if (!chat.error()) chat.error.set(t(compact ? 'chat.chatInput.toast.compactFailed' : 'miniChat.actions.failed'));
    };
    try { void work().then(accepted => { if (accepted === false) failed(); }).catch(failed); }
    catch (failure) { failed(failure); }
  }
  const changesSource = signal<ChangesSource | null>(null);
  const mcpPanel = signal(false);
  effect(() => { if (!chat.active() || lifecycle() !== 'active') mcpPanel.set(false); });
  effect(() => { if (!chat.active() || lifecycle() !== 'active') changesSource.set(null); });
  const composerAnchor = signal<ViewRef | null>(null);
  const referenceKeyboard = createNativeReferenceKeyboard({
    active: () => props.target.kind === 'session' && current() && chat.active() && lifecycle() === 'active' && inputMode() === 'normal' && !recording(),
    scope: () => chat.referenceScope, text: chat.draft,
    insert: (candidate, start, end) => chat.insertReference(candidate, start, end),
    chooseCommand: commandRouter.choose,
    commandOwner: operations.operation,
    commandActions: () => ['new', 'undo', 'redo', 'fork', 'compact', 'model', 'btw'],
  });
  const referenceTrigger = referenceKeyboard.trigger;
  const dismissReferences = referenceKeyboard.dismiss;
  effect(() => {
    const pinned = editorFocused() || keyboardFrame().height > 0 || recording() || attaching() || !!modelPicker() || goalPanel() || !!changesSource() || mcpPanel() || timelineOpen() || btw()?.state().open === true;
    untracked(() => chrome.pin(pinned));
  });
  function editCompactDraft() { if (current() && chat.active()) { chrome.expand(); editor?.focus(); } }
  function resumeLatest() { if (current() && chat.active()) { chrome.expand(); transcriptRef()?.scrollToIndex({ index: 0, animated: true, viewPosition: 1 }); } }
  const btwDraft = () => props.target.kind === 'session' && isNativeBtwCommand(chat.draft(), inputMode());
  function sendDisabled() {
    if (btwDraft()) return !operations.current() || !chat.active() || lifecycle() !== 'active' || admissionState() !== 'complete' || chat.draftStatus() !== 'ready' || recording() || attaching();
    return !chat.canSend() || chat.sending() || admissionState() !== 'complete' || chat.historyBusy() || chat.historyRepairPending() || chat.draftStatus() !== 'ready' || !!chat.queueEdit() || recording() || attaching() || (!chat.draft().trim() && !chat.attachments().length);
  }
  function sendDraft() {
    const lane = operations.operation(); if (!lane?.current()) return;
    if (props.target.kind === 'session' && commandRouter.submit() !== 'pass') return;
    void chat.send({
      inputMode: inputMode(),
      ...(props.target.kind === 'session' && inputMode() === 'normal' && (magicCommand(chat.draft()) || chat.references().length) ? { prepare: input => compileNativePrompt(input, lane.request) } : {}),
    });
  }
  function chooseAttachment() {
    void run(async () => {
      const lane = operations.capture();
      const choice = await AlertDialog.show({ title: t('chat.chatInput.actions.addAttachment'), presentation: 'actionSheet', actions: [
        { id: 'images', label: t('chat.chatInput.actions.attachPhotos') },
        { id: 'files', label: t('chat.chatInput.actions.attachFiles') },
        { id: 'cancel', label: t('chat.chatInput.actions.attachCancel'), role: 'cancel' },
      ] });
      if (lane.current() && (choice.action === 'images' || choice.action === 'files')) await attach(choice.action, lane);
    });
  }
  let speech: SpeechSession | undefined,
    speechOperation = 0, speechStarting = false;
  function endSpeech() {
    speechOperation++;
    speech?.abort();
    speech = undefined;
    recording.set(false);
    autoRead.endRecognition();
  }
  async function dictate() {
    const lane = operations.capture();
    if (recording()) {
      speech?.stop();
      return;
    }
    if (speechStarting) return;
    speechStarting = true;
    const operation = ++speechOperation;
    try {
      await autoRead.beginRecognition();
      if (!(await Speech.available())) throw new Error(t("chat.dictation.failed"));
      if (!lane.current() || operation !== speechOperation || !chat.active() || lifecycle() !== "active") return;
      const initial = chat.draft();
      speech = Speech.start({ interim: true });
      recording.set(true);
      speech.on("result", result => {
        if (lane.current() && chat.active() && operation === speechOperation)
          chat.setDraftText(initial + (initial ? "\n" : "") + result.text);
      });
      speech.on("end", result => {
        if (!lane.current() || operation !== speechOperation) return;
        recording.set(false); speech = undefined; autoRead.endRecognition();
        if (result.error) chat.error.set(t("chat.dictation.failed"));
      });
    } finally {
      if (lane.current() && operation === speechOperation) { speechStarting = false; if (!recording()) autoRead.endRecognition(); }
    }
  }
  effect(() => {
    const top = nav.routes().at(-1);
    batch(() => {
      const retained = retainedChatRoute();
      chat.syncActive.set(top !== props.route && retained === props.route && current());
      chat.active.set(top === props.route);
    });
  });
  effect(() => {
    if (!chat.active() || lifecycle() !== "active") endSpeech();
  });
  cleanup(endSpeech);
  const attachmentPicker = createAttachmentPick({ target: props.target, current: () => current() && chat.active() && lifecycle() === 'active', call: native,
    busy: attaching.set,
    failed: (phase, failure, retirement) => {
      const code = String(failure ?? '');
      const message = t(code.includes('attachment_original_authorization_unavailable') ? 'chat.attachments.originalAuthorizationUnavailable'
        : code.includes('attachment_upload_pending_capacity') ? 'chat.attachments.pendingCapacity'
        : code.includes('attachment_receipt_storage_failed') ? 'chat.attachments.receiptStorageFailed'
        : /attachment_(capture|upload)_not_dispatched/.test(code) ? 'chat.attachments.notDispatched'
        : phase === 'cancel' ? 'chat.attachments.retirementPending'
        : /attachment_upload_unknown|networkConnectionLost|lost ACK/.test(code) ? 'chat.attachments.receiptPending' : 'common.unavailable');
      if (current() && chat.active()) chat.error.set(message);
      if (phase === 'cancel' && retirement) reportOwnedError(failure, retirement, 'chat.attachments.retirementPending');
    } });
  effect(() => { chat.active(); lifecycle(); operations.operation(); untracked(attachmentPicker.sync); });
  cleanup(attachmentPicker.dispose);
  operations.onRetire(() => { endSpeech(); speechStarting = false; void attachmentPicker.cancel(); });
  async function attach(kind: "files" | "images", lane = operations.capture()) {
    if (attaching() || !lane.current() || !chat.active()) return;
    const selection = chat.captureAttachment(lane);
    if (!selection.expectedHost || !sameRuntimeScope(selection.expectedHost, lane.scope) || selection.target.kind !== props.target.kind || selection.target.id !== props.target.id) {
      selection.retire(); chat.error.set(t('common.unavailable')); return;
    }
    await attachmentPicker.pick(lane, kind, selection);
  }
  function previewAttachment(file: ContactAttachment) {
    if (!current() || !chat.active()) return;
    const lane = operations.operation();
    if (!lane?.current() || !lane.scope || props.target.kind !== 'assistant' || file.hostID !== lane.scope.hostID || file.assistantID !== props.target.id || !chat.attachments().includes(file)) return;
    try {
      const snapshot = attachmentFrom(file, { hostID: lane.scope.hostID, target: props.target });
      if (snapshot.kind !== 'contact') return;
      nav.push({ kind: 'contact-attachment-preview', file: Object.freeze(snapshot), expectedHost: Object.freeze({ ...lane.scope }) });
    } catch { chat.error.set(t('common.unavailable')); }
  }
  function openSelection() {
    if (props.target.kind === 'assistant') {
      const authority = headerSelection();
      const bot = app.bots().find(bot => bot.id === props.target.id) ?? (authority.id === props.target.id ? authority : undefined);
      if (bot) nav.push({ kind: 'assistant-details', bot });
      else report(new Error(t('common.unavailable')));
    } else modelPicker.set('model');
  }
  function openNewSessionDraft() {
    nav.push({ kind: 'new-session', project: app.projects().find(project => resourceWithin(props.target.directory, project.path)), directory: props.target.directory });
  }
  async function openOptions(action: ChatHeaderOption) {
    if (!current() || !chat.active()) return;
    if (action === 'new-session') {
      openNewSessionDraft();
    }
    if (action === 'selection') openSelection();
    if (action === 'files') nav.push({ kind: 'files', directory: props.target.directory, path: props.target.directory, ...(props.target.kind === 'session' ? { sessionId: props.target.id } : {}) });
    if (action === 'changes') { modelPicker.set(null); changesSource.set({ kind: 'workspace', directory: props.target.directory }); }
    if (action === 'remote-desktop') nav.push({ kind: 'remote-desktop' });
    if (action === 'mcp') { statusPopovers.close(); modelPicker.set(null); changesSource.set(null); mcpPanel.set(true); }
    if (action === 'refresh') await chat.load();
    if (action === 'auto-read') await autoRead.toggle();
  }
  return (
    <NavPage
      title={props.target.title}
      hidesBottomBarWhenPushed
      headerTransparent
      headerBackTitle=""
      headerClass="text-foreground tint-foreground"
      headerRight={<ChatHeaderActions native target={props.target} active={chat.active()} busy={chat.busy()} current={current} operation={operations.operation} autoRead={autoReadHeader()} onError={error => chat.error.set(String(error))} onOptions={action => { void run(() => openOptions(action)); }} />}
      header={<NativeChatHeader target={props.target} active={chat.active()} busy={chat.busy()} current={current} operation={operations.operation} autoRead={autoReadHeader()} onBack={() => { if (current() && chat.active()) nav.pop(); }} onOptions={action => { void run(() => openOptions(action)); }} />}
      class="flex-1 bg-background"
    >
      <NativeChatHeaderCollapse progress={chromeState().swap.progress} duration={chromeState().swap.phase === 'snapping' ? 240 : 0}
        active={current() && chat.active() && lifecycle() === 'active'} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />
      <NativeSpeechSettingsError speech={messageSpeech} />
      <NativeChatMcp directory={props.target.directory} active={chat.active()} open={mcpPanel()} onOpenChange={value => mcpPanel.set(value)} onCreate={() => { if (current() && chat.active()) nav.push({ kind: 'settings', route: { page: 'mcp', directory: props.target.directory, create: true } }); }} />
      <If when={chat.error()}>
        <Text class="px-4 py-2 text-destructive">{chat.error()}</Text>
      </If>
      <If when={!!chat.pendingSend() || ['unconfirmed', 'error'].includes(admissionState())}>
        <Button
          class={quiet}
          testID="chat-send-retry"
          disabled={chat.sending() || admissionState() === 'sending'}
          onPress={() => {
            if (admission && admissionState() !== 'complete') void admission.run();
            else void chat.retrySend();
          }}
        >
          <Text class="text-foreground">
            {t("chat.questionDelegate.retry")}
          </Text>
        </Button>
      </If>
      <If when={!chat.loading() && !chat.error() && !chat.visibleMessages().length && !chat.revert() && !chat.historyRepairPending()}>
        <View testID="chat-empty" class="flex-1 items-center justify-center px-10 gap-6">
          <Text class="text-3xl text-foreground text-center" style={{ maxWidth: 300, letterSpacing: -1 }}>
            {props.target.kind === 'session'
              ? t('chat.emptyState.draftTitleWithProject', { project: app.projects().find(project => project.path === props.target.directory)?.name || nameOf(props.target.directory) })
              : t('chat.emptyState.startNewChat')}
          </Text>
        </View>
      </If>
      <If when={chat.loading() || chat.visibleMessages().length > 0 || !!chat.revert() || chat.historyRepairPending()}>
      <List
        testID="transcript"
        ref={value => transcriptRef.set(value)}
        class="flex-1"
        contentStyle={nativeDensity().chat.transcript}
        header={() => <View testID="transcript-composer-inset" style={{ height: composerHeight() + 16 }} />}
        inverted
        onScrollDragStart={listHistoryEvents().onScrollDragStart}
        onScroll={listHistoryEvents().onScroll}
        onScrollDragEnd={listHistoryEvents().onScrollDragEnd}
        onScrollEnd={listHistoryEvents().onScrollEnd}
        onMomentumEnd={listHistoryEvents().onMomentumEnd}
        onLoadMore={listHistoryEvents().onLoadMore}
        loadMoreThreshold={0.5}
        onLoadMoreAtStart={listHistoryEvents().onLoadMoreAtStart}
        footer={() => <View style={{ minHeight: footerState().minHeight }}>
          <Each of={[footerState().naturalGeneration]} key={generation => String(generation)}>{() => {
            const natural = footer.captureNatural();
            return <View class="gap-2" ref={value => { if (natural.ref(value) && value) void natural.confirm(); }} onLayout={natural.onLayout}>
          <If when={chat.more()}><Button testID="history-load-older" class={quiet} disabled={chat.loading() || chat.olderLoading()} onPress={() => { void chat.loadOlder(); }}><Text class="text-muted-foreground">{t(chat.olderLoading() ? 'common.loading' : chat.historyError() ? 'chat.questionDelegate.retry' : 'chat.history.loadOlder')}</Text></Button></If>
          <If when={chat.historyError()}><Text testID="history-page-error" class="text-sm text-destructive">{chat.historyError()}</Text></If>
          <If when={chat.historyBoundaryMissing() || chat.historyRepairPending() || chat.hasGap()}><Button testID="history-refresh" class={quiet} disabled={chat.loading() || chat.historyBusy()} onPress={() => { void chat.load(false, ['messages']); }}><Text class="text-muted-foreground">{t('mobile.chat.syncingMessages')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
            </View>;
          }}</Each>
        </View>}
        each={bodyRowKeys()}
        keyExtractor={key => key}
        keyboardDismissMode="interactive"
      >
        {key => <If when={bodyRowsByKey().get(key())}>{(row) => {
          const item = () => row().tail;
          return (
          <View class={item().role === 'user' ? 'pt-2' : 'gap-2'}>
            <If when={row().head.role === 'assistant' && !!turns().get(row().head.id)?.header}><NativeTurnHeader message={turnHeader(row())} modelName={turnModelName(turnHeader(row()))} identityKey={row().turn?.turnId} /></If>
            <NativeTranscriptBody row={row()} live={chat.busy()} activityMaterialization={chat.activityMaterialization} autoRead={autoRead} autoReadScope={autoReadScope()} streaming={chat.streamingMessageIDs().has(row().tail.id)} collapsibleUserMessages={deviceChatPreferences()?.collapsibleUserMessages ?? null} renderCard={card => <ResourceCard card={card} />} target={props.target} current={() => current() && chat.active() && lifecycle() === 'active'}
              activityChoice={activityChoices()[row().turn?.turnId ?? row().key]} onToggleActivity={(turnID, expanded) => {
                const present = new Set(bodyRows().map(entry => entry.turn?.turnId ?? entry.key));
                activityChoices.set({ ...Object.fromEntries(Object.entries(activityChoices()).filter(([key]) => present.has(key))), [turnID]: expanded });
              }}
              onOpenChat={target => openChat(target)}
              onOpenFile={(path, target) => { void run(async () => { if (current() && chat.active()) openResourceFile(path, target.directory); }); }}
              onOpenDiff={(file, target, messageID, files) => {
                if (!current() || !chat.active() || target.kind !== 'session') return;
                modelPicker.set(null);
                changesSource.set({ kind: 'turn', directory: target.directory, sessionID: target.id, messageID, files, path: file.path });
              }}
            />
            <If when={pendingHeaders().has(row().head.id)}><NativeTurnHeader message={turnHeader(row())} modelName={turnModelName(turnHeader(row()))} identityKey={row().turn?.turnId} /></If>
            <NativeTurnError row={row()} />
            <If when={nativeUserActionsVisible(row()) || !!turns().get(item().id)?.footer}><NativeMessageActions history={history} message={item} speech={messageSpeech} tps={turns().get(item().id)?.tps} duration={turns().get(item().id)?.duration} /></If>
          </View>
        ); }}</If>}
      </List>
      </If>
      <history.Indicator />
      <If when={!!focusState() && !['idle', 'revealed', 'cancelled'].includes(focusState()!.status)}><View class="px-3 py-2 gap-2">
        <Text testID="history-focus-status" class="text-sm text-muted-foreground">{t(focusState()?.status === 'not-found' ? 'chat.history.focusMissing' : focusState()?.status === 'hidden' ? 'chat.history.focusHidden' : focusState()?.status === 'loading' ? 'mobile.chat.syncingMessages' : 'commandPalette.error.messages')}</Text>
        <If when={focusState()?.status === 'error'}><Button testID="history-focus-retry" class={quiet} onPress={() => { void messageFocus.retry(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      </View></If>
      <BlockingRequests chat={chat} />
      <NativeComposerChrome state={chromeState()} bottom={safeArea().bottom + 16} onHeight={value => composerHeight.set(value)} compact={<>
        <If when={props.target.kind === 'session'}><Button testID="compact-attach" class="size-8 items-center justify-center" disabled={attaching()} accessibilityLabel={t('chat.chatInput.actions.addAttachment')} onPress={chooseAttachment}><Icon name="attachment-2" size={20} /></Button></If>
        <Button testID="compact-edit" class="flex-1 min-w-0 min-h-11 justify-center" accessibilityLabel={t('chat.chatInput.placeholder.chatCompact')} onPress={editCompactDraft}><Text class={chat.draft().trim() ? 'text-foreground' : 'text-muted-foreground'} style={{ numberOfLines: 1, fontSize: 14 }}>{chat.draft().trim() || t('chat.chatInput.placeholder.chatCompact')}</Text></Button>
        <Button testID="compact-dictation" class="size-8 items-center justify-center" accessibilityLabel={t('chat.dictation.start')} onPress={() => { void run(dictate); }}><Icon name={recording() ? 'stop' : 'mic'} /></Button>
        <Button testID="compact-latest" class="size-8 items-center justify-center" accessibilityLabel={t('chat.scrollToBottom.aria')} onPress={resumeLatest}><Icon name="arrow-down-s" size={20} /></Button>
        <NativeComposerSend testIDPrefix="compact-" canAbort={chat.busy()} hasContent={!!chat.draft().trim() || chat.attachments().length > 0} onStop={() => { void run(chat.stop); }} inFlight={chat.sending() && !btwDraft()} disabled={sendDisabled()} onPress={sendDraft} />
      </>}>
      <View>
      <View
        style={{
          ...nativeDensity().chat.composerOuter,
          paddingBottom: keyboardFrame().height > 0
            ? 'calc(env(keyboard-inset-height) + 12px)'
            : 'calc(env(safe-area-inset-bottom) + 16px)',
        }}
        class="px-3 pt-2"
      >
        <If when={props.target.kind === 'session'}>
          <View accessibilityElementsHidden={chromeState().dock >= 1} style={{ opacity: 1 - chromeState().dock, pointerEvents: chromeState().dock >= 1 ? 'none' : 'auto' }}><View testID="composer-status-row" class="flex-row items-center gap-2 px-3 py-0.5" style={nativeDensity().chat.status}>
            <View class="flex-1 min-w-0"><NativeComposerChanges directory={props.target.directory} active={chat.active()} expanded={statusPopovers.opened() === 'changes'} onExpandedChange={open => statusPopovers.changes(open)} generationContext={changesGenerationContext()} diffLayoutPreference={nativeAppearance.current()?.diffLayoutPreference ?? null} onOpenPreview={(path, line) => { statusPopovers.close(); void run(async () => openResourceFile(path, props.target.directory, line)); }} /></View>
            <NativeComposerTasks todos={chat.tasks()} liveWorking={chat.busy()} active={chat.active()} expanded={statusPopovers.opened() === 'tasks'} onExpandedChange={open => statusPopovers.tasks(open)} />
          </View></View>
        </If>
        <View accessibilityElementsHidden={chromeState().dock >= 1} style={{ opacity: 1 - chromeState().dock, pointerEvents: chromeState().dock >= 1 ? 'none' : 'auto' }}><NativeChatQueue chat={chat} trailingVisible={props.target.kind === 'session' && goalEnabled() && (!!chat.goal.state().goal || !!chat.goal.state().readError || !!chat.goal.state().actionError)} trailing={<NativeGoalRow owner={chat.goal} enabled={goalEnabled()} active={chat.active()} open={goalPanel()} onOpenChange={open => { if (open) statusPopovers.close(); goalPanel.set(open); }} />} /></View>
        <View
          testID="composer-glass"
          ref={view => composerAnchor.set(view)}
          style={{ ...nativeComposerSurface, ...nativeDensity().chat.composerSurface }}
          class="px-3 pt-1 pb-1"
        >
          <NativeDraftFeedback chat={chat} />
          <Each of={chat.attachments()}>
            {(attachment) => (
              <View class="flex-row gap-2 items-center">
                <If when={attachment().kind === 'contact'} else={<Text class="text-sm text-foreground flex-1">{attachment().name}</Text>}>
                  <Button class={`${quiet} flex-1`} onPress={() => { const file = attachment(); if (file.kind === 'contact') previewAttachment(file); }}>
                    <Text class="text-sm text-foreground">{attachment().name}</Text>
                  </Button>
                </If>
                <Button
                  class={quiet}
                  accessibilityLabel={t("chat.chatInput.actions.attachCancel")}
                  onPress={() =>
                    chat.attachments.set(
                      chat
                        .attachments()
                        .filter((file) => file !== attachment()),
                    )
                  }
                >
                  <Text class="text-muted-foreground">×</Text>
                </Button>
              </View>
            )}
          </Each>
          <NativeInputMetadata ownerID="composer-glass" inputID="composer" label={t(inputMode() === 'shell' ? 'chat.chatInput.placeholder.shell' : 'chat.chatInput.placeholder.chatCompact')} active={chat.active() && lifecycle() === 'active'} />
          <NativeComposerSpellcheck ownerID="composer-glass" inputID="composer" />
          <NativeComposerPress ownerID="composer-glass" inputID="composer" />
          <Input
            testID="composer"
            accessibilityLabel={t(inputMode() === 'shell' ? 'chat.chatInput.placeholder.shell' : 'chat.chatInput.placeholder.chatCompact')}
            class="text-foreground min-h-[52px] max-h-36 py-[10px]"
            style={{ ...nativeChatTextStyle('composer'), ...nativeDensity().chat.input, backgroundColor: 'transparent', borderWidth: 0 }}
            multiline
            readonly={recording() || !chat.canSend()}
            value={chat.draft()}
            ref={node => { editor = node; referenceKeyboard.ref(node); }}
            selectedRange={referenceKeyboard.selectedRange()}
            onFocus={() => { editorFocused.set(true); chrome.pin(true); referenceKeyboard.onFocus(); }}
            onBlur={() => { editorFocused.set(false); referenceKeyboard.onBlur(); }}
            submitBehavior={referenceKeyboard.submitBehavior()}
            onSubmit={referenceKeyboard.onSubmit}
            onSelectionChange={referenceKeyboard.onSelectionChange}
            onCompositionChange={referenceKeyboard.onCompositionChange}
            onChange={(e) => {
              referenceKeyboard.beforeChange();
              if (props.target.kind === 'session' && inputMode() === 'normal' && !chat.draft() && e.value.startsWith('!')) {
                inputMode.set('shell'); chat.setDraftText(e.value.slice(1));
              } else chat.setDraftText(e.value);
              referenceKeyboard.refresh();
            }}
            placeholder={t(inputMode() === 'shell' ? 'chat.chatInput.placeholder.shell' : 'chat.chatInput.placeholder.chatCompact')}
          />
          <View class="min-h-10 flex-row gap-2 items-center" style={{ ...nativeDensity().chat.actions, gap: 8 * nativeDensity().scale }}>
            <If when={props.target.kind === "session"}>
              <Button
                class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40"
                hitSlop={6}
                disabled={attaching()}
                accessibilityLabel={t("chat.chatInput.actions.addAttachment")}
                onPress={chooseAttachment}
              >
                  <Icon name="attachment-2" size={20} />
              </Button>
            </If>
            <Button
              class="size-8 rounded-full items-center justify-center active:bg-accent"
              hitSlop={6}
              accessibilityLabel={t("chat.dictation.start")}
              onPress={() => {
                void run(dictate);
              }}
            >
              <Icon name={recording() ? 'stop' : 'mic'} />
            </Button>
            <If when={inputMode() === 'shell'}><Button testID="composer-normal-mode" class={quiet} accessibilityLabel={t('settings.common.actions.cancel')} onPress={() => inputMode.set('normal')}><Text class="text-foreground text-xs">! ×</Text></Button></If>
            <View class="flex-1" />
            <NativeGoalChip owner={chat.goal} enabled={goalEnabled()} />
            <NativeGoalObjectiveCounter armed={goalEnabled() && chat.goal.state().armed} length={chat.draft().length} />
            <NativeComposerSelection target={props.target} active={chat.active()} open={modelPicker()} onOpenChange={value => modelPicker.set(value)} onAssistantEdit={openSelection} onSelection={authority => {
              headerSelection.set(authority);
              if (!current() || !chat.active()) return;
              const model = record(authority.model);
              botCreationContext.update(props.target.directory, {
                providerID: text(model.providerID) || text(authority.providerID),
                modelID: text(model.id) || text(model.modelID) || text(authority.modelID),
                variant: text(model.variant) || text(authority.variant) || undefined,
              }, text(authority.agent) || undefined);
            }} />
            <NativeComposerSend
              canAbort={chat.busy()}
              hasContent={!!chat.draft().trim() || chat.attachments().length > 0}
              onStop={() => { void run(chat.stop); }}
              inFlight={chat.sending() && !btwDraft()}
              disabled={sendDisabled()}
              onPress={sendDraft}
            />
          </View>
        </View>
        <If when={!!referenceKeyboard.commandTrigger() && !!composerAnchor()}>
          <Overlay testID="composer-command-panel" anchor={composerAnchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={dismissReferences} onCancel={dismissReferences}>
            <NativeCommandSuggestions scope={chat.referenceScope} keyboard={referenceKeyboard} commands={chat.commands()} loadCommands={chat.loadCommands} context={commandContext()} maxHeight={Math.min(320, Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .4)} />
          </Overlay>
        </If>
        <If when={!!referenceTrigger() && !!composerAnchor()}>
          <Overlay testID="composer-reference-panel" anchor={composerAnchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={dismissReferences} onCancel={dismissReferences}>
            <NativeReferencePicker scope={chat.referenceScope} keyboard={referenceKeyboard} currentSessionID={props.target.id} maxHeight={Math.min(320, Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .4)} open={!!referenceTrigger()} query={referenceTrigger()?.query} request={operations.operation()?.request ?? (() => Promise.reject(new Error('page_operation_stale')))} onClose={dismissReferences} />
          </Overlay>
        </If>
      </View>
      </View>
      </NativeComposerChrome>
      <If when={props.target.kind === 'session'}><NativeChatTimeline open={timelineOpen()} operation={operations.operation()} onOpenChange={value => timelineOpen.set(value)} messages={chat.messages} messagesResolved={chat.messagesResolved} focusedMessageID={() => focusState()?.messageID ?? props.messageID ?? null} more={chat.more} olderLoading={chat.olderLoading} historyError={chat.historyError} loadOlder={chat.loadOlder} focusMessage={messageFocus.focus} resumeLatest={resumeLatest} messageOptions={history.props} /></If>
      <If when={!!btw()}><NativeBtwSheet owner={btw()!.owner} state={btw()!.state} active={btw()?.operation === operations.operation() && operations.current() && chat.active() && lifecycle() === 'active' && nav.routes().at(-1) === props.route} /></If>
      <If when={!!changesSource()}><NativeChangesSheet source={changesSource()!} open active={chat.active()} generationContext={changesGenerationContext()} diffLayoutPreference={nativeAppearance.current()?.diffLayoutPreference ?? null} onClose={() => changesSource.set(null)} onOpenPreview={(path, line) => { void run(async () => { changesSource.set(null); openResourceFile(path, props.target.directory, line); }); }} /></If>
    </NavPage>
  );
}

function ResourceCard(props: { card: Row }) {
  const operations = createPageOperations();
  const current = operations.current,
    pending = signal(false);
  operations.onRetire(() => pending.set(false));
  async function open() {
    if (!current() || pending()) return;
    const lane = operations.capture(), request = lane.request;
    const valid = lane.current;
    pending.set(true);
    await run(async () => {
      const card = props.card;
      if (card.cardType === "session") {
        const sessionID = text(card.sessionID);
        let directory =
          text(card.directory) ||
          app.sessions().find((session) => session.id === sessionID)
            ?.directory ||
          "";
        if (!directory)
          directory = text(
            record(
              record(
                await request(
                  `/api/yuri/session-index/session/${encodeURIComponent(sessionID)}`,
                ),
              ).session,
            ).directory,
          );
        if (!valid()) return;
        if (!sessionID || !directory) throw new Error(t("common.unavailable"));
        openChat({
          kind: "session",
          id: sessionID,
          title: text(card.title) || sessionID,
          directory,
        });
      } else if (card.cardType === "assistant") {
        let bot = app.bots().find((item) => item.id === card.assistantID);
        if (!bot)
          bot = list(
            record(await request("/api/yuri/assistants/snapshot")).assistants,
          ).find((item) => item.id === card.assistantID);
        if (!valid()) return;
        if (!bot) throw new Error(t("common.unavailable"));
        openChat({
          kind: "assistant",
          id: text(bot.id),
          title: text(bot.name),
          directory: text(bot.effectiveWorkspacePath),
        });
      } else if (card.cardType === "schedule") {
        let item = app
          .tasks()
          .find(
            (item) =>
              item.projectId === card.projectID &&
              record(item.task).id === card.taskID,
          );
        if (!item) {
          const task = list(
            record(
              await request(
                `/api/projects/${encodeURIComponent(text(card.projectID))}/scheduled-tasks`,
              ),
            ).tasks,
          ).find((task) => task.id === card.taskID);
          if (task) item = { projectId: card.projectID, task };
        }
        if (!valid()) return;
        if (!item) throw new Error(t("common.unavailable"));
        nav.push({ kind: "task", item });
      }
    });
    if (valid()) pending.set(false);
  }
  return (
    <View class="bg-card rounded-2xl p-4 gap-2">
      <If when={props.card.type === "compaction"}>
        <Text class="text-sm text-muted-foreground">
          {text(props.card.status)}
        </Text>
        <TextView
          markdown={
            text(props.card.summary) || text(record(props.card.error).message)
          }
          styles={nativeCodeTextViewStyles()}
          class="text-foreground"
          selectable
        />
      </If>
      <If when={props.card.type === "card"}>
        <Button
          class={quiet}
          disabled={pending()}
          onPress={() => {
            void open();
          }}
        >
          <Text class="text-base text-foreground">
            {text(props.card.title) ||
              text(props.card.name) ||
              (props.card.cardType === "session"
                ? t("sessions.switcher.draftTitle")
                : props.card.cardType === "schedule"
                  ? t("mobile.tabs.scheduled")
                  : t("mobile.tabs.assistant"))}
          </Text>
          <Text class="text-xs text-muted-foreground">
            {text(props.card.status)}
          </Text>
        </Button>
      </If>
    </View>
  );
}

function Files(props: {
  directory: string;
  path: string;
  registering?: boolean;
}) {
  const operations = createPageOperations();
  const current = operations.current;
  const entries = signal<Row[]>([]);
  effect(() => {
    const lane = operations.operation();
    if (!lane?.current()) return;
    untracked(() => { void run(async () => {
    const value = await lane.request(
      `/api/fs/list?path=${encodeURIComponent(props.path)}`,
    );
    if (lane.current())
      entries.set(list(record(value).entries));
    }); });
  });
  return (
    <NavPage title={nameOf(props.path)} class="flex-1 bg-background">
      <If when={props.registering}>
        <Button
          class={action}
          onPress={() => {
            void run(async () => {
              const lane = operations.capture();
              await lane.request("/api/opencode/directory", "POST", {
                path: props.path,
              });
              if (!lane.current()) return;
              await refresh();
              if (lane.current()) nav.popToRoot();
            });
          }}
        >
          <Text class="text-foreground">
            {t("directoryExplorerDialog.actions.addProject")}
          </Text>
        </Button>
      </If>
      <List
        class="flex-1"
        contentClass="p-5 gap-2"
        each={entries().filter(
          (e) => !props.registering || e.isDirectory === true,
        )}
      >
        {(item) => (
          <Button
            class="min-h-12 py-3 border-b border-border"
            onPress={() => {
              void run(async () => {
                const lane = operations.capture();
                const entry = item();
                const path =
                  text(entry.path) || `${props.path}/${text(entry.name)}`;
                if (entry.isDirectory || entry.type === "directory") {
                  if (!lane.current()) return;
                  nav.push({
                    kind: "files",
                    directory: props.directory,
                    path,
                    registering: props.registering,
                  });
                } else {
                  const result = await lane.request(
                    `/api/fs/read?path=${encodeURIComponent(path)}&${query(props.directory)}`,
                  );
                  if (!lane.current()) return;
                  nav.push({
                    kind: "preview",
                    title: nameOf(path),
                    content: "```\n" + text(result) + "\n```",
                  });
                }
              });
            }}
          >
            <Text class="text-foreground">{text(item().name)}</Text>
          </Button>
        )}
      </List>
    </NavPage>
  );
}

function ConnectionEditorPage(props: { route: Extract<Route, { kind: 'connection-editor' }> }) {
  const current = pageScope();
  const navigation = signal<ConnectionEditorNavigation>({ blocked: true, back: () => {} });
  const active = () => nav.routes().at(-1) === props.route;
  return <NavPage title={t(props.route.mode === 'rename' ? 'mobile.connect.history.rename' : 'mobile.instances.editTitle')} headerBackTitle="" class="flex-1 bg-background"
    popOnBack={!navigation().blocked} popOnSwipe={!navigation().blocked} onBackPress={() => { if (navigation().blocked) navigation().back(); }}>
    <Scroll class="flex-1" contentClass="p-5 gap-5 pb-10"><NativeConnectionEditor id={props.route.id} mode={props.route.mode} active={active()} current={current}
      onNavigation={next => navigation.set(next)} onCancel={() => { if (current() && active()) nav.pop(); }}
      onSaved={snapshot => { if (!current() || !active()) return; app.connections.set(snapshot.connections); nav.pop(); }}
      onReauthorize={edit => { if (current() && active()) nav.push({ kind: 'connect', edit }); }} /></Scroll>
  </NavPage>;
}

/** Keep the settings page/Scroll mounted; Settings owns retained edits and pending confirmations. */
function SettingsOperationPage(props: { route: Extract<Route, { kind: 'settings' }> }) {
  const operations = createPageOperations(() => nav.routes().at(-1) === props.route);
  return <SettingsPage {...settingsCallbacks} {...props.route.route} active={nav.routes().at(-1) === props.route} retention={retentionController()}
    operationToken={operations.operation()} onCollectionDirectory={(directory, route) => {
      if (nav.routes().at(-1) === props.route && operations.displayCurrent()) replaceCollectionDirectory(directory, route);
    }} />;
}

function SettingsQuotaOperationPage(props: { route: Extract<Route, { kind: 'settings-quota' }> }) {
  const current = pageScope(), route = props.route;
  return <SettingsQuotaCredentialsPage providerId={route.provider} providerName={route.providerName} directory={route.directory}
    active={current() && nav.routes().at(-1) === route && app.connection()?.id === route.hostID}
    onBack={() => { if (current() && nav.routes().at(-1) === route) nav.pop(); }} />;
}

/** Stable display owners survive foreground leases; only operation objects are replaced. */
function NativeSetupTourOwners() {
  const connection = app.connection();
  const identity = JSON.stringify([connection?.id, connection?.url, connection?.authorizationID]);
  const prefix = identity.slice(0, -1) + ',';
  const operations = createPageOperations();
  let assigned: ReturnType<typeof captureHostOperation> | null = null;
  effect(() => {
    const operation = operations.operation(); tourHistoryMonitor();
    untracked(() => {
      assigned = operation; tourRootOperation.set(operation);
      if (!operation?.current()) return;
      for (const [key, owner] of tourHistoryOwners) if (key.startsWith(prefix) && !owner.current()) void owner.replaceLane(operation).then(adopted => { if (adopted) return owner.ensureDiscovery(); }).catch(report);
      for (const owner of tourOwners) if (owner.identity === identity && !owner.controller.current()) void owner.controller.replaceLane(operation).catch(report);
      if (!tourHistoryMonitor()) setupHistory(undefined, operation);
    });
  });
  cleanup(() => {
    const retired = new Set<HistoryImportController>();
    for (const [key, owner] of tourHistoryOwners) if (key.startsWith(prefix)) { owner.dispose(); retired.add(owner); tourHistoryOwners.delete(key); }
    if (tourHistoryMonitor() && retired.has(tourHistoryMonitor()!)) tourHistoryMonitor.set(null);
    for (const owner of tourOwners) if (owner.identity === identity) { closeTour(owner); owner.controller.dispose(); tourOwners.delete(owner); }
    nav.setRoutes(nav.routes().filter(route => route.kind !== 'history-import-tasks' || !retired.has(route.history)));
    if (tourRootOperation() === assigned) tourRootOperation.set(null);
  });
  return <></>;
}

function SetupTourRoutePage(props: { route: Extract<Route, { kind: 'setup-tour' }> }) {
  const operations = createPageOperations(() => nav.routes().at(-1) === props.route);
  let binding: { operation: ReturnType<typeof captureHostOperation>; preview: ReturnType<typeof bindResourceWebPreview> } | null = null;
  effect(() => { const operation = operations.operation(); untracked(() => {
    const prior = binding; binding = operation ? { operation, preview: bindResourceWebPreview(operation.scope, native, id) } : null;
    if (prior) void prior.preview.close();
  }); });
  cleanup(() => { if (binding) void binding.preview.close(); });
  const owner = props.route.owner;
  async function readmeLink(href: string) {
    const captured = binding, directory = owner.directory;
    if (!captured?.operation.current()) throw new Error('host_operation_stale');
    const path = directory ? resolveResourceLink(directory + '/README.md', href, directory) : null;
    if (path && directory) {
      if (/\.html?$/i.test(path)) await captured.preview.present({ directory, path });
      else nav.push({ kind: 'resource-preview', directory, path, expectedHost: captured.operation.scope, tourOwner: owner });
    } else if (resourceWebPreviewIntent({ directory: directory ?? '', href }).supported) await captured.preview.present({ directory: directory ?? '', href });
    else {
      if (!/^(?:https?:\/\/|mailto:)/i.test(href) || /^https?:\/\/[^/]*@/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) throw new Error('unsupported_resource_link');
      if (!(await openUrl(href)).opened) throw new Error('resource_link_failed');
    }
  }
  return <NativeSetupTourPage controller={owner.controller} active={nav.routes().at(-1) === props.route}
    onOpenDetail={detail => { if (owner.controller.current()) nav.push({ kind: 'setup-tour-detail', owner, detail }); }}
    onOpenHistoryTasks={() => { if (owner.controller.current()) nav.push({ kind: 'history-import-tasks', history: owner.controller.historyImport, owner }); }}
    onOpenReadmeLink={readmeLink} />;
}

function SetupTourDetailRoutePage(props: { route: Extract<Route, { kind: 'setup-tour-detail' }> }) {
  const operations = createPageOperations(() => nav.routes().at(-1) === props.route);
  const recognition = signal<(VoiceTestAsrAdapter & { dispose: () => Promise<void> }) | null>(null);
  const recognitionReady = signal(false);
  let version = 0;
  effect(() => {
    const operation = operations.operation(), active = props.route.detail.kind === 'voice' && props.route.detail.section === 'doubao' && nav.routes().at(-1) === props.route && lifecycle() === 'active';
    untracked(() => {
      const ticket = ++version, prior = recognition(); recognition.set(null); recognitionReady.set(false);
      void (async () => {
        await prior?.dispose();
        if (!active || !operation?.current() || ticket !== version) return;
        const adapter = await createSettingsVoiceRecognitionAdapter({ expectedHost: operation.scope, call: native, on: (name, callback) => host.on(name, callback), current: () => ticket === version && operation.current(), invalidated: () => { if (ticket === version) { const previous = recognition(); recognition.set(null); void previous?.dispose().catch(report); } } });
        if (ticket !== version || !operation.current()) { await adapter.dispose(); return; }
        recognition.set(adapter); recognitionReady.set(true);
      })().catch(cause => { if (ticket === version) recognitionReady.set(true); report(cause); });
    });
  });
  cleanup(() => { version++; const previous = recognition(); recognition.set(null); void previous?.dispose().catch(report); });
  return <NativeSetupTourDetailPage {...settingsCallbacks} detail={props.route.detail} directory={props.route.owner.directory}
    active={nav.routes().at(-1) === props.route} operationToken={operations.operation()} asrAdapter={recognition()} asrReady={recognitionReady()}
    onBack={() => { if (nav.routes().at(-1) === props.route) nav.remove(props.route); }}
    onComplete={() => props.route.owner.controller.completeVoice()} />;
}

function ProjectsHomeSurface(props: { active: boolean; bottomInset?: number }) {
  const sheet = signal<ProjectHomeSheetIntent | null>(null);
  const open = (intent: ProjectHomeSheetIntent) => { if (props.active && !sheet()) sheet.set(intent); };
  return <>
    <ProjectsHome {...projectsNavigation} active={props.active} bottomInset={props.bottomInset}
      onOpenProject={project => open({ kind: 'worktrees', project })}
      onEditProject={project => open({ kind: 'edit', project })}
      onAddProject={() => open({ kind: 'directory' })}
      onNewWorktree={project => open({ kind: 'new-worktree', project })}
      instanceOptions={app.connections().map(connection => ({ id: connection.id, label: connection.label, active: connection.id === app.connection()?.id, disabled: false }))} />
    <If when={!!sheet()}><ProjectsHomeSheet intent={sheet()!} active={props.active} navigation={projectsNavigation} onReplace={intent => sheet.set(intent)} onClosed={() => sheet.set(null)} /></If>
  </>;
}

function Home() {
  const tabBarHeight = signal(0);
  return (
    <NavPage
      title="Yuri"
      headerBackTitle=""
      class="flex-1 bg-background"
      headerVisible={false}
    >
      <View class="flex-1" style={{ paddingTop: safeArea().top, paddingLeft: safeArea().left, paddingRight: safeArea().right }}>
      <If when={!app.connection()}>
        <View class="flex-1 p-6 justify-center gap-4">
          <YuriMark size="hero" decorative />
          <YuriWordmark size="hero" />
          <Hint value={t("mobile.connect.welcome.pairingHint")} />
          <Button
            testID="connect-device"
            class={action}
            onPress={() => nav.push({ kind: "connect" })}
          >
            <Text class="text-foreground">
              {t("mobile.connect.connectButton")}
            </Text>
          </Button>
        </View>
      </If>
      <If when={!!app.connection()}>
        <View class="flex-1">
          <If when={!app.online()}><View class="px-5 pb-2">
            <Text class="text-xs text-muted-foreground">
              {app.connections().find(connection => connection.id === app.connection()?.id)?.label ?? app.connection()?.label} ·{" "}
              {app.online()
                ? t("mobile.instances.status.connected")
                : t("mobile.instances.status.saved")}
            </Text>
          </View></If>
          <Each of={app.connection() ? [app.connection()!] : []} key={connection => JSON.stringify([connection.id, connection.url, connection.authorizationID])}>{() => <>
          <View class="flex-1 flex-col" style={{ display: app.tab() === 0 ? 'flex' : 'none' }}>
            <ProjectsHomeSurface bottomInset={tabBarHeight()} active={nav.routes().length === 1 && app.tab() === 0} />
            <If when={!!tourHistoryMonitor()}><View class="px-5 pb-2"><NativeHistoryImportTaskEntry controller={tourHistoryMonitor()!} active={nav.routes().length === 1 && app.tab() === 0} onOpen={() => { const history = tourHistoryMonitor(); if (history?.current()) nav.push({ kind: 'history-import-tasks', history }); }} /></View></If>
          </View>
          <If when={app.tab() === 1}>
            <AssistantHome bottomInset={tabBarHeight()} active={nav.routes().length === 1 && app.tab() === 1} onOpenChat={openChat} onCreate={() => openBotEditor()} onEdit={bot => nav.push({ kind: 'assistant-details', bot })} onOpenSettings={() => nav.push({ kind: 'settings', route: { page: 'assistants' } })} />
          </If>
          <If when={app.tab() === 2}>
            <ScheduledHome bottomInset={tabBarHeight()} active={nav.routes().length === 1 && app.tab() === 2} onOpenAssistant={openChat} onCreate={() => openTaskEditor()} onEdit={item => openTaskEditor(item)} onOpenTask={item => nav.push({ kind: 'task', item })} onOpenSession={openChat} />
          </If>
          <If when={app.tab() === 3}>
            <SettingsHome {...settingsCallbacks} bottomInset={tabBarHeight()} />
          </If>
          </>}</Each>
        </View>
      </If>
      </View>
      <TabBar
        testID="main-tabs"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' }}
        onLayout={event => { const height = event.bounds.size.height; if (height > 0 && height !== tabBarHeight()) tabBarHeight.set(height); }}
        selectedIndex={app.tab()}
        onChange={(e) => app.tab.set(e.index)}
        items={[
          { title: t("mobile.tabs.projects"), icon: "folder" },
          { title: t("mobile.tabs.assistant"), icon: "sparkles" },
          { title: t("mobile.tabs.scheduled"), icon: "calendar" },
          { title: t("mobile.tabs.settings"), icon: "gearshape" },
        ]}
      />
    </NavPage>
  );
}

function NativeRetentionRoot(props: { hostID: string; generation: number }) {
  const hostID = props.hostID, generation = props.generation;
  const current = () => app.connection()?.id === hostID && epoch() === generation;
  const controller = createNativeRetentionOwner({ scope: hostID, current,
    active: () => current() && lifecycle() === 'active',
    protectedIDs: () => new Set(nav.routes().flatMap(route => route.kind === 'chat' && route.target.kind === 'session' ? [route.target.id] : [])),
    autoRun: true,
  });
  retentionController.set(controller);
  cleanup(() => { if (retentionController() === controller) retentionController.set(undefined); });
  return <></>;
}

export function YuriNativeApp(props: { startupFeedback?: JSX.Element; startupFeedbackVisible?: boolean } = {}) {
  cleanup(keymap.bind('mod+p', () => untracked(() => {
    if (lifecycle() !== 'active' || !app.connection()) return;
    const top = nav.routes().at(-1);
    if (top?.kind === 'project-search') { nav.pop(); return; }
    const directory = top?.kind === 'chat' ? top.target.directory
      : top?.kind === 'new-session' ? top.directory ?? top.project?.path
      : top?.kind === 'project' ? top.project.path
      : top?.kind === 'settings' ? top.route.directory
       : top?.kind === 'settings-home' ? top.directory
       : top?.kind === 'setup-tour' || top?.kind === 'setup-tour-detail' ? top.owner.directory
       : top?.kind === 'history-import-tasks' ? top.owner?.directory ?? top.history.directory ?? undefined
      : top?.kind === 'session-switcher' ? top.source?.directory : undefined;
    nav.push({ kind: 'project-search', directory });
  })));
  cleanup(keymap.bind('mod+b', () => untracked(() => {
    if (lifecycle() !== 'active' || !app.connection()) return;
    const top = nav.routes().at(-1);
    if (top?.kind === 'session-switcher') nav.pop();
    else if (top?.kind === 'chat') nav.push({ kind: 'session-switcher', source: top.target });
  })));
  let feedbackPageGeneration = 0;
  effect(() => { nav.routes().at(-1); feedbackPageGeneration++; });
  cleanup(registerFeedbackPageOwner(() => {
    const page = nav.routes().at(-1), captured = feedbackPageGeneration;
    return () => nav.routes().at(-1) === page && captured === feedbackPageGeneration;
  }));
  const initializeRoot = async () => {
    // Host appearance is authoritative; legacy unscoped Storage `appearance` must not override it.
    language.set((await Storage.getItem("language")) || "system");
    await loadConnections();
  };
  void run(initializeRoot, { retry: initializeRoot, current: () => true });
  runtimeLifecycle();
  const notifications = createNativeNotificationRoot<Route>({
    scope: nativeNotificationScope,
    captureRequest: captureHostRequest,
    authorizationID: nativeNotificationAuthorization,
    catalogReady: current => awaitNotificationCatalogReady(nativeNotificationScope(), current),
    catalog: (_target, current) => {
      if (!current() || !app.notificationCatalog().complete) throw new Error('notification_catalog_incomplete');
      return [
        ...app.bots().map(bot => ({ target: { kind: 'assistant' as const, id: text(bot.id) } })),
        ...app.tasks().map(item => ({ target: { kind: 'schedule' as const, id: text(record(item.task).id) }, projectID: text(item.projectId) })),
      ];
    },
    sessions: () => app.sessions(),
    resolve: identity => {
      if (identity.kind === 'session') return [{ kind: 'chat', target: { ...identity.session, kind: 'session' } }];
      if (identity.kind === 'assistant') return app.bots().filter(bot => text(bot.id) === identity.id).map<Route>(bot => ({ kind: 'chat', target: assistantChatTarget(bot) }));
      return app.tasks().filter(item => text(record(item.task).id) === identity.id).map<Route>(item => ({ kind: 'task', item }));
    },
    open: (route, current) => { if (current()) nav.push(route); },
  });
  effect(() => {
    const catalog = app.notificationCatalog(), active = lifecycle() === 'active';
    if (active && catalog.complete) untracked(() => { void notifications.recover(); });
  });
  const NotificationFeedback = notifications.Feedback;
  const diagnostics = createNativeAboutDiagnosticsRoot();
  observeRuntime(() => {
    void run(refresh, { retry: refresh, current: () => true });
  }, (event, scope) => {
    notifications.onEvent(event, scope);
    diagnostics.onEvent(event, scope);
  });
  let attentionScope: string | undefined;
  effect(() => {
    const scope = JSON.stringify([epoch(), app.connection()?.id]);
    const route = nav.routes().at(-1);
    if (attentionScope && attentionScope !== scope) projectsAttention.setViewedSession(attentionScope, null);
    attentionScope = scope;
    projectsAttention.setViewedSession(scope, lifecycle() === 'active' && route?.kind === 'chat' && route.target.kind === 'session' ? route.target.id : null);
  });
  cleanup(() => { if (attentionScope) projectsAttention.setViewedSession(attentionScope, null); });
  const stopLinks = host.on("connection.link", (value) => {
    const link = text(record(value).url);
    if (link) nav.push({ kind: "connect", link });
  });
  cleanup(stopLinks);
  cleanup(() => projectChangesSource.set(null));
  effect(() => { epoch(); lifecycle(); projectChangesSource.set(null); });
  let previous: string | undefined;
  effect(() => {
    const selected = app.connection()?.id;
    if (previous && selected !== previous) untracked(() => resourceConnectionClear.clear());
    previous = selected;
  });
  return (
    <View class="flex-1 bg-background">
      <Each of={app.connection() ? [app.connection()!] : []} key={connection => JSON.stringify([connection.id, connection.url, connection.authorizationID])}>{() => <NativeSetupTourOwners />}</Each>
      <Each of={app.connection() ? [{ hostID: app.connection()!.id, generation: epoch() }] : []} key={scope => JSON.stringify([scope.hostID, scope.generation])}>{scope => <NativeRetentionRoot hostID={scope().hostID} generation={scope().generation} />}</Each>
      <NativeAppearanceSync />
      <NativeDeviceChatPreferences />
      <NotificationFeedback />
      <NavStack state={nav} class="flex-1">
        {(route) => {
          if (route.kind === "root") return <Home />;
          if (route.kind === "connect") return <Connect link={route.link} edit={route.edit} />;
          if (route.kind === 'connection-editor') return <ConnectionEditorPage route={route} />;
          if (route.kind === "project")
            return <ProjectDetail project={route.project} initialCreateWorktree={route.createWorktree} {...projectsNavigation} active={nav.routes().at(-1) === route} />;
          if (route.kind === 'project-directory') return <ProjectDirectoryPage onAdded={(project, options) => { if (!options.openDraft) return; nav.replace({ kind: 'new-session', project }); }} />;
          if (route.kind === 'new-session') return <NativeNewSessionPage project={route.project} directory={route.directory} deviceChatPreferences={deviceChatPreferences} active={nav.routes().at(-1) === route} onSelection={(directory, selection, agent) => botCreationContext.update(directory, selection, agent)} onOpenChat={(target, handoff) => nav.replace({ kind: 'chat', target, handoff })} />;
          if (route.kind === 'remote-desktop') return <NavPage title={t('remoteDesktop.title')} headerVisible={false} class="flex-1 bg-background"><NativeRemoteDesktopPage scopeKey={`${epoch()}:${app.connection()?.id ?? ''}`} active={nav.routes().at(-1) === route} onClose={() => nav.pop()} /></NavPage>;
          if (route.kind === 'project-search') return <ProjectsSearchPage commands={projectSearchCommands(route.directory)} projects={app.projects()} focusDirectory={route.directory} onOpenProject={project => { nav.pop(); nav.push({ kind: 'new-session', project, directory: project.path }); }} onOpenChat={(target, options) => { nav.pop(); openChat(target, options); }} onOpenFile={(directory, path) => { void run(async () => { nav.pop(); openResourceFile(path, directory); }); }} />;
          if (route.kind === 'session-switcher') return <NativeSessionSwitcherPage currentTarget={route.source} current={pageScope()} onClose={() => nav.pop()} navigation={{ ...projectsNavigation, onOpenSearch: () => nav.push({ kind: 'project-search', directory: route.source?.directory }) }} />;
          if (route.kind === "chat") return <Chat route={route} target={route.target} messageID={route.messageID} handoff={route.handoff} />;
          if (route.kind === 'context-usage') return <ContextUsageRoute chat={route.chat} target={route.source.target} scope={route.chat.messageScope} current={route.current} active={nav.routes().at(-1) === route} appearance={nativeAppearance.current()} />;
          if (route.kind === "task") return <ScheduledTaskDetail item={route.item} active={nav.routes().at(-1) === route} onDeleted={() => nav.pop()} onEdit={item => nav.push({ kind: 'task-editor', item })} onOpenSession={openChat} />;
          if (route.kind === 'settings' && route.route.page === 'assistants') return <AssistantSettings active={nav.routes().at(-1) === route} onCreate={() => openBotEditor()} onEdit={bot => nav.push({ kind: 'assistant-details', bot })} />;
          if (route.kind === 'settings-home') return <NavPage title={t('settings.view.home.title')} headerBackTitle="" class="flex-1 bg-background"><SettingsHome {...settingsCallbacks} showTitle={false} /></NavPage>;
          if (route.kind === 'settings-quota') return <SettingsQuotaOperationPage route={route} />;
          if (route.kind === 'setup-tour') return <SetupTourRoutePage route={route} />;
          if (route.kind === 'setup-tour-detail') return <SetupTourDetailRoutePage route={route} />;
          if (route.kind === 'history-import-tasks') return <NativeHistoryImportTasksPage controller={route.history} active={nav.routes().at(-1) === route} />;
          if (route.kind === 'settings') return <SettingsOperationPage route={route} />;
          if (route.kind === 'assistant-details') return <AssistantDetails bot={route.bot} active={nav.routes().at(-1) === route} onDone={() => nav.pop()} onOpenChat={target => {
            const previous = nav.routes().at(-2);
            if (previous?.kind === 'chat' && previous.target.kind === target.kind && previous.target.id === target.id) nav.pop();
            else openChat(target);
          }} onOpenTask={item => nav.push({ kind: 'task', item })} historyActions={{ clearLabel: t('assistants.contact.clearHistory'), confirmDescription: t('assistants.contact.clearHistoryConfirm'), clearedLabel: t('assistants.contact.historyCleared') }} />;
          if (route.kind === "bot-editor")
            return (
              <BotEditor
                bot={route.bot}
                defaultContext={route.defaultContext}
                onDone={() => {
                  if (
                    route.bot &&
                    !app.bots().some((bot) => bot.id === route.bot?.id)
                  )
                    nav.popToRoot();
                  else nav.pop();
                }}
              />
            );
          if (route.kind === "task-editor")
            return (
              <TaskEditor
                item={route.item}
                creationContext={route.creationContext}
                active={nav.routes().at(-1) === route}
                onOpenSession={openChat}
                syncPendingDescription={t('sessions.scheduledTasks.editor.toast.schedulerSyncPending')}
                onDone={() => {
                  if (
                    route.item &&
                    !app
                      .tasks()
                      .some(
                        (item) =>
                          item.projectId === route.item?.projectId &&
                          record(item.task).id === record(route.item?.task).id,
                      )
                  )
                    nav.pop(2);
                  else nav.pop();
                }}
              />
            );
          if (route.kind === "models") return <ChatModels target={route.target} onDone={() => nav.pop()} />;
          if (route.kind === 'contact-attachment-preview') return <NavPage title={route.file.name} headerBackTitle="" class="flex-1 bg-background"><View class="flex-1 p-4"><ContactAttachmentPreview file={route.file} expectedHost={route.expectedHost} active={nav.routes().at(-1) === route} onClose={() => { if (nav.routes().at(-1) === route) nav.pop(); }} /></View></NavPage>;
          if (route.kind === "files")
            if (!route.registering) return <ResourceFilesPage title={t('mobile.menu.files')} directory={route.directory} path={route.path} sessionId={route.sessionId} active={nav.routes().at(-1) === route} connectionExit={owner => resourceConnectionClear.register(route, owner)} onClose={() => { if (nav.routes().at(-1) === route) nav.pop(); }} />;
          if (route.kind === 'resource-preview') return <ResourcePreviewPage title={nameOf(route.path)} directory={route.directory} path={route.path} sessionId={route.sessionId} targetLine={route.targetLine} expectedHost={route.expectedHost} active={nav.routes().at(-1) === route} connectionExit={owner => resourceConnectionClear.register(route, owner)} onClose={() => { if (nav.routes().at(-1) === route) nav.pop(); }} onOpen={path => { void run(async () => {
            if (route.expectedHost !== undefined) {
              const absolute = resourcePath(path.startsWith('/') ? path : route.directory + '/' + path);
              if (!resourceWithin(absolute, route.directory)) throw new Error(t('mobile.files.error.readUnavailable'));
              nav.push({ kind: 'resource-preview', directory: route.directory, path: absolute, expectedHost: route.expectedHost, tourOwner: route.tourOwner });
            } else openResourceFile(path, route.directory);
          }); }} />;
          if (route.kind === "files")
            return (
              <Files
                directory={route.directory}
                path={route.path}
                registering={route.registering}
              />
            );
          return (
            <NavPage title={route.title} class="flex-1 bg-background">
              <Scroll class="flex-1" contentClass="p-5">
                <TextView
                  markdown={route.content}
                  styles={nativeCodeTextViewStyles()}
                  selectable
                  class="text-foreground"
                />
              </Scroll>
            </NavPage>
          );
        }}
      </NavStack>
      <Each of={projectChangesSource() ? [projectChangesSource()!] : []} key={source => source.directory}>{value => {
        const source = value();
        return <NativeChangesSheet source={source} open active={lifecycle() === 'active'} diffLayoutPreference={nativeAppearance.current()?.diffLayoutPreference ?? null} onClose={() => projectChangesSource.set(null)} onOpenPreview={(path, line) => { void run(async () => openResourceFile(path, source.directory, line)); }} />;
      }}</Each>
      <NativeFeedbackLayer layoutKey={nav.routes().at(-1)}>{props.startupFeedback}<NativeRootErrorFeedback suppressed={props.startupFeedbackVisible} /><NativeAppearanceFeedback suppressed={props.startupFeedbackVisible || rootErrorVisible()} /></NativeFeedbackLayer>
    </View>
  );
}
