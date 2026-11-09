import { cleanup, computed, effect, lifecycle, signal, untracked, colorScheme, locale, View, Text, Scroll, Image, Clipboard, List, type ListRef } from 'nsh';
import { Button, Input, TextView } from 'nsh/base';
import { bindRequest, native } from './runtime';
import { app, epoch } from './state';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { bindContactAttachmentRead, bindResourceRead, bindResourceStat } from './resources-request';
import { createResourceWatcher } from './resources-watcher';
import { ResourceSVGImage } from './resource-svg';
import { Icon } from './Icon';
import { ResourceHtmlViewer } from './resource-html-viewer';
import { ResourceHTMLView, ResourceHTMLPresentationAnchor } from './resource-html-native';
import type { ResourceHtmlDialog, ResourceHtmlGui, ResourceHtmlInput, ResourceHtmlViewerController } from './resource-html-viewer-state';
import { t, language } from './i18n';
import { nativeChatTextStyle, nativeAppearance, nativeCodeTextViewStyles } from './appearance';
import { bindNativeGuiPluginPreview } from './gui-plugin-native-context-factory';
import { createResourceGuiFile, type ResourceGuiState } from './resources-gui';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import type { ResourceRetirementOwner } from './resource-retirement';
import { id, type ContactAttachment } from './model';
import { resourceCanPreview, resourceEntries, resourceFence, resourceFindRoute, resourceName, resourceParent, resourcePath, resourceSearchEntries, resourceWatchable, resourceWithin, type ResourceContent, type ResourceEntry } from './resources-model';

const action = 'min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';
export type ResourcesBrowserProps = { directory: string; path?: string; sessionId?: string; active?: boolean; onClose?: () => void; onOpen?: (path: string) => void; expectedHost?: RuntimeScope | null; retirementOwner?: (owner: ResourceRetirementOwner) => void };

function createResourceNavigation(props: ResourcesBrowserProps) {
  const root = resourcePath(props.directory);
  return { root, directory: signal(root), search: signal(''), preview: signal(props.path && props.path !== root ? resourcePath(props.path) : '') };
}

export function ResourcesBrowser(props: ResourcesBrowserProps) {
  const navigation = createResourceNavigation(props);
  return <ResourceScopeBoundary {...props}>{(scope, attach) => <ResourcesBrowserOwner {...props} retirementOwner={attach} navigation={navigation} expectedHost={scope} />}</ResourceScopeBoundary>;
}

/** Receipt changes revoke reads immediately but keep the display until retirement.
 * Only then may an unscoped boundary mount a replacement. An inherited receipt
 * remains fixed, so late child previews cannot upgrade an old parent's authority. */
