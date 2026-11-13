import React from 'react';
import { WorkspaceSurface } from '@/components/ui/WorkspaceSurface';
import { useEvent, useResizeObserver } from '@reactuses/core';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DiffView } from '@/components/views/DiffView';
import { FilesView } from '@/components/views/FilesView';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { SelectedProjectHostBoundary } from '@/contexts/SelectedProjectHostBoundary';
import { hostApiPath, locationKey, locationSessionKey, parseLocationKey } from '@/lib/remote-projects/location';
import { sessionDraftKey, newSessionDraftKey } from '@/sync/input-draft-types';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { RemoteChatContainer } from '@/components/chat/RemoteChatContainer';
import { useRemoteHostSummaries } from '@/queries/remoteProjectQueries';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { getContextPanelState, useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { markSessionViewed } from '@/sync/notification-store';
import { setContextPanelViewedSession, setExternallyViewedSession, useDirectoryStore } from '@/sync/sync-context';
import { ContextPanelContent } from './ContextSidebarTab';
import { BtwPanel } from './BtwPanel';
import { RightSidebar } from './RightSidebar';
import { RightSidebarTabs, RightSidebarToolbar } from './RightSidebarTabs';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useSessionBtwStore } from '@/stores/useSessionBtwStore';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { Icon } from "@/components/icon/Icon";
import { YuriLogo } from "@/components/ui/YuriLogo";
import { invokeDesktopCommand } from '@/lib/desktopNative';
import {
  EMBEDDED_SESSION_CHAT_CLOSE_TAB_EVENT,
  EMBEDDED_SESSION_CHAT_VISIBILITY_EVENT,
  EMBEDDED_SESSION_CHAT_VISIBILITY_REQUEST_EVENT,
  getOrCreateEmbeddedSessionChatURL,
  type EmbeddedSessionChatURLCacheEntry,
} from './contextPanelEmbeddedChat';
import { ContextPanelSessionTranscript } from './ContextPanelSessionTranscript';
import {
  normalizeBrowserUrl,
  resolveBrowserPaneNavigation,
} from './browserPaneNavigation';
import {
  createContextPanelNavigationState,
  createContextPanelSessionSurfaceId,
  createContextPanelSessionViewKey,
  cleanupContextPanelNavigationSurfaces,
  navigateContextPanelBack,
  reduceContextPanelSessionCache,
  resolveContextPanelActiveNavigation,
  resolveContextPanelViewedSessionId,
  resolveContextPanelChatRenderMode,
  updateContextPanelNavigation,
  type ContextPanelNavigationState,
  type ContextPanelSessionCacheState,
} from './contextPanelSessionSurface';
import {
  type PreviewElementMetadata,
  isPreviewElementMetadata,
  formatPreviewAnnotationMarkdown,
  renderPreviewScreenshot,
  desktopAnnotationToFile,
  getCachedProxyTarget,
  previewProxyTargetCache,
} from '@/lib/preview/screenshot-capture';
import { resolveRelayPreviewFrameSrc } from '@/lib/preview/relay-preview-frame-src';
import {
  ensurePreviewGatewayOrigin,
  hasDesktopPreviewGateway,
} from '@/lib/preview/relay-preview-gateway-client';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { openDesktopBrowserNetwork } from '@/lib/preview/desktop-browser-network';
import { HtmlNetworkBoundary } from '@/components/preview/HtmlNetworkBoundary';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isLocalRuntimeActive } from '@/lib/desktopLocalRuntime';

const CONTEXT_PANEL_MIN_WIDTH = 300;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
const PREVIEW_SPLIT_MIN_WIDTH = 400;
type TranslateFn = ReturnType<typeof useI18n>['t'];
const EMPTY_SESSION_TITLE_MAP = new Map<string, string>();
const subscribeToNoSessionTitles = () => () => {};

type PreviewConsoleEvent = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'resource' | 'runtime';
  message: string;
  details?: string;
  ts: number;
};

type PreviewConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs';

type PreviewBridgeMessage = {
  source?: string;
  version?: number;
  type?: string;
  level?: PreviewConsoleEvent['level'];
  args?: unknown[];
  message?: unknown;
  stack?: unknown;
  filename?: unknown;
  line?: unknown;
  column?: unknown;
  tag?: unknown;
  url?: unknown;
  outerHTML?: unknown;
  title?: unknown;
  ts?: unknown;
  target?: unknown;
  navigation?: unknown;
};


const PREVIEW_CONSOLE_EVENT_LIMIT = 200;

const getPreviewConsoleFilterMatch = (event: PreviewConsoleEvent, filter: PreviewConsoleFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'errors') return event.level === 'error' || event.level === 'runtime' || event.level === 'resource';
  if (filter === 'warnings') return event.level === 'warn';
  return event.level === 'log' || event.level === 'info' || event.level === 'debug';
};


const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

const clampWidthToAvailableSpace = (width: number, panel: HTMLElement | null): number => {
  const clampedWidth = clampWidth(width);
  const availableWidth = getAvailablePanelWidth(panel);
  if (availableWidth === null) {
    return clampedWidth;
  }

  return Math.min(clampedWidth, Math.max(1, availableWidth));
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'btw') return t('chat.btw.title');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'file-diff') return t('contextPanel.mode.diff');
  if (mode === 'preview') return t('contextPanel.mode.preview');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'preview') {
    const url = tab.targetPath;
    if (url) {
      try {
        const parsed = new URL(url);
        return parsed.host || parsed.hostname || t('contextPanel.mode.preview');
      } catch {
        // ignore invalid URL
      }
    }
    return t('contextPanel.mode.preview');
  }

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  if (tab.mode === 'file-diff') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { mode: ContextPanelMode; targetPath: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff' || tab.mode === 'file-diff') {
    return <Icon name="arrow-left-right" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    // Match right-sidebar context tab: list glyph, not filled pie (usage meter).
    return <Icon name="file-list-2" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-thread" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <Icon name="global" className="h-3.5 w-3.5 text-[var(--status-info)]" />;
  }

  if (tab.mode === 'browser') {
    return <Icon name="global" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

const areTitleMapsEqual = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

const buildSessionTitleMap = (sessions: Array<{ id: string; title?: string | null }>, sessionIDs: readonly string[]): Map<string, string> => {
  if (sessionIDs.length === 0) return EMPTY_SESSION_TITLE_MAP;
  const wanted = new Set(sessionIDs);
  const next = new Map<string, string>();
  for (const session of sessions) {
    if (!wanted.has(session.id)) continue;
    const title = session.title?.trim();
    if (title) next.set(session.id, title);
  }
  return next.size === 0 ? EMPTY_SESSION_TITLE_MAP : next;
};

const useSessionTitleMap = (directory: string | undefined, sessionIDs: readonly string[], remoteSessions?: Array<{ id: string; title?: string | null }>): ReadonlyMap<string, string> => {
  const host = useHostRuntime();
  const remote = !!host?.entry.location.hostId;
  const store = useDirectoryStore(host?.entry.location.hostId ? undefined : directory, { bootstrap: !host?.entry.location.hostId });
  const snapshotRef = React.useRef<ReadonlyMap<string, string>>(EMPTY_SESSION_TITLE_MAP);
  const sessionIDsRef = React.useRef<readonly string[]>(sessionIDs);

  sessionIDsRef.current = sessionIDs;

  const local = React.useSyncExternalStore(
    remote ? subscribeToNoSessionTitles : store.subscribe,
    React.useMemo(() => () => {
      if (remote) return EMPTY_SESSION_TITLE_MAP;
      const next = buildSessionTitleMap(store.getState().session, sessionIDsRef.current);
      if (areTitleMapsEqual(snapshotRef.current, next)) {
        return snapshotRef.current;
      }
      snapshotRef.current = next;
      return next;
    }, [remote, store]),
    () => EMPTY_SESSION_TITLE_MAP,
  );
  return React.useMemo(() => host?.entry.location.hostId
    ? buildSessionTitleMap(remoteSessions ?? [], sessionIDs)
    : local, [host?.entry.location.hostId, local, remoteSessions, sessionIDs]);
};

const DESKTOP_BROWSER_INSPECT_SCRIPT = `new Promise((resolve) => {
  const existing = document.getElementById('__yuri_desktop_browser_overlay');
  if (existing) existing.remove();
  if (typeof window.__yuriDesktopBrowserCancelInspect === 'function') {
    try { window.__yuriDesktopBrowserCancelInspect(); } catch { /* webview not ready */ }
  }
  const overlay = document.createElement('div');
  overlay.id = '__yuri_desktop_browser_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #60a5fa;background:rgba(96,165,250,.24);border-radius:3px;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const cssEscape = (value) => {
    try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  };
  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + '#' + cssEscape(element.id);
    const className = String(element.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const metadata = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
      ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
      current = current.parentElement;
    }
    const attrs = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 16)) attrs[attr.name] = attr.value.slice(0, 300);
    const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      selector: element.id ? '#' + cssEscape(element.id) : path,
      path,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes: attrs,
      computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
      ancestry,
    };
  };
  const move = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay || element === document.documentElement || element === document.body) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };
  const cleanup = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', keydown, true);
    if (window.__yuriDesktopBrowserCancelInspect === cancel) {
      delete window.__yuriDesktopBrowserCancelInspect;
    }
  };
  const cancel = () => {
    cleanup();
    overlay.remove();
    resolve(null);
  };
  const click = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const result = element ? metadata(element) : null;
    cleanup();
    overlay.remove();
    resolve(result);
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    cancel();
  };
  window.__yuriDesktopBrowserCancelInspect = cancel;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', keydown, true);
});`;

const DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT = `(() => {
  if (typeof window.__yuriDesktopBrowserCancelInspect === 'function') {
    window.__yuriDesktopBrowserCancelInspect();
    return;
  }
  const overlay = document.getElementById('__yuri_desktop_browser_overlay');
  if (overlay) overlay.remove();
})()`;

const DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT = `(() => {
  if (window.__yuriSameWebviewNavigationInstalled) return;
  window.__yuriSameWebviewNavigationInstalled = true;

  const navigate = (rawUrl) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      window.location.assign(url.href);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (navigate(url)) return null;
    return originalOpen(url, target, features);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[target="_blank"][href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!navigate(anchor.href)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})()`;

const runIframeScript = async <T,>(iframe: HTMLIFrameElement, script: string): Promise<T> => {
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    throw new Error('Iframe window is not available');
  }

  const evaluate = (frameWindow as Window & { eval: (code: string) => unknown }).eval;
  const result = evaluate.call(frameWindow, script) as unknown;
  return await Promise.resolve(result) as T;
};


