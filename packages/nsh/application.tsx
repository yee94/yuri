import {
  batch,
  cleanup,
  Clipboard,
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
  platform,
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
import { TabBar } from "nsh/mobile";
import { isAvailable as desktopWindowAvailable, Window } from 'nsh/desktop';
import { NativeDesktopTitleBar, installNativeDesktopMenu } from './desktop';
import { createDesktopLayout, NativeDesktopWorkspace } from './desktop-workspace';
import { createNativeDesktopSettingsRoot } from './desktop-settings-root';
import { NativeDesktopTerminalDock } from './desktop-terminal';
import { createDesktopTerminalPreview } from './desktop-terminal-preview';
import type { NativeDesktopTerminalShortcutOwner, NativeDesktopTerminalShortcutPublisher } from './desktop-terminal-actions';
import { createDesktopWindowCloseOwner } from './desktop-window-close-core';
import { NativeDesktopCommandPalette } from './desktop-command-palette';
import { NativeDesktopSessionSwitcher } from './desktop-session-switcher';
import type { DesktopSwitcherSource } from './desktop-session-switcher-core';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';
import { DesktopShortcutsSettings } from './desktop-shortcuts-settings';
import type { NativeShortcutActions, NativeShortcutCapture } from './desktop-shortcuts-core';
import { createNativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutPublisher } from './desktop-composer-actions';
import type { DesktopSidebarActions, DesktopSidebarActionsRef } from './desktop-sidebar-navigation';
import { DesktopSidebar } from './desktop-sidebar';
import { NativeDesktopHelpDialog } from './desktop-help';
import { createDesktopPanelTabsPersistence } from './desktop-panel-tabs-persistence';
import { createDesktopFileJournalStorage } from './desktop-files-storage';
import { createNativeDesktopPanelTabs, NativeDesktopPanel } from './desktop-panel';
import type { DesktopPanelIntent, DesktopPanelScope } from './desktop-panel-model';
import { currentLocale, language, t } from "./i18n";
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
  desktopSidebarAuthority,
  desktopContactCatalog,
  desktopContactSessionStatus,
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
import { createDesktopPageDeparture } from './desktop-page-departure';
import type { TaskEditorLeave } from './task-editor-owner';
import { createBotCreationContext, type BotDefaultContext } from './features-bot-defaults';
import type { TaskEditorCreationContext } from './task-editor-defaults';
import type { ConnectionEditorMutation, ConnectionEditorSnapshot } from './connection-editor-core';
import { NativeConnectionEditor, type ConnectionEditorNavigation } from './connection-editor';
import { BlockingRequests } from "./blocking";
import { Icon } from './Icon';
import { YuriMark, YuriWordmark } from './branding';
import { ChatModels } from './chat-models';
import { ChatHeaderActions, NativeChatHeader, type ChatHeaderOption } from './chat-header';
import { NativeDesktopRuntimeHeader } from './desktop-header-runtime';
import { createDesktopHeaderInstancesRoot } from './desktop-header-instances-root';
import { createDesktopHeaderNavigation } from './desktop-header-navigation';
import { createNativeDesktopHeaderGitHubRoot } from './desktop-header-github-root';
import { createNativeDesktopHeaderUpdateRoot } from './desktop-header-update-root';
import { createDesktopChatHeaderOwner } from './desktop-chat-header-owner';
import { bindNativeDesktopDiffPreferences, createNativeDesktopDiffPreferences } from './desktop-diff-preferences';
import { createDesktopWindowMetadataStorage, desktopWindowMetadataIdentity, desktopWindowPreferenceCoordination, type DesktopWindowMetadataStorage, type DesktopWindowPreferenceCoordination } from './desktop-window-metadata';
import type { DesktopChatHeaderActions, DesktopChatHeaderResult } from './desktop-chat-header-core';
import type { ChatHeaderMetadata } from './chat-header-metadata';
import { compileNativePrompt, magicCommand, magicCommands } from './composer';
import { createNativeLocalCommands, type NativeLocalCommandAction, type NativeLocalCommandInvocation, type NativeLocalCommandSnapshot } from './composer-local-commands';
import { createNativeLocalMagicAction } from './composer-local-commands-actions';
import { NativeComposerTimeline } from './composer-timeline';
import { confirmNativeLocalCommandConflict } from './desktop-local-command-conflict';
import { sameReferenceScope } from './composer-references';
import { resolveTurnOffsetTarget } from '../ui/src/components/chat/hooks/chatTurnNavigationCore';
import { nativeRowTurns, type NativeBodyRow } from './transcript-body-model';
import { desktopContactMessageRows } from './desktop-assistant-message-model';
import { createDesktopAssistantReadMarker } from './desktop-assistant-read-marker';
import { createDesktopAssistantReadSnapshot } from './desktop-assistant-read-snapshot';
import { createContactTimeFormatter } from '../ui/src/components/assistants/contactMessageTime';
import { desktopAssistantEditorStyle, NativeDesktopAssistantEmpty, NativeDesktopAssistantMessage, NativeDesktopAssistantSendError, NativeDesktopAssistantTyping } from './desktop-assistant-conversation';
import { NativeCommandSuggestions } from './composer-controls';
import { shouldSubmitCommandOnSelection } from './composer-commands-model';
import { NativeComposerPress } from './native-composer-press';
import { nativeComposerSurface } from './composer-surface';
import { NativeInputMetadata } from './native-input-metadata';
import { NativeComposerSpellcheck } from './native-composer-spellcheck';
import { createChatComposerCommands } from './chat-composer-commands';
import { isNativeBtwCommand, type NativeCommandIntent } from './composer-command-router';
import { createNativeBtwOwner, NativeBtwSheet } from './chat-btw';
import { NativeChatTimeline } from './chat-timeline';
import { ContactAttachmentPreview, ResourcePreview, ResourcesBrowser, resolveResourceLink } from './resources';
import { ResourceFilesPage, ResourcePreviewPage } from './resource-navigation';
import { createResourceConnectionClear } from './resource-retirement';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { resourcePath, resourceResolve, resourceWithin } from './resources-model';
import { NativeChatQueue, NativeDraftFeedback } from './chat-queue';
import { NativeChatMcp } from './chat-mcp';
import { NativeChangesPresentation, NativeChangesSheet, NativeComposerChanges, type NativeChangesPresentationHandle } from './chat-changes';
import type { ChangesSource } from './chat-changes-model';
import { NativeComposerSelection } from './chat-composer-selection';
import { NativeComposerSend } from './composer-send';
import { nativeDensity } from './appearance';
import { NativeReferencePicker } from './composer-references-controls';
import { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';
import { nativeAppearance, nativeChatTextStyle, nativeCodeTextViewStyles } from './appearance';
import { createNativeTranscriptHistory, NativeMessageActions } from './transcript-actions';
import { NativeTranscriptBody } from './transcript-body';
import { createDesktopContentLink } from './desktop-content-link';
import { createNativeDesktopRemoteConnectionsRoot } from './desktop-remote-connections-root';
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
import type { DesktopAssistantConversationContext } from './desktop-assistants';
import { SETTINGS_ENTRIES, SettingsHome, SettingsPage, type SettingsRoute, type SettingsCallbacks } from './settings';
import { SettingsQuotaCredentialsPage } from './settings-quota-credentials';
import type { QuotaCredentialProvider } from './settings-quota-credentials-core';
import { ContextUsageRoute } from './context-usage-route';
import { NativeDesktopContext } from './desktop-context';
import { createDesktopBtwWorkbench, type DesktopBtwWorkbench } from './desktop-btw-workbench';
import { NativeDesktopBtwPanel, type NativeBtwSpeech } from './desktop-btw-panel';
import { createDesktopBtwSpeech } from './desktop-btw-speech';
import type { NativeBtwScope, NativeBtwSelection } from './desktop-btw';
import { loadNativeDesktopHttpGrant, type DesktopHttpGrant } from './desktop-http';
import { loadDesktopPanelChatNativeStream } from './desktop-panel-chat-native-stream';
import type { DesktopPanelChatStream } from './desktop-panel-chat-source';
import { NativeChatBodyLayout, NativeChatComposerLayout, NativeChatRow } from './chat-layout-surfaces';
import { NativeDesktopChatEmptyState, desktopChatEditorStyle, desktopChatListContentStyle } from './desktop-chat-layout';
import { desktopChatContentWidth } from './desktop-chat-layout-core';
import { createNativeDesktopChatWorkStatus, createNativeDesktopChatWorkStatusWindow, type NativeDesktopChatWorkStatusWindow } from './desktop-chat-work-status';
import { observeDesktopWorkStatusChildren, readDesktopWorkStatusChildren } from './desktop-work-status-source';
import type { DesktopWorkStatusLocation, DesktopWorkStatusScope } from './desktop-work-status-core';
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
import { createDesktopChatAttachments } from './desktop-chat-attachments';
import { NativeDesktopAssistantCard, type NativeDesktopAssistantCardProps } from './desktop-assistant-cards';
import { NativeDesktopAssistantAttachment } from './desktop-assistant-attachment';
import { loadNativeDesktopWriterClient } from './desktop-writer';
import type { DesktopWriterClient, VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { NativeDesktopChatWriter, type NativeDesktopChatWriterOwner } from './desktop-chat-writer-native';
import { createDesktopWriterDeparture, type DesktopWriterDepartureGuard } from './desktop-writer-departure';
import { createNativeDesktopOpenInApps } from './desktop-open-in-apps-native';
import type { NativeNewSessionPageHandoff, NativeNewSessionFolderTarget, NativeNewSessionOwner } from './new-session';
import { NativeDesktopBtwSelection } from './desktop-btw-selection';
import { desktopGitContextInput, desktopGitDraftAuthority, type DesktopGitAgentRequest, type DesktopGitContextInput } from './desktop-git-dispatch';
import type { DesktopGitOwnerPublisher } from './desktop-git-dispatch-owner';
import { createNewSessionAdmission, type NewSessionAdmissionState } from './new-session-admission';
import { attachDesktopNavigationApplication } from './desktop-navigation-application';
import { NativeDesktopNavigationFeedback } from './desktop-navigation-feedback';
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
const desktopContactCardSource = signal<DesktopSwitcherSource | null>(null);
const desktopAssistantCardGeneration = signal(0), desktopScheduledCardGeneration = signal(0);
type TourOwner = { id: string; hostID: string; identity: string; directory?: string; controller: ReturnType<typeof createNativeSetupTour> };
type Route =
  | { kind: "root" }
  | { kind: "connect"; link?: string; edit?: ConnectionEditorMutation }
  | { kind: 'connection-editor'; id: string; mode: 'rename' | 'edit' }
  | { kind: "project"; project: Project; createWorktree?: boolean }
  | { kind: "chat"; target: ChatTarget; messageID?: string; handoff?: NativeNewSessionPageHandoff }
  | { kind: 'new-session'; project?: Project; directory?: string; initialContext?: DesktopGitContextInput; initialFolder?: NativeNewSessionFolderTarget }
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
const rawNavigation = { push: nav.push, pop: nav.pop, popToRoot: nav.popToRoot, replace: nav.replace, setRoutes: nav.setRoutes, remove: nav.remove };
let desktopNavigationMutation: ((apply: () => void) => void) | undefined;
let desktopPageDeparture: ReturnType<typeof createDesktopPageDeparture> | undefined;
let desktopDirectoryChanged: ((route: Route, directory: string) => void) | undefined;
let desktopDraftOwnerChanged: (() => void) | undefined;
let desktopNavigationIntent: (() => void) | undefined;
let desktopSystemNavigationReset: (() => void) | undefined;
let desktopOpenScheduledCard: ((item: Row, current: () => boolean) => Promise<boolean>) | undefined;
let desktopTakeScheduledCard: (() => Row | undefined) | undefined;
let desktopOpenAssistantCard: ((assistantID: string, current: () => boolean) => Promise<boolean>) | undefined;
let desktopTakeAssistantCard: (() => string | undefined) | undefined;
let desktopSelectAssistantContact: ((assistantID: string, current: () => boolean) => Promise<boolean>) | undefined;
let desktopGuardedNavigation: ((commit: () => void, before: readonly Route[], after: readonly Route[], retireInline?: boolean) => Promise<boolean>) | undefined;
let desktopWriterCommitDepth = 0;
for (const method of ['push', 'pop', 'popToRoot', 'replace', 'setRoutes', 'remove'] as const) {
  const apply = (...args: unknown[]) => Reflect.apply(rawNavigation[method], nav, args);
    Object.assign(nav, { [method]: (...args: unknown[]) => {
    const commit = () => { if (desktopNavigationMutation) desktopNavigationMutation(() => apply(...args)); else apply(...args); };
    if (desktopWriterCommitDepth) { commit(); return; }
    if (desktopGuardedNavigation) {
      const before = nav.routes();
      const after = method === 'push' ? [...before, args[0] as Route]
        : method === 'pop' ? before.slice(0, Math.max(1, before.length - (typeof args[0] === 'number' ? args[0] : 1)))
        : method === 'popToRoot' ? before.slice(0, 1)
        : method === 'replace' ? [...before.slice(0, -1), args[0] as Route]
        : method === 'setRoutes' ? args[0] as Route[] : before.filter(route => route !== args[0]);
      void desktopGuardedNavigation(commit, before, after); return;
    }
    if (desktopPageDeparture) void desktopPageDeparture.request(commit); else commit();
  } });
}
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
const mountedChatRevision = signal(0);
const desktopRouteAuthorities = new WeakMap<Route, string>();
const desktopChatSubmitters = new WeakMap<Extract<Route, { kind: 'chat' }>, () => Promise<boolean>>();
const desktopChatHeader = signal<{ route: Extract<Route, { kind: 'chat' }>; metadata: () => ChatHeaderMetadata; refreshUsage: () => Promise<DesktopChatHeaderResult> } | null>(null);
const desktopWorkStatusWindow = signal<NativeDesktopChatWorkStatusWindow | null>(null);
const desktopDraftDirectories = new WeakMap<Route, { host: string; directory: string }>();
const desktopRetainedDraftOwners = new WeakMap<Route, NativeNewSessionOwner>();
const retainDesktopDraftOwner = (route: Route, owner: NativeNewSessionOwner) => {
  desktopRetainedDraftOwners.set(route, owner);
  const unregister = desktopRegisterWriterGuard?.({ route, owner, inline: false }, {
    current: owner.ownedScope, prepare: owner.prepareWriterRetirement, canClose: owner.canReleaseWriter, cancel: owner.cancelWriterRetirement,
    release: owner.releaseWriter,
  });
  return () => { unregister?.(); if (desktopRetainedDraftOwners.get(route) === owner) desktopRetainedDraftOwners.delete(route); };
};
const retainDesktopDraftAdmission = (route: Route, guard: DesktopWriterDepartureGuard) =>
  desktopRegisterWriterGuard?.({ route, owner: guard, inline: false }, guard);
const desktopDraftRevision = signal(0);
const desktopHostIdentity = computed(() => { const connection = app.connection(); return JSON.stringify([connection?.id, connection?.url, connection?.authorizationID]); });
function publishDesktopDraftDirectory(route: Route, directory: string) {
  const host = desktopHostIdentity(), previous = desktopDraftDirectories.get(route);
  if (previous?.host === host && previous.directory === directory) return;
  desktopDraftDirectories.set(route, { host, directory }); desktopDraftRevision.set(desktopDraftRevision() + 1);
  desktopDirectoryChanged?.(route, directory);
}
function routeDirectory(route = nav.routes().at(-1)): string | undefined {
  if (!route) return;
  if (route.kind === 'chat') return route.target.directory;
  if (route.kind === 'new-session' || route.kind === 'root') {
    desktopDraftRevision();
    const draft = desktopDraftDirectories.get(route);
    return draft?.host === desktopHostIdentity() ? draft.directory : route.kind === 'new-session' ? route.directory ?? route.project?.path : undefined;
  }
  if (route.kind === 'project') return route.project.path;
  if (route.kind === 'settings') return route.route.directory;
  if (route.kind === 'files' || route.kind === 'resource-preview' || route.kind === 'settings-home' || route.kind === 'project-search' || route.kind === 'settings-quota') return route.directory;
  if (route.kind === 'context-usage') return route.source.target.directory;
  if (route.kind === 'session-switcher') return route.source?.directory;
}
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
  nav.push({ kind: 'task-editor', item, creationContext: taskEditorCreationContext(item) });
}
function taskEditorCreationContext(item?: Row): TaskEditorCreationContext | undefined {
  const context = item ? undefined : botCreationContext.snapshot();
  const project = context?.directory ? app.projects().filter(project => resourceWithin(context.directory!, project.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  return context?.directory && context.selection && project ? {
    projectID: project.id, directory: context.directory, selection: { ...context.selection, ...(context.agent ? { agent: context.agent } : {}) },
  } : undefined;
}
const projectChangesSource = signal<Extract<ChangesSource, { kind: 'workspace' }> | null>(null);
const projectChangesHandle = signal<NativeChangesPresentationHandle | null>(null);
let desktopOpenPanel: ((directory: string, intent?: DesktopPanelIntent) => boolean) | undefined;
let desktopOpenWorkStatusGit: ((scope: DesktopWorkStatusScope) => boolean) | undefined;
let desktopOpenFileReference: ((source: DesktopPanelScope, path: string, targetLine?: number) => boolean) | undefined;
let desktopSearch: (() => void) | undefined;
let desktopOpenSettings: ((route: SettingsRoute) => void) | undefined;
let desktopOpenSessionSwitcher: (() => void) | undefined;
const desktopBtwAction = signal<NativeLocalCommandAction | undefined>(undefined);
const desktopBtwSelections = new WeakMap<Route, () => NativeBtwSelection | null>();
const desktopBtwSpeechSources = new WeakMap<Route, () => NativeBtwSpeech | undefined>();
const desktopBtwModelLabels = new WeakMap<Route, () => { providerID: string; modelID: string; label: string } | null>();
const desktopInteractionBlocked = signal(false);
const desktopWriterClient = signal<DesktopWriterClient | undefined>(undefined);
const desktopWriterClientReady = signal(false);
let desktopWriterClientOwner: object | undefined;
type DesktopWriterGuardTag = { route: Route; owner: object; inline: boolean };
let desktopRegisterWriterGuard: ((tag: DesktopWriterGuardTag, guard: DesktopWriterDepartureGuard) => () => void) | undefined;
let desktopRequestConversationChange: ((commit: () => void, current: () => boolean) => Promise<boolean>) | undefined;
const desktopExternalModalOpen = signal(false);
let desktopSetContactDownloadModal: ((owner: object, selecting: boolean) => void) | undefined;
const desktopTimelineOwner = signal<Route | null>(null);
const desktopGitDialogOpen = signal(false);
const desktopDraftOwners = signal<readonly Parameters<DesktopGitOwnerPublisher>[0]['owner'][]>([]);
const desktopStagingContexts = new WeakSet<DesktopGitContextInput>();
async function stageDesktopGitContext(owner: Pick<ReturnType<typeof createChat>, 'stageContext'>, input: DesktopGitContextInput, current: () => boolean) {
  if (!current()) return false;
  let result = await owner.stageContext(input);
  if (!current()) return false;
  if (result.status === 'requires-confirmation') {
    if (desktopGitDialogOpen()) return false;
    desktopGitDialogOpen.set(true);
    let answer: Awaited<ReturnType<typeof AlertDialog.show>>;
    try { answer = await AlertDialog.show({ title: t('chat.gitContext.replaceDraftTitle'), description: t('chat.gitContext.replaceDraftBody'), actions: [
        { id: 'replace', label: t('chat.gitContext.replaceDraftAction'), role: 'destructive' },
        { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
      ] }); }
    finally { desktopGitDialogOpen.set(false); }
    if (!current() || answer.action !== 'replace') return false;
    result = await owner.stageContext(input, result.confirmation);
  }
  if (result.status !== 'staged') throw new Error(t('chat.gitContext.stagingFailed'));
  return current();
}
const publishDesktopDraftOwner: DesktopGitOwnerPublisher = registration => {
  const previous = desktopDraftOwners();
  if (registration.type === 'retire') {
    if (previous.includes(registration.owner)) desktopDraftOwners.set(previous.filter(owner => owner !== registration.owner));
    return;
  }
  if (!previous.includes(registration.owner)) desktopDraftOwners.set([...previous, registration.owner]);
  desktopDraftOwnerChanged?.();
  const input = registration.initialContext;
  if (!input || desktopStagingContexts.has(input)) return;
  desktopStagingContexts.add(input);
  void stageDesktopGitContext(registration.owner, input, () => registration.owner.current() && desktopDraftOwners().includes(registration.owner)).catch(report);
};
const desktopComposerOwners = signal<readonly NativeDesktopComposerShortcutOwner[]>([]);
const desktopComposerShortcuts = computed(() => desktopComposerOwners().findLast(owner => owner.current()) ?? desktopComposerOwners().at(-1) ?? null);
const publishDesktopComposerShortcuts: NativeDesktopComposerShortcutPublisher = registration => {
  const previous = desktopComposerOwners();
  if (registration.type === 'register') {
    if (!previous.includes(registration.owner)) desktopComposerOwners.set([...previous, registration.owner]);
  } else if (previous.includes(registration.owner)) desktopComposerOwners.set(previous.filter(owner => owner !== registration.owner));
};
let folderNavigationPending: { current: () => boolean } | undefined, newSessionIntent = 0;
function openNewSession(project?: Project, directory = project?.path, folder?: NativeNewSessionFolderTarget) {
  if (folderNavigationPending?.current()) { report(new Error(t('common.unavailable'))); return; }
  const intent = ++newSessionIntent, captured = folder ? captureHostOperation() : undefined;
  const authority = desktopHostIdentity();
  const commit = () => {
    if (folder && (!captured?.current() || desktopHostIdentity() !== authority || newSessionIntent !== intent)) return;
    if (platform.desktop) {
      const effectiveDirectory = directory ?? routeDirectory();
      const routes = nav.routes();
      const index = routes.findLastIndex(route => (route.kind === 'new-session' || route.kind === 'root')
        && routeDirectory(route) === effectiveDirectory);
      if (index >= 0) {
        const route = routes[index], navigate = () => { app.tab.set(0); nav.setRoutes(routes.slice(0, index + 1)); };
        if (!folder) { navigate(); return; }
        const owner = desktopRetainedDraftOwners.get(route);
        if (!owner || owner.directory !== effectiveDirectory || owner.draftAuthorityKey !== authority || !captured?.current()) { report(new Error(t('common.unavailable'))); return; }
        const ticket = { current: () => captured.current() && desktopHostIdentity() === authority };
        folderNavigationPending = ticket;
        // A retained page has no write authority until displayed. Its actual
        // owner is reactivated, never reconstructed from sidebar metadata.
        const activated = !owner.current();
        if (activated) navigate();
        const expectedTop = nav.routes().at(-1);
        void (async () => {
          try {
            if (!owner.current() || newSessionIntent !== intent || !captured.current()) throw new Error('new-session-folder-retired');
            await owner.setFolder(folder);
            if (!owner.current() || newSessionIntent !== intent || !captured.current() || nav.routes().at(-1) !== expectedTop) return;
            if (!activated) navigate();
          } catch { if (captured.current() && desktopHostIdentity() === authority) report(new Error(t('common.unavailable'))); }
          finally { if (folderNavigationPending === ticket) folderNavigationPending = undefined; }
        })();
        return;
      }
      app.tab.set(0);
      const route: Route = { kind: 'new-session', project, directory: effectiveDirectory, ...(folder ? { initialFolder: { ...folder } } : {}) };
      if (nav.routes().at(-1)?.kind === 'project-search' || nav.routes().at(-1)?.kind === 'project-directory') nav.replace(route);
      else nav.push(route);
      return;
    }
    nav.push({ kind: 'new-session', project, directory, ...(folder ? { initialFolder: { ...folder } } : {}) });
  };
  if (desktopWriterCommitDepth) { commit(); return; }
  if (desktopGuardedNavigation) {
    const before = nav.routes(), effectiveDirectory = directory ?? routeDirectory();
    const index = before.findLastIndex(route => (route.kind === 'new-session' || route.kind === 'root') && routeDirectory(route) === effectiveDirectory);
    const replace = before.at(-1)?.kind === 'project-search' || before.at(-1)?.kind === 'project-directory';
    const after = index >= 0 ? before.slice(0, index + 1) : [...(replace ? before.slice(0, -1) : before), { kind: 'new-session' as const, project, directory: effectiveDirectory }];
    void desktopGuardedNavigation(commit, before, after, true);
  } else if (desktopPageDeparture) void desktopPageDeparture.request(commit); else commit();
}
const openChat = (target: ChatTarget, options?: { messageID?: string }) => {
  if (platform.desktop) {
    const routes = nav.routes();
    const index = routes.findLastIndex(route => route.kind === 'chat' && route.target.kind === target.kind && route.target.id === target.id
      && route.target.directory === target.directory && desktopRouteAuthorities.get(route) === desktopHostIdentity()
      && (!options?.messageID || route.messageID === options.messageID));
    if (index >= 0) { if (index !== routes.length - 1) nav.setRoutes(routes.slice(0, index + 1)); return; }
  }
  const route: Route = { kind: 'chat', target, messageID: options?.messageID };
  if (platform.desktop && nav.routes().at(-1)?.kind === 'project-search') nav.replace(route);
  else nav.push(route);
};
function openNestedChat(target: ChatTarget) {
  if (!platform.desktop || target.kind !== 'session') { openChat(target); return; }
  const directory = routeDirectory();
  if (!directory || !desktopOpenPanel?.(directory, { kind: 'chat', target: { sessionID: target.id, directory: target.directory, title: target.title } })) report(new Error(t('common.unavailable')));
}
function openResourceFile(path: string, directory: string, targetLine?: number, target?: ChatTarget) {
  const root = resourcePath(directory), absolute = resourceResolve(path, root);
  if (!resourceWithin(absolute, root)) throw new Error(t('mobile.files.error.readUnavailable'));
  if (platform.desktop && target) {
    const host = app.runtimeScope();
    if (!host || !desktopOpenFileReference?.({ host, authorityKey: desktopHostIdentity(), directory: root, sessionID: target.kind === 'session' ? target.id : null }, absolute, targetLine)) throw new Error(t('common.unavailable'));
    return;
  }
  if (platform.desktop && desktopOpenPanel?.(root, /\.html?$/i.test(absolute) && targetLine === undefined ? { kind: 'preview', path: absolute } : { kind: 'file', path: absolute, targetLine })) return;
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
async function openDesktopContentLink(href: string, target: ChatTarget, current: () => boolean) {
  const host = app.runtimeScope(), directory = routeDirectory();
  if (!host || !directory || !current() || desktopInteractionBlocked() || desktopGitDialogOpen() || lifecycle() !== 'active') return;
  const generation = epoch(), authorityKey = desktopHostIdentity();
  const scope: DesktopPanelScope = { host: { ...host }, authorityKey, directory: target.directory, sessionID: target.kind === 'session' ? target.id : null };
  const admitted = () => current() && epoch() === generation && desktopHostIdentity() === authorityKey && sameRuntimeScope(app.runtimeScope(), host)
    && !desktopInteractionBlocked() && !desktopGitDialogOpen() && lifecycle() === 'active';
  const open = createDesktopContentLink({ scope, current: () => admitted() ? scope : null,
    openFile: (own, path, line) => admitted() && desktopOpenFileReference?.(own, path, line) === true,
    openPanel: (_own, url) => admitted() && desktopOpenPanel?.(directory, { kind: 'browser', url }) === true,
    openExternal: openUrl,
  });
  await open(href);
}
const settingsCallbacks: SettingsCallbacks = {
  onOpen: route => {
    if (platform.desktop && desktopOpenSettings) { desktopOpenSettings({ ...route, directory: route.directory ?? routeDirectory() }); return; }
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
  onOpenChanges: directory => {
    if (platform.desktop && desktopOpenPanel?.(directory, { kind: 'diff', source: { kind: 'workspace', directory } })) return;
    projectChangesSource.set({ kind: 'workspace', directory });
  },
  onEditProject: project => settingsCallbacks.onOpen({ page: 'projects', entity: project.id, directory: project.path }),
  onAddProject: () => nav.push({ kind: 'project-directory' }),
  onOpenSearch: () => { if (platform.desktop && desktopSearch) desktopSearch(); else nav.push({ kind: 'project-search' }); },
  onNewWorktree: project => nav.push({ kind: 'project', project, createWorktree: true }),
  onOpenArchivedSessions: () => settingsCallbacks.onOpen({ page: 'archived-sessions' }),
  onRemoteDesktop: () => nav.push({ kind: 'remote-desktop' }),
  onNewSession: project => openNewSession(project),
  onWorktreeCreated: (project, directory) => openNewSession(project, directory),
  onScanQr: () => {
    const generation = epoch();
    void run(async () => { const link = await native<string>('camera.scan'); if (generation === epoch() && link) nav.push({ kind: 'connect', link }); });
  },
  onSwitchInstance: id => { if (id) void run(() => switchConnection(id)); else settingsCallbacks.onOpen({ page: 'instances' }); },
};
function pageScope() {
  return createPageOperations().displayCurrent;
}
function projectSearchCommands(directory?: string, dismiss?: () => void): ProjectSearchCommand[] {
  const project = directory ? app.projects().filter(project => resourceWithin(directory, project.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  const previous = nav.routes().at(dismiss ? -1 : -2);
  const source = previous?.kind === 'chat' ? previous.target : undefined;
  const sourceRoute = retainedChatRoute();
  const sourceChat = sourceRoute ? mountedChats.get(sourceRoute) : undefined;
  const closeSearch = dismiss ?? (() => nav.pop());
  const closeAndOpen = (route: Route) => { batch(() => { closeSearch(); if (platform.desktop && route.kind === 'new-session') openNewSession(route.project, route.directory); else nav.push(route); }); };
  return [
    ...SETTINGS_ENTRIES.map(entry => ({ id: `settings:${entry.page}`, title: t(entry.title), group: 'settings' as const, onSelect: () => {
      if (platform.desktop) { closeSearch(); settingsCallbacks.onOpen({ page: entry.page, directory }); }
      else closeAndOpen({ kind: 'settings', route: { page: entry.page, directory } });
    } })),
    { id: 'new-session', title: t('commandPalette.item.newSession'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'new-session', project, directory }) },
    { id: 'setup-tour', title: t('tour.open'), group: 'commands', onSelect: () => { closeSearch(); void run(() => openSetupTour(directory)); } },
    { id: 'toggle-sidebar', title: t('commandPalette.item.showSessionSwitcher'), group: 'commands', onSelect: () => {
      if (platform.desktop && desktopOpenSessionSwitcher) { closeSearch(); desktopOpenSessionSwitcher(); }
      else closeAndOpen({ kind: 'session-switcher', source });
    } },
    ...(sourceRoute?.target.kind === 'session' && sourceChat ? [{ id: 'show-context-usage', title: t('commandPalette.item.showContextUsage'), group: 'commands' as const, onSelect: () => {
      if (mountedChats.get(sourceRoute) !== sourceChat || epoch() !== sourceChat.messageScope.generation || app.connection()?.id !== sourceChat.messageScope.hostID) return;
      closeAndOpen({ kind: 'context-usage', source: sourceRoute, chat: sourceChat, current: () => mountedChats.get(sourceRoute) === sourceChat && epoch() === sourceChat.messageScope.generation && app.connection()?.id === sourceChat.messageScope.hostID });
    } }] : []),
    ...(project ? [{ id: 'new-worktree', title: t('commandPalette.item.newWorktreeDraft'), group: 'commands' as const, onSelect: () => closeAndOpen({ kind: 'project', project, createWorktree: true }) }] : []),
    { id: 'project:add', title: t('commandPalette.item.addProject'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'project-directory' }) },
    { id: 'connect', title: t('mobile.connect.connectButton'), group: 'commands', onSelect: () => closeAndOpen({ kind: 'connect' }) },
    { id: 'open-settings', title: t('commandPalette.item.openSettings'), group: 'commands', onSelect: () => {
      if (platform.desktop) { closeSearch(); settingsCallbacks.onOpen({ page: 'appearance', directory }); }
      else closeAndOpen({ kind: 'settings-home', directory });
    } },
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
      if (props.edit && snapshot.runtimeInvalidated !== true) nav.pop(2);
      else if (app.connection()?.id === snapshot.selected) {
        if (platform.desktop && desktopSystemNavigationReset) desktopSystemNavigationReset();
        else nav.popToRoot();
      }
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
          testID="connection-submit"
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
        <Button testID="connection-manual" class={quiet} onPress={() => advanced.set(!advanced())}>
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
                    desktopNavigationIntent?.();
                    const selectedID = connection().id;
                    void run(async () => {
                      await switchConnection(selectedID);
                      if (app.connection()?.id !== selectedID) return;
                      if (platform.desktop && desktopSystemNavigationReset) desktopSystemNavigationReset();
                      else nav.popToRoot();
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
                  if (current()) openNewSession(project());
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
            if (current()) openNewSession(props.project);
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

function ChatPageLayout(props: { inline: boolean; embedded?: boolean; target: ChatTarget; headerRight: JSX.Element; header: JSX.Element; children?: JSX.Element }) {
  if (props.inline || props.embedded) return <View testID={props.inline ? 'desktop-assistant-chat' : undefined} class="flex-1 min-h-0 min-w-0 bg-background">{props.children}</View>;
  return <NavPage title={props.target.title} hidesBottomBarWhenPushed headerTransparent headerBackTitle="" headerVisible={!platform.desktop}
    headerClass="text-foreground tint-foreground" headerRight={props.headerRight} header={props.header} class="flex-1 bg-background">{props.children}</NavPage>;
}

type ChatProps = { route: Extract<Route, { kind: 'chat' }>; target: ChatTarget; messageID?: string; handoff?: NativeNewSessionPageHandoff; inline?: DesktopAssistantConversationContext };
function Chat(props: ChatProps) {
  if (!platform.desktop) return <ChatOwner {...props} />;
  const authority = desktopHostIdentity();
  let alive = true, chat: ReturnType<typeof createChat> | undefined;
  cleanup(() => { alive = false; });
  if (props.handoff) {
    const handoff = props.handoff, source = handoff.owner;
    let unregister = desktopRegisterWriterGuard?.({ route: props.route, owner: source, inline: false }, {
      current: source.ownedScope, prepare: source.prepareWriterRetirement, canClose: source.canReleaseWriter,
      cancel: source.cancelWriterRetirement, release: source.releaseWriter,
    });
    effect(() => { if (handoff.released()) untracked(() => { unregister?.(); unregister = undefined; }); });
    cleanup(() => { unregister?.(); unregister = undefined; });
  }
  return <ChatPageLayout inline={!!props.inline} target={props.target} header={undefined} headerRight={undefined}><NativeDesktopChatWriter client={desktopWriterClient} capabilitiesReady={desktopWriterClientReady}
    target={{ kind: props.target.kind, id: props.target.id }} handoff={props.handoff?.desktopWriter}
    committedRuntimeScope={app.runtimeScope} stableAuthorityIdentity={desktopHostIdentity}
    current={() => alive && desktopHostIdentity() === authority}
    onOwner={writer => {
      const empty = () => !writer.status().constructed && ['unsupported', 'denied'].includes(writer.status().phase);
      return desktopRegisterWriterGuard?.({ route: props.route, owner: writer, inline: !!props.inline }, {
        current: () => alive && desktopHostIdentity() === authority,
        prepare: () => empty() ? Promise.resolve(true) : writer.prepareRetirement(),
        canClose: () => empty() || writer.canClose(), cancel: () => { writer.cancel(); }, release: () => empty() ? Promise.resolve(true) : writer.release(),
      });
    }}
    scopeReady={() => { chat?.rebuildOperationLane(); }}
    waiting={status =>
      <View testID="desktop-chat-writer-waiting" class="flex-1 p-5 justify-center"><Text role={status.phase === 'unknown' || status.phase === 'denied' ? 'alert' : undefined} class="text-sm text-muted-foreground">{t(status.phase === 'unknown' ? 'chat.questionDelegate.uncertain' : ['capabilities-loading', 'acquiring', 'renewing', 'waiting-scope'].includes(status.phase) ? 'common.loading' : 'common.unavailable')}</Text></View>
    }>
    {(writerGrant, writerUnknown, writer) => <ChatOwner {...props} frameOwned writerGrant={writerGrant} writerUnknown={writerUnknown} writer={writer} onChat={value => { chat = value; }} />}
  </NativeDesktopChatWriter></ChatPageLayout>;
}
function ChatOwner(props: ChatProps & { frameOwned?: boolean; writerGrant?: () => VerifiedDesktopWriterGrant | null; writerUnknown?: (cause?: unknown) => void; writer?: NativeDesktopChatWriterOwner; onChat?: (chat: ReturnType<typeof createChat>) => void }) {
  const desktopContact = platform.desktop && props.target.kind === 'assistant';
  const operations = createPageOperations(() => props.inline ? props.inline.active() : nav.routes().at(-1) === props.route, props.writerGrant);
  const current = operations.displayCurrent;
  const recoveryReads = platform.desktop ? createPageOperations(() => current() && !desktopInteractionBlocked() && !desktopGitDialogOpen()
    && (props.inline ? props.inline.active() && props.inline.interactive() : nav.routes().at(-1) === props.route)) : undefined;
  const footerExperiment = signal(false);
  const footer = createNativeHistoryFooterController({
    current: () => current() && nav.routes().at(-1) === props.route && lifecycle() === 'active',
    changed: value => footerState.set(value),
  });
  const footerState = signal(footer.snapshot());
  cleanup(footer.dispose);
  const chat = createChat(props.target, { ...(platform.desktop && app.connection() ? { draftAuthorityKey: props.handoff?.receipt.draftAuthorityKey ?? desktopGitDraftAuthority(app.connection()!) } : {}), contactOptimistic: desktopContact, writerGrant: props.writerGrant, writerUnknown: props.writerUnknown, recoveryReadOperation: recoveryReads?.operation, deviceChatPreferences, messageStreamTransport: () => nativeAppearance.current()?.messageStreamTransport ?? null, followUpBehavior: () => nativeAppearance.current()?.followUpBehavior ?? null, beforeHistoryPresentationFlush: footer.beforeHistoryPresentationFlush });
  props.onChat?.(chat);
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
  untracked(() => mountedChatRevision.update(value => value + 1));
  cleanup(() => { if (mountedChats.get(props.route) === chat) { mountedChats.delete(props.route); untracked(() => mountedChatRevision.update(value => value + 1)); } });
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
  const messageSpeech = createNativeSpeech({ current: () => !desktopContact && current() && chat.active(), operation: operations.operation });
  const timelineOpen = signal(false);
  function showTimeline(open: boolean) {
    timelineOpen.set(open);
    if (open) desktopTimelineOwner.set(props.route);
    else if (desktopTimelineOwner() === props.route) desktopTimelineOwner.set(null);
  }
  const historyReadCurrent = () => current() && lifecycle() === 'active' && (chat.active() || timelineOpen() && desktopTimelineOwner() === props.route && !desktopExternalModalOpen() && !desktopGitDialogOpen());
  const timelineScope = () => JSON.stringify([desktopHostIdentity(), epoch(), props.target.kind, props.target.directory, props.target.id, operations.operation()?.generation]);
  effect(() => {
    if (!timelineOpen()) return;
    if (!current() || lifecycle() !== 'active' || nav.routes().at(-1) !== props.route || desktopExternalModalOpen() || desktopGitDialogOpen()) untracked(() => showTimeline(false));
  });
  cleanup(() => { if (desktopTimelineOwner() === props.route) desktopTimelineOwner.set(null); });
  const history = createNativeTranscriptHistory({ chat, target: props.target, current, canRead: historyReadCurrent, operation: operations.operation, writerUnknown: props.writerUnknown,
    key: `${epoch()}:${props.target.kind}:${props.target.directory}:${props.target.id}`,
    storageKey: encodeURIComponent(JSON.stringify([app.connection()?.id, props.target.directory, props.target.kind, props.target.id, ...(platform.desktop ? [desktopHostIdentity()] : [])])),
    onOpenChat: target => { if (historyReadCurrent()) { showTimeline(false); openChat(target); } },
  });
  const projectHistoryRows = createNativeHistoryRows();
  const contactBot = () => props.inline?.bot() ?? app.bots().find(bot => bot.id === props.target.id) ?? { id: props.target.id, name: props.target.title };
  const contactRows = computed(() => desktopContact ? desktopContactMessageRows(chat.visibleMessages(), { locale: currentLocale(), todayLabel: t('common.date.today'), now: new Date() }) : []);
  const contactRowsByID = computed(() => new Map(contactRows().map(row => [row.message.id, row])));
  const firstContactMessageID = computed(() => contactRows().find(row => row.visible)?.message.id);
  const contactPendingFailure = computed(() => desktopContact && chat.contactOptimistic().some(turn => turn.messageID === chat.pendingSend()?.id && turn.status === 'failed'));
  const contactCardCatalog = computed(() => {
    if (!desktopContact) return null;
    const snapshot = desktopContactCardSource()?.snapshot(), rootCatalog = desktopContactCatalog();
    const sessions = new Map(rootCatalog.sessions.map(session => [session.id, session]));
    for (const session of snapshot?.sessions ?? []) {
      const prior = sessions.get(session.id);
      if (!prior || session.updated >= prior.updated) sessions.set(session.id, session);
    }
    return { sessions, branches: snapshot?.branches, assistants: new Map(rootCatalog.assistants.map(bot => [text(bot.id), bot])),
      tasks: new Map(rootCatalog.tasks.map(item => [JSON.stringify([text(item.projectId), text(record(item.task).id)]), record(item.task)])) };
  });
  function contactCardMetadata(card: Row): Omit<NativeDesktopAssistantCardProps, 'card' | 'current' | 'onOpen'> {
    const catalog = contactCardCatalog(), session = catalog?.sessions.get(text(card.sessionID));
    const directory = text(session?.directory).trim() || text(card.directory);
    return { session, assistant: catalog?.assistants.get(text(card.assistantID)), task: catalog?.tasks.get(JSON.stringify([text(card.projectID), text(card.taskID)])),
      branch: catalog?.branches?.get(normalizeDirectoryKey(directory)), liveStatus: desktopContactSessionStatus(app.runtimeScope(), text(card.sessionID), directory),
      avatarClockScope: JSON.stringify([epoch(), app.connection()?.id]) };
  }
  const bodyRows = computed((): NativeBodyRow[] => desktopContact
    ? contactRows().filter(row => row.visible).map(row => ({ key: row.message.id, head: row.message, tail: row.message, messages: [row.message], isLastTurn: false })).reverse()
    : projectHistoryRows(chat.visibleMessages()));
  const navigationTurns = computed(() => nativeRowTurns(bodyRows().slice().reverse()));
  let readingTurnID: string | null = null;
  // NSH matches List items by ===; keyExtractor only labels viewability tokens.
  const bodyRowKeys = computed(() => bodyRows().map(row => row.key));
  const bodyRowsByKey = computed(() => new Map(bodyRows().map(row => [row.key, row])));
  const transcriptRef = signal<ListRef | null>(null);
  const contactReadRef = signal<ViewRef | null>(null);
  const contactReadCurrent = () => current() && chat.active() && lifecycle() === 'active' && !chat.loading() && !chat.hasGap() && !chat.historyRepairPending();
  const contactReader = desktopContact ? createDesktopAssistantReadMarker({ assistantID: props.target.id,
    current: contactReadCurrent,
    position: chat.contactReadPosition, operation: operations.operation,
    measure: async () => {
      const marker = contactReadRef(), list = transcriptRef();
      if (!marker || !list) return null;
      const [point, viewport] = await Promise.all([marker.measure(), list.measure()]);
      if (!point || !viewport || contactReadRef() !== marker || transcriptRef() !== list) return null;
      return { marker: { ...point.pagePosition, ...point.bounds.size }, viewport: { ...viewport.pagePosition, ...viewport.bounds.size } };
    },
  }) : undefined;
  const contactReadSnapshot = contactReader ? createDesktopAssistantReadSnapshot({
    current: contactReadCurrent, list: transcriptRef, marker: contactReadRef,
    operation: operations.operation, position: chat.contactReadPosition,
    invalidateFrame: contactReader.invalidateFrame, accept: contactReader.scroll,
  }) : undefined;
  effect(() => {
    if (!contactReadSnapshot) return;
    contactReadCurrent(); operations.operation(); chat.contactReadPosition(); transcriptRef(); contactReadRef();
    untracked(() => { void contactReadSnapshot.request(); });
  });
  cleanup(() => { contactReadSnapshot?.dispose(); contactReader?.dispose(); });
  const transcriptWidth = signal(0);
  const focusState = signal<Readonly<NativeHistoryFocusState> | null>(null);
  const focusScope = () => JSON.stringify([app.connection()?.id, epoch(), props.target.kind, props.target.directory, props.target.id, chat.historyGeneration()]);
  const messageFocus = createNativeHistoryFocus({
    current: () => historyReadCurrent() && chat.messagesResolved(),
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
  async function scrollByTurnOffset(offset: -1) {
    if (!historyReadCurrent()) return;
    const turns = navigationTurns(), target = resolveTurnOffsetTarget(turns.map(turn => turn.turnId), readingTurnID, offset);
    if (target.kind !== 'turn') return;
    const turn = turns.find(turn => turn.turnId === target.turnId), messageID = turn?.userMessageId ?? turn?.headerMessageId ?? turn?.messages[0]?.messageId;
    if (!messageID) return;
    messageFocus.cancel();
    if ((await messageFocus.focus(messageID)).status === 'revealed' && historyReadCurrent()) readingTurnID = target.turnId;
  }
  function resumeToLatest() {
    if (!historyReadCurrent()) return;
    messageFocus.cancel(); readingTurnID = navigationTurns().at(-1)?.turnId ?? null;
    transcriptRef()?.scrollToIndex({ index: 0, animated: false, viewPosition: 1 });
  }
  let focusedScope: string | undefined;
  effect(() => {
    const scope = focusScope(), active = historyReadCurrent();
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
  const headerModelLabel = signal<{ providerID: string; modelID: string; label: string } | null>(null);
  const changesGenerationContext = () => {
    const selection = headerSelection(), model = record(selection.model);
    return {
      ...(props.target.kind === 'session' ? { sessionID: props.target.id } : {}),
      preferredProviderID: text(model.providerID) || text(selection.providerID) || undefined,
      preferredModelID: text(model.id) || text(model.modelID) || text(selection.modelID) || undefined,
    };
  };
  if (platform.desktop && props.target.kind === 'session') {
    const speech = createDesktopBtwSpeech({ speech: messageSpeech, identity: JSON.stringify([chat.referenceScope, epoch()]), current: () => current() && chat.active(),
      resume: async () => {
        const result = await AlertDialog.show({ title: t('chat.messageBody.tts.readAloud'), actions: [
          { id: 'resume', label: t('chat.messageBody.tts.resume') }, { id: 'restart', label: t('chat.messageBody.tts.restart') },
          { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        ] });
        return result.action === 'resume' || result.action === 'restart' ? result.action : 'cancel';
      } });
    const read = () => {
      const authority = headerSelection(), model = record(authority.model);
      const providerID = text(model.providerID), modelID = text(model.id);
      if (!current() || !providerID || !modelID) return null;
      return { providerID, modelID, ...(text(model.variant) ? { variant: text(model.variant) } : {}), ...(text(authority.agent) ? { agent: text(authority.agent) } : {}) };
    };
    desktopBtwSelections.set(props.route, read);
    desktopBtwSpeechSources.set(props.route, speech);
    desktopBtwModelLabels.set(props.route, headerModelLabel);
    untracked(() => mountedChatRevision.update(value => value + 1));
    cleanup(() => { if (desktopBtwSelections.get(props.route) === read) { desktopBtwSelections.delete(props.route); desktopBtwSpeechSources.delete(props.route); desktopBtwModelLabels.delete(props.route); untracked(() => mountedChatRevision.update(value => value + 1)); } });
  }
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
  const turnModelName = createNativeTurnModelNames(() => !desktopContact && current() && chat.active(), props.target.directory);
  const recording = signal(false),
    attaching = signal(false);
  const desktopComposing = signal(false), desktopSelectionShortcuts = signal<NativeDesktopComposerShortcutOwner | null>(null);
  const publishSelectionShortcuts: NativeDesktopComposerShortcutPublisher = registration => {
    if (registration.type === 'register') desktopSelectionShortcuts.set(registration.owner);
    else if (desktopSelectionShortcuts() === registration.owner) desktopSelectionShortcuts.set(null);
  };
  const chromeState = signal(createChatChromeState()), editorFocused = signal(false), composerHeight = signal(160), composerWidth = signal(0);
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
  const desktopAttachments = platform.desktop ? createDesktopChatAttachments({
    key: JSON.stringify([desktopHostIdentity(), props.target.kind, props.target.id, props.target.directory]),
    target: props.target.kind === 'assistant' ? { kind: 'assistant', assistantID: props.target.id } : { kind: 'session' },
    captureOperation: operations.capture, operation: operations.operation,
    current: () => current() && chat.active() && lifecycle() === 'active' && chat.draftStatus() === 'ready' && !chat.sending() && admissionState() === 'complete' && inputMode() === 'normal',
    read: chat.attachments,
    write: files => { if (!current() || !chat.active()) return false; chat.attachments.set(files); return true; },
    onError: message => chat.error.set(message),
  }) : undefined;
  const attachmentBusy = () => attaching() || desktopAttachments?.blocked() === true;
  const AttachmentRecovery = desktopAttachments?.Recovery;
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
  let uncertainLocal: { invocation: NativeLocalCommandInvocation; inputID: string } | undefined;
  function localSnapshot(): NativeLocalCommandSnapshot {
    const authority = headerSelection(), model = record(authority.model);
    const providerID = text(model.providerID) || text(authority.providerID), modelID = text(model.id) || text(model.modelID) || text(authority.modelID);
    return {
      scope: chat.referenceScope, authority: JSON.stringify([epoch(), desktopHostIdentity(), operations.operation()?.generation]),
      target: { kind: props.target.kind, id: props.target.id, directory: props.target.directory },
      revision: chat.composerRevision(), text: chat.draft(), inputMode: inputMode(),
      active: current() && chat.active() && lifecycle() === 'active' && !desktopComposing() && !recording() && !attachmentBusy(),
      ready: chat.draftStatus() === 'ready' && admissionState() === 'complete' && !chat.historyBusy() && !chat.historyRepairPending(),
      pending: !!chat.pendingSend(), unknown: chat.pendingSend()?.uncertain === true, sending: chat.sending(), queueEditing: !!chat.queueEdit(),
      hasReferences: chat.references().length > 0, hasMessages: chat.messages().length > 0,
      selection: providerID && modelID ? { model: { providerID, modelID, ...(text(model.variant) || text(authority.variant) ? { variant: text(model.variant) || text(authority.variant) } : {}) }, ...(text(authority.agent) ? { agent: text(authority.agent) } : {}) } : null,
    };
  }
  const replaceLocalText = (expected: NativeLocalCommandSnapshot, value: string) => {
    const next = localSnapshot();
    return next.active && next.authority === expected.authority && sameReferenceScope(next.scope, expected.scope)
      && next.target.kind === expected.target.kind && next.target.id === expected.target.id && next.target.directory === expected.target.directory
      && next.text === expected.text && chat.compareAndSetDraftText(expected.revision, value);
  };
  const localCommands = platform.desktop && props.target.kind === 'session' ? createNativeLocalCommands({
    t, read: localSnapshot, replaceText: replaceLocalText,
    actions: {
      get btw() { return desktopBtwAction(); },
      new: { run: invocation => {
        if (!invocation.current()) return { status: 'rejected' };
        openNewSession(app.projects().find(project => resourceWithin(props.target.directory, project.path)), props.target.directory);
        return { status: 'accepted' };
      } },
      model: { run: invocation => {
        if (!invocation.current()) return { status: 'rejected' };
        Keyboard.dismiss(); modelPicker.set('model'); return { status: 'accepted' };
      } },
      timeline: { run: invocation => {
        if (!invocation.current()) return { status: 'rejected' };
        Keyboard.dismiss(); showTimeline(true); return { status: 'accepted' };
      } },
      undo: { run: invocation => history.undo(invocation) },
      redo: { run: invocation => history.redoStep(invocation) },
      fork: { run: invocation => history.fork(null, invocation) },
      compact: { run: invocation => chat.admitLocalCompact(invocation) },
      ...Object.fromEntries(magicCommands.map(command => [command.name, createNativeLocalMagicAction({
        request: path => operations.capture().request(path), admit: chat.admitLocalMagic,
        onPreparationError: () => chat.error.set(t('common.unavailable')),
      })])),
    },
    onBlocked: () => chat.error.set(t('common.unavailable')),
    onConflict: conflict => { void confirmNativeLocalCommandConflict(conflict, {
      current: () => { const next = localSnapshot(); return next.active && next.authority === conflict.snapshot.authority && sameReferenceScope(next.scope, conflict.snapshot.scope); },
      replace: replaceLocalText, submit: () => { localCommands?.submit(); }, focus: () => editor?.focus(),
    }).then(result => { if (result.status === 'rejected' && current() && chat.active()) chat.error.set(t('common.unavailable')); }); },
    onOutcome: (invocation, outcome) => {
      if (outcome.status === 'unknown') {
        const inputID = chat.pendingSend()?.id;
        if (inputID) uncertainLocal = { invocation, inputID };
        chat.error.set(t('common.unavailable'));
      } else if (outcome.status === 'rejected') chat.error.set(t('common.unavailable'));
    },
  }) : undefined;
  cleanup(() => localCommands?.dispose());
  const changesSource = signal<ChangesSource | null>(null);
  let unregisterChanges: (() => void) | undefined;
  const changesHandle = (handle: NativeChangesPresentationHandle | null) => {
    unregisterChanges?.(); unregisterChanges = undefined;
    if (platform.desktop && handle) unregisterChanges = desktopRegisterWriterGuard?.({ route: props.route, owner: handle, inline: !!props.inline }, {
      current, prepare: async () => handle.canLeave(), canClose: handle.canLeave, cancel: () => {}, release: async () => true,
    });
  };
  cleanup(() => { unregisterChanges?.(); unregisterChanges = undefined; });
  const btw = signal<(ReturnType<typeof createNativeBtwOwner> & { operation: NonNullable<ReturnType<typeof operations.operation>> }) | null>(null);
  const btwOperation = computed(() => {
    if (platform.desktop) return null;
    const operation = operations.operation(), runtime = app.runtimeScope();
    const active = props.target.kind === 'session' && chat.active() && lifecycle() === 'active' && nav.routes().at(-1) === props.route;
    return active && operation?.current() && runtime && sameRuntimeScope(operation.scope, runtime) ? operation : null;
  });
  effect(() => {
    const operation = btwOperation();
    if (!operation?.scope) { untracked(() => { if (!platform.desktop) showTimeline(false); }); return; }
    untracked(() => showTimeline(false));
    const capturedRuntime = Object.freeze({ ...operation.scope });
    const binding = createNativeBtwOwner({ runtime: capturedRuntime, sessionID: props.target.id, directory: props.target.directory },
      () => operation === operations.operation() && operation.current() && sameRuntimeScope(capturedRuntime, app.runtimeScope()) && chat.active() && lifecycle() === 'active' && nav.routes().at(-1) === props.route);
    untracked(() => btw.set({ ...binding, operation }));
    cleanup(binding.owner.retire);
  });
  const commandContext = () => ({ hasSession: props.target.kind === 'session', hasMessages: chat.messages().length > 0, hasNewDraft: false });
  const commandRouter = !platform.desktop ? createChatComposerCommands({
    read: () => {
      const operation = operations.operation();
      if (props.target.kind !== 'session' || !operation?.current() || !chat.active() || lifecycle() !== 'active' || nav.routes().at(-1) !== props.route || chat.draftStatus() !== 'ready' || admissionState() !== 'complete') return null;
      return { owner: operation, revision: chat.draftRevision(), document: chat.referenceDocument(), inputMode: inputMode(), context: commandContext() };
    },
    write: (document, expected) => operations.operation() === expected.owner && chat.draftRevision() === expected.revision && chat.setReferenceDocument(document, expected.document),
    btw: () => { const binding = btw(); return binding?.operation === operations.operation() && binding.operation.current() ? binding.owner : null; },
    openNewDraft: openNewSessionDraft,
    openModel: () => { Keyboard.dismiss(); openSelection(); },
    openTimeline: () => showTimeline(true),
    actions: {
      undo: intent => runLocalCommand(intent, history.sessionActions.undo),
      redo: intent => runLocalCommand(intent, history.sessionActions.redo),
      fork: intent => runLocalCommand(intent, history.sessionActions.fork),
      compact: intent => runLocalCommand(intent, chat.compact, true),
    },
    notify: key => chat.error.set(t(key)),
  }) : undefined;
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
  const mcpPanel = signal(false);
  effect(() => { if (!chat.active() || lifecycle() !== 'active') mcpPanel.set(false); });
  effect(() => { if (!chat.active() || lifecycle() !== 'active') changesSource.set(null); });
  const composerAnchor = signal<ViewRef | null>(null);
  const referenceKeyboard = createNativeReferenceKeyboard({
    active: () => props.target.kind === 'session' && current() && chat.active() && lifecycle() === 'active' && inputMode() === 'normal' && !recording(),
    scope: () => chat.referenceScope, text: chat.draft,
    insert: (candidate, start, end) => chat.insertReference(candidate, start, end),
    onSubmit: () => { if (!sendDisabled()) sendDraft(); },
    chooseCommand: (command, submit, context) => {
      if (!current() || !chat.active()) return false;
      if (localCommands) return localCommands.choose(command, submit, context);
      if (commandRouter) return commandRouter.choose(command, submit, context);
      if (shouldSubmitCommandOnSelection(command, submit)) {
        chat.setDraftText(context.text.slice(context.end)); Keyboard.dismiss(); openSelection();
      } else {
        chat.setDraftText(`/${command.name} ${context.text.slice(context.end)}`);
      }
    },
    ...(commandRouter ? { commandOwner: operations.operation, commandActions: () => ['new', 'undo', 'redo', 'fork', 'compact', 'model', 'btw'] as const } : {}),
  });
  const referenceTrigger = referenceKeyboard.trigger;
  const dismissReferences = referenceKeyboard.dismiss;
  effect(() => {
    const pinned = editorFocused() || keyboardFrame().height > 0 || recording() || attachmentBusy() || !!modelPicker() || goalPanel() || !!changesSource() || mcpPanel() || timelineOpen() || btw()?.state().open === true;
    untracked(() => chrome.pin(pinned));
  });
  function editCompactDraft() { if (current() && chat.active()) { chrome.expand(); editor?.focus(); } }
  function resumeLatest() { if (current() && chat.active()) { chrome.expand(); transcriptRef()?.scrollToIndex({ index: 0, animated: true, viewPosition: 1 }); } }
  const btwDraft = () => props.target.kind === 'session' && isNativeBtwCommand(chat.draft(), inputMode());
  function sendDisabled() {
    if (btwDraft()) return !operations.current() || !chat.active() || lifecycle() !== 'active' || admissionState() !== 'complete' || chat.draftStatus() !== 'ready' || recording() || attachmentBusy();
    return !current() || !chat.canSend() || chat.sending() || admissionState() !== 'complete' || chat.historyBusy() || chat.historyRepairPending() || chat.draftStatus() !== 'ready' || !!chat.queueEdit() || recording() || attachmentBusy() || (!chat.draft().trim() && !chat.attachments().length);
  }
  function sendDraft() {
    const lane = operations.operation(); if (!lane?.current() || sendDisabled()) return;
    if (localCommands && localCommands.submit().kind !== 'pass') return;
    if (commandRouter && commandRouter.submit() !== 'pass') return;
    if (!commandRouter && props.target.kind === 'session' && inputMode() === 'normal' && /^\/model(?:\s|$)/i.test(chat.draft().trim())) {
      chat.setDraftText(chat.draft().trimStart().replace(/^\/model\s*/i, ''));
      Keyboard.dismiss(); openSelection(); return;
    }
    void chat.send({
      inputMode: inputMode(),
      ...(props.target.kind === 'session' && inputMode() === 'normal' && (magicCommand(chat.draft()) || chat.references().length) ? { prepare: input => compileNativePrompt(input, lane.request) } : {}),
    });
  }
  function submitFromEditor() {
    if (!current() || !chat.active() || desktopComposing() || !editorFocused() || lifecycle() !== 'active') return;
    if (props.target.kind === 'session' && inputMode() === 'normal') referenceKeyboard.onSubmit();
    else if (!sendDisabled()) sendDraft();
  }
  if (platform.desktop) {
    desktopChatSubmitters.set(props.route, async () => {
      const lane = operations.operation();
      if (!lane?.current() || !current() || !chat.active() || inputMode() !== 'normal' || desktopComposing() || sendDisabled()) return false;
      if (localCommands && localCommands.submit().kind !== 'pass') return false;
      return await chat.send({ inputMode: 'normal', ...(magicCommand(chat.draft()) || chat.references().length ? { prepare: input => compileNativePrompt(input, lane.request) } : {}) }) === true;
    });
    cleanup(() => desktopChatSubmitters.delete(props.route));
  }
  function chooseAttachment() {
    if (!current() || !chat.active() || lifecycle() !== 'active' || recording()) return;
    void run(async () => {
      const lane = operations.capture();
      if (attachmentBusy()) return;
      const choice = await AlertDialog.show({ title: t('chat.chatInput.actions.addAttachment'), presentation: platform.desktop ? 'alert' : 'actionSheet', actions: [
        { id: 'images', label: t('chat.chatInput.actions.attachPhotos') },
        { id: 'files', label: t('chat.chatInput.actions.attachFiles') },
        { id: 'cancel', label: t('chat.chatInput.actions.attachCancel'), role: 'cancel' },
      ] });
      if (lane.current() && current() && chat.active() && lifecycle() === 'active' && (choice.action === 'images' || choice.action === 'files')) await attach(choice.action, lane);
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
    const blocked = platform.desktop && desktopInteractionBlocked();
    batch(() => {
      const displayed = props.inline ? props.inline.active() && props.inline.interactive() : top === props.route;
      const retained = props.inline ? props.inline.active() : retainedChatRoute() === props.route;
      chat.syncActive.set((!displayed || blocked) && retained && current());
      chat.active.set(displayed && !blocked && current() && (!props.writerGrant || !!props.writerGrant()));
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
    if (desktopAttachments) { await desktopAttachments.attach(kind, lane); return; }
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
      openNewSession(app.projects().find(project => resourceWithin(props.target.directory, project.path)), props.target.directory);
    }
    if (action === 'selection') openSelection();
    if (action === 'files') {
      if (!platform.desktop || !desktopOpenPanel?.(props.target.directory)) nav.push({ kind: 'files', directory: props.target.directory, path: props.target.directory, ...(props.target.kind === 'session' ? { sessionId: props.target.id } : {}) });
    }
    if (action === 'changes') {
      modelPicker.set(null);
      const source: ChangesSource = { kind: 'workspace', directory: props.target.directory };
      if (!platform.desktop || !desktopOpenPanel?.(props.target.directory, { kind: 'diff', source })) changesSource.set(source);
    }
    if (action === 'remote-desktop') nav.push({ kind: 'remote-desktop' });
    if (action === 'mcp') { statusPopovers.close(); modelPicker.set(null); changesSource.set(null); mcpPanel.set(true); }
    if (action === 'refresh') await chat.load();
    if (action === 'auto-read') await autoRead.toggle();
  }
  let workStatus: ReturnType<typeof createNativeDesktopChatWorkStatus> | undefined;
  if (platform.desktop) {
    const editable = () => current() && chat.active() && lifecycle() === 'active' && !!operations.operation()?.current();
    const shortcuts = createNativeDesktopComposerShortcutOwner({ current: editable, composing: desktopComposing,
      overlayOpen: () => !!modelPicker() || goalPanel() || !!changesSource(), actions: {
        focus_input: { run: editCompactDraft },
        submit_message: { get enabled() { return !chat.sending() && admissionState() === 'complete' && !recording() && !attachmentBusy() && chat.draftStatus() === 'ready'; }, run: submitFromEditor },
        clear_input: { get enabled() { return !chat.sending() && !recording() && chat.draftStatus() === 'ready'; }, run: () => { chat.setDraftText(''); referenceKeyboard.dismiss(); editor?.focus(); } },
        abort_run: { get enabled() { return chat.busy() && !chat.sending(); }, run: () => chat.stop() },
        toggle_dictation: { get enabled() { return !chat.sending() && !attachmentBusy(); }, run: () => dictate() },
        ...Object.fromEntries(['open_model_selector', 'open_agent_selector', 'cycle_agent', 'cycle_thinking_variant'].map(id => [id, {
          get enabled() { return desktopSelectionShortcuts()?.actions[id]?.enabled === true; },
          run: (intent: Parameters<NonNullable<NativeShortcutActions[string]>['run']>[0]) => desktopSelectionShortcuts()?.actions[id]?.run(intent),
        }])),
      } });
    untracked(() => publishDesktopComposerShortcuts({ type: 'register', owner: shortcuts.owner }));
    cleanup(() => { shortcuts.retire(); publishDesktopComposerShortcuts({ type: 'retire', owner: shortcuts.owner }); });
    if (!props.inline) {
      const metadata = signal<ChatHeaderMetadata>({ loading: false, errors: [] });
      const owner = createDesktopChatHeaderOwner({ target: props.target, operation: operations.operation, current,
        changed: value => metadata.set(value) });
      const header = { route: props.route, metadata, refreshUsage: () => owner.refreshQuotas(true) };
      if (props.target.kind === 'session') {
        const scope = computed((): DesktopWorkStatusScope | null => {
          const host = app.runtimeScope();
          return host && current() ? { host, authorityKey: desktopHostIdentity(), sessionID: props.target.id, directory: props.target.directory } : null;
        });
        const scopeCurrent = (captured: DesktopWorkStatusScope) => current() && chat.active() && lifecycle() === 'active'
          && sameRuntimeScope(captured.host, app.runtimeScope()) && captured.authorityKey === desktopHostIdentity()
          && captured.sessionID === props.target.id && captured.directory === props.target.directory;
        const location = computed((): DesktopWorkStatusLocation => {
          const status = metadata(), project = app.projects().find(project => resourcePath(project.path) === resourcePath(props.target.directory));
          const git = { branch: status.branch ?? null, changedFiles: status.changedFiles ?? null, additions: null, deletions: null };
          return { project: project ? { label: project.name, path: project.path } : null, secondaryWorktree: null,
            git: status.gitStale ? { phase: 'failed', ...(status.repository ? { value: git } : {}) }
              : status.repository === false ? { phase: 'not-repository' }
              : status.repository ? { phase: 'ready', value: git } : { phase: 'unknown' } };
        });
        workStatus = createNativeDesktopChatWorkStatus({ scope, window: desktopWorkStatusWindow, current,
          active: () => chat.active() || chat.syncActive(), interactive: () => current() && chat.active() && lifecycle() === 'active',
          operation: operations.operation, chat: chat.workStatus, location, readChildren: readDesktopWorkStatusChildren, observeChildren: observeDesktopWorkStatusChildren,
          actions: {
            async copyText(value, captured) { if (!scopeCurrent(captured)) throw new Error('work_status_scope_stale'); await Clipboard.writeText(value); },
            openGit(captured) { if (scopeCurrent(captured)) desktopOpenWorkStatusGit?.(captured); },
            openChild({ scope: captured, sessionID, label }) {
              if (scopeCurrent(captured) && captured.directory) desktopOpenPanel?.(captured.directory, { kind: 'chat', target: { sessionID, directory: captured.directory, title: label } });
            },
            onError(key) { if (current() && chat.active()) chat.error.set(t(key)); },
          } });
      }
      effect(() => {
        const lane = operations.operation(), displayed = current(), readDemand = (chat.active() || chat.syncActive()) && lifecycle() === 'active', busy = chat.busy();
        untracked(() => {
          owner.update({ readDemand, busy });
          if (displayed && readDemand) desktopChatHeader.set(header);
          else if (desktopChatHeader()?.route === props.route) desktopChatHeader.set(null);
        });
      });
      cleanup(() => { owner.dispose(); if (desktopChatHeader()?.route === props.route) desktopChatHeader.set(null); });
    }
  }
  if (props.writer) cleanup(props.writer.bindBusiness(chat, () => !history.pending() && !history.unknown() && !attachmentBusy() && !recording() && !speechStarting && !uncertainLocal && admissionState() === 'complete'));
  return (
    <ChatPageLayout inline={!!props.inline && !props.frameOwned} embedded={props.frameOwned} target={props.target}
      headerRight={platform.desktop ? undefined : <ChatHeaderActions native target={props.target} active={chat.active()} busy={chat.busy()} current={current} operation={operations.operation} autoRead={autoReadHeader()} onError={error => chat.error.set(String(error))} onOptions={action => { void run(() => openOptions(action)); }} />}
      header={platform.desktop ? undefined : <NativeChatHeader target={props.target} active={chat.active()} busy={chat.busy()} current={current} operation={operations.operation} autoRead={autoReadHeader()} onBack={() => { if (current() && chat.active()) nav.pop(); }} onOptions={action => { void run(() => openOptions(action)); }} />}
    >
      <If when={platform.os === 'ios'}><NativeChatHeaderCollapse progress={chromeState().swap.progress} duration={chromeState().swap.phase === 'snapping' ? 240 : 0}
        active={current() && chat.active() && lifecycle() === 'active'} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} /></If>
      <NativeChatBodyLayout bodyRef={workStatus?.bodyRef} onBodyLayout={() => { void workStatus?.measureBody(); }} statusPanel={workStatus ? <workStatus.Panel /> : undefined} feedback={<>
      <If when={!desktopContact}><NativeSpeechSettingsError speech={messageSpeech} /></If>
      <NativeChatMcp directory={props.target.directory} active={chat.active()} open={mcpPanel()} onOpenChange={value => mcpPanel.set(value)} onCreate={() => { if (current() && chat.active()) nav.push({ kind: 'settings', route: { page: 'mcp', directory: props.target.directory, create: true } }); }} />
      <If when={chat.error()}>
        <Text testID="chat-global-error" class="px-4 py-2 text-destructive">{chat.error()}</Text>
      </If>
      <If when={!!chat.pendingSend() && !contactPendingFailure() || ['unconfirmed', 'error'].includes(admissionState())}>
        <Button
          class={quiet}
          testID="chat-send-retry"
          disabled={chat.sending() || admissionState() === 'sending'}
          onPress={() => {
            if (admission && admissionState() !== 'complete') void admission.run();
            else if (uncertainLocal && chat.pendingSend()?.id === uncertainLocal.inputID) {
              const captured = uncertainLocal;
              void chat.recoverPendingSend().then(verified => {
                if (verified && uncertainLocal === captured && localCommands?.resolveUnknown(captured.invocation, 'accepted')) uncertainLocal = undefined;
              }).catch(() => { if (current() && chat.active()) chat.error.set(t('common.unavailable')); });
            } else void chat.retrySend();
          }}
        >
          <Text class="text-foreground">
            {t("chat.questionDelegate.retry")}
          </Text>
        </Button>
      </If>
      </>} transcript={<>
      <If when={!chat.loading() && !chat.error() && !chat.visibleMessages().length && !chat.revert() && !chat.historyRepairPending()}>
        <If when={platform.desktop} else={
        <View testID="chat-empty" class="flex-1 items-center justify-center px-10 gap-6">
          <Text class="text-3xl text-foreground text-center" style={{ maxWidth: 300, letterSpacing: -1 }}>
            {props.target.kind === 'session'
              ? t('chat.emptyState.draftTitleWithProject', { project: app.projects().find(project => project.path === props.target.directory)?.name || nameOf(props.target.directory) })
              : t('chat.emptyState.startNewChat')}
          </Text>
        </View>
        }><If when={desktopContact} else={<NativeDesktopChatEmptyState />}><NativeDesktopAssistantEmpty bot={contactBot()} current={() => current() && chat.active()} /></If></If>
      </If>
      <If when={chat.loading() || chat.visibleMessages().length > 0 || !!chat.revert() || chat.historyRepairPending()}>
      <List
        testID="transcript"
        ref={value => transcriptRef.set(value)}
        class="flex-1"
        contentStyle={desktopContact ? { paddingHorizontal: windowSize().width >= 640 ? 32 : 16, paddingTop: 0, gap: 0 } : platform.desktop ? desktopChatListContentStyle : nativeDensity().chat.transcript}
        onLayout={event => { if (platform.desktop && event.bounds.size.width > 0) transcriptWidth.set(event.bounds.size.width); void contactReadSnapshot?.request(); }}
        header={() => <><If when={desktopContact && chat.busy() && !chat.sending()}><View class="w-full self-center" style={{ maxWidth: 672, paddingTop: 12 }}><NativeDesktopAssistantTyping bot={contactBot()} current={() => current() && chat.active()} /></View></If><View testID="transcript-composer-inset" style={{ height: desktopContact ? 48 : platform.desktop ? 16 : composerHeight() + 16 }} /></>}
        inverted
        onScrollDragStart={event => { listHistoryEvents().onScrollDragStart(event); historyScroll.onScrollDragStart(event); if (!platform.desktop) chrome.begin(event); }}
        onScroll={event => { listHistoryEvents().onScroll(event); historyScroll.onScroll(event); contactReadSnapshot?.scroll(event); if (!platform.desktop) chrome.scroll(event); }}
        onScrollDragEnd={event => { listHistoryEvents().onScrollDragEnd(event); chrome.release(event); }}
        onScrollEnd={() => { listHistoryEvents().onScrollEnd(); historyScroll.onScrollEnd(); chrome.end(); }}
        viewabilityConfig={{ itemVisibleThreshold: .01 }} onViewableItemsChange={info => {
          if (!platform.desktop || !historyReadCurrent()) return;
          let topIndex = -1, topTurnID: string | undefined;
          for (const item of info.viewableItems) if (item.isViewable && item.item.turn && item.index > topIndex) { topIndex = item.index; topTurnID = item.item.turn.turnId; }
          if (topTurnID) readingTurnID = topTurnID;
        }}
        onMomentumEnd={() => { listHistoryEvents().onMomentumEnd(); chrome.end(); }}
        onLoadMore={listHistoryEvents().onLoadMore}
        loadMoreThreshold={0.5}
        onLoadMoreAtStart={listHistoryEvents().onLoadMoreAtStart}
        footer={() => <View style={{ minHeight: footerState().minHeight, paddingTop: desktopContact ? windowSize().width >= 640 ? 28 : 20 : undefined }}>
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
          if (desktopContact) {
            const contact = () => contactRowsByID().get(item().id);
            const failedTurn = () => chat.contactOptimistic().find(turn => turn.messageID === item().id && turn.status === 'failed');
            const bot = () => contact()?.kind === 'peer'
              ? app.bots().find(bot => bot.id === item().contact?.fromAssistantID) ?? { id: item().contact?.fromAssistantID, name: item().contact?.fromAssistantName }
              : contactBot();
            return <View class="w-full min-w-0"><NativeDesktopAssistantMessage message={item()} bot={bot()} kind={contact()?.kind ?? 'assistant'} showAvatar={contact()?.showAvatar ?? false}
              timeSeparator={contact()?.separatorLabel} peerLabel={item().contact?.fromAssistantName ?? undefined}
              first={firstContactMessageID() === item().id}
              spacing={contact()?.sameAssistantRun ? 6 : contact()?.startsTurn ? 24 : 12}
              status={chat.streamingMessageIDs().has(item().id) ? 'streaming' : item().contact?.status as 'sending' | 'streaming' | 'failed' | 'complete' | 'admitted' | 'error' | undefined}
              current={() => current() && chat.active() && lifecycle() === 'active'}
              onOpenLink={href => openDesktopContentLink(href, props.target, () => current() && chat.active())}
              feedback={<If when={!!failedTurn()}><NativeDesktopAssistantSendError messageID={item().id} error={failedTurn()?.error ?? ''}
                active={current() && lifecycle() === 'active' && (chat.active() || recoveryReads?.current() === true)} retryDisabled={chat.sending()}
                onRetry={() => { void chat.retryContactMessage(item().id).catch(() => { if (current()) chat.error.set(t('assistants.contact.sendFailed')); }); }} /></If>}
              renderCard={card => <ResourceCard card={card} contact={contactCardMetadata(card)} current={() => current() && chat.active()}
                navigationCurrent={() => current() && lifecycle() === 'active' && !desktopInteractionBlocked() && !desktopGitDialogOpen()
                  && (props.inline ? props.inline.active() && props.inline.interactive() : nav.routes().at(-1) === props.route)} />}
              renderFile={file => <NativeDesktopAssistantAttachment file={file} assistantID={props.target.id} current={() => current() && chat.active() && lifecycle() === 'active'} onSelecting={(owner, selecting) => desktopSetContactDownloadModal?.(owner, selecting)} />} />
              <If when={chat.contactReadPosition()?.messageID === item().id}><View testID="desktop-assistant-read-marker" accessible={false} style={{ width: 1, height: 1 }}
                ref={value => contactReadRef.set(value)} onLayout={() => { void contactReadSnapshot?.request(); }} /></If>
            </View>;
          }
          return (
          <NativeChatRow role={item().role === 'user' ? 'user' : item().role === 'assistant' ? 'assistant' : 'notice'} reserveRight={workStatus?.reserve()}
            header={!!turns().get(row().head.id)?.header || pendingHeaders().has(row().head.id)}
            continued={!turns().get(row().tail.id)?.footer} working={chat.streamingMessageIDs().has(row().tail.id)}>
            <If when={row().head.role === 'assistant' && !!turns().get(row().head.id)?.header}><NativeTurnHeader message={turnHeader(row())} modelName={turnModelName(turnHeader(row()))} identityKey={row().turn?.turnId} /></If>
            <NativeTranscriptBody row={row()} live={chat.busy()} activityMaterialization={chat.activityMaterialization} autoRead={autoRead} autoReadScope={autoReadScope()} streaming={chat.streamingMessageIDs().has(row().tail.id)} contentWidth={platform.desktop ? desktopChatContentWidth(transcriptWidth(), windowSize().width, false, 1, workStatus?.reserve()) : undefined} collapsibleUserMessages={platform.desktop ? nativeAppearance.current()?.collapsibleUserMessages : deviceChatPreferences()?.collapsibleUserMessages ?? null} renderCard={card => <ResourceCard card={card} current={() => current() && chat.active()} />} target={props.target} current={() => current() && chat.active() && lifecycle() === 'active'}
              activityChoice={activityChoices()[row().turn?.turnId ?? row().key]} onToggleActivity={(turnID, expanded) => {
                const present = new Set(bodyRows().map(entry => entry.turn?.turnId ?? entry.key));
                activityChoices.set({ ...Object.fromEntries(Object.entries(activityChoices()).filter(([key]) => present.has(key))), [turnID]: expanded });
              }}
              onOpenChat={target => { if (current() && chat.active()) openNestedChat(target); }}
              onOpenLink={platform.desktop ? href => openDesktopContentLink(href, props.target, () => current() && chat.active()) : undefined}
              onOpenFile={(path, target) => { void run(async () => { if (current() && chat.active()) openResourceFile(path, target.directory, undefined, target); }); }}
              onOpenDiff={(file, target, messageID, files) => {
                if (!current() || !chat.active() || target.kind !== 'session') return;
                modelPicker.set(null);
                const source: ChangesSource = { kind: 'turn', directory: target.directory, sessionID: target.id, messageID, files, path: file.path };
                if (!platform.desktop || !desktopOpenPanel?.(target.directory, { kind: 'diff', source })) changesSource.set(source);
              }}
            />
            <If when={pendingHeaders().has(row().head.id)}><NativeTurnHeader message={turnHeader(row())} modelName={turnModelName(turnHeader(row()))} identityKey={row().turn?.turnId} /></If>
            <NativeTurnError row={row()} />
            <If when={nativeUserActionsVisible(row()) || !!turns().get(item().id)?.footer}><NativeMessageActions history={history} message={item} speech={messageSpeech} tps={turns().get(item().id)?.tps} duration={turns().get(item().id)?.duration} /></If>
          </NativeChatRow>
        ); }}</If>}
      </List>
      </If>
      </>} historyFeedback={<>
      <history.Indicator />
      <If when={!!focusState() && !['idle', 'revealed', 'cancelled'].includes(focusState()!.status)}><View class="px-3 py-2 gap-2">
        <Text testID="history-focus-status" class="text-sm text-muted-foreground">{t(focusState()?.status === 'not-found' ? 'chat.history.focusMissing' : focusState()?.status === 'hidden' ? 'chat.history.focusHidden' : focusState()?.status === 'loading' ? 'mobile.chat.syncingMessages' : 'commandPalette.error.messages')}</Text>
        <If when={focusState()?.status === 'error'}><Button testID="history-focus-retry" class={quiet} onPress={() => { void messageFocus.retry(); }}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button></If>
      </View></If>
      </>} blocking={<BlockingRequests chat={chat} />} edgeFade={chat.loading() || chat.visibleMessages().length > 0 || !!chat.error() || !!chat.revert() || chat.historyRepairPending()}
      composer={<NativeChatComposerLayout reserveRight={workStatus?.reserve()} state={chromeState()} onHeight={value => composerHeight.set(value)} contact={desktopContact ? {
        attach: <Button testID="composer-attach" class="size-8 rounded-full items-center justify-center active:bg-accent disabled:opacity-40" accessibilityLabel={t('chat.chatInput.actions.addAttachment')}
          disabled={attachmentBusy() || !current() || !chat.active() || lifecycle() !== 'active'} onPress={() => { if (current() && chat.active() && lifecycle() === 'active' && !attachmentBusy()) void attach('files'); }}><Icon name="attachment-2" size={20} /></Button>,
        send: <NativeComposerSend active={current() && chat.active() && lifecycle() === 'active'} inFlight={chat.sending()} disabled={sendDisabled()} onPress={sendDraft} />,
      } : undefined} compact={<>
        <If when={props.target.kind === 'session'}><Button testID="compact-attach" class="size-8 items-center justify-center" disabled={attachmentBusy()} accessibilityLabel={t('chat.chatInput.actions.addAttachment')} onPress={chooseAttachment}><Icon name="attachment-2" size={20} /></Button></If>
        <Button testID="compact-edit" class="flex-1 min-w-0 min-h-11 justify-center" accessibilityLabel={t('chat.chatInput.placeholder.chatCompact')} onPress={editCompactDraft}><Text class={chat.draft().trim() ? 'text-foreground' : 'text-muted-foreground'} style={{ numberOfLines: 1, fontSize: 14 }}>{chat.draft().trim() || t('chat.chatInput.placeholder.chatCompact')}</Text></Button>
        <Button testID="compact-dictation" class="size-8 items-center justify-center" accessibilityLabel={t('chat.dictation.start')} onPress={() => { void run(dictate); }}><Icon name={recording() ? 'stop' : 'mic'} /></Button>
        <Button testID="compact-latest" class="size-8 items-center justify-center" accessibilityLabel={t('chat.scrollToBottom.aria')} onPress={resumeLatest}><Icon name="arrow-down-s" size={20} /></Button>
        <NativeComposerSend testIDPrefix="compact-" canAbort={chat.busy()} hasContent={!!chat.draft().trim() || chat.attachments().length > 0} onStop={() => { void run(chat.stop); }} inFlight={chat.sending() && !btwDraft()} disabled={sendDisabled()} onPress={sendDraft} />
      </>} queue={<NativeChatQueue chat={chat} />}
        goal={<If when={props.target.kind === 'session'}><NativeGoalRow owner={chat.goal} enabled={goalEnabled()} active={chat.active()} open={goalPanel()} onOpenChange={open => { if (open) statusPopovers.close(); goalPanel.set(open); }} /></If>}
        status={<If when={props.target.kind === 'session'}>
          <View class="flex-row items-center justify-between">
            <NativeComposerChanges directory={props.target.directory} active={chat.active()} expanded={statusPopovers.opened() === 'changes'} onExpandedChange={open => statusPopovers.changes(open)} generationContext={changesGenerationContext()} diffLayoutPreference={nativeAppearance.current()?.diffLayoutPreference ?? null} onOpenPreview={(path, line) => { statusPopovers.close(); void run(async () => openResourceFile(path, props.target.directory, line)); }} />
            <NativeComposerTasks todos={chat.tasks()} liveWorking={chat.busy()} active={chat.active()} expanded={statusPopovers.opened() === 'tasks'} onExpandedChange={open => statusPopovers.tasks(open)} />
          </View>
        </If>} anchorRef={view => composerAnchor.set(view)} onWidth={width => composerWidth.set(width)} focused={editorFocused()}
        feedback={<NativeDraftFeedback chat={chat} />} attachments={<Each of={chat.attachments()}>
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
                  testID={`composer-remove-attachment-${attachment().name}`}
                  disabled={!current() || !chat.active() || lifecycle() !== 'active' || recording()}
                  onPress={() => {
                    if (!current() || !chat.active() || lifecycle() !== 'active' || recording()) return;
                    chat.attachments.set(
                      chat
                        .attachments()
                        .filter((file) => file !== attachment()),
                    );
                  }}
                >
                  <Text class="text-muted-foreground">×</Text>
                </Button>
              </View>
            )}
          </Each>} editor={<Input
            testID="composer"
            class={platform.desktop ? 'text-foreground' : 'text-foreground min-h-[52px] max-h-36 py-[10px]'}
            style={{ ...nativeChatTextStyle('composer'), ...(desktopContact ? desktopAssistantEditorStyle : platform.desktop ? desktopChatEditorStyle : { backgroundColor: 'transparent', borderWidth: 0 }) }}
            multiline
            readonly={recording() || !current() || !chat.active() || lifecycle() !== 'active'}
            value={chat.draft()}
            ref={node => { editor = node; referenceKeyboard.ref(node); }}
            selectedRange={referenceKeyboard.selectedRange()}
            onFocus={() => { editorFocused.set(true); chrome.pin(true); referenceKeyboard.onFocus(); }}
            onBlur={() => { editorFocused.set(false); desktopComposing.set(false); referenceKeyboard.onBlur(); }}
            submitBehavior={referenceKeyboard.submitBehavior()}
            onSubmit={submitFromEditor}
            onSelectionChange={referenceKeyboard.onSelectionChange}
            onCompositionChange={event => { desktopComposing.set(event.composing); referenceKeyboard.onCompositionChange(event); }}
            onChange={(e) => {
              if (!current() || !chat.active() || lifecycle() !== 'active' || recording()) return;
              referenceKeyboard.beforeChange();
              if (props.target.kind === 'session' && inputMode() === 'normal' && !chat.draft() && e.value.startsWith('!')) {
                inputMode.set('shell'); chat.setDraftText(e.value.slice(1));
              } else chat.setDraftText(e.value);
              referenceKeyboard.refresh();
            }}
            placeholder={desktopContact ? t('assistants.contact.placeholder', { name: text(contactBot().name) }) : t(inputMode() === 'shell' ? 'chat.chatInput.placeholder.shell' : 'chat.chatInput.placeholder.chatCompact')}
          />} recovery={AttachmentRecovery ? <AttachmentRecovery /> : null} leadingActions={<If when={!desktopContact}>
            <If when={props.target.kind === "session"}>
              <Button
                testID="composer-attach"
                class={`${platform.desktop ? 'size-6' : 'size-8'} rounded-full items-center justify-center active:bg-accent disabled:opacity-40`}
                hitSlop={6}
                disabled={attachmentBusy() || !current() || !chat.active() || lifecycle() !== 'active' || recording()}
                accessibilityLabel={t("chat.chatInput.actions.addAttachment")}
                onPress={chooseAttachment}
              >
                  <Icon name="attachment-2" size={platform.desktop ? 16 : 20} />
              </Button>
            </If>
            <Button
              testID="composer-dictate"
              class={`${platform.desktop ? 'size-6' : 'size-8'} rounded-full items-center justify-center active:bg-accent disabled:opacity-40`}
              hitSlop={6}
              disabled={!current() || !chat.active() || lifecycle() !== 'active'}
              accessibilityLabel={t("chat.dictation.start")}
              onPress={() => {
                void run(dictate);
              }}
            >
              <Icon name={recording() ? 'stop' : 'mic'} size={platform.desktop ? 16 : 20} />
            </Button>
            <If when={inputMode() === 'shell'}><Button testID="composer-normal-mode" class={quiet} accessibilityLabel={t('settings.common.actions.cancel')} onPress={() => inputMode.set('normal')}><Text class="text-foreground text-xs">! ×</Text></Button></If>
             </If>} trailingActions={<If when={!desktopContact}>
            <NativeGoalChip owner={chat.goal} enabled={goalEnabled()} />
            <NativeGoalObjectiveCounter armed={goalEnabled() && chat.goal.state().armed} length={chat.draft().length} />
             <If when={!desktopContact}><NativeComposerSelection presentation={platform.desktop ? 'desktop' : 'mobile'} target={props.target} active={chat.active()} open={modelPicker()} onOpenChange={value => modelPicker.set(value)} onAssistantEdit={openSelection} onDesktopShortcuts={platform.desktop ? publishSelectionShortcuts : undefined} onModelLabel={value => headerModelLabel.set(value)} onSelection={authority => {
              headerSelection.set(authority);
              if (!current() || !chat.active()) return;
              const model = record(authority.model);
              botCreationContext.update(props.target.directory, {
                providerID: text(model.providerID) || text(authority.providerID),
                modelID: text(model.id) || text(model.modelID) || text(authority.modelID),
                variant: text(model.variant) || text(authority.variant) || undefined,
              }, text(authority.agent) || undefined);
            }} /></If>
            <NativeComposerSend
              presentation={platform.desktop ? 'desktop' : 'mobile'} active={current() && chat.active() && lifecycle() === 'active'}
              canAbort={chat.busy()}
              hasContent={!!chat.draft().trim() || chat.attachments().length > 0}
              onStop={() => { void run(chat.stop); }}
              inFlight={chat.sending() && !btwDraft()}
              disabled={sendDisabled()}
              onPress={sendDraft}
            />
           </If>} overlays={<>
        <If when={!!referenceKeyboard.commandTrigger() && !!composerAnchor()}>
          <Overlay testID="composer-command-panel" anchor={composerAnchor()} placement="top" align="start" offset={8} margin={12} style={{ width: platform.desktop ? Math.min(composerWidth() || 752, windowSize().width - 24) : windowSize().width - 24 }} onPressOutside={dismissReferences} onCancel={dismissReferences}>
            <NativeCommandSuggestions scope={chat.referenceScope} keyboard={referenceKeyboard} commands={chat.commands()} loadCommands={chat.loadCommands} catalog={localCommands?.catalog} context={commandContext()} maxHeight={Math.min(320, Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .4)} />
          </Overlay>
        </If>
        <If when={!!referenceTrigger() && !!composerAnchor()}>
          <Overlay testID="composer-reference-panel" anchor={composerAnchor()} placement="top" align="start" offset={8} margin={12} style={{ width: platform.desktop ? Math.min(composerWidth() || 752, windowSize().width - 24) : windowSize().width - 24 }} onPressOutside={dismissReferences} onCancel={dismissReferences}>
            <NativeReferencePicker scope={chat.referenceScope} keyboard={referenceKeyboard} currentSessionID={props.target.id} maxHeight={Math.min(320, Math.max(0, windowSize().height - safeArea().top - safeArea().bottom) * .4)} open={!!referenceTrigger()} query={referenceTrigger()?.query} request={operations.operation()?.request ?? (() => Promise.reject(new Error('page_operation_stale')))} onClose={dismissReferences} />
          </Overlay>
        </If>
      </>} />}
      overlays={<>
      <NativeChangesPresentation source={changesSource()} open={!!changesSource()} active={chat.active()} current={current} onHandle={changesHandle}
        onClose={() => changesSource.set(null)} onBlocked={() => report(new Error(t('common.unavailable')))}
        onOpenPreview={(path, line, source) => { void run(async () => { changesSource.set(null); openResourceFile(path, source.directory, line); }); }} />
      <If when={platform.desktop && props.target.kind === 'session'}><NativeComposerTimeline scope={timelineScope()} open={timelineOpen()} active={historyReadCurrent()}
        messages={chat.messages} canLoadEarlier={chat.more()} isLoadingEarlier={chat.olderLoading()}
        onLoadEarlier={async () => { if (!historyReadCurrent()) return false; await chat.loadOlder(); return historyReadCurrent() && !chat.historyError(); }}
        onScrollToMessage={async messageID => (await messageFocus.focus(messageID)).status === 'revealed'}
        canRevert={history.capability().stage} canFork={history.capability().fork}
        onRevertMessage={messageID => history.stage(messageID, { current: historyReadCurrent })}
        onForkMessage={messageID => history.fork(messageID, { current: historyReadCurrent })}
        onScrollByTurnOffset={offset => { void scrollByTurnOffset(offset); }} onResumeToLatest={resumeToLatest}
        onOpenChange={showTimeline} onUnknown={() => { if (historyReadCurrent()) chat.error.set(t('chat.questionDelegate.uncertain')); }} /></If>
      </>} />
    </ChatPageLayout>
  );
}

function ResourceCard(props: { card: Row; contact?: Omit<NativeDesktopAssistantCardProps, 'card' | 'current' | 'onOpen'>; current?: () => boolean; navigationCurrent?: () => boolean; readOnly?: boolean; onOpenSession?: (target: ChatTarget) => void }) {
  const operations = createPageOperations(() => props.navigationCurrent?.() ?? props.current?.() ?? true);
  const current = () => operations.current() && (props.current?.() ?? true),
    pending = signal(false);
  operations.onRetire(() => pending.set(false));
  async function open() {
    if (!current() || pending() || props.readOnly && props.card.cardType !== 'session') return;
    const lane = operations.capture(), request = lane.request;
    const valid = lane.current;
    pending.set(true);
    await run(async () => {
      const card = props.card;
      if (card.cardType === "session") {
        const sessionID = text(card.sessionID);
        const session = props.contact ? props.contact.session : app.sessions().find(session => session.id === sessionID);
        let directory = props.contact ? text(session?.directory).trim() || text(card.directory) : text(card.directory) || text(session?.directory);
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
        (props.onOpenSession ?? openChat)({
          kind: "session",
          id: sessionID,
          title: text(props.contact?.session?.title).trim() || text(card.title) || sessionID,
          directory,
        });
      } else if (card.cardType === "assistant") {
        let bot = (props.contact ? desktopContactCatalog().assistants : app.bots()).find((item) => item.id === card.assistantID);
        if (!bot)
          bot = list(
            record(await request("/api/yuri/assistants/snapshot")).assistants,
          ).find((item) => item.id === card.assistantID);
        if (!valid()) return;
        if (!bot) throw new Error(t("common.unavailable"));
        const target: ChatTarget = {
          kind: "assistant",
          id: text(bot.id),
          title: text(bot.name),
          directory: text(bot.effectiveWorkspacePath),
        };
        if (props.contact && platform.desktop) {
          if (!desktopOpenAssistantCard || !await desktopOpenAssistantCard(target.id, valid)) throw new Error(t('common.unavailable'));
        } else openChat(target);
      } else if (card.cardType === "schedule") {
        let item = (props.contact ? desktopContactCatalog().tasks : app.tasks())
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
        if (props.contact && platform.desktop) {
          if (!desktopOpenScheduledCard || !await desktopOpenScheduledCard(item, valid)) throw new Error(t('common.unavailable'));
        } else nav.push({ kind: "task", item });
      }
    });
    if (valid()) pending.set(false);
  }
  return (
    <If when={!!props.contact && props.card.type === 'card' && ['session', 'assistant', 'schedule'].includes(text(props.card.cardType))} else={
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
          testID={`resource-card-${text(props.card.cardType)}-${text(props.card.sessionID) || text(props.card.assistantID) || text(props.card.taskID)}`}
          class={quiet}
          disabled={pending() || props.readOnly && props.card.cardType !== 'session'}
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
    </View>}><NativeDesktopAssistantCard card={props.card} session={props.contact?.session} assistant={props.contact?.assistant} task={props.contact?.task}
      branch={props.contact?.branch} liveStatus={props.contact?.liveStatus} avatarClockScope={props.contact?.avatarClockScope}
      current={() => current() && !pending() && !(props.readOnly && props.card.cardType !== 'session')} onOpen={() => { void open(); }} /></If>
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
  if (!platform.desktop) return <MobileHome />;
  return <If when={!!app.connection()} else={<MobileHome />}><Each of={[desktopHostIdentity()]}>{() => <DesktopHomeContent />}</Each></If>;
}

function DesktopHomeContent() {
  const route = nav.routes()[0];
  const contactRoute = signal<Extract<Route, { kind: 'chat' }> | null>(null);
  const publishContactRoute = (route: Extract<Route, { kind: 'chat' }>) => {
    contactRoute.set(route);
    return () => { if (contactRoute() === route) contactRoute.set(null); };
  };
  function contactStatus(bot: Row) {
    mountedChatRevision();
    const selected = contactRoute();
    const chat = selected && selected.target.id === bot.id && selected.target.directory === bot.effectiveWorkspacePath ? mountedChats.get(selected) : undefined;
    if (chat?.sending() || chat?.busy()) return t('assistants.conversation.typing');
    const previewTime = record(bot.latestMessagePreview).createdAt;
    const timestamp = typeof previewTime === 'number' && Number.isFinite(previewTime) ? previewTime : chat?.messages().at(-1)?.contact?.createdAt;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return t('assistants.conversation.lastContact', { time: createContactTimeFormatter(currentLocale(), t('common.date.today'), new Date())(timestamp) });
    if (!chat || !chat.messagesResolved() && !chat.messageReadError()) return t('common.loading');
    if (chat.messageReadError()) return t('assistants.contact.loadFailed');
    return t('assistants.conversation.neverContacted');
  }
  function AssistantPane() {
    const initialAssistantID = desktopTakeAssistantCard?.();
    return <View class="flex-1 bg-background"><AssistantHome presentation="desktop" active={nav.routes().length === 1}
      initialAssistantID={initialAssistantID} onConversationNavigation={select => {
        desktopSelectAssistantContact = select;
        return () => { if (desktopSelectAssistantContact === select) desktopSelectAssistantContact = undefined; };
      }}
      interactive={!desktopInteractionBlocked() && !desktopGitDialogOpen()} renderConversation={context => <DesktopAssistantChat context={context} onRoute={publishContactRoute} />}
      contactStatus={contactStatus}
      requestConversationChange={(commit, current) => desktopRequestConversationChange?.(commit, current) ?? Promise.resolve(false)}
      onOpenChat={openChat} onCreate={() => openBotEditor()} onEdit={bot => nav.push({ kind: 'assistant-details', bot })} onOpenSettings={() => settingsCallbacks.onOpen({ page: 'assistants' })} /></View>;
  }
  return <><If when={app.tab() === 0}><NativeNewSessionPage active={nav.routes().length === 1 && !desktopInteractionBlocked()} desktopWriter={desktopWriterClient} directory={routeDirectory(route)} onDesktopShortcuts={publishDesktopComposerShortcuts} onDesktopOwner={publishDesktopDraftOwner} onRetainedOwner={owner => retainDesktopDraftOwner(route, owner)} onWriterAdmissionGuard={guard => retainDesktopDraftAdmission(route, guard)} onUserIntent={() => desktopNavigationIntent?.()}
    onSelection={(directory, selection, agent) => { const route = nav.routes()[0]; if (route) publishDesktopDraftDirectory(route, directory); botCreationContext.update(directory, selection, agent); }}
    onOpenChat={(target, handoff) => nav.push({ kind: 'chat', target, handoff })} /></If>
    <If when={app.tab() === 1}><Each of={[desktopAssistantCardGeneration()]}>{() => <AssistantPane />}</Each></If>
    <If when={app.tab() === 2}><Each of={[desktopScheduledCardGeneration()]}>{() => <DesktopScheduleHome />}</Each></If>
  </>;
}

function DesktopAssistantChat(props: { context: DesktopAssistantConversationContext; onRoute?: (route: Extract<Route, { kind: 'chat' }>) => () => void }) {
  return <Each of={[assistantChatTarget(props.context.bot())]} key={target => JSON.stringify([target.id, target.directory])}>{target => <DesktopAssistantChatOwner target={target()} context={props.context} onRoute={props.onRoute} />}</Each>;
}

function DesktopAssistantChatOwner(props: { target: ChatTarget; context: DesktopAssistantConversationContext; onRoute?: (route: Extract<Route, { kind: 'chat' }>) => () => void }) {
  const route: Extract<Route, { kind: 'chat' }> = { kind: 'chat', target: props.target };
  const unpublish = props.onRoute?.(route);
  cleanup(() => unpublish?.());
  // Transfer the same entity to an explicit Chat route instead of retaining two
  // draft writers; temporary Settings/Search/Help do not remove the inline owner.
  const transferred = () => nav.routes().some(value => value.kind === 'chat' && value.target.kind === props.target.kind && value.target.id === props.target.id && value.target.directory === props.target.directory);
  return <If when={!transferred()}><Chat route={route} target={props.target} inline={props.context} /></If>;
}

function DesktopScheduleHome() {
  type Selection = { serial: number; item?: Row; creationContext?: TaskEditorCreationContext };
  const initialItem = desktopTakeScheduledCard?.();
  const selected = signal<Selection | null>(initialItem ? { serial: 1, item: initialItem, creationContext: taskEditorCreationContext(initialItem) } : null), leave = signal<TaskEditorLeave | null>(null);
  const windowGuard = signal<{ requestClose: () => Promise<boolean>; canClose: () => boolean } | null>(null);
  const historyCommit = signal<((item: Row | null) => void) | null>(null);
  const authority = desktopHostIdentity();
  let alive = true, serial = initialItem ? 1 : 0;
  const active = () => alive && authority === desktopHostIdentity() && app.tab() === 2 && nav.routes().length === 1;
  const interactive = () => active() && !desktopInteractionBlocked() && !desktopGitDialogOpen() && lifecycle() === 'active';
  const clear = () => { selected.set(null); leave.set(null); windowGuard.set(null); };
  const unbind = desktopPageDeparture?.bind({
    current: () => active() && !!selected(),
    requestLeave: async commit => {
      const captured = selected(), guard = windowGuard();
      if (!captured || !guard) return;
      if (await guard.requestClose() && active() && selected() === captured && windowGuard() === guard && guard.canClose()) commit();
    },
    release: clear,
    requestClose: async () => await windowGuard()?.requestClose() === true,
    canClose: () => windowGuard()?.canClose() === true,
  });
  cleanup(() => { alive = false; unbind?.(); });
  function choose(item?: Row) {
    if (!interactive()) return;
    const prior = selected()?.item;
    if (selected() && (!prior && !item || prior && item && prior.projectId === item.projectId && record(prior.task).id === record(item.task).id)) return;
    const commit = () => {
      if (!interactive()) return;
      leave.set(null); windowGuard.set(null);
      selected.set({ serial: ++serial, item, creationContext: taskEditorCreationContext(item) });
    };
    if (desktopPageDeparture) void desktopPageDeparture.request(commit); else commit();
  }
  function Editor(props: { selection: Selection }) {
    const captured = props.selection;
    const current = () => alive && selected() === captured && authority === desktopHostIdentity();
    return <TaskEditor presentation="desktop" item={captured.item} creationContext={captured.creationContext}
      active={active() && current()} interactive={interactive() && current()}
      onNavigation={guard => { if (current()) leave.set(guard); }}
      onWindowGuard={guard => { if (current()) windowGuard.set(guard); }}
      onDone={() => { if (current()) clear(); }} onClose={() => { if (current()) clear(); }}
      onOpenHistory={() => { if (!current() || !interactive()) return; const commit = historyCommit(); if (commit) { clear(); commit(captured.item ?? null); } }} />;
  }
  return <View class="flex-1 min-w-0 min-h-0 bg-background"><ScheduledHome presentation="desktop" active={active()} interactive={interactive()}
    editorOpen={!!selected()} selectedTask={selected()?.item ? { projectId: text(selected()!.item!.projectId), taskId: text(record(selected()!.item!.task).id) } : null}
    editor={<Each of={selected() ? [selected()!] : []} key={selection => selection.serial}>{selection => <Editor selection={selection()} />}</Each>}
    requestViewChange={commit => { if (desktopPageDeparture) void desktopPageDeparture.request(commit); else commit(); }}
    onHistoryCommit={commit => historyCommit.set(commit)}
    onCreate={() => choose()} onEdit={choose} onOpenTask={choose} onOpenAssistant={openChat} onOpenSession={openChat} /></View>;
}

function MobileHome() {
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
      <If when={!platform.desktop}><TabBar
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
      /></If>
    </NavPage>
  );
}

function DesktopContextPanel(props: { scope: DesktopPanelScope; current: () => boolean; active: () => boolean; interactive: () => boolean }) {
  const operations = createPageOperations(props.current);
  const source = computed(() => {
    mountedChatRevision();
    const route = retainedChatRoute(), chat = route ? mountedChats.get(route) : undefined;
    return route?.target.kind === 'session' && route.target.id === props.scope.sessionID && route.target.directory === props.scope.directory && chat ? { route, chat } : null;
  });
  const current = () => {
    const selected = source();
    return !!selected && props.current() && mountedChats.get(selected.route) === selected.chat && epoch() === selected.chat.messageScope.generation && operations.current();
  };
  return <NativeDesktopContext scope={props.scope} chat={source()?.chat ?? null} current={current} active={props.active()}
    interactive={props.interactive()}
    read={path => operations.capture().request(path, 'GET')} appearance={nativeAppearance.current()} />;
}

function DesktopBtwPanelContent(props: { workbench: DesktopBtwWorkbench; context: Parameters<NonNullable<import('./desktop-panel').NativeDesktopPanelProps['btw']>>[0]; close: () => void }) {
  const scope = props.context.scope;
  const admitted = props.workbench.admit(scope);
  const speech = () => {
    mountedChatRevision(); const route = retainedChatRoute();
    return route?.target.kind === 'session' && route.target.id === scope.sessionID && route.target.directory === scope.directory ? desktopBtwSpeechSources.get(route)?.() : undefined;
  };
  const modelLabel = () => {
    mountedChatRevision(); const route = retainedChatRoute();
    return route?.target.kind === 'session' && route.target.id === scope.sessionID && route.target.directory === scope.directory ? desktopBtwModelLabels.get(route)?.() ?? null : null;
  };
  return <If when={admitted} else={<Text class="p-3 text-muted-foreground">{t('common.unavailable')}</Text>}><NativeDesktopBtwPanel
    store={props.workbench.store} scope={props.workbench.scope(scope)} authority={JSON.stringify([scope.authorityKey, scope.host.lease, epoch()])}
    current={props.context.current} active={props.context.active()} interactive={props.context.interactive()} visible={props.context.visible()}
    onHandle={handle => props.workbench.publish(scope, handle)} onClose={props.close}
    speech={speech()}
    renderSelection={slot => <NativeDesktopBtwSelection slot={slot} label={modelLabel()} current={() => props.context.current() && props.context.active()} />}
    onOpenLink={href => openDesktopContentLink(href, { kind: 'session', id: scope.sessionID!, directory: scope.directory, title: scope.sessionID! }, () => props.context.current() && props.context.interactive())} /></If>;
}

function NativeApplicationWorkspace(props: { layout: ReturnType<typeof createDesktopLayout> | null; metadataStorage: DesktopWindowMetadataStorage | null; preferenceCoordination: DesktopWindowPreferenceCoordination; children: JSX.Element }) {
  if (!props.layout) return props.children;
  const metadataStorage = props.metadataStorage;
  if (!metadataStorage) throw new Error('desktop_window_metadata_unavailable');
  const diffPreferences = createNativeDesktopDiffPreferences({ coordination: props.preferenceCoordination });
  cleanup(bindNativeDesktopDiffPreferences(diffPreferences));
  cleanup(() => { diffPreferences.dispose(); });
  const layout = props.layout, tabs = createNativeDesktopPanelTabs({ storage: createDesktopFileJournalStorage(native) });
  const panelMetadataRevision = signal(0);
  const panelMetadata = createDesktopPanelTabsPersistence(tabs, metadataStorage, () => untracked(() => panelMetadataRevision.set(panelMetadataRevision() + 1)));
  const panelMetadataState = () => { panelMetadataRevision(); return panelMetadata.state(); };
  const journalRetrying = signal(false);
  void panelMetadata.restore();
  cleanup(panelMetadata.dispose);
  const closeCommitting = signal(false);
  const contactDownloadModals = signal<ReadonlySet<object>>(new Set());
  const panelStream = signal<DesktopPanelChatStream | undefined>(undefined);
  const httpGrant = signal<DesktopHttpGrant | undefined>(undefined);
  let workspaceAlive = true;
  const setContactDownloadModal = (owner: object, selecting: boolean) => {
    if (!workspaceAlive || contactDownloadModals().has(owner) === selecting) return;
    const next = new Set(contactDownloadModals());
    if (selecting) next.add(owner); else next.delete(owner);
    contactDownloadModals.set(next);
  };
  desktopSetContactDownloadModal = setContactDownloadModal;
  cleanup(() => { if (desktopSetContactDownloadModal === setContactDownloadModal) desktopSetContactDownloadModal = undefined; });
  const remoteConnections = createNativeDesktopRemoteConnectionsRoot({ current: () => workspaceAlive,
    runtimeReady: () => workspaceAlive && lifecycle() === 'active' && !closeCommitting() });
  cleanup(remoteConnections.dispose);
  void loadDesktopPanelChatNativeStream(native).then(port => { if (workspaceAlive) panelStream.set(port); });
  void loadNativeDesktopHttpGrant({ current: () => workspaceAlive }).then(grant => { if (workspaceAlive) httpGrant.set(grant); });
  cleanup(() => { workspaceAlive = false; });
  const githubOperation = signal<ReturnType<typeof captureHostOperation> | null>(null);
  const github = createNativeDesktopHeaderGitHubRoot({
    committed: () => {
      const host = app.runtimeScope(), directory = routeDirectory();
      return host && directory ? { host, directory, authorityKey: desktopHostIdentity() } : null;
    },
    current: () => workspaceAlive,
    operation: githubOperation,
    active: () => headerCurrent(), interactive: () => headerCurrent(),
  });
  const update = createNativeDesktopHeaderUpdateRoot({
    committed: () => { const host = app.runtimeScope(); return host ? { host, authorityKey: desktopHostIdentity() } : null; },
    operation: tourRootOperation, current: () => workspaceAlive,
  });
  effect(() => {
    app.runtimeScope(); desktopHostIdentity(); tourRootOperation();
    untracked(update.reconcile);
  });
  cleanup(() => { if (!update.dispose()) update.retire(); });
  const writerDepartures = createDesktopWriterDeparture<DesktopWriterGuardTag>({ scope: () => JSON.stringify([epoch(), desktopHostIdentity()]) });
  desktopRegisterWriterGuard = writerDepartures.register;
  cleanup(() => { if (desktopRegisterWriterGuard === writerDepartures.register) desktopRegisterWriterGuard = undefined; writerDepartures.dispose(); });
  const rootRoute = nav.routes()[0];
  effect(() => {
    const handle = projectChangesHandle();
    if (!handle) return;
    return writerDepartures.register({ route: rootRoute, owner: handle, inline: false }, {
      current: () => workspaceAlive, prepare: async () => handle.canLeave(), canClose: handle.canLeave, cancel: () => {}, release: async () => true,
    });
  });
  const shortcutCapture = signal<NativeShortcutCapture | null>(null);
  const settingsRoot = createNativeDesktopSettingsRoot({ retention: retentionController, onError: report, codeTypographyReady: true,
    remoteConnections: remoteConnections.slot, desktopGitHub: github.settings, desktopAbout: update.about,
    shortcuts: context => <DesktopShortcutsSettings preferences={shortcuts.preferences} actions={shortcutActions} capture={shortcutCapture}
      onCaptureChange={value => shortcutCapture.set(value)} active={context.active} />,
    callbacks: {
    onConnect: () => nav.push({ kind: 'connect' }),
    onEditConnection: (id, mode) => nav.push({ kind: 'connection-editor', id, mode }),
    onAssistants: () => nav.push({ kind: 'settings', route: { page: 'assistants' } }),
    onManageQuotaCredentials: (provider, providerName, directory) => {
      const hostID = app.connection()?.id;
      if (hostID) nav.push({ kind: 'settings-quota', provider, providerName, directory, hostID, generation: epoch() });
    },
  } });
  const SettingsRoot = settingsRoot.Root;
  const openSettings = (route: SettingsRoute) => { void settingsRoot.open(route); };
  desktopOpenSettings = openSettings;
  cleanup(() => { if (desktopOpenSettings === openSettings) desktopOpenSettings = undefined; });
  const scope = (): DesktopPanelScope | null => {
    const host = app.runtimeScope(), directory = routeDirectory();
    if (!host || !directory) return null;
    const route = retainedChatRoute();
    return { host, authorityKey: desktopHostIdentity(), directory, sessionID: route?.target.kind === 'session' && route.target.directory === directory ? route.target.id : null };
  };
  const openPanel = (directory: string, intent?: DesktopPanelIntent) => {
    if (desktopInteractionBlocked() || desktopGitDialogOpen() || closeCommitting() || lifecycle() !== 'active') return false;
    const selected = scope();
    if (!selected || !resourceWithin(directory, selected.directory) || !resourceWithin(selected.directory, directory)) return false;
    if (intent && !tabs.open(selected, intent)) return false;
    layout.set({ panelOpen: true });
    return true;
  };
  desktopOpenPanel = openPanel;
  cleanup(() => { if (desktopOpenPanel === openPanel) desktopOpenPanel = undefined; });
  const openWorkStatusGit = (captured: DesktopWorkStatusScope) => {
    const selected = scope();
    if (!selected || !sameRuntimeScope(selected.host, captured.host) || selected.authorityKey !== captured.authorityKey
      || selected.sessionID !== captured.sessionID || selected.directory !== captured.directory || !openPanel(selected.directory)) return false;
    tabs.setRail(selected, 'git');
    return true;
  };
  desktopOpenWorkStatusGit = openWorkStatusGit;
  cleanup(() => { if (desktopOpenWorkStatusGit === openWorkStatusGit) desktopOpenWorkStatusGit = undefined; });
  const openFileReference = (source: DesktopPanelScope, path: string, targetLine?: number) => {
    if (!workspaceAlive || desktopInteractionBlocked() || desktopGitDialogOpen() || closeCommitting() || lifecycle() !== 'active') return false;
    const parent = scope();
    if (!parent || parent.authorityKey !== source.authorityKey || !sameRuntimeScope(parent.host, source.host)) return false;
    const id = source.sessionID !== null
      ? tabs.openFileReference(parent, { directory: source.directory, sessionID: source.sessionID }, path, targetLine)
      : resourcePath(source.directory) === resourcePath(parent.directory) ? tabs.open(parent, { kind: 'file', path, targetLine }) : '';
    if (!id) return false;
    tabs.setRail(parent, null); layout.set({ panelOpen: true });
    return true;
  };
  desktopOpenFileReference = openFileReference;
  cleanup(() => { if (desktopOpenFileReference === openFileReference) desktopOpenFileReference = undefined; });
  const palette = signal<{ directory?: string; scope: string } | null>(null);
  const helpOpen = signal(false);
  const dismissHelp = () => helpOpen.set(false);
  const switcherAnchor = signal<ViewRef | null>(null);
  const sessionSwitcher = signal<{ scope: string; route: Route | undefined; authority: string } | null>(null);
  let switcherGeneration = 0;
  const dismissSwitcher = (scope?: unknown) => { if (scope === undefined || sessionSwitcher()?.scope === scope) sessionSwitcher.set(null); };
  effect(() => { const external = settingsRoot.isOpen() || !!palette() || !!sessionSwitcher() || helpOpen() || closeCommitting() || contactDownloadModals().size > 0, blocked = external || !!desktopTimelineOwner(); untracked(() => { desktopExternalModalOpen.set(external); desktopInteractionBlocked.set(blocked); }); });
  cleanup(() => { desktopExternalModalOpen.set(false); desktopInteractionBlocked.set(false); });
  const paletteScope = () => JSON.stringify([epoch(), desktopHostIdentity()]);
  const dismissPalette = () => palette.set(null);
  effect(() => {
    const value = palette(), current = paletteScope(), active = lifecycle() === 'active', settingsOpen = settingsRoot.isOpen();
    if (value && (value.scope !== current || !active || settingsOpen)) untracked(dismissPalette);
  });
  effect(() => {
    const value = sessionSwitcher(), current = paletteScope(), route = nav.routes().at(-1);
    if (value && (value.authority !== current || value.route !== route || lifecycle() !== 'active' || settingsRoot.isOpen() || palette() || closeCommitting())) untracked(() => dismissSwitcher(value.scope));
  });
  const search = () => {
    if (settingsRoot.isOpen() || closeCommitting() || desktopGitDialogOpen() || !app.connection() || lifecycle() !== 'active') return;
    if (palette()) dismissPalette();
    else { dismissHelp(); dismissSwitcher(); palette.set({ directory: routeDirectory(), scope: paletteScope() }); }
  };
  const help = () => {
    if (settingsRoot.isOpen() || closeCommitting() || desktopGitDialogOpen() || lifecycle() !== 'active') return;
    if (helpOpen()) dismissHelp();
    else { dismissPalette(); dismissSwitcher(); helpOpen.set(true); }
  };
  desktopSearch = search;
  cleanup(() => { if (desktopSearch === search) desktopSearch = undefined; });
  const newSession = (project?: Project) => {
    if (!settingsRoot.isOpen() && app.connection() && lifecycle() === 'active') openNewSession(project);
  };
  const settings = () => settingsCallbacks.onOpen({ page: 'appearance' });
  let rawNavigationDepth = 0;
  let programmaticTop: Route | undefined;
  const navigation = attachDesktopNavigationApplication({
    storage: metadataStorage,
    authorize: async (_resource, context) => {
      await tabs.ready;
      return context.current() && !settingsRoot.isOpen() && !helpOpen() && !closeCommitting() && !palette() && !sessionSwitcher() && nav.routes().length === 1 && tabs.canRestoreNavigation();
    },
    rawApply: (resource, context) => {
      if (!context.current() || closeCommitting() || settingsRoot.isOpen() || helpOpen() || palette() || sessionSwitcher() || nav.routes().length !== 1 || !tabs.canRestoreNavigation()) return false;
      if (resource.kind === 'home') {
        rawNavigationDepth++;
        try { app.tab.set(resource.section === 'assistants' ? 1 : 2); rawNavigation.popToRoot(); programmaticTop = nav.routes()[0]; }
        finally { rawNavigationDepth--; }
        return true;
      }
      const route: Route = resource.kind === 'session' || resource.kind === 'assistant'
        ? { kind: 'chat', target: resource.target, ...(resource.kind === 'session' && resource.messageID ? { messageID: resource.messageID } : {}) }
        : resource.kind === 'project' ? { kind: 'project', project: resource.project }
        : { kind: 'new-session', directory: resource.directory, project: resource.project };
      desktopRouteAuthorities.set(route, desktopHostIdentity());
      rawNavigationDepth++;
      try { app.tab.set(0); rawNavigation.setRoutes([nav.routes()[0], route]); programmaticTop = route; }
      finally { rawNavigationDepth--; }
      return true;
    },
  });
  const pageDepartureOwner = createDesktopPageDeparture({ scope: () => JSON.stringify([epoch(), desktopHostIdentity()]), onIntent: () => navigation.userNavigated(), onError: report });
  async function requestWriterDeparture(commit: () => void, validate: () => boolean = () => true,
    release: (tag: DesktopWriterGuardTag) => boolean = () => false, skip?: (tag: DesktopWriterGuardTag) => boolean) {
    const current = () => workspaceAlive && contactDownloadModals().size === 0 && github.canClose() && update.canClose() && remoteConnections.guard.canLeave() && validate();
    if (!current()) return false;
    const ticket = writerDepartures.capture({ release, select: tag => !skip?.(tag), current });
    if (!ticket) return false;
    let committed = false;
    try {
      return await pageDepartureOwner.request(() => {
        if (!current() || !ticket.canCommit()) return;
        ticket.finish();
        desktopWriterCommitDepth++;
        try { commit(); committed = true; }
        finally { desktopWriterCommitDepth--; }
      }, current, async () => await ticket.prepare() && current() && await ticket.release() && ticket.canCommit());
    } finally {
      if (!committed) { ticket.cancel(); if (ticket.status().failClosed) report(new Error(t('common.unavailable'))); }
    }
  }
  const pageDeparture = { ...pageDepartureOwner, request: (commit: () => void, validate?: () => boolean) => requestWriterDeparture(commit, validate) };
  let scheduledCardSelection: { authority: string | null; item: Row } | undefined, assistantCardSelection: { authority: string | null; id: string } | undefined;
  const takeScheduledCard = () => {
    const seed = scheduledCardSelection; scheduledCardSelection = undefined;
    return seed?.authority === desktopHostIdentity() ? seed?.item : undefined;
  };
  const openScheduledCard = async (item: Row, current: () => boolean) => {
    const before = nav.routes(), authority = desktopHostIdentity(), projectID = text(item.projectId), taskID = text(record(item.task).id);
    const rows = desktopContactCatalog().tasks;
    const listed = rows.some(row => row.projectId === projectID && record(row.task).id === taskID);
    const latest = () => {
      const currentRows = desktopContactCatalog().tasks;
      return currentRows.find(row => row.projectId === projectID && record(row.task).id === taskID)
        ?? (!listed && currentRows === rows ? item : undefined);
    };
    const valid = () => current() && authority === desktopHostIdentity() && nav.routes() === before && !!latest()
      && !desktopInteractionBlocked() && !desktopGitDialogOpen() && lifecycle() === 'active';
    if (!valid()) return false;
    return requestWriterDeparture(() => {
      const actual = latest(); if (!actual) return;
      scheduledCardSelection = { authority, item: actual };
      desktopScheduledCardGeneration.set(desktopScheduledCardGeneration() + 1);
      app.tab.set(2); nav.popToRoot();
    }, valid, () => true);
  };
  const takeAssistantCard = () => {
    const seed = assistantCardSelection; assistantCardSelection = undefined;
    return seed?.authority === desktopHostIdentity() ? seed?.id : undefined;
  };
  const openAssistantCard = async (assistantID: string, current: () => boolean) => {
    if (!current()) return false;
    if (app.tab() === 1 && nav.routes().length === 1 && desktopSelectAssistantContact) return desktopSelectAssistantContact(assistantID, current);
    const before = nav.routes(), authority = desktopHostIdentity();
    const valid = () => current() && authority === desktopHostIdentity() && nav.routes() === before
      && desktopContactCatalog().assistants.some(bot => bot.id === assistantID)
      && !desktopInteractionBlocked() && !desktopGitDialogOpen() && lifecycle() === 'active';
    if (!valid()) return false;
    return requestWriterDeparture(() => {
      assistantCardSelection = { authority, id: assistantID };
      desktopAssistantCardGeneration.set(desktopAssistantCardGeneration() + 1);
      app.tab.set(1); nav.popToRoot();
    }, valid, () => true);
  };
  desktopOpenScheduledCard = openScheduledCard; desktopTakeScheduledCard = takeScheduledCard;
  desktopOpenAssistantCard = openAssistantCard; desktopTakeAssistantCard = takeAssistantCard;
  cleanup(() => {
    scheduledCardSelection = undefined; assistantCardSelection = undefined;
    if (desktopOpenScheduledCard === openScheduledCard) desktopOpenScheduledCard = undefined;
    if (desktopTakeScheduledCard === takeScheduledCard) desktopTakeScheduledCard = undefined;
    if (desktopOpenAssistantCard === openAssistantCard) desktopOpenAssistantCard = undefined;
    if (desktopTakeAssistantCard === takeAssistantCard) desktopTakeAssistantCard = undefined;
  });
  const requestConversationChange = (commit: () => void, current: () => boolean) => requestWriterDeparture(commit, current, tag => tag.inline);
  desktopRequestConversationChange = requestConversationChange;
  cleanup(() => { if (desktopRequestConversationChange === requestConversationChange) desktopRequestConversationChange = undefined; });
  const guardedNavigation = (commit: () => void, before: readonly Route[], after: readonly Route[], retireInline = false) => {
    const removed = new Set(before.filter(route => !after.includes(route)));
    const handoff = after.at(-1)?.kind === 'chat' ? (after.at(-1) as Extract<Route, { kind: 'chat' }>).handoff : undefined;
    const transfer = (tag: DesktopWriterGuardTag) => !!handoff && tag.owner === handoff.owner && handoff.owner.phase() === 'installed'
      && handoff.desktopWriter === handoff.owner.desktopWriter() && !!handoff.desktopWriter?.grant();
    return requestWriterDeparture(commit, () => nav.routes() === before,
      tag => removed.has(tag.route) || tag.inline && (retireInline || after.some(route => route.kind === 'chat' && tag.route.kind === 'chat'
        && route.target.kind === tag.route.target.kind && route.target.id === tag.route.target.id && route.target.directory === tag.route.target.directory)), transfer);
  };
  desktopGuardedNavigation = guardedNavigation;
  desktopPageDeparture = pageDeparture;
  cleanup(() => { if (desktopPageDeparture === pageDeparture) desktopPageDeparture = undefined; if (desktopGuardedNavigation === guardedNavigation) desktopGuardedNavigation = undefined; pageDeparture.dispose(); });
  let draftPersistenceGrant: { route: Route; authority: string } | undefined;
  const persistNavigation = (captured: ReturnType<typeof navigation.captureAuthority>) => {
    const route = nav.routes().at(-1);
    if (!captured || !route) return;
    if (route.kind !== 'root' && desktopRouteAuthorities.get(route) !== desktopHostIdentity()) return;
    if (route.kind === 'root' && (app.tab() === 1 || app.tab() === 2)) {
      navigation.save({ kind: 'home', section: app.tab() === 1 ? 'assistants' : 'schedules' }, captured);
      return;
    }
    if (route.kind === 'root' || route.kind === 'new-session') {
      const owner = desktopDraftOwners().findLast(owner => owner.current() && owner.draftAuthorityKey === desktopHostIdentity());
      if (owner) {
        navigation.save({ kind: 'new-session', directory: owner.directory, ...(owner.project.id ? { projectID: owner.project.id } : {}) }, captured);
        return;
      }
    }
    navigation.saveRoute(route, captured, routeDirectory(route));
  };
  const navigationIntent = () => {
    const route = nav.routes().at(-1), authority = desktopHostIdentity();
    if (!route || draftPersistenceGrant?.route === route && draftPersistenceGrant.authority === authority) return;
    navigation.userNavigated();
    draftPersistenceGrant = { route, authority };
    persistNavigation(navigation.captureAuthority());
  };
  const mutateNavigation = (apply: () => void) => {
    navigation.userNavigated();
    const captured = navigation.captureAuthority(), authority = desktopHostIdentity(), previousRoutes = nav.routes();
    rawNavigationDepth++;
    try {
      apply(); programmaticTop = nav.routes().at(-1);
      for (const route of nav.routes()) if (!previousRoutes.includes(route)) desktopRouteAuthorities.set(route, authority);
    }
    finally { rawNavigationDepth--; }
    const route = nav.routes().at(-1);
    draftPersistenceGrant = route ? { route, authority: desktopHostIdentity() } : undefined;
    persistNavigation(captured);
  };
  let observedTop = nav.routes().at(-1), observedAuthority = desktopHostIdentity();
  effect(() => {
    const top = nav.routes().at(-1), authority = desktopHostIdentity();
    const changed = observedTop !== top, sameAuthority = observedAuthority === authority;
    observedTop = top; observedAuthority = authority;
    if (!changed || !sameAuthority || rawNavigationDepth || top === programmaticTop) return;
    // NSH's native Back removes an entry directly; it does not call our JS methods.
    untracked(() => { navigation.userNavigated(); persistNavigation(navigation.captureAuthority()); });
  });
  const directoryChanged = (route: Route, directory: string) => {
    if (rawNavigationDepth || nav.routes().at(-1) !== route || app.tab() !== 0) return;
    // A grant belongs to this route and stable authority, not the previous Host's restore state.
    if (draftPersistenceGrant?.route !== route || draftPersistenceGrant.authority !== desktopHostIdentity()) return;
    persistNavigation(navigation.captureAuthority());
  };
  const draftOwnerChanged = () => {
    const route = nav.routes().at(-1);
    if (route) directoryChanged(route, routeDirectory(route) ?? '');
  };
  const resetNavigation = () => {
    draftPersistenceGrant = undefined;
    programmaticTop = nav.routes()[0];
    rawNavigationDepth++;
    try { rawNavigation.popToRoot(); }
    finally { rawNavigationDepth--; }
  };
  desktopSystemNavigationReset = resetNavigation;
  desktopNavigationMutation = mutateNavigation; desktopDirectoryChanged = directoryChanged; desktopNavigationIntent = navigationIntent;
  desktopDraftOwnerChanged = draftOwnerChanged;
  cleanup(() => {
    if (desktopNavigationMutation === mutateNavigation) desktopNavigationMutation = undefined;
    if (desktopDirectoryChanged === directoryChanged) desktopDirectoryChanged = undefined;
    if (desktopNavigationIntent === navigationIntent) desktopNavigationIntent = undefined;
    if (desktopDraftOwnerChanged === draftOwnerChanged) desktopDraftOwnerChanged = undefined;
    if (desktopSystemNavigationReset === resetNavigation) desktopSystemNavigationReset = undefined;
  });
  let closeWriterTicket: ReturnType<typeof writerDepartures.capture>;
  const cancelCloseWriters = () => { closeWriterTicket?.cancel(); closeWriterTicket = null; };
  const windowClose = createDesktopWindowCloseOwner({
    scope: () => JSON.stringify([epoch(), desktopHostIdentity(), lifecycle()]),
    requestFiles: async () => !desktopGitDialogOpen() && await tabs.requestWindowClose(),
    requestSettings: async () => {
      if (contactDownloadModals().size > 0 || !github.canClose() || !update.canClose() || !remoteConnections.guard.canWindowClose() || !await pageDeparture.requestClose() || !await settingsRoot.requestWindowClose()) return false;
      closeWriterTicket = writerDepartures.capture();
      return !!closeWriterTicket && await closeWriterTicket.prepare() && await navigation.flush() && await panelMetadata.flush() && await layout.flush() && await diffPreferences.flush();
    },
    canCloseFiles: () => contactDownloadModals().size === 0 && !!closeWriterTicket?.canClose() && github.canClose() && update.canClose() && remoteConnections.guard.canWindowClose() && pageDeparture.canClose() && tabs.canWindowClose() && layout.canClose() && diffPreferences.canClose() && panelMetadataState().hydrated && !panelMetadataState().error && !panelMetadataState().pending,
    decide: async decision => {
      try {
        const accepted = await native('desktop.window.closeDecision', decision);
        if (!decision.approved || accepted !== true) cancelCloseWriters();
        return accepted;
      } catch (error) { cancelCloseWriters(); throw error; }
    },
    onCommitting: value => { closeCommitting.set(value); if (!value) cancelCloseWriters(); },
    onError: report,
  });
  cleanup(host.on('desktop.window.closeRequested', value => { void windowClose.request(value); }));
  cleanup(windowClose.dispose);
  const switcher = () => {
    if (helpOpen() || settingsRoot.isOpen() || closeCommitting() || !app.connection() || lifecycle() !== 'active') return;
    if (sessionSwitcher()) dismissSwitcher();
    else { dismissPalette(); sessionSwitcher.set({ scope: `${paletteScope()}:${++switcherGeneration}`, route: nav.routes().at(-1), authority: paletteScope() }); }
  };
  desktopOpenSessionSwitcher = switcher;
  cleanup(() => { if (desktopOpenSessionSwitcher === switcher) desktopOpenSessionSwitcher = undefined; });
  const togglePanel = () => { if (!desktopInteractionBlocked() && scope()) layout.togglePanel(); };
  const toggleTerminal = () => { if (!desktopInteractionBlocked() && scope()) layout.toggleTerminal(); };
  const toggleSidebar = () => { if (!desktopInteractionBlocked()) layout.toggleSidebar(); };
  const headerRegistration = () => { const value = desktopChatHeader(); return value?.route === nav.routes().at(-1) ? value : null; };
  const headerRouteKeys = new WeakMap<Route, number>();
  let headerRouteSerial = 0;
  const headerScope = computed(() => {
    const route = nav.routes().at(-1);
    if (route && !headerRouteKeys.has(route)) headerRouteKeys.set(route, ++headerRouteSerial);
    return JSON.stringify([epoch(), desktopHostIdentity(), app.runtimeScope()?.lease, routeDirectory(), route ? headerRouteKeys.get(route) : null]);
  });
  const headerCurrent = () => workspaceAlive && lifecycle() === 'active' && !desktopInteractionBlocked() && !desktopGitDialogOpen() && !closeCommitting() && !tabs.modalOpen();
  const openInAppsRevision = signal(0);
  const openInApps = createNativeDesktopOpenInApps({ current: () => workspaceAlive,
    target: () => { const expectedHost = app.runtimeScope(), directory = routeDirectory(); return headerCurrent() && expectedHost && directory ? { scope: headerScope(), expectedHost, directory } : null; },
    changed: () => untracked(() => openInAppsRevision.set(openInAppsRevision() + 1)),
  });
  const openInAppsProjection = () => { openInAppsRevision(); return openInApps.project(); };
  void openInApps.read(); cleanup(openInApps.dispose);
  effect(() => {
    const captured = tourRootOperation(), active = headerCurrent();
    untracked(() => {
      if (githubOperation()?.current()) return;
      githubOperation.set(null);
      if (!captured?.current() || !active) return;
      const current = () => workspaceAlive && githubOperation() === operation && captured.current() && headerCurrent();
      const operation: ReturnType<typeof captureHostOperation> = { ...captured, current,
        async request(path, method, body) {
          if (!current()) throw new Error('page_operation_stale');
          const value = await captured.request(path, method, body);
          if (!current()) throw new Error('page_operation_stale');
          return value;
        },
      };
      githubOperation.set(operation);
    });
  });
  cleanup(() => githubOperation.set(null));
  effect(() => {
    const directory = routeDirectory(), host = app.runtimeScope(), authority = desktopHostIdentity(), active = headerCurrent(); githubOperation();
    untracked(() => { github.reconcile(); if (directory && host && authority && active) void github.header.ensure(); });
  });
  const headerNavigationWindow = {};
  let headerExternalRevision = 0, headerExternalBlocked = false;
  const headerExternalModal = () => settingsRoot.isOpen() || !!palette() || !!sessionSwitcher() || helpOpen() || closeCommitting()
    || contactDownloadModals().size > 0 || !!desktopTimelineOwner() || desktopGitDialogOpen() || lifecycle() !== 'active';
  effect(() => {
    const blocked = headerExternalModal();
    if (blocked && !headerExternalBlocked) headerExternalRevision++;
    headerExternalBlocked = blocked;
  });
  const sameHeaderTarget = (target: { id: string; url: string; authorizationID?: string }) => {
    const selected = app.connection();
    return selected?.id === target.id && selected.url === target.url && selected.authorizationID === target.authorizationID;
  };
  const headerNavigation = createDesktopHeaderNavigation({
    canStart: () => headerCurrent() && app.runtimeScope() !== null && github.canClose() && update.canClose() && remoteConnections.guard.canLeave(),
    capture: () => {
      const external = headerExternalRevision;
      return { window: headerNavigationWindow, route: nav.routes().at(-1) ?? null, runtimeScope: app.runtimeScope(),
        connection: app.connection(), connections: app.connections(), generation: epoch(),
        valid: () => workspaceAlive && external === headerExternalRevision && !headerExternalModal() && github.canClose() && update.canClose() && remoteConnections.guard.canLeave() };
    },
    files: { async request() { await tabs.ready; return await tabs.requestWindowClose(); }, canLeave: tabs.canWindowClose },
    departure: { request: (commit, validate, action) => requestWriterDeparture(commit, validate, action === 'switch' ? () => true : () => false) },
    switch: { async commit(target, ticket) {
      if (!ticket.current()) return { status: 'stale' };
      try { await switchConnection(target.id); }
      catch { return { status: sameHeaderTarget(target) ? 'accepted' : 'unknown' }; }
      return { status: sameHeaderTarget(target) ? 'accepted' : 'unknown' };
    } },
    add: { async commit(ticket) {
      if (!ticket.current()) return { status: 'stale' };
      return { status: await settingsRoot.open({ page: 'instances', directory: routeDirectory() }) ? 'accepted' : 'failed' };
    } },
  });
  cleanup(headerNavigation.dispose);
  const headerInstances = createDesktopHeaderInstancesRoot({ current: () => workspaceAlive, remote: remoteConnections.header,
    switch: { available: () => headerCurrent() && !headerNavigation.pending() && github.canClose() && update.canClose() && remoteConnections.guard.canLeave(), run: headerNavigation.switch },
    add: { available: () => headerCurrent() && !headerNavigation.pending() && github.canClose() && update.canClose() && remoteConnections.guard.canLeave(), run: headerNavigation.add } });
  const activePanelTab = () => { const selected = scope(); return selected && layout.state().panelOpen ? tabs.snapshot(selected).tabs.find(tab => tab.id === tabs.snapshot(selected).selectedID) : undefined; };
  const workStatus = createNativeDesktopChatWorkStatusWindow(() => {
    const selected = scope(), snapshot = selected ? tabs.snapshot(selected) : null;
    return { windowWidth: windowSize().width, desktop: true, active: workspaceAlive && lifecycle() === 'active', expandedInput: false,
      hasSession: retainedChatRoute()?.target.kind === 'session', draftConversation: false,
      previewOpen: layout.state().panelOpen && !!snapshot && activePanelTab()?.kind !== 'chat',
      rightSidebarOpen: layout.state().panelOpen && !!snapshot?.rail };
  });
  desktopWorkStatusWindow.set(workStatus);
  cleanup(() => { if (desktopWorkStatusWindow() === workStatus) desktopWorkStatusWindow.set(null); });
  const headerActions: DesktopChatHeaderActions = {
    ...openInApps.actions,
    'work-status': { get available() { return headerCurrent() && !!scope(); }, run(intent) {
      if (!intent.current() || !headerCurrent() || !scope()) return { status: 'stale' };
      workStatus.toggle(); return { status: 'accepted' };
    } },
    terminal: { get available() { return headerCurrent() && !!scope(); }, run(intent) {
      if (!intent.current() || !headerCurrent() || !scope()) return { status: 'stale' };
      layout.toggleTerminal(); return { status: 'accepted' };
    } },
    'toggle-panel': { get available() { return headerCurrent() && !!scope(); }, run(intent) {
      if (!intent.current() || !headerCurrent() || !scope()) return { status: 'stale' };
      layout.togglePanel(); return { status: 'accepted' };
    } },
    context: { get available() { return headerCurrent() && !!scope()?.sessionID; }, run(intent) {
      const selected = scope();
      if (!intent.current() || !headerCurrent() || !selected?.sessionID) return { status: 'stale' };
      if (activePanelTab()?.kind === 'context') layout.set({ panelOpen: false });
      else { if (!tabs.open(selected, { kind: 'context' })) return { status: 'failed' }; layout.set({ panelOpen: true }); }
      return { status: 'accepted' };
    } },
    browser: { get available() { return headerCurrent() && !!scope(); }, run(intent) {
      const selected = scope();
      if (!intent.current() || !headerCurrent() || !selected) return { status: 'stale' };
      if (activePanelTab()?.kind === 'browser') { layout.set({ panelOpen: false }); return { status: 'accepted' }; }
      const browser = tabs.snapshot(selected).tabs.findLast(tab => tab.kind === 'browser');
      const id = browser?.id ?? tabs.open(selected, { kind: 'browser', url: '' });
      if (!id) return { status: 'failed' };
      tabs.select(selected, id);
      if (tabs.snapshot(selected).selectedID !== id) return { status: 'failed' };
      layout.set({ panelOpen: true }); return { status: 'accepted' };
    } },
    'copy-path': { get available() { return headerCurrent() && !!scope(); }, async run(intent) {
      const selected = scope();
      if (!intent.current() || !headerCurrent() || !selected) return { status: 'stale' };
      try { await Clipboard.writeText(selected.directory); }
      catch { return { status: intent.current() ? 'failed' : 'stale' }; }
      return { status: intent.current() && headerCurrent() ? 'accepted' : 'stale' };
    } },
    'refresh-usage': { get available() { return headerCurrent() && !!headerRegistration()?.refreshUsage; }, async run(intent) {
      const registration = headerRegistration();
      if (!intent.current() || !headerCurrent() || !registration?.refreshUsage) return { status: 'stale' };
      const result = await registration.refreshUsage();
      return intent.current() && headerCurrent() && headerRegistration() === registration ? result : { status: 'stale' };
    } },
  };
  const closeTab = () => {
    if (helpOpen()) { dismissHelp(); return; }
    if (sessionSwitcher()) { dismissSwitcher(); return; }
    if (palette()) { dismissPalette(); return; }
    if (settingsRoot.isOpen()) { void settingsRoot.close(); return; }
    const top = nav.routes().at(-1);
    if (top && !['root', 'chat', 'new-session'].includes(top.kind)) { nav.pop(); return; }
    const current = scope(), selected = current ? tabs.snapshot(current).selectedID : null;
    if (layout.state().panelOpen) {
      if (current && selected) tabs.close(current, selected);
      else layout.set({ panelOpen: false });
      return;
    }
    if (desktopWindowAvailable) void tabs.requestWindowClose().then(approved => { if (approved && tabs.canWindowClose()) Window.close(); }).catch(report);
  };
  const sidebarActions = signal<DesktopSidebarActions | null>(null);
  const terminalShortcuts = signal<NativeDesktopTerminalShortcutOwner | null>(null);
  const publishTerminalShortcuts: NativeDesktopTerminalShortcutPublisher = registration => {
    if (registration.type === 'register') terminalShortcuts.set(registration.owner);
    else if (terminalShortcuts() === registration.owner) terminalShortcuts.set(null);
  };
  const sidebarActionsRef: DesktopSidebarActionsRef = { current: null, set: value => sidebarActions.set(value) };
  const switcherSource: DesktopSwitcherSource = {
    snapshot: () => sidebarActions()?.switcherSource.snapshot() ?? { sessions: [], projects: [], pinnedSessionIDs: [], ready: false, loading: false, error: t('common.unavailable') },
    status: row => sidebarActions()?.switcherSource.status?.(row) ?? null,
    retry: async () => { await sidebarActions()?.switcherSource.retry?.(); },
  };
  desktopContactCardSource.set(switcherSource);
  cleanup(() => { if (desktopContactCardSource() === switcherSource) desktopContactCardSource.set(null); });
  const menuKeystrokes = signal<readonly string[]>([]);
  const selectRail = (rail: 'git' | 'files') => {
    const selected = scope();
    if (!selected || settingsRoot.isOpen() || palette()) return;
    tabs.setRail(selected, rail); layout.set({ panelOpen: true });
  };
  const shortcutActions = computed((): NativeShortcutActions => ({
    new_chat: { run: () => newSession(), enabled: !!app.connection() },
    open_command_palette: { run: search, enabled: !!app.connection() },
    open_settings: { run: settings },
    open_help: { run: help },
    toggle_sidebar: { run: toggleSidebar },
    toggle_right_sidebar: { run: togglePanel, enabled: !!scope() },
    toggle_terminal: { run: toggleTerminal, enabled: !!scope() },
    toggle_bottom_panel: { run: toggleTerminal, enabled: !!scope() },
    toggle_terminal_expanded: { run: () => { if (scope()) layout.set({ terminalOpen: true, terminalExpanded: !layout.state().terminalExpanded }); }, enabled: !!scope() },
    close_context_panel_tab: { run: closeTab },
    open_right_sidebar_git: { run: () => selectRail('git'), enabled: !!scope() },
    open_right_sidebar_files: { run: () => selectRail('files'), enabled: !!scope() },
    cycle_right_sidebar_tab: { run: () => { const selected = scope(); if (selected) selectRail(tabs.snapshot(selected).rail === 'git' ? 'files' : 'git'); }, enabled: !!scope() },
    previous_session: { run: () => { sidebarActions()?.adjacent(-1); }, enabled: !!sidebarActions() },
    next_session: { run: () => { sidebarActions()?.adjacent(1); }, enabled: !!sidebarActions() },
    new_chat_worktree: { run: () => { const directory = routeDirectory(), project = directory ? app.projects().find(project => resourceWithin(directory, project.path)) : undefined; if (project) projectsNavigation.onNewWorktree?.(project); }, enabled: !!scope() && app.projects().some(project => resourceWithin(scope()!.directory, project.path)) },
    ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`switch_tab_${index + 1}`, { run: () => { sidebarActions()?.numbered(index + 1); }, enabled: !!sidebarActions() }])),
    ...(terminalShortcuts()?.focused() ? { focus_input: desktopComposerShortcuts()?.actions.focus_input } : desktopComposerShortcuts()?.actions ?? {}),
    ...(terminalShortcuts()?.actions ?? {}),
  }));
  const shortcuts = installNativeDesktopShortcuts({ actions: shortcutActions, enabled: () => lifecycle() === 'active' && !closeCommitting() && !desktopGitDialogOpen(),
    settingsOpen: settingsRoot.isOpen, settingsAllowedActions: () => ['open_settings', 'close_context_panel_tab'],
    blockingOverlay: () => !!palette() || !!sessionSwitcher() || helpOpen(), capture: shortcutCapture, menuOwnedKeystrokes: menuKeystrokes,
    composing: () => terminalShortcuts()?.focused() ? terminalShortcuts()?.composing() === true : desktopComposerShortcuts()?.current() === true && desktopComposerShortcuts()?.composing() === true,
    chatActive: () => !terminalShortcuts()?.focused() && desktopComposerShortcuts()?.current() === true,
    scope: () => JSON.stringify([epoch(), desktopHostIdentity(), nav.routes().at(-1)?.kind, retainedChatRoute()?.target.id, routeDirectory()]),
    onError: (_action, cause) => report(cause),
  });
  effect(() => {
    const owner = terminalShortcuts(), bindings = shortcuts.bindings();
    if (!owner) return;
    untracked(() => owner.setKeyboardRouting(bindings, shortcuts.dispatchBinding));
    cleanup(() => owner.setKeyboardRouting([], shortcuts.dispatchBinding));
  });
  const menu = installNativeDesktopMenu(() => ({ newSession: { run: () => shortcuts.execute('new_chat'), disabled: settingsRoot.isOpen() || !app.connection() }, search: { run: () => shortcuts.execute('open_command_palette'), disabled: settingsRoot.isOpen() || !app.connection() },
    switchSession: { run: switcher, disabled: settingsRoot.isOpen() || !app.connection() }, settings: { run: () => shortcuts.execute('open_settings') },
    toggleSidebar: { run: () => shortcuts.execute('toggle_sidebar'), disabled: settingsRoot.isOpen() }, togglePanel: { run: () => shortcuts.execute('toggle_right_sidebar'), disabled: settingsRoot.isOpen() || !scope() },
    toggleTerminal: { run: () => shortcuts.execute('toggle_terminal'), disabled: settingsRoot.isOpen() || !scope() }, closeTab: { run: () => shortcuts.execute('close_context_panel_tab') } }),
    { userOverrides: shortcuts.userOverrides, ready: () => shortcuts.ready() && !shortcutCapture() });
  effect(() => menuKeystrokes.set(menu.ownedKeystrokes()));
  const panelCurrent = (expected: DesktopPanelScope) => {
    const selected = scope();
    return !!selected && selected.host.hostID === expected.host.hostID && selected.host.lease === expected.host.lease
      && selected.authorityKey === expected.authorityKey && selected.sessionID === expected.sessionID && selected.directory === expected.directory;
  };
  const btw = createDesktopBtwWorkbench({ grant: httpGrant, runtime: () => ({ transport: desktopHostIdentity(), generation: epoch() }), runtimeScope: app.runtimeScope, scope,
    current: expected => workspaceAlive && panelCurrent(expected),
    interactive: () => panelMetadataState().hydrated && lifecycle() === 'active' && !desktopInteractionBlocked() && !desktopGitDialogOpen() && !closeCommitting() && !tabs.modalOpen(),
    selection: expected => {
      mountedChatRevision();
      const route = retainedChatRoute();
      return route?.target.kind === 'session' && route.target.id === expected.sessionId && route.target.directory === expected.directory ? desktopBtwSelections.get(route)?.() ?? null : null;
    },
    open: expected => openPanel(expected.directory, { kind: 'btw', sessionID: expected.sessionID! }),
    present: expected => layout.state().panelOpen && tabs.snapshot(expected).tabs.some(tab => tab.kind === 'btw' && tab.sessionID === expected.sessionID),
    onIssue: () => report(new Error(t('common.unavailable'))),
  });
  effect(() => { const available = btw.available() && panelMetadataState().hydrated; desktopBtwAction.set(available ? btw.action : undefined); });
  effect(() => { scope(); epoch(); desktopHostIdentity(); desktopInteractionBlocked(); lifecycle(); layout.state().panelOpen; const selected = scope(); if (selected) tabs.snapshot(selected); untracked(btw.reconcile); });
  cleanup(() => { if (desktopBtwAction() === btw.action) desktopBtwAction.set(undefined); btw.dispose(); });
  const openTerminalPreview = createDesktopTerminalPreview({ scope,
    active: () => lifecycle() === 'active' && layout.state().terminalOpen && !desktopInteractionBlocked() && !desktopGitDialogOpen() && !closeCommitting(),
    openPanel: (expected, url) => panelCurrent(expected) && openPanel(expected.directory, { kind: 'browser', url }),
    openExternal: openUrl,
  });
  const resolveWithAgent = async (request: DesktopGitAgentRequest) => {
    if (!panelCurrent(request.scope) || desktopInteractionBlocked() || closeCommitting() || desktopGitDialogOpen()) return;
    const input = desktopGitContextInput(request), captured = captureHostOperation();
    const current = () => captured.current() && panelCurrent(request.scope) && !desktopInteractionBlocked() && !closeCommitting();
    if (request.target === 'new') {
      desktopNavigationIntent?.();
      const routes = nav.routes(), index = routes.findLastIndex(route => (route.kind === 'root' || route.kind === 'new-session') && routeDirectory(route) === input.directory);
      if (index >= 0) {
        if (index !== routes.length - 1 || app.tab() !== 0) {
          const after = routes.slice(0, index + 1);
          if (!await guardedNavigation(() => { app.tab.set(0); nav.setRoutes(after); }, routes, after, true) || !captured.current()) return;
        }
        const owner = desktopDraftOwners().findLast(owner => owner.current() && owner.directory === input.directory && owner.draftAuthorityKey === input.authorityKey);
        if (!owner) throw new Error(t('chat.gitContext.stagingFailed'));
        await stageDesktopGitContext(owner, input, () => captured.current() && owner.current());
      } else {
        const route: Route = { kind: 'new-session', directory: input.directory, initialContext: input };
        await guardedNavigation(() => { app.tab.set(0); nav.push(route); }, routes, [...routes, route], true);
      }
      return;
    }
    const route = retainedChatRoute(), chat = route ? mountedChats.get(route) : undefined;
    if (!route || !chat || route.target.kind !== 'session' || route.target.id !== input.sessionID || !current()) throw new Error(t('chat.gitContext.stagingFailed'));
    if (!await stageDesktopGitContext(chat, input, current)) return;
    if (request.kind !== 'conflict' && request.kind !== 'integration') {
      if (!current() || !await desktopChatSubmitters.get(route)?.()) throw new Error(t('gitView.pr.toast.sendMessageFailed'));
    }
  };
  const panelScopes = computed(() => { const value = scope(); return value && panelMetadataState().hydrated ? [value] : []; });
  const sidebarSection = computed(() => {
    if (settingsRoot.isOpen()) return 'settings';
    const route = nav.routes().at(-1);
    if (route?.kind === 'connect' || route?.kind === 'connection-editor') return 'connections';
    if (route?.kind === 'chat') return route.target.kind === 'assistant' ? 'assistants' : 'chat';
    return app.tab() === 1 ? 'assistants' : app.tab() === 2 ? 'schedules' : 'chat';
  });
  const terminalScopes = computed(() => { const value = app.runtimeScope(); return value ? [value] : []; });
  return <View class="flex-1 min-h-0 min-w-0" disabled={closeCommitting() || desktopGitDialogOpen()}><NativeDesktopWorkspace layout={layout} panelAvailable={!!scope()} terminalAvailable={!!scope()}
    titlebar={<NativeDesktopTitleBar title={retainedChatRoute()?.target.title ?? 'Yuri'} height={48} menu={menu}
      leadingWidth={layout.state().sidebarOpen ? layout.state().sidebarWidth : undefined}
      leading={<View class="flex-row flex-1 min-w-0 items-center" style={{ justifyContent: layout.state().sidebarOpen ? 'space-between' : 'flex-start' }}>
        <If when={layout.state().sidebarOpen}><View class="flex-row min-w-0 items-center" style={{ gap: 4, flexShrink: 1 }}><YuriMark size="compact" decorative /><YuriWordmark size="compact" /></View></If>
        <View class="flex-row items-center" style={{ gap: 4, flexShrink: 0 }}>
          <Button testID="desktop-global-search" class="size-7 rounded-md items-center justify-center hover:bg-accent" accessibilityLabel={t('mobile.sessions.searchAria')} onPress={search}><Icon name="search" size={16} /></Button>
          <Button testID="desktop-sidebar-toggle" class="size-7 rounded-md items-center justify-center hover:bg-accent" accessibilityLabel={t('helpDialog.item.toggleSessionSidebar')} onPress={toggleSidebar}><Icon name="layout-left-rounded" size={16} /></Button>
        </View>
      </View>}
      heading={<View ref={node => switcherAnchor.set(node)}><Button testID="desktop-session-title" class="min-h-8 max-w-full px-2 rounded-md hover:bg-accent" accessibilityLabel={t('sessions.switcher.openAria')} disabled={!app.connection() || settingsRoot.isOpen()} onPress={switcher}>
        <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{retainedChatRoute()?.target.title ?? (routeDirectory() ? t('sessions.switcher.draftTitle') : 'Yuri')}</Text>
      </Button></View>}>
      <NativeDesktopRuntimeHeader scope={headerScope()} directory={routeDirectory() ?? undefined} instances={headerInstances} githubPort={github.header} update={update.port} openInApps={openInAppsProjection()}
        current={() => workspaceAlive && !!app.connection()} active={headerCurrent()} metadata={headerRegistration()?.metadata?.()}
        sessionTitle={retainedChatRoute()?.target.title ?? t('sessions.switcher.draftTitle')}
        status={{ workStatusSelected: workStatus.layout().selected, panelOpen: layout.state().panelOpen, contextOpen: activePanelTab()?.kind === 'context', browserOpen: activePanelTab()?.kind === 'browser' }}
        workStatusRef={workStatus.toggleRef} onWorkStatusLayout={() => { void workStatus.measureToggle(); }}
        actions={headerActions} host={{ label: app.connection()?.label || t('common.unavailable') }}
        onResult={(_action, result) => { if (headerCurrent() && !['accepted', 'stale'].includes(result.status)) report(new Error(t('common.unavailable'))); }} />
    </NativeDesktopTitleBar>}
    sidebar={<DesktopSidebar authority={desktopSidebarAuthority()} active={lifecycle() === 'active'} interactive={!desktopInteractionBlocked() && !desktopGitDialogOpen()} visible={layout.state().sidebarOpen} actionsRef={sidebarActionsRef} selectedTarget={retainedChatRoute()?.target} selectedSection={sidebarSection()} navigation={{ ...projectsNavigation,
      onOpenFiles: directory => { if (!openPanel(directory)) { openNewSession(undefined, directory); openPanel(directory); } },
    }} onNewSession={newSession} onNewSessionInFolder={(project, folder) => { if (!desktopInteractionBlocked() && !closeCommitting() && lifecycle() === 'active') openNewSession(project, project.path, folder); }} onAssistants={() => { void requestWriterDeparture(() => { app.tab.set(1); nav.popToRoot(); }, () => true, () => true); }} onSchedules={() => { void requestWriterDeparture(() => { app.tab.set(2); nav.popToRoot(); }, () => true, () => true); }}
      onSettings={settings} onConnections={() => nav.push({ kind: 'connect' })} onShortcuts={help} onSearch={search} onSessionSwitcher={switcher} />}
    terminal={<Each of={terminalScopes()} key={host => JSON.stringify([host.hostID, host.lease])}>{host => <NativeDesktopTerminalDock scope={host()} directory={routeDirectory() ?? ''}
      current={() => sameRuntimeScope(host(), app.runtimeScope())} active={layout.state().terminalOpen && !!scope() && !desktopInteractionBlocked()}
      onDesktopShortcuts={publishTerminalShortcuts}
      onOpenPreview={openTerminalPreview}
      expanded={layout.state().terminalExpanded} onToggleExpanded={() => layout.set({ terminalExpanded: !layout.state().terminalExpanded })}
      onClose={() => layout.set({ terminalOpen: false })} />}</Each>}
    panel={<Each of={panelScopes()} key={value => JSON.stringify([value.host.hostID, value.host.lease, value.authorityKey, value.sessionID, value.directory])}>{value => <NativeDesktopPanel scope={value()} tabs={tabs} diffPreferences={diffPreferences}
       menuOwnedKeystrokes={menu.ownedKeystrokes()}
       current={() => panelCurrent(value())} active={layout.state().panelOpen}
        modalOpen={desktopInteractionBlocked() || desktopGitDialogOpen()} onResolveWithAgent={resolveWithAgent}
        btw={context => <If when={!!httpGrant()} else={<Text class="p-3 text-muted-foreground">{t('common.unavailable')}</Text>}><Each of={httpGrant() ? [httpGrant()!] : []} key={grant => grant.windowID}>{() => <DesktopBtwPanelContent workbench={btw} context={context} close={() => { if (context.current()) void tabs.close(context.scope, context.tabID); }} />}</Each></If>}
         panelChat={{ enabled: true, stream: panelStream(),
          onOpenLink: context => openDesktopContentLink(context.href, context.target, () => context.current() && panelCurrent(context.scope)),
         renderCard: (card, surface) => <ResourceCard card={card} readOnly current={surface.current} onOpenSession={target => { if (surface.current()) void surface.navigate({ sessionID: target.id, directory: target.directory, title: target.title }); }} />,
         onOpenFile: context => {
           if (!context.current() || !panelCurrent(context.scope) || context.target.kind !== 'session') return;
            openResourceFile(context.path, context.target.directory, context.targetLine, context.target);
         },
         onOpenDiff: context => {
           if (!context.current() || !panelCurrent(context.scope)) return;
           if (!context.source.path) { report(new Error(t('common.unavailable'))); return; }
           try { tabs.open(context.scope, { kind: 'file-diff', source: { ...context.source, path: context.source.path } }); }
           catch { report(new Error(t('common.unavailable'))); }
         },
       }}
      expanded={layout.state().panelExpanded} onToggleExpanded={() => layout.set({ panelExpanded: !layout.state().panelExpanded })}
      onClose={() => layout.set({ panelOpen: false })}
      context={(expected, active, interactive) => <DesktopContextPanel scope={expected} current={() => panelCurrent(expected)} active={active} interactive={interactive} />} />}</Each>}>
    <NativeDesktopNavigationFeedback controller={navigation} active={!desktopInteractionBlocked() && !desktopGitDialogOpen() && lifecycle() === 'active'} />
    <If when={!!(tabs.journalState().error || tabs.filesError()) && (!scope() || !layout.state().panelOpen)}><View testID="desktop-file-journal-error" class="px-3 py-2 flex-row items-center gap-2">
      <Text role="alert" class="flex-1 text-xs text-destructive">{t('chat.newSessionDraft.operationFailed')}</Text>
      <Button testID="desktop-file-journal-retry" class="min-h-8 px-2 rounded-md bg-secondary" disabled={desktopInteractionBlocked() || lifecycle() !== 'active' || journalRetrying()} onPress={() => {
        if (desktopInteractionBlocked() || lifecycle() !== 'active' || journalRetrying()) return;
        journalRetrying.set(true);
        void (async () => { try { if (await tabs.editors.journal?.retry()) await tabs.restoreOperations(); } finally { journalRetrying.set(false); } })();
      }}><Text>{t('diffView.actions.retry')}</Text></Button>
    </View></If>
    <If when={!!panelMetadataState().error}><View testID="desktop-panel-metadata-error" class="px-3 py-2 flex-row items-center gap-2">
      <Text role="alert" class="flex-1 text-xs text-destructive">{t('chat.newSessionDraft.operationFailed')}</Text>
      <Button testID="desktop-panel-metadata-retry" class="min-h-8 px-2 rounded-md bg-secondary" disabled={desktopInteractionBlocked() || lifecycle() !== 'active' || panelMetadataState().reading || panelMetadataState().writing || panelMetadataState().error === 'conflict' || panelMetadataState().error === 'rollback'} onPress={() => { if (!desktopInteractionBlocked() && lifecycle() === 'active') void panelMetadata.retry(); }}><Text>{t('diffView.actions.retry')}</Text></Button>
    </View></If>
    {props.children}
  </NativeDesktopWorkspace><SettingsRoot />
    <NativeDesktopHelpDialog open={helpOpen()} onClose={dismissHelp}
      scope={JSON.stringify([paletteScope(), nav.routes().at(-1)?.kind, retainedChatRoute()?.target.id, routeDirectory(), app.tab()])}
      active={lifecycle() === 'active' && !settingsRoot.isOpen() && !palette() && !sessionSwitcher() && !closeCommitting()}
      userOverrides={shortcuts.userOverrides()} actions={shortcutActions()} />
    <If when={sessionSwitcher()}>{source => { const presentation = source(); return <NativeDesktopSessionSwitcher open anchor={switcherAnchor()} scope={presentation.scope}
      current={() => presentation.authority === paletteScope() && presentation.route === nav.routes().at(-1)}
      active={lifecycle() === 'active' && !settingsRoot.isOpen() && !palette() && !closeCommitting()} source={switcherSource}
      currentTarget={retainedChatRoute()?.target} onClose={dismissSwitcher} onOpenChat={openChat} onNewSession={() => openNewSession()} />; }}</If>
    <If when={palette()}>{source => { const presentation = source(); return <NativeDesktopCommandPalette open onClose={dismissPalette} scope={presentation.scope}
      active={lifecycle() === 'active' && !settingsRoot.isOpen() && presentation.scope === paletteScope()}
      commands={projectSearchCommands(presentation.directory, dismissPalette)} focusDirectory={presentation.directory} projects={app.projects()}
      onOpenProject={project => { dismissPalette(); openNewSession(project, project.path); }}
      onOpenChat={(target, options) => { dismissPalette(); openChat(target, options); }}
      onOpenFile={(directory, path) => { dismissPalette(); openResourceFile(path, directory); }} />; }}</If>
  </View>;
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
  let changesCurrent = true;
  cleanup(() => { changesCurrent = false; projectChangesHandle.set(null); });
  if (platform.desktop) {
    const owner = {}; let alive = true;
    desktopWriterClientOwner = owner;
    desktopWriterClientReady.set(false);
    void loadNativeDesktopWriterClient({ current: () => alive && desktopWriterClientOwner === owner }).then(client => {
      if (alive && desktopWriterClientOwner === owner) { desktopWriterClient.set(client); desktopWriterClientReady.set(true); }
      else client?.retire();
    });
    cleanup(() => {
      alive = false;
      if (desktopWriterClientOwner !== owner) return;
      desktopWriterClient()?.retire(); desktopWriterClient.set(undefined); desktopWriterClientReady.set(false); desktopWriterClientOwner = undefined;
    });
  }
  let desktopMetadata: DesktopWindowMetadataStorage | null = null;
  if (platform.desktop) {
    try { desktopMetadata = createDesktopWindowMetadataStorage(Storage, desktopWindowMetadataIdentity(host.params)); }
    catch { return <View testID="desktop-window-descriptor-error" class="flex-1 items-center justify-center bg-background"><Text class="text-sm text-destructive">{t('common.unavailable')}</Text></View>; }
  }
  const desktopLayout = desktopMetadata ? createDesktopLayout(desktopMetadata) : null;
  if (!desktopLayout) {
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
  }
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
  const resourceConnectionClear = createResourceConnectionClear<Route>({
    routes: nav.routes,
    setRoutes: routes => rawNavigation.setRoutes(routes),
    popToRoot: () => { if (desktopSystemNavigationReset) desktopSystemNavigationReset(); else rawNavigation.popToRoot(); },
  });
  let previous: string | undefined;
  effect(() => {
    const selected = desktopHostIdentity();
    const changed = previous !== undefined && selected !== previous;
    previous = selected;
    if (changed) untracked(() => resourceConnectionClear.clear());
  });
  return (
    <View class="flex-1 bg-background">
      <Each of={app.connection() ? [app.connection()!] : []} key={connection => JSON.stringify([connection.id, connection.url, connection.authorizationID])}>{() => <NativeSetupTourOwners />}</Each>
      <Each of={app.connection() ? [{ hostID: app.connection()!.id, generation: epoch() }] : []} key={scope => JSON.stringify([scope.hostID, scope.generation])}>{scope => <NativeRetentionRoot hostID={scope().hostID} generation={scope().generation} />}</Each>
      <NativeAppearanceSync />
      <NativeApplicationWorkspace layout={desktopLayout} metadataStorage={desktopMetadata} preferenceCoordination={desktopWindowPreferenceCoordination(host.params)}><View class="flex-1 min-h-0 min-w-0">
      <NativeAppearanceFeedback />
      <NotificationFeedback />
      <NavStack state={nav} class="flex-1">
        {(route) => {
          if (route.kind === "root") return <Home />;
          if (route.kind === "connect") return <Connect link={route.link} edit={route.edit} />;
          if (route.kind === 'connection-editor') return <ConnectionEditorPage route={route} />;
          if (route.kind === "project")
            return <ProjectDetail project={route.project} initialCreateWorktree={route.createWorktree} {...projectsNavigation} active={nav.routes().at(-1) === route} />;
            if (route.kind === 'project-directory') return <ProjectDirectoryPage onAdded={(project, options) => { if (!options.openDraft) return; if (platform.desktop) openNewSession(project); else nav.replace({ kind: 'new-session', project }); }} />;
               if (route.kind === 'new-session') return <NativeNewSessionPage project={route.project} directory={route.directory} deviceChatPreferences={deviceChatPreferences} desktopWriter={platform.desktop ? desktopWriterClient : undefined} active={nav.routes().at(-1) === route && !desktopInteractionBlocked()} onDesktopShortcuts={platform.desktop ? publishDesktopComposerShortcuts : undefined} onDesktopOwner={platform.desktop ? publishDesktopDraftOwner : undefined} onRetainedOwner={platform.desktop ? owner => retainDesktopDraftOwner(route, owner) : undefined} onWriterAdmissionGuard={platform.desktop ? guard => retainDesktopDraftAdmission(route, guard) : undefined} initialContext={route.initialContext} initialFolder={route.initialFolder} onUserIntent={() => desktopNavigationIntent?.()} onSelection={(directory, selection, agent) => { if (platform.desktop) publishDesktopDraftDirectory(route, directory); botCreationContext.update(directory, selection, agent); }} onOpenChat={(target, handoff) => nav.replace({ kind: 'chat', target, handoff })} />;
          if (route.kind === 'remote-desktop') return <NavPage title={t('remoteDesktop.title')} headerVisible={false} class="flex-1 bg-background"><NativeRemoteDesktopPage scopeKey={`${epoch()}:${app.connection()?.id ?? ''}`} active={nav.routes().at(-1) === route} onClose={() => nav.pop()} /></NavPage>;
            if (route.kind === 'project-search') return <ProjectsSearchPage commands={projectSearchCommands(route.directory)} projects={app.projects()} focusDirectory={route.directory} onOpenProject={project => { if (!platform.desktop) nav.pop(); openNewSession(project, project.path); }} onOpenChat={(target, options) => { if (!platform.desktop) nav.pop(); openChat(target, options); }} onOpenFile={(directory, path) => { void run(async () => { const commit = () => { nav.pop(); openResourceFile(path, directory); }; if (desktopPageDeparture) await desktopPageDeparture.request(commit); else commit(); }); }} />;
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
              const absolute = resourceResolve(path, route.directory);
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
      </NavStack></View></NativeApplicationWorkspace>
      <NativeChangesPresentation source={projectChangesSource()} open={!!projectChangesSource()} active={lifecycle() === 'active'} current={() => changesCurrent}
        onHandle={handle => projectChangesHandle.set(handle)} onClose={() => projectChangesSource.set(null)} onBlocked={() => report(new Error(t('common.unavailable')))}
        onOpenPreview={(path, line, source) => { void run(async () => openResourceFile(path, source.directory, line)); }} />
      <NativeDeviceChatPreferences />
      <NativeFeedbackLayer layoutKey={nav.routes().at(-1)}><NativeRootErrorFeedback /><If when={!rootErrorVisible()}>{props.startupFeedback}</If><NativeAppearanceFeedback suppressed={rootErrorVisible() || !!props.startupFeedbackVisible} /></NativeFeedbackLayer>
    </View>
  );
}