function ResourceScopeBoundary(props: { expectedHost?: RuntimeScope | null; retirementOwner?: (owner: ResourceRetirementOwner) => void; unavailable?: () => ReturnType<typeof View>; children: (scope: RuntimeScope, attach: (owner: ResourceRetirementOwner) => void) => ReturnType<typeof View> }) {
  const hostID = props.expectedHost?.hostID ?? app.runtimeScope()?.hostID ?? app.connection()?.id;
  const inherited = props.expectedHost === undefined ? undefined : runtimeScopeFrom(props.expectedHost);
  const available = () => {
    const current = runtimeScopeFrom(app.runtimeScope());
    if (!current || hostID && current.hostID !== hostID || inherited !== undefined && !sameRuntimeScope(inherited, current)) return [];
    return [inherited ?? current];
  };
  const initial = available()[0];
  if (!initial && inherited !== undefined) {
    props.retirementOwner?.({ retire: async () => {} });
    if (props.unavailable) return <View class="flex-1"><If when>{() => props.unavailable?.()}</If></View>;
    return <Each of={[] as RuntimeScope[]}>{scope => props.children(scope(), () => {})}</Each>;
  }
  const shown = signal<RuntimeScope | undefined>(initial), error = signal('');
  let child: ResourceRetirementOwner | undefined, live = true, exiting = false, failed = false;
  let requested = available()[0], replacing: Promise<void> | undefined;
  const retire = async () => { exiting = true; await child?.retire(); };
  props.retirementOwner?.({ retire });
  cleanup(() => { live = false; exiting = true; void child?.retire().catch(() => {}); });
  function replace() {
    if (!live || exiting || failed || replacing) return;
    replacing = Promise.resolve().then(() => child?.retire()).then(() => {
      if (!live || exiting) return;
      child = undefined; shown.set(requested);
    }).catch(cause => { failed = true; if (live) error.set(String(cause)); }).finally(() => { replacing = undefined; });
  }
  effect(() => {
    if (!live || exiting) return;
    const next = available()[0], previous = shown();
    if (sameRuntimeScope(next ?? null, previous ?? null) || !next && !previous) return;
    untracked(() => { requested = next; replace(); });
  });
  const content = () => <Each of={shown() ? [shown()!] : []} key={scope => JSON.stringify([scope.hostID, scope.lease])}>{scope => {
    const body = props.children(scope(), value => { child = value; });
    return <View class="flex-1">
    {body}
    <If when={!!error()}><Text class="text-destructive">{t('mobile.files.error.readUnavailable')}</Text><Button testID="resource-scope-retire-retry" onPress={() => { failed = false; error.set(''); replace(); }}><Text>{t('contextPanel.preview.actions.retry')}</Text></Button></If>
  </View>;
  }}</Each>;
  if (props.unavailable) return <View class="flex-1"><If when={!shown()}>{() => props.unavailable?.()}</If>{content()}</View>;
  return content();
}

function ResourcesBrowserOwner(props: ResourcesBrowserProps & { navigation: ReturnType<typeof createResourceNavigation> }) {
  const expectedHost = runtimeScopeFrom(props.expectedHost === undefined ? app.runtimeScope() : props.expectedHost);
  const request = bindRequest(expectedHost), generation = epoch();
  let retiring = false, previewOwner: ResourceRetirementOwner | undefined;
  const active = () => !retiring && !!expectedHost && generation === epoch() && sameRuntimeScope(expectedHost, app.runtimeScope()) && props.active !== false && lifecycle() === 'active';
  const { root, directory, search, preview } = props.navigation;
  const entries = signal<ResourceEntry[]>([]), busy = signal(false), error = signal('');
  const fence = resourceFence(epoch);
  props.retirementOwner?.({ retire: async () => { retiring = true; fence.cancel(); await previewOwner?.retire(); } });
  cleanup(() => { retiring = true; fence.cancel(); });
  async function load() {
    if (!active()) return;
    const valid = fence.begin(), at = directory(), term = search().trim();
    busy.set(true); error.set('');
    try {
      // Search stays on this directory and uses the authoritative Host file.find route.
      const result = term ? await request(resourceFindRoute(at, term)) : await request(`/api/fs/list?path=${encodeURIComponent(at)}`);
      const next = term ? resourceSearchEntries(result, at, root) : resourceEntries(result, root);
      if (valid() && active()) entries.set(next);
    } catch (cause) { if (valid()) error.set(String(cause)); }
    finally { if (valid()) busy.set(false); }
  }
  effect(() => {
    if (retiring) return;
    const at = directory(), term = search();
    const visible = active();
    const timer = visible ? setTimeout(() => { if (directory() === at && search() === term) void load(); }, term.trim() ? 250 : 0) : undefined;
    cleanup(() => { clearTimeout(timer); fence.cancel(); });
  });
  function open(entry: ResourceEntry) {
    if (!active()) return;
    if (entry.isDirectory) { entries.set([]); search.set(''); directory.set(entry.path); }
    else { props.onOpen?.(entry.path); preview.set(entry.path); }
  }
  return <View class="flex-1 bg-background gap-3 p-4">
    {preview() ? <ResourcePreviewOwner kind="file" directory={root} path={preview()} sessionId={props.sessionId} expectedHost={expectedHost} active={props.active} retirementOwner={value => { previewOwner = value; }} onClose={() => preview.set('')} onOpen={path => { if (!active()) return; props.onOpen?.(path); preview.set(path); }} /> : <>
      <View class="flex-row gap-2 items-center">
        {props.onClose ? <Button class={action} onPress={props.onClose}><Text class="text-foreground">{t('gitView.common.close')}</Text></Button> : null}
        {resourceParent(directory(), root) ? <Button class={action} onPress={() => { entries.set([]); search.set(''); directory.set(resourceParent(directory(), root)!); }}><Text class="text-foreground">{t('mobile.files.parentDirectory')}</Text></Button> : null}
        <Button class={action} disabled={busy()} onPress={() => void load()}><Text class="text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
      </View>
      <Text class="text-sm text-muted-foreground">{directory()}</Text>
      <Input testID="resource-search" class="text-foreground min-h-11 px-3 rounded-xl bg-secondary" value={search()} placeholder={t('mobile.files.search.placeholder')} onChange={event => { fence.cancel(); entries.set([]); search.set(event.value); }} />
      {busy() ? <Text class="text-muted-foreground">{t('common.loading')}</Text> : null}
      {error() ? <Text class="text-destructive">{error()}</Text> : null}
      {!busy() && !entries().length && !error() ? <Text class="text-muted-foreground">{t(search().trim() ? 'mobile.files.search.empty' : 'mobile.files.empty.directory')}</Text> : null}
      <List class="flex-1" each={entries()} keyExtractor={entry => entry.path}>{entry => <Button class="min-h-14 px-3 py-3 bg-card active:bg-accent" onPress={() => open(entry())}><View class="gap-1"><Text class="text-foreground">{entry().isDirectory ? '▸ ' : ''}{entry().name}</Text><Text class="text-xs text-muted-foreground">{entry().path}{entry().size === undefined ? '' : ` · ${entry().size} B`}</Text></View></Button>}</List>
    </>}
  </View>;
}