const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

type PreviewPaneProps = {
  rawUrl: string;
  onNavigate: (url: string) => void;
};

type PreviewProxyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; proxyBasePath: string; previewToken?: string; expiresAt: number }
  | { status: 'error'; message: string };

const scopedPreviewPath = (entry: HostRuntimeEntry | undefined, path: string): string => {
  const prefix = hostApiPath(entry?.location.hostId, '/api/preview/proxy/');
  if (path.startsWith(prefix)) return path;
  return hostApiPath(entry?.location.hostId, path);
};

const validPreviewBasePath = (entry: HostRuntimeEntry | undefined, path: string): boolean => {
  const prefix = hostApiPath(entry?.location.hostId, '/api/preview/proxy/');
  const id = path.startsWith(prefix) ? path.slice(prefix.length) : path.startsWith('/api/preview/proxy/') ? path.slice('/api/preview/proxy/'.length) : '';
  return /^[a-f0-9]{16,64}$/i.test(id);
};

const getPreviewProxyOrigin = (proxySrc: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    return new URL(proxySrc || window.location.href, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
};

const postPreviewBridgeMessage = (frameWindow: Window, proxySrc: string, payload: Record<string, unknown>): void => {
  const targetOrigin = getPreviewProxyOrigin(proxySrc);
  frameWindow.postMessage(payload, targetOrigin);
};

const stripPreviewTokenFromUrl = (value: string): string => {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('yuri_preview_token');
    parsed.searchParams.delete('yuri_client_token');
    parsed.searchParams.delete('yuri_url_token');
    return parsed.toString();
  } catch {
    return value;
  }
};

const PreviewPane: React.FC<PreviewPaneProps> = ({ rawUrl, onNavigate }) => {
  const host = useHostRuntime();
  const entry = host?.entry;
  const fetchPreview = entry?.fetch ?? runtimeFetch;
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [reloadNonce, bumpReload] = React.useReducer((x: number) => x + 1, 0);
  const [proxyRegistrationNonce, bumpProxyRegistration] = React.useReducer((x: number) => x + 1, 0);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const [urlAuthReadyKey, setUrlAuthReadyKey] = React.useState('');
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const nextConsoleEventIdRef = React.useRef(1);
  const [bridgeReady, setBridgeReady] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [consoleFilter, setConsoleFilter] = React.useState<PreviewConsoleFilter>('all');
  const [consoleEvents, setConsoleEvents] = React.useState<PreviewConsoleEvent[]>([]);
  const [inspectMode, setInspectMode] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const localSessionId = useSessionUIStore((state) => state.currentSessionId);
  const localDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const remoteSelection = useSessionNavigationStore((state) => state.remoteSession);
  const selectedRemote = entry && remoteSelection && locationKey(remoteSelection.location) === entry.key ? remoteSelection : null;
  const currentSessionId = entry?.location.hostId ? selectedRemote?.sessionId ?? null : localSessionId;
  const newSessionDraftOpen = entry?.location.hostId ? !selectedRemote?.sessionId : localDraftOpen;
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addLocalAttachedFile = useInputStore((state) => state.addAttachedFile);
  const addAttachedFile = useEvent(async (file: File) => {
    if (!entry?.location.hostId) return addLocalAttachedFile(file);
    const owner = { transportIdentity: getRuntimeTransportIdentity(), location: entry.location };
    const draft = currentSessionId ? sessionDraftKey(owner, currentSessionId) : newSessionDraftKey(owner, 'remote-new-session');
    await useInputStore.getState().addDraftLocalAttachment(draft, file);
  });
  const annotationSessionKey = entry?.location.hostId ? locationSessionKey(entry.location, currentSessionId ?? 'draft') : currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = rawUrl ? new URL(rawUrl) : null;
  } catch {
    parsedUrl = null;
  }

  const isLoopback = parsedUrl
    ? (parsedUrl.hostname === 'localhost'
        || parsedUrl.hostname === '127.0.0.1'
        || parsedUrl.hostname === '::1'
        || parsedUrl.hostname === '[::1]'
        || parsedUrl.hostname === '0.0.0.0')
    : false;
  const needsProxy = isLoopback || !!entry?.location.hostId;

  const normalizedUrl = parsedUrl
    ? (parsedUrl.hostname === '0.0.0.0'
        ? new URL(parsedUrl.toString().replace('0.0.0.0', '127.0.0.1'))
        : parsedUrl)
    : null;

  const targetKey = normalizedUrl ? normalizedUrl.toString() : '';
  const proxyCacheKey = targetKey ? entry?.location.hostId
    ? `${getRuntimeApiBaseUrl() || 'same-origin'}|${entry.key}|${entry.connectionGeneration}|${targetKey}`
    : `${getRuntimeApiBaseUrl() || 'same-origin'}|${targetKey}` : '';
  const previewColorScheme = currentTheme.metadata.variant;

  React.useEffect(() => {
    if (!targetKey || !needsProxy) {
      setProxyState({ status: 'idle' });
      return;
    }

    const cached = getCachedProxyTarget(proxyCacheKey);
    if (cached?.previewToken) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, previewToken: cached.previewToken, expiresAt: cached.expiresAt });
      return () => { if (entry?.location.hostId) previewProxyTargetCache.delete(proxyCacheKey); };
    }
    if (cached) {
      previewProxyTargetCache.delete(proxyCacheKey);
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetchPreview('/api/preview/targets', {
          method: 'POST',
           headers: { 'Content-Type': 'application/json', ...(entry?.location.hostId ? { 'x-opencode-directory': entry.location.directory } : {}) },
          credentials: 'include',
           body: JSON.stringify({ url: targetKey, ...(entry?.location.hostId && !isLoopback ? { allowExternal: true } : {}) }),
        });

        if (!response.ok) {
          previewProxyTargetCache.delete(proxyCacheKey);
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' && validPreviewBasePath(entry, body.proxyBasePath) ? scopedPreviewPath(entry, body.proxyBasePath) : '';
        const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!validPreviewBasePath(entry, proxyBasePath) || !previewToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          previewProxyTargetCache.delete(proxyCacheKey);
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        if (cancelled) return;
        entry?.sdk();
        previewProxyTargetCache.set(proxyCacheKey, { proxyBasePath, previewToken, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, previewToken, expiresAt });
        }
      } catch (error) {
        previewProxyTargetCache.delete(proxyCacheKey);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (entry?.location.hostId) previewProxyTargetCache.delete(proxyCacheKey);
    };
  }, [entry, fetchPreview, isLoopback, needsProxy, proxyCacheKey, proxyRegistrationNonce, t, targetKey]);

  const directSrc = normalizedUrl
    && (normalizedUrl.protocol === 'http:' || normalizedUrl.protocol === 'https:')
    ? normalizedUrl.toString()
    : '';

  const proxyUrlAuthKey = needsProxy && proxyState.status === 'ready'
    ? `${proxyState.proxyBasePath}|${proxyState.previewToken || ''}|${reloadNonce}`
    : '';

  React.useEffect(() => {
    if (!proxyUrlAuthKey) {
      setUrlAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setUrlAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setUrlAuthReadyKey(proxyUrlAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [proxyUrlAuthKey]);

  const proxySrc = needsProxy && proxyState.status === 'ready' && normalizedUrl && urlAuthReadyKey === proxyUrlAuthKey
    ? (() => {
      const path = normalizedUrl.pathname || '/';
      const searchParams = new URLSearchParams(normalizedUrl.search);
      searchParams.delete('yuri_url_token');
      searchParams.delete('yuri_client_token');
      searchParams.set('yuriPreview', String(reloadNonce));
      searchParams.set('yuri_preview_token', proxyState.previewToken || '');
      const search = searchParams.toString();
      const hash = normalizedUrl.hash || '';
       return getRuntimeUrlResolver().authenticatedAsset(scopedPreviewPath(entry, `${proxyState.proxyBasePath}${path}${search ? `?${search}` : ''}${hash}`));
    })()
    : '';

  // Electron + Relay: iframe must load http://127.0.0.1:<ephemeral> (loopback
  // gateway). LAN/direct keep authenticatedAsset as-is — do not start gateway.
  const relayPreviewActive = needsProxy && isRelayModeActive() && hasDesktopPreviewGateway();
  const [previewGatewayOrigin, setPreviewGatewayOrigin] = React.useState('');
  React.useEffect(() => {
    if (!relayPreviewActive) {
      setPreviewGatewayOrigin('');
      return;
    }
    let cancelled = false;
    setPreviewGatewayOrigin('');
    void ensurePreviewGatewayOrigin()
      .then((origin) => {
        if (!cancelled && origin) setPreviewGatewayOrigin(origin);
      })
      .catch(() => {
        if (!cancelled) setPreviewGatewayOrigin('');
      });
    return () => {
      cancelled = true;
    };
  }, [relayPreviewActive, proxyUrlAuthKey]);

  const frameSrc = needsProxy
    ? resolveRelayPreviewFrameSrc({
      relayActive: relayPreviewActive,
      gatewayOrigin: previewGatewayOrigin || null,
      authenticatedAssetUrl: proxySrc,
    })
    : '';
  // Under relay+electron wait for gateway origin before treating the frame as ready.
  const relayGatewayPending = relayPreviewActive && Boolean(proxySrc) && !previewGatewayOrigin;
  const effectiveSrc = needsProxy
    ? (relayGatewayPending ? '' : frameSrc)
    : directSrc;
  const headerSrc = needsProxy
    ? stripPreviewTokenFromUrl(frameSrc || proxySrc)
    : directSrc;
  const showLoading = needsProxy && (
    proxyState.status === 'loading'
    || proxyState.status === 'idle'
    || urlAuthReadyKey !== proxyUrlAuthKey
    || relayGatewayPending
  );
  const showError = needsProxy && proxyState.status === 'error';

  const attachPreviewAnnotation = React.useCallback((target: PreviewElementMetadata) => {
    const sessionKey = annotationSessionKey;
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const pageUrl = rawUrl || effectiveSrc || '';
    const viewport = typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    void (async () => {
      let attachedScreenshot = false;
      try {
        const iframe = iframeRef.current;
         const screenshot = iframe ? await renderPreviewScreenshot(iframe, target, entry) : null;
        if (screenshot) {
          await addAttachedFile(screenshot);
          attachedScreenshot = true;
        }
      } catch {
        attachedScreenshot = false;
      }

      addInlineCommentDraft({
        sessionKey,
        source: 'preview-annotation',
        fileLabel: pageUrl || 'preview',
        startLine: 1,
        endLine: 1,
        code: formatPreviewAnnotationMarkdown({
          pageUrl,
          viewport,
          devicePixelRatio,
          target,
          screenshotAttached: attachedScreenshot,
          intro: t('contextPanel.preview.inspect.attachAnnotation'),
        }),
        language: 'markdown',
        text: '',
      });
      toast.success(t('contextPanel.preview.inspect.attached'));
    })();
  }, [entry, addAttachedFile, addInlineCommentDraft, annotationSessionKey, effectiveSrc, rawUrl, t]);

  React.useEffect(() => {
    setBridgeReady(false);
    setConsoleEvents([]);
    setConsoleOpen(false);
    setConsoleFilter('all');
    setInspectMode(false);
    setHoverTarget(null);
    nextConsoleEventIdRef.current = 1;
  }, [effectiveSrc]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    // postMessage targetOrigin must match the iframe document origin (gateway
    // under Relay, authenticated asset origin on LAN/direct).
    postPreviewBridgeMessage(frameWindow, effectiveSrc || proxySrc, {
      source: 'yuri-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled: inspectMode,
    });
  }, [bridgeReady, effectiveSrc, inspectMode, proxySrc]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    postPreviewBridgeMessage(frameWindow, effectiveSrc || proxySrc, {
      source: 'yuri-preview-parent',
      version: 1,
      type: 'set-color-scheme',
      scheme: previewColorScheme,
    });
  }, [bridgeReady, effectiveSrc, previewColorScheme, proxySrc]);

  React.useEffect(() => {
    if (!inspectMode || typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setInspectMode(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [inspectMode]);

  React.useEffect(() => {
    if (!needsProxy || typeof window === 'undefined') {
      return;
    }

    const stringify = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const pushConsoleEvent = (event: Omit<PreviewConsoleEvent, 'id'>) => {
      const id = nextConsoleEventIdRef.current;
      nextConsoleEventIdRef.current += 1;
      setConsoleEvents((current) => {
        const next = [...current, { ...event, id }];
        return next.length > PREVIEW_CONSOLE_EVENT_LIMIT
          ? next.slice(next.length - PREVIEW_CONSOLE_EVENT_LIMIT)
          : next;
      });
    };

    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== 'yuri-preview-bridge' || data.version !== 1) {
        return;
      }

      if (data.type === 'ready') {
        setBridgeReady(true);
        return;
      }

      if (data.type === 'console') {
        const level = data.level === 'error' || data.level === 'warn' || data.level === 'info' || data.level === 'debug'
          ? data.level
          : 'log';
        const args = Array.isArray(data.args) ? data.args.map(stringify).filter(Boolean) : [];
        pushConsoleEvent({
          level,
          message: args.join(' '),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'runtime-error') {
        const filename = stringify(data.filename);
        const line = typeof data.line === 'number' ? data.line : null;
        const column = typeof data.column === 'number' ? data.column : null;
        const location = filename
          ? `${filename}${line !== null ? `:${line}${column !== null ? `:${column}` : ''}` : ''}`
          : '';
        const stack = stringify(data.stack);
        pushConsoleEvent({
          level: 'runtime',
          message: stringify(data.message) || t('contextPanel.preview.console.runtimeError'),
          details: [location, stack].filter(Boolean).join('\n'),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'resource-error') {
        const tag = stringify(data.tag) || 'resource';
        const url = stringify(data.url);
        pushConsoleEvent({
          level: 'resource',
          message: url ? `${tag}: ${url}` : tag,
          details: stringify(data.outerHTML),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(data.target);
        setInspectMode(false);
        attachPreviewAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const navigation = data.navigation === 'external' ? 'external' : 'proxy';
        if (nextUrl && navigation === 'external' && !entry?.location.hostId) {
          void openExternalUrl(nextUrl);
          return;
        }
        if (nextUrl) {
          onNavigate(nextUrl);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [entry, attachPreviewAnnotation, needsProxy, onNavigate, t]);

  const consoleErrorCount = consoleEvents.filter((event) => event.level === 'error' || event.level === 'runtime' || event.level === 'resource').length;
  const filteredConsoleEvents = consoleEvents.filter((event) => getPreviewConsoleFilterMatch(event, consoleFilter));

  const copyConsoleEvents = React.useCallback(() => {
    const header = [
      `Preview URL: ${rawUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    void copyTextToClipboard(`${header}${text}`).then((result) => {
      if (result.ok) {
        toast.success(t('contextPanel.preview.console.copied'));
      } else {
        toast.error(t('contextPanel.preview.console.copyFailed'));
      }
    });
  }, [consoleEvents, effectiveSrc, rawUrl, t]);

  const attachConsoleEvents = React.useCallback(() => {
    const sessionKey = annotationSessionKey;
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.console.attachNoSession'));
      return;
    }

    const header = [
      `Preview URL: ${rawUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    addInlineCommentDraft({
      sessionKey,
      source: 'preview-console',
      fileLabel: rawUrl || effectiveSrc || 'preview',
      startLine: 1,
      endLine: Math.max(1, consoleEvents.length),
      code: `${header}${text}`,
      language: 'text',
      text: t('contextPanel.preview.console.attachAnnotation'),
    });
    toast.success(t('contextPanel.preview.console.attached'));
  }, [addInlineCommentDraft, consoleEvents, annotationSessionKey, effectiveSrc, rawUrl, t]);

  // Out-of-band upstream probe: iframes don't expose HTTP status to the parent,
  // so when the proxy returns a 502 (upstream dev server is offline) the iframe
  // would just render the raw JSON error body. Probe the proxy URL with a HEAD
  // request and surface a friendly overlay when the upstream is unreachable.
  type UpstreamState = 'unknown' | 'starting' | 'reachable' | 'unreachable';
  const [upstreamState, setUpstreamState] = React.useState<UpstreamState>('unknown');
  const upstreamProbeStartedAtRef = React.useRef<number>(0);
  const upstreamProbeAttemptRef = React.useRef<number>(0);
  const PREVIEW_STARTUP_GRACE_MS = 15_000;

  React.useEffect(() => {
    if (!proxySrc) {
      setUpstreamState('unknown');
      upstreamProbeStartedAtRef.current = 0;
      upstreamProbeAttemptRef.current = 0;
      return;
    }

    let cancelled = false;
    if (!upstreamProbeStartedAtRef.current) {
      upstreamProbeStartedAtRef.current = Date.now();
      upstreamProbeAttemptRef.current = 0;
    }
    setUpstreamState('unknown');

    void (async () => {
      const probe = async (): Promise<Response | null> => {
        try {
           const target = new URL(proxySrc, window.location.href);
           const hostPrefix = entry?.location.hostId ? hostApiPath(entry.location.hostId, '/api').slice(0, -4) : '';
           const probePath = `${hostPrefix && target.pathname.startsWith(hostPrefix + '/') ? target.pathname.slice(hostPrefix.length) : target.pathname}${target.search}`;
           return await fetchPreview(probePath, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'manual',
          });
        } catch {
          return null;
        }
      };

      const response = await probe();

      if (cancelled) return;

      if (!response) {
        // Network-level failure (e.g. server itself is down) — treat as unreachable.
        setUpstreamState('unreachable');
        return;
      }

      if (response.status === 403 || response.status === 404) {
        previewProxyTargetCache.delete(proxyCacheKey);
        setProxyState({ status: 'loading' });
        bumpProxyRegistration();
        return;
      }

      // The proxy emits 502 when the upstream is unreachable. Anything else
      // (including 4xx from the upstream) means the upstream answered.
      if (response.status !== 502) {
        setUpstreamState('reachable');
        return;
      }

      const startedAt = upstreamProbeStartedAtRef.current || Date.now();
      const elapsed = Date.now() - startedAt;
      if (elapsed < PREVIEW_STARTUP_GRACE_MS) {
        // Dev servers can take a moment to bind. During the grace window,
        // keep retrying and show a softer "starting" state.
        setUpstreamState('starting');
        upstreamProbeAttemptRef.current += 1;
        const attempt = upstreamProbeAttemptRef.current;
        const delay = Math.min(2000, 250 * Math.pow(2, Math.min(4, attempt)));
        setTimeout(() => {
          if (!cancelled) {
            bumpReload();
          }
        }, delay).unref?.();
        return;
      }

      setUpstreamState('unreachable');
    })();

    return () => {
      cancelled = true;
    };
  }, [entry, fetchPreview, proxyCacheKey, proxySrc, reloadNonce]);

  const showUpstreamStarting = needsProxy
    && proxyState.status === 'ready'
    && (upstreamState === 'unknown' || upstreamState === 'starting');

  const showUpstreamUnreachable = needsProxy
    && proxyState.status === 'ready'
    && upstreamState === 'unreachable';

  const handlePreviewFrameLoad = React.useCallback((event: React.SyntheticEvent<HTMLIFrameElement>) => {
    if (!needsProxy || proxyState.status !== 'ready') {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const frameWindow = event.currentTarget.contentWindow;
    if (!frameWindow) {
      return;
    }

    try {
      const location = frameWindow.location;
      const proxyOrigin = getPreviewProxyOrigin(effectiveSrc || proxySrc);
      if (location.origin !== proxyOrigin) {
        return;
      }
      if (location.pathname.startsWith(proxyState.proxyBasePath)) {
        return;
      }

      const nextPath = `${proxyState.proxyBasePath}${location.pathname}${location.search}${location.hash}`;
      frameWindow.location.replace(nextPath);
    } catch {
      // Cross-origin frames are expected for non-loopback/direct previews.
    }
  }, [effectiveSrc, needsProxy, proxySrc, proxyState]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <div className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={headerSrc || rawUrl}>
          {headerSrc || rawUrl || t('contextPanel.preview.empty')}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => bumpReload()}
          title={t('contextPanel.preview.actions.reload')}
          aria-label={t('contextPanel.preview.actions.reload')}
          disabled={!effectiveSrc}
        >
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => {
            if (!directSrc) return;
             void openExternalUrl(entry?.location.hostId ? effectiveSrc : directSrc);
          }}
          title={t('contextPanel.preview.actions.openExternal')}
          aria-label={t('contextPanel.preview.actions.openExternal')}
          disabled={entry?.location.hostId ? !effectiveSrc : !directSrc}
        >
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
        {needsProxy ? (
          <Button
            type="button"
            size="sm"
            variant={inspectMode ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setInspectMode((value) => !value)}
            title={t('contextPanel.preview.inspect.toggle')}
            aria-label={t('contextPanel.preview.inspect.toggle')}
            disabled={!bridgeReady}
          >
            <Icon name="cursor" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {needsProxy ? (
          <Button
            type="button"
            size="sm"
            variant={consoleOpen ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setConsoleOpen((value) => !value)}
            title={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            aria-label={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            disabled={!bridgeReady && consoleEvents.length === 0}
          >
            <Icon name="terminal-box" className="h-3.5 w-3.5" />
            {consoleErrorCount > 0 ? (
              <span className="typography-micro text-status-error">{consoleErrorCount}</span>
            ) : null}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {showUpstreamStarting ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.startingServer')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.startingServerHint')}</div>
          </div>
        ) : showUpstreamUnreachable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.upstreamUnreachable')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.upstreamUnreachableHint')}</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => bumpReload()}
            >
              {t('contextPanel.preview.actions.retry')}
            </Button>
          </div>
        ) : effectiveSrc && (!needsProxy || upstreamState === 'reachable') ? (
          <div className="relative h-full w-full">
            <iframe
              ref={iframeRef}
              key={`${effectiveSrc}:${reloadNonce}`}
              src={effectiveSrc}
              title={t('contextPanel.preview.iframeTitle')}
              className="h-full w-full border-0"
              style={{ colorScheme: previewColorScheme }}
              onLoad={handlePreviewFrameLoad}
              sandbox={needsProxy
                ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
                : 'allow-scripts allow-forms'}
            />
            {inspectMode && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        ) : showLoading ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.loading')}
          </div>
        ) : showError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.proxyError')}</div>
             {proxyState.status === 'error' ? (
               <div className="text-center text-xs opacity-70">{proxyState.message}</div>
             ) : null}
             <Button type="button" size="sm" onClick={() => bumpProxyRegistration()}>{t('contextPanel.preview.actions.retry')}</Button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.invalidUrl')}
          </div>
        )}
        {consoleOpen ? (
          <div className="absolute inset-x-3 bottom-3 z-10 max-h-[45%] overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] shadow-lg">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.preview.console.title')}</div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={attachConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.attach')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={copyConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.copy')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setConsoleEvents([])}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.clear')}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-1 border-b border-border/30 px-3 py-1.5">
              {(['all', 'errors', 'warnings', 'logs'] as const).map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  size="xs"
                  variant={consoleFilter === filter ? 'secondary' : 'ghost'}
                  onClick={() => setConsoleFilter(filter)}
                >
                  {filter === 'all'
                    ? t('contextPanel.preview.console.filter.all')
                    : filter === 'errors'
                      ? t('contextPanel.preview.console.filter.errors')
                      : filter === 'warnings'
                        ? t('contextPanel.preview.console.filter.warnings')
                        : t('contextPanel.preview.console.filter.logs')}
                </Button>
              ))}
            </div>
            <div className="max-h-64 overflow-auto p-2 typography-code text-xs">
              {consoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.empty')}</div>
              ) : filteredConsoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.noFilteredEvents')}</div>
              ) : filteredConsoleEvents.map((event) => (
                <div key={event.id} className="border-b border-border/30 px-2 py-1 last:border-b-0">
                  <div className="flex gap-2">
                    <span className={cn(
                      'shrink-0 uppercase',
                      event.level === 'error' || event.level === 'runtime' || event.level === 'resource'
                        ? 'text-status-error'
                        : event.level === 'warn'
                          ? 'text-status-warning'
                          : 'text-muted-foreground'
                    )}>
                      {event.level}
                    </span>
                    <span className="min-w-0 break-words text-foreground">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
  partition?: string;
};

const isElectronBrowserRuntime = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__YURI_ELECTRON__);
};

function useBrowserAnnotationTarget() {
  const entry = useHostRuntime()?.entry;
  const localSessionId = useSessionUIStore((state) => state.currentSessionId);
  const localDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const remoteSelection = useSessionNavigationStore((state) => state.remoteSession);
  const selectedRemote = entry && remoteSelection && locationKey(remoteSelection.location) === entry.key ? remoteSelection : null;
  const currentSessionId = entry?.location.hostId ? selectedRemote?.sessionId ?? null : localSessionId;
  const newSessionDraftOpen = entry?.location.hostId ? !selectedRemote?.sessionId : localDraftOpen;
  const addLocalAttachedFile = useInputStore((state) => state.addAttachedFile);
  const addAttachedFile = useEvent(async (file: File) => {
    if (!entry?.location.hostId) return addLocalAttachedFile(file);
    const owner = { transportIdentity: getRuntimeTransportIdentity(), location: entry.location };
    const draft = currentSessionId ? sessionDraftKey(owner, currentSessionId) : newSessionDraftKey(owner, 'remote-new-session');
    await useInputStore.getState().addDraftLocalAttachment(draft, file);
  });
  const annotationSessionKey = entry?.location.hostId ? locationSessionKey(entry.location, currentSessionId ?? 'draft') : currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
  return { annotationSessionKey, addAttachedFile };
}

const IframeBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID }) => {
  const host = useHostRuntime();
  const entry = host?.entry;
  const { t } = useI18n();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(() => startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(() => startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  const [isLoading, setIsLoading] = React.useState(Boolean(startUrl));
  const [isInspecting, setIsInspecting] = React.useState(false);
  const { annotationSessionKey, addAttachedFile } = useBrowserAnnotationTarget();
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const applyUrl = React.useCallback((url: string, options?: { replaceHistory?: boolean; inFrame?: boolean }) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    const nextUrl = normalizedUrl !== 'about:blank' ? normalizedUrl : '';
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    if (!options?.inFrame) {
      setLoadedUrl(nextUrl);
      setIsLoading(Boolean(nextUrl));
    } else {
      setIsLoading(false);
    }
    persistUrl(nextUrl);

    setHistory((current) => {
      if (!nextUrl) {
        setHistoryIndex(-1);
        return [];
      }

      if (options?.replaceHistory) {
        return current;
      }

      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      const previous = kept[kept.length - 1];
      if (previous === nextUrl) {
        setHistoryIndex(kept.length - 1);
        return kept;
      }

      const nextHistory = [...kept, nextUrl];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex, persistUrl]);

  // Follow parent tab targetPath changes (same desktop-browser tab, new markdown link).
  const currentUrlRef = React.useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  React.useEffect(() => {
    const nextUrl = resolveBrowserPaneNavigation(initialUrl, currentUrlRef.current);
    if (nextUrl === null) return;
    applyUrl(nextUrl);
  }, [initialUrl, applyUrl]);

  const goToHistory = React.useCallback((nextIndex: number) => {
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setCurrentUrl(nextUrl);
    setLoadedUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(true);
    persistUrl(nextUrl);
  }, [history, persistUrl]);

  const handleReload = React.useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      bumpReload();
    }
  }, [currentUrl]);

  const iframeSrc = loadedUrl;

  const attachBrowserAnnotation = React.useCallback(async (target: PreviewElementMetadata) => {
    const sessionKey = annotationSessionKey;
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const iframe = iframeRef.current;
    const frameWindow = iframe?.contentWindow;
    const rect = iframe?.getBoundingClientRect();
    const viewport = {
      width: Number.isFinite(frameWindow?.innerWidth) ? frameWindow?.innerWidth ?? rect?.width ?? 0 : rect?.width ?? 0,
      height: Number.isFinite(frameWindow?.innerHeight) ? frameWindow?.innerHeight ?? rect?.height ?? 0 : rect?.height ?? 0,
    };

    const file = iframe ? await renderPreviewScreenshot(iframe, target, entry) : null;
    const screenshotAttached = Boolean(file);
    if (file) {
      await addAttachedFile(file);
    }

    addInlineCommentDraft({
      sessionKey,
      source: 'preview-annotation',
      fileLabel: currentUrl || 'browser',
      startLine: 1,
      endLine: 1,
      code: formatPreviewAnnotationMarkdown({
        pageUrl: currentUrl,
        viewport,
        devicePixelRatio: window.devicePixelRatio || 1,
        target,
        screenshotAttached,
        intro: t(screenshotAttached
          ? 'contextPanel.preview.inspect.attachAnnotationWithScreenshot'
          : 'contextPanel.preview.inspect.attachAnnotation'),
      }),
      language: 'markdown',
      text: '',
    });
    toast.success(t('contextPanel.preview.inspect.attached'));
  }, [entry, addAttachedFile, addInlineCommentDraft, annotationSessionKey, currentUrl, t]);

  const cancelInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    void runIframeScript<unknown>(iframe, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      cancelInspect();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [cancelInspect, isInspecting]);

  React.useEffect(() => () => cancelInspect(), [cancelInspect]);

  const handleInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !currentUrl) return;

    if (isInspecting) {
      setIsInspecting(false);
      cancelInspect();
      return;
    }

    setIsInspecting(true);
    void (async () => {
      try {
        const target = await runIframeScript<unknown>(iframe, DESKTOP_BROWSER_INSPECT_SCRIPT);
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;
        await attachBrowserAnnotation(target);
      } catch {
        setIsInspecting(false);
        toast.error(t('contextPanel.browser.inspectUnavailable'));
      }
    })();
  }, [attachBrowserAnnotation, cancelInspect, currentUrl, isInspecting, t]);

  const handleIframeLoad = React.useCallback(() => {
    try {
      const frameUrl = iframeRef.current?.contentWindow?.location.href || '';
      if (frameUrl && frameUrl !== 'about:blank') applyUrl(frameUrl, { inFrame: true });
    } catch {
      // Cross-origin iframe location remains browser-owned.
    }

    setIsLoading(false);
  }, [applyUrl]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex <= 0} onClick={() => goToHistory(historyIndex - 1)}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goToHistory(historyIndex + 1)}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={handleReload}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); applyUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!currentUrl}
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {iframeSrc ? (
          <div className="absolute inset-0">
            <iframe
              key={`${tabID}:${reloadNonce}`}
              ref={iframeRef}
              src={iframeSrc}
              title={t('contextPanel.browser.empty')}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              allow="clipboard-read; clipboard-write; fullscreen"
              allowFullScreen
              onLoad={handleIframeLoad}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <YuriLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
            <span className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
            <span className="max-w-md typography-micro leading-relaxed text-status-warning/70">{t('contextPanel.browser.trustNotice')}</span>
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const ElectronBrowserPane: React.FC<DesktopBrowserPaneProps> = (props) => {
  const entry = useHostRuntime()?.entry;
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const openNetwork = React.useMemo(() => (signal: AbortSignal, fail: () => void) =>
    openDesktopBrowserNetwork(signal, fail, entry), [entry]);
  const scopeKey = `${generation}:${entry?.key ?? ''}:${entry?.connectionGeneration ?? 0}`;
  return entry?.location.hostId || !isLocalRuntimeActive()
    ? <HtmlNetworkBoundary key={scopeKey} open={openNetwork}>
        {network => <DesktopBrowserPane {...props} partition={network.partition} />}
      </HtmlNetworkBoundary>
    : <DesktopBrowserPane key={scopeKey} {...props} />;
};

const DesktopBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID, partition = 'persist:yuri-browser' }) => {
  const { t } = useI18n();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const initialWebviewSrcRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLoading = isLoading;

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);
  const { annotationSessionKey, addAttachedFile } = useBrowserAnnotationTarget();
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);

  // Listen to webview navigation events
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const syncUrl = () => {
      try {
        const url = webview.getURL();
        if (url && url !== 'about:blank') {
          setCurrentUrl(url);
          setUrlInput(url);
          persistUrl(url);
        }
      } catch { /* webview not ready */ }
    };

    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string }>).detail;
      if (typeof detail?.url === 'string' && detail.url) {
        setCurrentUrl(detail.url);
        setUrlInput(detail.url);
        persistUrl(detail.url);
      }
    };

    const onStartLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(true), 200);
    };
    const onStopLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
      syncUrl();
    };

    const onNewWindow = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; disposition: string }>).detail;
      if (detail?.disposition === 'new-window' || detail?.disposition === 'foreground-tab' || detail?.disposition === 'background-tab') {
        event.preventDefault();
        const w = webviewRef.current;
        if (typeof w?.loadURL === 'function' && detail.url) {
          w.loadURL(detail.url);
        }
      }
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true).catch(() => {});
      } catch { /* webview not ready */ }
    };

    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('new-window', onNewWindow);
    webview.addEventListener('dom-ready', installSameWebviewNavigation);

    // Check current loading state imperatively — we may have missed the event
    try {
      if (!webview.isLoading()) {
        setIsLoading(false);
        syncUrl();
      }
    } catch { /* webview not ready */ }
    installSameWebviewNavigation();

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('new-window', onNewWindow);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
    };
  }, [persistUrl]);

  // Safety timeout: hide loading overlay after 30s even if events fire late
  React.useEffect(() => {
    const safety = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(safety);
  }, []);

  // Escape key cancels inspect mode
  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      const webview = webviewRef.current;
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isInspecting]);

  // Cancel inspect on unmount
  React.useEffect(() => {
    const webview = webviewRef.current;
    return () => {
      try {
        const url = webview?.getURL?.();
        if (url && url !== 'about:blank') {
          setContextPanelTabTargetPath(directory, tabID, url);
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const loadUrl = React.useCallback((value: string) => {
    const webview = webviewRef.current;
    if (typeof webview?.loadURL !== 'function') return;
    const nextUrl = normalizeBrowserUrl(value);
    try { webview.loadURL(nextUrl); } catch { /* webview may not be ready */ }
  }, []);

  // Follow parent tab targetPath changes (same desktop-browser tab, new markdown link).
  const currentUrlRef = React.useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  React.useEffect(() => {
    const nextUrl = resolveBrowserPaneNavigation(initialUrl, currentUrlRef.current);
    if (nextUrl === null) return;
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(true);
    loadUrl(nextUrl);
  }, [initialUrl, loadUrl]);

  const handleInspect = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isInspecting) {
      setIsInspecting(false);
      try { webview.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
      return;
    }

    setIsInspecting(true);
    webview.executeJavaScript?.(DESKTOP_BROWSER_INSPECT_SCRIPT, true)
      .then(async (target: unknown) => {
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;

        const sessionKey = annotationSessionKey;
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }

        const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (wcId === null || wcId === undefined) return;

        const capture = await invokeDesktopCommand<{ mime: string; base64: string; width: number; height: number }>(
          'desktop_browser_capture_page', { webContentsId: wcId }
        );

        const cssViewport = await webview.executeJavaScript?.(
          '({ width: window.innerWidth, height: window.innerHeight })', true
        ).catch(() => null) as { width: number; height: number } | null | undefined;

        const cssWidth = Number.isFinite(cssViewport?.width) ? (cssViewport as { width: number }).width : capture.width;
        const cssHeight = Number.isFinite(cssViewport?.height) ? (cssViewport as { height: number }).height : capture.height;

        const file = await desktopAnnotationToFile(capture.base64, capture.width, capture.height, cssWidth, cssHeight, target);
        const screenshotAttached = Boolean(file);
        if (file) {
          await addAttachedFile(file);
        }

        addInlineCommentDraft({
          sessionKey,
          source: 'preview-annotation',
          fileLabel: currentUrl || 'browser',
          startLine: 1,
          endLine: 1,
          code: formatPreviewAnnotationMarkdown({
            pageUrl: currentUrl,
            viewport: { width: cssWidth, height: cssHeight },
            devicePixelRatio: window.devicePixelRatio || 1,
            target,
            screenshotAttached,
            intro: t('contextPanel.preview.inspect.attachAnnotationWithScreenshot'),
          }),
          language: 'markdown',
          text: '',
        });
        toast.success(t('contextPanel.preview.inspect.attached'));
      })
      .catch(() => setIsInspecting(false));
  }, [addAttachedFile, addInlineCommentDraft, annotationSessionKey, currentUrl, isInspecting, t]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goBack?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goForward?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.reload?.(); } catch { /* webview not ready */ } }}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); loadUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        <webview
          ref={webviewRef}
          src={initialWebviewSrcRef.current}
          partition={partition}
          allowpopups
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
        {(!currentUrl || currentUrl === 'about:blank') && !isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <YuriLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
          </div>
        ) : null}
        {showLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

type ContextPanelProps = {
  directory?: string | null;
  onReservedWidthChange?: (width: number) => void;
  fillAvailableSpace?: boolean;
  getMaxSplitWidth?: () => number;
};

export const ContextPanel: React.FC<ContextPanelProps> = (props) => {
  const host = useHostRuntime();
  return host ? <ScopedContextPanel key={host.entry.key} {...props} /> : <SelectedProjectHostBoundary><ScopedContextPanel {...props} /></SelectedProjectHostBoundary>;
};

const ScopedContextPanel: React.FC<ContextPanelProps> = (props) => {
  const host = useHostRuntime();
  return host?.entry.location.hostId ? <RemoteContextPanel {...props} /> : <ContextPanelContentView {...props} />;
};

const RemoteContextPanel: React.FC<ContextPanelProps> = (props) => {
  const host = useHostRuntime()!;
  const summaries = useRemoteHostSummaries(host.registry, host.entry.location.hostId);
  const sessions = React.useMemo(() => summaries.data?.directories.flatMap((item) => item.sessions) ?? [], [summaries.data]);
  return <ContextPanelContentView {...props} remoteSessions={sessions} />;
};

const ContextPanelContentView: React.FC<ContextPanelProps & { remoteSessions?: Array<{ id: string; title?: string | null }> }> = ({ directory: directoryOverride, onReservedWidthChange, fillAvailableSpace = false, getMaxSplitWidth, remoteSessions }) => {
  const { t } = useI18n();
  const host = useHostRuntime();
  const remote = !!host?.entry.location.hostId;
  const localBtwSessionId = useSessionUIStore((state) => state.currentSessionId);
  const remoteSelection = useSessionNavigationStore((state) => state.remoteSession);
  const btwSessionId = remote ? remoteSelection && locationKey(remoteSelection.location) === host.entry.key ? remoteSelection.sessionId : null : localBtwSessionId;
  const fallbackDirectory = useEffectiveDirectory() ?? '';
  const effectiveDirectory = directoryOverride ? parseLocationKey(directoryOverride, host?.entry.location.hubId ?? 'local').directory : fallbackDirectory;
  const directoryKey = remote
    ? locationKey({ ...host.entry.location, directory: effectiveDirectory })
    : normalizeDirectoryKey(effectiveDirectory);

  const panelState = useUIStore((state) => getContextPanelState(state, directoryKey));
  const contextToolDiff = useUIStore((state) => (directoryKey ? state.contextToolDiffByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const isFileTreeOpen = useUIStore((state) => state.isRightSidebarOpen);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
  const { themeMode, setThemeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const isOpen = Boolean(panelState?.isOpen);
  const requestedExpanded = Boolean(panelState?.expanded);
  const isExpanded = isOpen && (requestedExpanded || fillAvailableSpace);
  const previewBodyRef = React.useRef<HTMLDivElement>(null);
  const compactRef = React.useRef(true);
  const [isCompact, setIsCompact] = React.useState(true);
  useResizeObserver(previewBodyRef, ([entry]) => {
    if (!entry || entry.contentRect.width <= 0) return;
    const compact = entry.contentRect.width < PREVIEW_SPLIT_MIN_WIDTH;
    if (compact === compactRef.current) return;
    compactRef.current = compact;
    setIsCompact(compact);
  });
  const railVisible = isOpen && (!activeTab || (isFileTreeOpen && (!isCompact || panelState?.activeView !== 'preview')));
  const previewVisible = isOpen && (!isCompact || !railVisible);
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [tabs]);
  const sessionTitleById = useSessionTitleMap(effectiveDirectory || undefined, chatSessionIDs, remoteSessions);

  const [isResizing, setIsResizing] = React.useState(false);
  const [suppressWidthTransition, setSuppressWidthTransition] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const lastSplitWidthRef = React.useRef({ directory: directoryKey, width });
  React.useLayoutEffect(() => {
    if (isResizing) return;
    if (lastSplitWidthRef.current.directory !== directoryKey || (isOpen && !isExpanded)) {
      lastSplitWidthRef.current = { directory: directoryKey, width };
    }
    onReservedWidthChange?.(isOpen ? (requestedExpanded ? Infinity : width) : 0);
  }, [directoryKey, isExpanded, isOpen, isResizing, onReservedWidthChange, requestedExpanded, width]);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const chatFrameSrcByTabIDRef = React.useRef<Map<string, EmbeddedSessionChatURLCacheEntry>>(new Map());
  const wasOpenRef = React.useRef(false);
  const previousIsOpenRef = React.useRef(isOpen);
  const suppressWidthTransitionFrameRef = React.useRef<number | null>(null);
  const [sessionNavigationByTabId, setSessionNavigationByTabId] = React.useState<Record<string, ContextPanelNavigationState>>({});
  const sessionNavigationRef = React.useRef(sessionNavigationByTabId);
  sessionNavigationRef.current = sessionNavigationByTabId;
  const [sessionCache, dispatchSessionCache] = React.useReducer(reduceContextPanelSessionCache, { activeViewKey: null, tabs: {}, mountedViews: {} } satisfies ContextPanelSessionCacheState);
  const chatRenderMode = remote ? 'react-surface' : resolveContextPanelChatRenderMode();
  const runtimeKey = getRuntimeKey();

  const commitSessionNavigation = React.useCallback((update: (current: Record<string, ContextPanelNavigationState>) => Record<string, ContextPanelNavigationState>) => {
    const current = sessionNavigationRef.current;
    const next = update(current);
    if (next === current) return false;
    sessionNavigationRef.current = next;
    setSessionNavigationByTabId(next);
    return true;
  }, []);

  const closePanelTab = React.useCallback((tabId: string) => {
    if (!directoryKey) return;
    if (useUIStore.getState().contextPanelByDirectory[directoryKey]?.tabs.find((tab) => tab.id === tabId)?.mode === 'btw') {
      const sessionId = btwSessionId;
      if (sessionId) useSessionBtwStore.getState().clear({ sessionId, directory: effectiveDirectory, host: remote ? host.entry : undefined });
    }
    dispatchSessionCache({ type: 'close-tab', tabId });
    const surfaceId = createContextPanelSessionSurfaceId(directoryKey, tabId);
    commitSessionNavigation((current) => {
      if (!current[surfaceId]) return current;
      const next = { ...current };
      delete next[surfaceId];
      return next;
    });
    closeContextPanelTab(directoryKey, tabId);
  }, [btwSessionId, effectiveDirectory, host, remote, closeContextPanelTab, commitSessionNavigation, directoryKey]);

  const suppressWidthTransitionForFrame = React.useCallback(() => {
    setSuppressWidthTransition(true);
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
    suppressWidthTransitionFrameRef.current = window.requestAnimationFrame(() => {
      suppressWidthTransitionFrameRef.current = null;
      setSuppressWidthTransition(false);
    });
  }, []);

  React.useEffect(() => () => {
    if (suppressWidthTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(suppressWidthTransitionFrameRef.current);
    }
  }, []);

  React.useLayoutEffect(() => {
    const wasOpen = previousIsOpenRef.current;
    previousIsOpenRef.current = isOpen;

    if (!isOpen) {
      setSuppressWidthTransition(false);
      return;
    }

    if (wasOpen) {
      return;
    }

    suppressWidthTransitionForFrame();
  }, [isOpen, suppressWidthTransitionForFrame]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) {
        panel.focus({ preventScroll: true });
      }
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const applyLiveWidth = useEvent((nextWidth: number) => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const liveWidth = clampWidthToAvailableSpace(nextWidth, panel);
    panel.style.setProperty('--yuri-context-panel-width', `${liveWidth}px`);
    onReservedWidthChange?.(liveWidth);
  });

  const handleResizeStart = useEvent((event: React.PointerEvent) => {
    if (!isOpen || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore; fallback listeners still handle drag
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    const initialWidth = panelRef.current?.clientWidth || width;
    startWidthRef.current = initialWidth;
    resizingWidthRef.current = initialWidth;
    if (requestedExpanded) toggleContextPanelExpanded(directoryKey);
    applyLiveWidth(initialWidth);
    event.preventDefault();
  });

  const handleResizeMove = React.useCallback((event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampWidthToAvailableSpace(startWidthRef.current + delta, panelRef.current);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  }, [applyLiveWidth, isResizing]);

  const handleResizeEnd = React.useCallback((event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = clampWidthToAvailableSpace(resizingWidthRef.current ?? width, panelRef.current);
    suppressWidthTransitionForFrame();
    applyLiveWidth(finalWidth);
    resizingWidthRef.current = finalWidth;
    setContextPanelWidth(directoryKey, finalWidth);
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [applyLiveWidth, directoryKey, setContextPanelWidth, suppressWidthTransitionForFrame, width]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    const sessionId = btwSessionId;
    if (sessionId) useSessionBtwStore.getState().cancel({ sessionId, directory: effectiveDirectory, host: remote ? host.entry : undefined });
    closeContextPanel(directoryKey);
  }, [btwSessionId, effectiveDirectory, host, remote, closeContextPanel, directoryKey]);

  const handleToggleExpanded = useEvent(() => {
    if (!directoryKey) {
      return;
    }
    if (!isExpanded) {
      toggleContextPanelExpanded(directoryKey);
      return;
    }
    const preferredWidth = lastSplitWidthRef.current.width;
    const restoredWidth = clampWidth(Math.min(preferredWidth, getMaxSplitWidth?.() ?? preferredWidth));
    if (restoredWidth !== width) setContextPanelWidth(directoryKey, restoredWidth);
    if (requestedExpanded) toggleContextPanelExpanded(directoryKey);
  });

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && activeTab && directoryKey) {
      event.preventDefault();
      event.stopPropagation();
      closePanelTab(activeTab.id);
      return;
    }
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [activeTab, closePanelTab, directoryKey, handleClose]);

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }

    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath, { allowOutsideRoot: true });
      return;
    }

  }, [activeTab, directoryKey, setSelectedFilePath]);

  const activeChatTabID = activeTab?.mode === 'chat' ? activeTab.id : null;
  const activeChatSessionID = resolveContextPanelViewedSessionId(
    activeChatTabID ? sessionNavigationByTabId[createContextPanelSessionSurfaceId(directoryKey, activeChatTabID)] : undefined,
    activeChatTabID ? getSessionIDFromDedupeKey(activeTab?.dedupeKey) : null,
  );

  React.useEffect(() => {
    if (remote || !previewVisible || !directoryKey || !activeChatSessionID) {
      setContextPanelViewedSession('', null);
      return;
    }
    setContextPanelViewedSession(directoryKey, activeChatSessionID);
    return () => {
      setContextPanelViewedSession('', null);
    };
  }, [activeChatSessionID, directoryKey, previewVisible, remote]);

  React.useEffect(() => {
    if (remote || !previewVisible || !directoryKey || !activeChatSessionID || typeof window === 'undefined') {
      return;
    }

    const markActiveChatViewed = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        setExternallyViewedSession(directoryKey, activeChatSessionID, false);
        return;
      }

      markSessionViewed(activeChatSessionID);
      setExternallyViewedSession(directoryKey, activeChatSessionID, true);
    };

    markActiveChatViewed();
    const interval = window.setInterval(markActiveChatViewed, 10_000);
    window.addEventListener('focus', markActiveChatViewed);
    window.addEventListener('blur', markActiveChatViewed);
    document.addEventListener('visibilitychange', markActiveChatViewed);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', markActiveChatViewed);
      window.removeEventListener('blur', markActiveChatViewed);
      document.removeEventListener('visibilitychange', markActiveChatViewed);
      setExternallyViewedSession(directoryKey, activeChatSessionID, false);
    };
  }, [activeChatSessionID, directoryKey, previewVisible, remote]);

  const getEmbeddedChatSrc = React.useCallback((tabID: string, sessionID: string, readOnly: boolean): string => {
    return getOrCreateEmbeddedSessionChatURL(chatFrameSrcByTabIDRef.current, tabID, sessionID, directoryKey || null, readOnly, {
      mode: themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    });
  }, [currentTheme, darkThemeId, directoryKey, lightThemeId, themeMode]);

  React.useEffect(() => {
    const liveTabIDs = new Set(tabs.map((tab) => tab.id));
    for (const tabID of chatFrameSrcByTabIDRef.current.keys()) {
      if (!liveTabIDs.has(tabID)) {
        chatFrameSrcByTabIDRef.current.delete(tabID);
      }
    }
  }, [tabs]);

  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || (activeTab?.mode !== 'diff' && activeTab?.mode !== 'file-diff')) {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: activeTab.mode,
      targetPath: activeTab.targetPath,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);

  const postThemeSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const payload = {
      themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    };

    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const directThemeSync = (frameWindow as unknown as {
        __yuriApplyThemeSync?: (themePayload: typeof payload) => void;
      }).__yuriApplyThemeSync;

      if (typeof directThemeSync === 'function') {
        try {
          directThemeSync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: 'yuri:theme-sync',
          payload,
        },
        window.location.origin,
      );
    }
  }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

  const postChatSettingsSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const payload = { allowPromptingSubagentSessions };
    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) continue;

      const directSync = (frameWindow as unknown as {
        __yuriApplyChatSettingsSync?: (settings: typeof payload) => void;
      }).__yuriApplyChatSettingsSync;
      if (typeof directSync === 'function') {
        try {
          directSync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage({ type: 'yuri:chat-settings-sync', payload }, window.location.origin);
    }
  }, [allowPromptingSubagentSessions]);

  const postEmbeddedVisibilityToChats = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    for (const [tabID, frame] of chatFrameRefs.current.entries()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const payload = { visible: previewVisible && activeChatTabID === tabID };
      const directVisibilitySync = (frameWindow as unknown as {
        __yuriSetEmbeddedVisibility?: (visibilityPayload: typeof payload) => void;
      }).__yuriSetEmbeddedVisibility;

      if (typeof directVisibilitySync === 'function') {
        try {
          directVisibilitySync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: EMBEDDED_SESSION_CHAT_VISIBILITY_EVENT,
          payload,
        },
        window.location.origin,
      );
    }
  }, [activeChatTabID, previewVisible]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const isKnownChatFrame = Array.from(chatFrameRefs.current.values())
        .some((frame) => frame.contentWindow === event.source);
      if (!isKnownChatFrame) {
        return;
      }

      const data = event.data as { type?: unknown };
      if (data?.type === EMBEDDED_SESSION_CHAT_CLOSE_TAB_EVENT) {
        const frameEntry = Array.from(chatFrameRefs.current.entries())
          .find(([, frame]) => frame.contentWindow === event.source);
        if (frameEntry && directoryKey) {
          closePanelTab(frameEntry[0]);
        }
        return;
      }

      if (data?.type === 'yuri:chat-settings-request') {
        postChatSettingsSyncToEmbeddedChat();
        return;
      }
      if (data?.type === EMBEDDED_SESSION_CHAT_VISIBILITY_REQUEST_EVENT) {
        // Child finished wiring its listener after parent onLoad may already
        // have pushed a visibility message into the void — re-send current state.
        postEmbeddedVisibilityToChats();
        return;
      }
      if (data?.type !== 'yuri:cycle-theme-request') {
        return;
      }

      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const currentIndex = modes.indexOf(themeMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      setThemeMode(modes[nextIndex]);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [closePanelTab, directoryKey, postChatSettingsSyncToEmbeddedChat, postEmbeddedVisibilityToChats, setThemeMode, themeMode]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postChatSettingsSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postChatSettingsSyncToEmbeddedChat, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  const tabItems = React.useMemo(() => tabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [effectiveDirectory, sessionTitleById, t, tabs]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelContent active={previewVisible} />
        : activeTab?.mode === 'preview'
                ? <PreviewPane key={`${directoryKey}:${host?.entry.connectionGeneration ?? ''}:${activeTab.id}`} rawUrl={activeTab.targetPath ?? ''} onNavigate={(url) => openContextPreview(directoryKey, url)} />
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                    <div aria-hidden="true" className="flex h-18 w-24 flex-col overflow-hidden rounded-lg border border-current/35 text-muted-foreground/45">
                      <div className="flex h-3.5 shrink-0 items-end border-b border-current/25 px-2">
                        <span className="h-1.5 w-5 rounded-t-sm bg-current/20" />
                      </div>
                      <div className="flex min-h-0 flex-1">
                        <div className="flex w-6 shrink-0 flex-col gap-1.5 border-r border-current/25 px-1.5 py-3">
                          <span className="h-0.5 w-full rounded-full bg-current/40" />
                          <span className="h-0.5 w-2 rounded-full bg-current/25" />
                          <span className="h-0.5 w-full rounded-full bg-current/25" />
                        </div>
                        <div className="flex flex-1 items-center justify-center">
                          <Icon name="file-text" className="size-7" />
                        </div>
                      </div>
                    </div>
                    <p className="typography-ui-label text-muted-foreground">{t('contextPanel.empty.selectFile')}</p>
                  </div>
                );

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const browserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser'),
    [tabs],
  );
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff' || tab.mode === 'file-diff'),
    [tabs],
  );
  // Browser network follows the session Location, not the window's Relay mode.
  const BrowserPane = isElectronBrowserRuntime() ? ElectronBrowserPane : IframeBrowserPane;
  const nativeBrowserVisible = previewVisible && activeTab?.mode === 'browser' && BrowserPane === ElectronBrowserPane;
  React.useLayoutEffect(() => {
    if (!nativeBrowserVisible) return;
    // MainLayout owns one ContextPanel. Publish only visibility transitions;
    // root :has(descendant) otherwise invalidates the whole tree on text edits.
    const root = document.documentElement;
    root.setAttribute('data-yuri-native-browser-visible', '');
    return () => root.removeAttribute('data-yuri-native-browser-visible');
  }, [nativeBrowserVisible]);
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';
  const [retainedFileTarget, setRetainedFileTarget] = React.useState<{ directory: string; path: string | null } | null>(null);
  const fileTargetPath = isFileTabActive
    ? activeTab.targetPath
    : retainedFileTarget?.directory === directoryKey
      && tabs.some((tab) => tab.mode === 'file' && tab.targetPath === retainedFileTarget.path)
      ? retainedFileTarget.path
      : null;
  React.useEffect(() => {
    setRetainedFileTarget((current) => current?.directory === directoryKey && current.path === fileTargetPath
      ? current
      : { directory: directoryKey, path: fileTargetPath ?? null });
  }, [directoryKey, fileTargetPath]);
  const fileNotice = isFileTabActive ? activeTab?.fileNotice ?? null : null;

  React.useEffect(() => {
    const liveChatSurfaceIDs = new Set(chatTabs.map((tab) => createContextPanelSessionSurfaceId(directoryKey, tab.id)));
    commitSessionNavigation((current) => {
      let changed = false;
      const next: Record<string, ContextPanelNavigationState> = {};
      for (const tab of chatTabs) {
        const sessionId = getSessionIDFromDedupeKey(tab.dedupeKey);
        if (!sessionId) continue;
        const surfaceId = createContextPanelSessionSurfaceId(directoryKey, tab.id);
        const existing = current[surfaceId];
        next[surfaceId] = existing ?? createContextPanelNavigationState({ sessionId, directory: directoryKey });
        changed ||= !existing;
      }
      const retained = cleanupContextPanelNavigationSurfaces(current, liveChatSurfaceIDs);
      changed ||= retained !== current;
      return changed ? { ...retained, ...next } : current;
    });
    for (const tabId of Object.keys(sessionCache.tabs)) {
      if (!liveChatSurfaceIDs.has(createContextPanelSessionSurfaceId(directoryKey, tabId)) || sessionCache.tabs[tabId]?.directory !== directoryKey) dispatchSessionCache({ type: 'close-tab', tabId });
    }
  }, [chatTabs, commitSessionNavigation, directoryKey, sessionCache.tabs]);

  const activeChatSurfaceId = activeChatTabID ? createContextPanelSessionSurfaceId(directoryKey, activeChatTabID) : null;
  const activeChatAnchor = activeChatTabID ? getSessionIDFromDedupeKey(activeTab?.dedupeKey) : null;
  const activeChatNavigation = activeChatSurfaceId && activeChatAnchor
    ? resolveContextPanelActiveNavigation(sessionNavigationByTabId[activeChatSurfaceId], { sessionId: activeChatAnchor, directory: directoryKey })
    : undefined;
  const activeChatViewKey = activeChatNavigation && activeChatSurfaceId
    ? createContextPanelSessionViewKey(runtimeKey, activeChatSurfaceId, activeChatNavigation.current.directory, activeChatNavigation.current.sessionId)
    : null;

  React.useLayoutEffect(() => {
    if (chatRenderMode !== 'react-surface' || !isOpen || !activeChatTabID || !activeChatNavigation || !activeChatSurfaceId || !activeChatViewKey) {
      if (chatRenderMode === 'react-surface') dispatchSessionCache({ type: 'activate', viewKey: null, now: Date.now() });
      return;
    }
    commitSessionNavigation((current) => current[activeChatSurfaceId]
      ? current
      : { ...current, [activeChatSurfaceId]: activeChatNavigation });
    dispatchSessionCache({
      type: 'touch',
      tab: { tabId: activeChatTabID, sessionId: activeChatNavigation.anchor.sessionId, directory: activeChatNavigation.anchor.directory },
      view: { tabId: activeChatTabID, surfaceId: activeChatSurfaceId, sessionId: activeChatNavigation.current.sessionId, directory: activeChatNavigation.current.directory, viewKey: activeChatViewKey },
      now: Date.now(),
    });
  }, [activeChatNavigation, activeChatSurfaceId, activeChatTabID, activeChatViewKey, chatRenderMode, commitSessionNavigation, isOpen]);

  const handleSessionNavigate = React.useCallback((tabId: string, sessionId: string, directory: string): boolean => {
    const surfaceId = createContextPanelSessionSurfaceId(directoryKey, tabId);
    let accepted = false;
    commitSessionNavigation((current) => {
      const targetDirectory = remote && host ? locationKey({ ...host.entry.location, directory: parseLocationKey(directory, host.entry.location.hubId).directory }) : directory;
      const result = updateContextPanelNavigation(current, surfaceId, { sessionId, directory: targetDirectory });
      accepted = result.accepted;
      return result.navigationBySurfaceId;
    });
    return accepted;
  }, [commitSessionNavigation, directoryKey, remote, host]);

  const handleSessionNavigateBack = React.useCallback((tabId: string) => {
    const surfaceId = createContextPanelSessionSurfaceId(directoryKey, tabId);
    commitSessionNavigation((current) => {
      const state = current[surfaceId];
      if (!state) return current;
      const next = navigateContextPanelBack(state);
      return next === state ? current : { ...current, [surfaceId]: next };
    });
  }, [commitSessionNavigation, directoryKey]);

  const header = (
    <header
      className={cn(
        'app-region-drag flex shrink-0 select-none items-center pl-2',
        currentTheme.metadata.variant === 'light' && [
          '[--interactive-hover:color-mix(in_srgb,var(--surface-foreground)_6%,var(--background))]',
          '[--interactive-active:color-mix(in_srgb,var(--surface-foreground)_10%,var(--background))]',
        ],
      )}
      style={{
        height: 'calc(var(--yuri-header-height, 3rem) - 0.75rem * var(--padding-scale, 1))',
        minHeight: 'calc(max(3rem, var(--yuri-wco-titlebar-height, 0px)) - 0.75rem * var(--padding-scale, 1))',
        paddingRight: 'calc(0.75rem + var(--yuri-wco-right-inset, 0px))',
        ...(fillAvailableSpace && !isSidebarOpen ? { paddingLeft: 'calc(var(--yuri-titlebar-left-inset, 0.75rem) + var(--yuri-titlebar-controls-width, 5.5rem) + 0.5rem)' } : {}),
      }}
    >
      <SortableTabsStrip
        items={tabItems}
        activeId={activeTab?.id ?? null}
        onSelect={(tabID) => {
          if (!directoryKey) {
            return;
          }
          setActiveContextPanelTab(directoryKey, tabID);
        }}
        onClose={(tabID) => {
          closePanelTab(tabID);
        }}
        onReorder={(activeTabID, overTabID) => {
          if (!directoryKey) {
            return;
          }
          reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
        }}
        layoutMode="scrollable"
        variant="compact"
        className="app-region-no-drag h-6"
      />
      <div className="app-region-no-drag flex shrink-0 items-center gap-1 pl-1.5">
        {isOpen ? <RightSidebarToolbar railVisible={railVisible} /> : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className="h-7 w-7 p-0"
          title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          aria-pressed={isExpanded}
        >
          <Icon name={isExpanded ? 'collapse-diagonal' : 'expand-diagonal'} className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
        <WindowsWindowControls visible={isOpen && usesFramelessChrome && windowControlsSide === 'right'} position="right" />
      </div>
    </header>
  );

  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--yuri-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        width: 0,
        minWidth: 0,
        maxWidth: 0,
        opacity: 0,
        overflow: 'hidden',
        visibility: 'hidden',
      }
      : {
          width: isExpanded ? '100%' : 'min(var(--yuri-context-panel-width), 100%)',
          minWidth: `min(${CONTEXT_PANEL_MIN_WIDTH}px, 100%)`,
          maxWidth: '100%',
          ['--yuri-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-native-browser-visible={nativeBrowserVisible ? 'true' : undefined}
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-visible bg-transparent',
        isOpen && 'py-1.5 pl-1 pr-1.5',
        'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        isResizing || !isOpen || suppressWidthTransition || onReservedWidthChange ? 'transition-none' : 'transition-[width] duration-200 ease-in-out'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
        <Tooltip>
        <TooltipTrigger asChild>
        <div
          className="group/preview-resize absolute -left-1 top-0 z-50 h-full w-4 touch-none cursor-col-resize"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
          data-context-resize-handle
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-[2px] top-1/2 h-14 w-[3px] -translate-y-1/2 rounded-full bg-muted-foreground/25 opacity-0 transition-opacity duration-150 group-hover/preview-resize:opacity-100',
              isResizing && 'opacity-100',
            )}
          />
        </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={4}>{t('contextPanel.actions.resizePanel')}</TooltipContent>
        </Tooltip>
      <WorkspaceSurface data-context-panel-surface>
      {header}
      {fileNotice === 'turn-diff-outside-workspace' ? (
        <div className="shrink-0 border-b border-status-info/20 bg-status-info/10 px-3 py-2 typography-meta text-status-info">
          {t('contextPanel.file.notice.turnDiffOutsideWorkspace')}
        </div>
      ) : null}
      <div ref={previewBodyRef} className={cn('relative flex min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')} data-context-layout={isCompact ? 'single' : 'split'}>
      <div className={cn('min-h-0 min-w-0 flex-1 flex-col overflow-hidden', previewVisible ? 'flex' : 'hidden')} inert={!previewVisible || undefined} data-context-preview-content>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {hasFileTabs && fileTargetPath ? (
          <div className={cn('absolute inset-0', isFileTabActive ? 'block' : 'hidden')}>
            <FilesView
              key={`${directoryKey}:${fileTargetPath ?? ''}`}
              mode="editor-only"
              targetPath={fileTargetPath}
              isActive={previewVisible && isFileTabActive}
            />
          </div>
        ) : null}
        {chatRenderMode === 'legacy-iframe' && chatTabs.map((tab) => {
          const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
          if (!sessionID) {
            return null;
          }

          const src = getEmbeddedChatSrc(tab.id, sessionID, tab.readOnly);
          if (!src) {
            return null;
          }

          return (
            <iframe
              key={tab.id}
              ref={(node) => {
                if (!node) {
                  chatFrameRefs.current.delete(tab.id);
                  return;
                }
                chatFrameRefs.current.set(tab.id, node);
              }}
              src={src}
              title={t('contextPanel.iframe.sessionChatTitle', { sessionID })}
              className={cn(
                'absolute inset-0 h-full w-full border-0 bg-background',
                activeChatTabID === tab.id ? 'block' : 'hidden'
              )}
              onLoad={() => {
                postThemeSyncToEmbeddedChat();
                postChatSettingsSyncToEmbeddedChat();
                postEmbeddedVisibilityToChats();
              }}
            />
          );
        })}
        {chatRenderMode === 'react-surface' ? Object.values(sessionCache.mountedViews).map((view) => {
          const navigation = sessionNavigationByTabId[createContextPanelSessionSurfaceId(directoryKey, view.tabId)];
            const visible = previewVisible && activeChatTabID === view.tabId && activeChatViewKey === view.viewKey;
          return (
            <React.Activity key={view.viewKey} name={`context-panel-session-${view.sessionId}`} mode={visible ? 'visible' : 'hidden'}>
              {remote && host ? <div className="relative h-full min-h-0">
                {visible && navigation?.stack.length ? <Button type="button" variant="outline" size="xs" onClick={() => handleSessionNavigateBack(view.tabId)} className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95" aria-label={t('chat.container.returnToParent.aria')} title={t('chat.container.returnToParent.title')}><Icon name="arrow-left" className="h-4 w-4" />{t('chat.container.returnToParent.label')}</Button> : null}
                <RemoteChatContainer
                location={{ ...host.entry.location, directory: parseLocationKey(view.directory, host.entry.location.hubId).directory }}
                sessionId={view.sessionId}
                active={visible}
                readOnly={tabs.find((tab) => tab.id === view.tabId)?.readOnly ?? true}
                onNavigateSession={(sessionId, directory) => { handleSessionNavigate(view.tabId, sessionId, directory); }}
              /></div> : <ContextPanelSessionTranscript
                surfaceId={view.surfaceId}
                sessionId={view.sessionId}
                directory={view.directory}
                active={visible}
                canNavigateBack={visible && Boolean(navigation?.stack.length)}
                onNavigateSession={(sessionId, directory) => handleSessionNavigate(view.tabId, sessionId, directory)}
                onNavigateBack={() => handleSessionNavigateBack(view.tabId)}
                onEstimateBytes={(viewKey, estimatedBytes) => dispatchSessionCache({ type: 'estimate', viewKey, estimatedBytes })}
              />}
            </React.Activity>
          );
        }) : null}
        {tabs.filter((tab) => tab.mode === 'btw').map((tab) => {
          const visible = previewVisible && activeTab?.id === tab.id;
          return <React.Activity key={`btw:${directoryKey}:${btwSessionId}:${tab.id}`} name="context-panel-btw" mode={visible ? 'visible' : 'hidden'}>
            {btwSessionId
              ? <BtwPanel scope={{ sessionId: btwSessionId, directory: effectiveDirectory, host: remote ? host.entry : undefined }} hostRegistry={remote ? host.registry : undefined} active={visible} />
              : <p className="p-4 text-muted-foreground">{t('chat.btw.sessionRequired')}</p>}
          </React.Activity>;
        })}
        {browserTabs.map((tab) => (
          <div
            key={`${directoryKey}:${host?.entry.connectionGeneration ?? ''}:${tab.id}`}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <BrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
          </div>
        ))}
        {diffTabs.map((tab) => {
          const toolPatches = tab.mode === 'diff'
            && contextToolDiff?.targetPath === tab.targetPath
            && contextToolDiff.turnMessageId === tab.diffTurnMessageId
            ? contextToolDiff.patches
            : null;

          return (
            <div
              key={tab.id}
              className={cn(
                'absolute inset-0',
                activeTab?.id !== tab.id && 'hidden'
              )}
            >
              <DiffView
                hideStackedFileSidebar
                stackedDefaultCollapsedAll={!toolPatches}
                pinSelectedFileHeaderToTopOnNavigate
                showOpenInEditorAction
                diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
                turnMessageId={tab.diffTurnMessageId}
                sessionId={tab.diffSessionId}
                directory={effectiveDirectory}
                onDiffScopeChange={handleDiffScopeChange}
                targetFilePath={tab.targetPath}
                targetLine={tab.diffTargetLine ?? null}
                toolPatches={toolPatches}
                navigationRequestKey={tab.touchedAt}
                flushContent
                singleFileView={tab.mode === 'file-diff'}
                preloadFullFiles={tab.mode === 'file-diff'}
              />
            </div>
          );
        })}
        {activeTab?.mode !== 'chat' && activeTab?.mode !== 'btw' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' && activeTab?.mode !== 'file-diff' ? activeNonChatContent : null}
      </div>
      </div>
      <RightSidebar isOpen={railVisible} className={cn('!min-w-0 shrink-0 bg-transparent [--layout-chrome-divider-width:1px] [--layout-chrome-divider:color-mix(in_srgb,var(--surface-foreground)_8%,var(--background))]', isCompact && '!transition-none', isCompact && railVisible ? '!w-full !max-w-full !border-l-0 [&>[role=separator]]:hidden' : '!max-w-[50%]')}>
        {railVisible ? <ErrorBoundary><RightSidebarTabs isActive={railVisible} /></ErrorBoundary> : null}
      </RightSidebar>
      </div>
      </WorkspaceSurface>
    </aside>
  );
};