export function ResourcePreview(props: ResourcesBrowserProps & { path: string; targetLine?: number; guiPreview?: boolean }) {
  return <ResourceScopeBoundary {...props}>{(scope, attach) => <ResourcePreviewOwner {...props} retirementOwner={attach} kind="file" expectedHost={scope} />}</ResourceScopeBoundary>;
}

export type ContactAttachmentPreviewProps = { file: ContactAttachment; expectedHost: RuntimeScope; active: boolean; onClose?: () => void; retirementOwner?: (owner: ResourceRetirementOwner) => void };

export function ContactAttachmentPreview(props: ContactAttachmentPreviewProps) {
  return <ResourceScopeBoundary expectedHost={runtimeScopeFrom(props.expectedHost)} retirementOwner={props.retirementOwner} unavailable={() => <View class="flex-1 gap-3"><Text class="text-sm text-muted-foreground">{t('mobile.files.error.previewExpired')}</Text><If when={!!props.onClose}><Button onPress={() => props.onClose?.()}><Text>{t('gitView.common.close')}</Text></Button></If></View>}>{(scope, attach) => <ResourcePreviewOwner {...props} retirementOwner={attach} kind="contact" expectedHost={scope} />}</ResourceScopeBoundary>;
}

type ResourcePreviewOwnerProps = (ResourcesBrowserProps & { kind: 'file'; path: string; targetLine?: number; guiPreview?: boolean })
  | (ContactAttachmentPreviewProps & { kind: 'contact' });

function ResourcePreviewOwner(props: ResourcePreviewOwnerProps) {
  const expectedHost = runtimeScopeFrom(props.expectedHost === undefined ? app.runtimeScope() : props.expectedHost);
  const fs = () => props.kind === 'file' ? props : undefined;
  const readFile = bindResourceRead(expectedHost, native), readContact = bindContactAttachmentRead(expectedHost, native);
  const statFile = bindResourceStat(expectedHost, bindRequest(expectedHost));
  const webPreview = fs() ? bindResourceWebPreview(expectedHost, native, id) : undefined;
  const name = () => props.kind === 'contact' ? props.file.name : resourceName(props.path);
  const sourceKey = () => props.kind === 'contact' ? JSON.stringify(['contact', props.file]) : JSON.stringify(['file', resourcePath(props.path), props.sessionId, props.targetLine, props.guiPreview]);
  const targetLine = () => fs()?.targetLine;
  const generation = epoch();
  const content = signal<ResourceContent | null>(null), busy = signal(false), error = signal(''), source = signal(false);
  let cleanupLease = content()?.lease;
  const viewerOwner = id(), guiResolution = signal<ResourceHtmlGui>('preparing'), presenterReady = signal('');
  let htmlController: ResourceHtmlViewerController | undefined;
  const presentationKey = (owner?: ResourceHtmlDialog) => owner ? `${viewerOwner}_${owner.generation}` : undefined;
  const html = () => !!fs() && /\.html?$/i.test(name());
  let lineList: ListRef | undefined, revealedTarget = '';
  const lines = computed(() => content()?.kind === 'text' && targetLine() !== undefined ? (content()?.text ?? '').split('\n') : []);
  const targetIndex = () => { const line = targetLine(); return line !== undefined && Number.isInteger(line) && line > 0 && line <= lines().length ? line - 1 : -1; };
  function revealLine() {
    const index = targetIndex(), key = `${sourceKey()}:${content()?.lease}:${index}`;
    if (index < 0 || !lineList || key === revealedTarget) return;
    lineList.scrollToIndex({ index, animated: false, viewPosition: .25 });
    revealedTarget = key;
  }
  const fence = resourceFence(epoch);
  let disposed = false, readAuthority = true, retirement: Promise<void> | undefined, retired = false;
  const active = () => !disposed && readAuthority && generation === epoch() && sameRuntimeScope(expectedHost, app.runtimeScope()) && (props.kind === 'contact' ? props.active === true : props.active !== false) && lifecycle() === 'active';
  const connection = app.connection();
  const appearanceScope = connection ? Object.freeze({ hostID: connection.id, generation, url: connection.url }) : null;
  const guiState = signal<ResourceGuiState>({ preparing: false, matched: false, failed: false });
  const gui = fs() ? createResourceGuiFile({ expectedHost, active, changed: value => {
    if (disposed) return;
    guiState.set(value);
    if (value.failed) guiResolution.set('failed');
    else if (value.matched) guiResolution.set('matched');
    else if (value.preparing) guiResolution.set('preparing');
  }, unmatched: () => { if (!disposed) guiResolution.set('unmatched'); }, capture: scope => {
    if (!appearanceScope) throw new Error('GUI_APPEARANCE_UNAVAILABLE');
    return bindNativeGuiPluginPreview({ expectedHost: scope, appearanceScope, appearance: nativeAppearance.current(), systemMode: colorScheme(),
      locale: language() === 'system' ? locale() : language(), t, call: native, identify: id, isCurrent: active });
  } }) : undefined;
  const guiIntent = () => { const file = fs(); if (!file) throw new Error('resource_path_required'); return { directory: file.directory, path: file.path, ...(file.sessionId === undefined ? {} : { sessionId: file.sessionId }) }; };
  let readID: string | undefined, loadedScope = '', contentSource = sourceKey(), guiCycle = 0;
  function cancelRead() {
    const requestId = readID; readID = undefined;
    if (requestId) void native('resources.cancel', { requestId }).catch(() => {});
  }
  function closeLease(lease: string, release = false) {
    void native('resources.close', { lease }).catch(() => {}).then(() => release ? native('resources.release', { lease }).catch(() => {}) : undefined);
  }
  const watcher = props.kind === 'file' ? createResourceWatcher({ current: active, identity: sourceKey, available: () => !busy(),
    stat: () => statFile(props.path), read: readContent, failed: cause => error.set(String(cause)) }) : undefined;
  function retire(): Promise<void> {
    if (retired) return Promise.resolve();
    if (retirement) return retirement;
    readAuthority = false; watcher?.dispose(); fence.cancel(); cancelRead();
    if (!disposed) busy.set(false);
    const lease = cleanupLease;
    retirement = Promise.resolve().then(async () => {
      await Promise.all([gui?.dispose(), webPreview?.close(), htmlController?.dispose(), lease ? native('resources.close', { lease }) : undefined]);
      if (lease) await native('resources.release', { lease });
      cleanupLease = undefined; retired = true;
    }).catch(cause => { if (!disposed) error.set(String(cause)); throw cause; }).finally(() => { retirement = undefined; });
    return retirement;
  }
  props.retirementOwner?.({ retire });
  cleanup(() => { disposed = true; htmlController?.detachDisplay(); void retire().catch(() => {}); });
  async function readContent() {
    if (!active() || busy()) return;
    cancelRead();
    const requestId = id(); readID = requestId;
    const valid = fence.begin(), readingSource = sourceKey(); busy.set(true); error.set('');
    try {
      const next = await (props.kind === 'contact' ? readContact(props.file, requestId) : readFile(props.path, requestId)) as ResourceContent;
      if (!valid() || !active() || readingSource !== sourceKey()) { void native('resources.release', { lease: next.lease }).catch(() => {}); return; }
      const previous = content(); contentSource = readingSource; cleanupLease = next.lease; content.set(next);
      if (previous) closeLease(previous.lease, true);
      return next.stat;
    } catch (cause) { if (valid() && active() && readingSource === sourceKey()) error.set(String(cause)); throw cause; }
    finally { if (readID === requestId) readID = undefined; if (valid()) busy.set(false); }
  }
  const load = () => watcher ? watcher.refresh() : readContent().catch(() => {});
  const htmlInput = (): ResourceHtmlInput => ({ identity: JSON.stringify([expectedHost, fs()?.directory, fs()?.path]), active: active(),
    htmlFile: html() && content()?.kind === 'text' && contentSource === sourceKey(), targetLine: targetLine(), gui: fs()?.guiPreview === false ? 'bypassed' : guiResolution() });
  effect(() => {
    if (disposed || !readAuthority) return;
    const scope = JSON.stringify([app.connection()?.id, app.runtimeScope(), epoch(), sourceKey()]), visible = active();
    untracked(() => {
      const cycle = ++guiCycle, identity = sourceKey();
      watcher?.pause(); fence.cancel(); cancelRead(); busy.set(false);
      if (scope !== loadedScope && visible) {
        loadedScope = scope;
        watcher?.reset();
        const previous = content(); cleanupLease = undefined; content.set(null); source.set(false);
        if (previous) closeLease(previous.lease, true);
      }
      if (!visible) { void gui?.close(true).catch(cause => { if (!disposed) error.set(String(cause)); }); void webPreview?.close().catch(cause => { if (!disposed) error.set(String(cause)); }); const lease = content()?.lease; if (lease) closeLease(lease); return; }
      if (props.kind === 'file' && resourceWatchable(props.path)) watcher?.start();
      if (fs()?.guiPreview !== false && gui) {
        guiResolution.set('preparing');
        void (async () => {
          try {
            await htmlController?.update(htmlInput()); await htmlController?.waitRetired();
            if (cycle === guiCycle && active() && sourceKey() === identity) await gui.open(guiIntent(), { targetLine: targetLine() });
          } catch (cause) { if (cycle === guiCycle && active()) { guiResolution.set('failed'); error.set(String(cause)); } }
        })();
      }
      if (!content()) void load();
    });
  });
  async function perform(action: string, owner?: ResourceHtmlDialog) {
    if (!active() || busy() || !content() || contentSource !== sourceKey()) return;
    const presenter = presentationKey(owner);
    if (owner && (presenterReady() !== presenter || htmlController?.state().dialog?.generation !== owner.generation || !htmlController.state().dialog?.open)) return;
    const valid = fence.begin(); busy.set(true); error.set('');
    void htmlController?.setPresentationPending(true);
    try { await native('resources.present', { lease: content()?.lease, action, ...(presenter ? { presentationOwner: presenter } : {}) }); }
    catch (cause) { if (valid()) error.set(String(cause)); }
    finally { void htmlController?.setPresentationPending(false); if (valid()) busy.set(false); }
  }
  const markdown = () => /\.(md|mdx|markdown)$/i.test(name()) || props.kind === 'contact' && props.file.mime.split(';')[0].trim().toLowerCase() === 'text/markdown';
  const rich = () => markdown() && !source();
  async function previewHTML(href?: string) {
    const file = fs();
    if (!file || !webPreview || !active() || busy()) return;
    const current = fence.begin(); busy.set(true); error.set('');
    try { await webPreview.present({ directory: file.directory, ...(href === undefined ? { path: file.path } : { href }) }); }
    catch { if (current()) error.set(t('mobile.files.error.readUnavailable')); }
    finally { if (current()) busy.set(false); }
  }
  async function chooseGUI() {
    if (!active() || !gui || busy()) return;
    try {
      if (guiState().preparing) { await gui.close(); if (active()) guiResolution.set('bypassed'); return; }
      guiResolution.set('preparing');
      await htmlController?.update(htmlInput());
      await htmlController?.waitRetired();
      if (!active()) return;
      await gui.open(guiIntent(), { manual: true, targetLine: targetLine() });
    } catch (cause) { if (!disposed) { guiResolution.set('failed'); error.set(String(cause)); } }
  }
  async function back() {
    if (htmlController?.state().dialog) { await htmlController.back(); return; }
    try { await retire(); if (!disposed) props.onClose?.(); }
    catch (cause) { if (!disposed) error.set(String(cause)); }
  }
  const actions = (owner?: ResourceHtmlDialog) => owner ? <View class="flex-row items-center">
    <Button testID="resource-html-save" class="min-h-11 min-w-11 items-center justify-center" disabled={busy() || !content() || presenterReady() !== presentationKey(owner)} accessibilityLabel={t('sessions.scheduledTasks.editor.actions.save')} onPress={() => { void perform('save', owner); }}><Icon name="download" size={18} /></Button>
    <Button testID="resource-html-share" class="min-h-11 min-w-11 items-center justify-center" disabled={busy() || !content() || presenterReady() !== presentationKey(owner)} accessibilityLabel={t('sessions.sidebar.session.menu.share')} onPress={() => { void perform('share', owner); }}><Icon name="share-2" size={18} /></Button>
   </View> : <View testID="resource-inline-actions" class="w-full min-w-0 flex-row flex-wrap gap-2">
      {props.onClose ? <Button class={action} disabled={busy()} onPress={() => { void back(); }}><Text class="text-foreground">{t('gitView.common.close')}</Text></Button> : null}
      <Button class={action} disabled={busy()} onPress={() => void load()}><Text class="text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
      {fs() ? <Button class={action} onPress={() => { const file = fs(); if (file) void Clipboard.writeText(file.path).catch(cause => error.set(String(cause))); }}><Text class="text-foreground">{t('mobile.files.copyPathAria')}</Text></Button> : null}
      {gui && (guiState().preparing || guiState().matched || guiState().failed) ? <Button testID="resource-gui-preview" class={action} disabled={busy()} onPress={() => { void chooseGUI(); }}><Text class="text-foreground">{t(guiState().preparing ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode')}</Text></Button> : null}
      {content()?.kind === 'text' ? <>
        {targetLine() === undefined && markdown() ? <Button class={action} onPress={() => source.set(!source())}><Text class="text-foreground">{t(source() ? 'mobile.files.html.viewPreviewAria' : 'mobile.files.html.viewSourceAria')}</Text></Button> : null}
        <Button class={action} onPress={() => { if (active() && contentSource === sourceKey()) void Clipboard.writeText(content()?.text || '').catch(cause => error.set(String(cause))); }}><Text class="text-foreground">{t('mobile.files.copyContent')}</Text></Button>
      </> : null}
      <Button class={action} disabled={busy() || !content()} onPress={() => void perform('save')}><Text class="text-foreground">{t('sessions.scheduledTasks.editor.actions.save')}</Text></Button>
      <Button class={action} disabled={busy() || !content()} onPress={() => void perform('share')}><Text class="text-foreground">{t('sessions.sidebar.session.menu.share')}</Text></Button>
    </View>;
  const status = () => <View>
    <If when={busy() && readID !== undefined}><Text testID="resource-read-loading" class="text-muted-foreground">{t('common.loading')}</Text></If>
    {error() ? <Text class="text-destructive">{error()}</Text> : null}
    {guiState().failed ? <Text class="text-muted-foreground">{t('guiPlugins.error')}</Text> : null}
  </View>;
  const renderSource = () => content()?.kind === 'text' ? <If when={targetLine() !== undefined} else={<Scroll class="flex-1"><TextView selectable links="report" styles={nativeCodeTextViewStyles()} markdown={rich() ? content()?.text : undefined} document={rich() ? undefined : { blocks: [{ type: 'codeBlock', code: content()?.text || '', language: name().split('.').pop() }] }} renderImage={image => {
      const file = fs();
      if (file) return <ResourceInlineImage directory={file.directory} path={file.path} source={image.src} expectedHost={expectedHost} />;
      if (!active() || contentSource !== sourceKey()) return <Text>{t('mobile.files.error.readUnavailable')}</Text>;
      return /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.src) ? <Image class="w-full h-64" src={image.src} /> : <Text>{t('mobile.files.error.readUnavailable')}</Text>;
    }} onLinkPress={event => {
      const file = fs();
      if (!file || !active()) return;
      const path = resolveResourceLink(file.path, event.url, file.directory);
      if (path) file.onOpen?.(path);
      else if (resourceWebPreviewIntent({ directory: file.directory, href: event.url }).supported) void previewHTML(event.url);
    }} /></Scroll>}>
      <If when={targetIndex() < 0}><Text class="text-muted-foreground">{t('diffView.actions.openFileAtFirstChangedLine')} · {t('common.unavailable')}</Text></If>
      <List testID="resource-source-lines" class="flex-1" ref={value => { lineList = value; }} each={lines()} keyExtractor={(_, index) => String(index)} initialScrollIndex={Math.max(0, targetIndex())} onLayout={revealLine}>{(line, index) => <View selectable testID={`resource-line-${index() + 1}`} class={index() === targetIndex() ? 'flex-row gap-3 px-2 py-0.5 bg-accent' : 'flex-row gap-3 px-2 py-0.5'}><Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('code'), width: 48 }}>{index() + 1}</Text><Text class="flex-1 text-foreground" style={nativeChatTextStyle('code')}>{line() || ' '}</Text></View>}</List>
    </If> : null;
  const previewUnavailable = () => {
    const value = content();
    if (!value || contentSource !== sourceKey() || guiState().matched) return false;
    // Text/source (including HTML) and SVG have their own display/error owners.
    // The generic native presenter capability does not describe those renderers.
    if (value.kind === 'text' || value.kind === 'svg') return false;
    return value.kind === 'binary' || value.preview === 'unsupported';
  };
  return <View class="flex-1 gap-3">
    <Text class="text-lg font-semibold text-foreground">{name()}</Text>
    <If when={!html()}>{actions()}{status()}{renderSource()}</If>
      <ResourceHtmlViewer inlineVisible={html()} input={htmlInput()} title={name()} identifyMount={id} onBack={() => { void back(); }} controllerReady={value => { htmlController = value; }}
         closePreview={async owner => {
           if (!webPreview) throw new Error('resource_web_scope_required');
          await webPreview.closeOwner(owner);
        }} renderSource={renderSource} renderStatus={status} renderActions={actions}
         presentationAnchor={(owner, lifecycle) => { const key = presentationKey(owner)!; return <ResourceHTMLPresentationAnchor config={{ owner: key, expectedHost }} closing={lifecycle.closing} closeAttempt={lifecycle.closeAttempt} style={{ position: 'absolute', width: 0, height: 0 }} accessible={false}
           onReady={event => { if (event.owner === key && htmlController?.state().dialog?.generation === owner.generation) presenterReady.set(key); }}
           onOpened={event => { if (event.owner === key) lifecycle.opened(); }} onClosed={event => { if (event.owner === key) lifecycle.closed(); }}
           onCloseFailed={event => { if (event.owner === key) lifecycle.failed(event.attempt); }}
          onFailed={() => { error.set(t('mobile.files.error.readUnavailable')); }} />; }}
        renderPreview={mount => {
          const file = fs(), original = untracked(content);
          if (!file || !original || original.kind !== 'text') throw new Error('resource_html_content_required');
          const key = mount.presentation === 'fullScreen' ? presentationKey(htmlController?.state().dialog ?? undefined) : undefined;
          const config = Object.freeze({ owner: mount.owner, expectedHost, directory: file.directory, path: file.path, lease: original.lease, ...(key ? { presentationOwner: key } : {}) });
          return <ResourceHTMLView testID="resource-html-native" class="flex-1" config={config} onFailed={event => htmlController?.previewFailed(event.owner)} />;
        }} />
    {content()?.kind === 'image' ? <Button class="flex-1" disabled={busy() || !resourceCanPreview(content()!)} onPress={() => void perform('preview')}><Image class="w-full h-64" src={content()?.thumbnail} /><Text class="text-foreground">{t('mobile.files.html.fullscreenAria')}</Text></Button> : null}
    {content()?.kind === 'svg' ? <View class="flex-1 gap-3"><ResourceSVGImage testID="resource-svg-image" class="w-full h-64" config={{ lease: content()!.lease, expectedHost, active: active() && contentSource === sourceKey() }} /><If when={resourceCanPreview(content()!)}><Button testID="resource-svg-preview" class={action} disabled={busy()} onPress={() => void perform('preview')}><Text class="text-foreground">{t('mobile.files.html.fullscreenAria')}</Text></Button></If></View> : null}
    {content() && ['pdf', 'video', 'audio'].includes(content()!.kind) && resourceCanPreview(content()!) ? <Button testID="resource-media-preview" class={action} disabled={busy()} onPress={() => void perform('preview')}><Text class="text-foreground">{t('mobile.files.html.viewPreviewAria')}</Text></Button> : null}
    {previewUnavailable() ? <Text testID="resource-preview-unavailable" class="text-muted-foreground">{t('mobile.files.error.readUnavailable')}</Text> : null}
  </View>;
}

export function resolveResourceLink(base: string, href: string, root: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(href)) return null;
  try { const path = resourcePath(href.startsWith('/') ? decodeURIComponent(href) : base.slice(0, base.lastIndexOf('/') + 1) + decodeURIComponent(href)); return resourceWithin(path, resourcePath(root)) ? path : null; } catch { return null; }
}
function ResourceInlineImage(props: { directory: string; path: string; source: string; expectedHost: RuntimeScope | null }) {
  const path = resolveResourceLink(props.path, props.source, props.directory);
  return path ? <ResourcePreview directory={props.directory} path={path} expectedHost={props.expectedHost} guiPreview={false} /> : <Text>{t('mobile.files.error.readUnavailable')}</Text>;
}
