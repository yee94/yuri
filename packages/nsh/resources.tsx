import { cleanup, computed, effect, lifecycle, signal, untracked, View, Text, Scroll, Image, Clipboard, List, type ListRef } from 'nsh';
import { Button, Input, TextView } from 'nsh/base';
import { bindRequest, native } from './runtime';
import { app, epoch } from './state';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { bindResourceRead } from './resources-request';
import { t } from './i18n';
import { nativeChatTextStyle } from './appearance';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { id } from './model';
import { resourceCanPreview, resourceEntries, resourceFence, resourceFindRoute, resourceName, resourceParent, resourcePath, resourceSearchEntries, resourceWithin, type ResourceContent, type ResourceEntry } from './resources-model';

const action = 'min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';
export type ResourcesBrowserProps = { directory: string; path?: string; active?: boolean; onClose?: () => void; onOpen?: (path: string) => void; expectedHost?: RuntimeScope | null };

function createResourceNavigation(props: ResourcesBrowserProps) {
  const root = resourcePath(props.directory);
  return { root, directory: signal(root), search: signal(''), preview: signal(props.path && props.path !== root ? resourcePath(props.path) : '') };
}

export function ResourcesBrowser(props: ResourcesBrowserProps) {
  const navigation = createResourceNavigation(props);
  return <ResourceScopeBoundary {...props}>{scope => <ResourcesBrowserOwner {...props} navigation={navigation} expectedHost={scope} />}</ResourceScopeBoundary>;
}

/** A native foreground receipt change remounts a new owner. An inherited receipt
 * remains fixed, so late child previews cannot upgrade an old parent's authority. */
function ResourceScopeBoundary(props: ResourcesBrowserProps & { children: (scope: RuntimeScope) => ReturnType<typeof View> }) {
  const hostID = props.expectedHost?.hostID ?? app.runtimeScope()?.hostID ?? app.connection()?.id;
  const inherited = props.expectedHost === undefined ? undefined : runtimeScopeFrom(props.expectedHost);
  const available = () => {
    const current = runtimeScopeFrom(app.runtimeScope());
    if (!current || hostID && current.hostID !== hostID || inherited !== undefined && !sameRuntimeScope(inherited, current)) return [];
    return [inherited ?? current];
  };
  return <Each of={available()} key={scope => JSON.stringify([scope.hostID, scope.lease])}>{scope => props.children(scope())}</Each>;
}

function ResourcesBrowserOwner(props: ResourcesBrowserProps & { navigation: ReturnType<typeof createResourceNavigation> }) {
  const expectedHost = runtimeScopeFrom(props.expectedHost === undefined ? app.runtimeScope() : props.expectedHost);
  const request = bindRequest(expectedHost), generation = epoch();
  const active = () => !!expectedHost && generation === epoch() && sameRuntimeScope(expectedHost, app.runtimeScope()) && props.active !== false && lifecycle() === 'active';
  const { root, directory, search, preview } = props.navigation;
  const entries = signal<ResourceEntry[]>([]), busy = signal(false), error = signal('');
  const fence = resourceFence(epoch);
  cleanup(() => fence.cancel());
  let previousHost = app.connection();
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
    const host = app.connection();
    if (host !== previousHost) { entries.set([]); preview.set(''); previousHost = host; }
    const at = directory(), term = search();
    const visible = active();
    const timer = visible ? setTimeout(() => { if (directory() === at && search() === term) void load(); }, term.trim() ? 250 : 0) : undefined;
    cleanup(() => { clearTimeout(timer); fence.cancel(); });
  });
  function open(entry: ResourceEntry) {
    if (entry.isDirectory) { entries.set([]); search.set(''); directory.set(entry.path); }
    else { props.onOpen?.(entry.path); preview.set(entry.path); }
  }
  return <View class="flex-1 bg-background gap-3 p-4">
    {preview() ? <ResourcePreview directory={root} path={preview()} expectedHost={expectedHost} active={props.active} onClose={() => preview.set('')} onOpen={path => { props.onOpen?.(path); preview.set(path); }} /> : <>
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

export function ResourcePreview(props: ResourcesBrowserProps & { path: string; targetLine?: number }) {
  return <ResourceScopeBoundary {...props}>{scope => <ResourcePreviewOwner {...props} expectedHost={scope} />}</ResourceScopeBoundary>;
}

function ResourcePreviewOwner(props: ResourcesBrowserProps & { path: string; targetLine?: number }) {
  const expectedHost = runtimeScopeFrom(props.expectedHost === undefined ? app.runtimeScope() : props.expectedHost);
  const readResource = bindResourceRead(expectedHost, native);
  const webPreview = bindResourceWebPreview(expectedHost, native, id);
  const generation = epoch();
  const content = signal<ResourceContent | null>(null), busy = signal(false), error = signal(''), source = signal(false);
  let lineList: ListRef | undefined, revealedTarget = '';
  const lines = computed(() => content()?.kind === 'text' && props.targetLine !== undefined ? (content()?.text ?? '').split('\n') : []);
  const targetIndex = () => props.targetLine !== undefined && Number.isInteger(props.targetLine) && props.targetLine > 0 && props.targetLine <= lines().length ? props.targetLine - 1 : -1;
  function revealLine() {
    const index = targetIndex(), key = `${props.path}:${content()?.lease}:${index}`;
    if (index < 0 || !lineList || key === revealedTarget) return;
    lineList.scrollToIndex({ index, animated: false, viewPosition: .25 });
    revealedTarget = key;
  }
  const fence = resourceFence(epoch);
  const active = () => generation === epoch() && sameRuntimeScope(expectedHost, app.runtimeScope()) && props.active !== false && lifecycle() === 'active';
  let readID: string | undefined, loadedScope = '';
  function cancelRead() {
    const requestId = readID; readID = undefined;
    if (requestId) void native('resources.cancel', { requestId }).catch(() => {});
  }
  function closeLease(lease: string, release = false) {
    void native('resources.close', { lease }).catch(() => {}).then(() => release ? native('resources.release', { lease }).catch(() => {}) : undefined);
  }
  cleanup(() => { fence.cancel(); cancelRead(); void webPreview.close(); const lease = content()?.lease; if (lease) closeLease(lease, true); });
  async function load() {
    if (!active()) return;
    cancelRead();
    const requestId = id(); readID = requestId;
    const valid = fence.begin(); busy.set(true); error.set('');
    try {
      const next = await readResource(props.path, requestId) as ResourceContent;
      if (!valid() || !active()) { void native('resources.release', { lease: next.lease }).catch(() => {}); return; }
      const previous = content(); content.set(next);
      if (previous) closeLease(previous.lease, true);
    } catch (cause) { if (valid()) error.set(String(cause)); }
    finally { if (readID === requestId) readID = undefined; if (valid()) busy.set(false); }
  }
  effect(() => {
    const scope = JSON.stringify([app.connection()?.id, app.runtimeScope(), epoch(), resourcePath(props.path)]), visible = active();
    untracked(() => {
      fence.cancel(); cancelRead(); busy.set(false);
      if (scope !== loadedScope) {
        loadedScope = scope;
        const previous = content(); content.set(null); source.set(false);
        if (previous) closeLease(previous.lease, true);
      }
      if (!visible) { void webPreview.close(); const lease = content()?.lease; if (lease) closeLease(lease); return; }
      if (!content()) void load();
    });
  });
  async function perform(action: string) {
    if (!active() || busy() || !content()) return;
    const valid = fence.begin(); busy.set(true); error.set('');
    try { await native('resources.present', { lease: content()?.lease, action }); }
    catch (cause) { if (valid()) error.set(String(cause)); }
    finally { if (valid()) busy.set(false); }
  }
  const rich = () => /\.(md|mdx|markdown)$/i.test(props.path) && !source();
  async function previewHTML(href?: string) {
    if (!active() || busy()) return;
    const current = fence.begin(); busy.set(true); error.set('');
    try { await webPreview.present({ directory: props.directory, ...(href === undefined ? { path: props.path } : { href }) }); }
    catch { if (current()) error.set(t('mobile.files.error.readUnavailable')); }
    finally { if (current()) busy.set(false); }
  }
  return <View class="flex-1 gap-3">
    <Text class="text-lg font-semibold text-foreground">{resourceName(props.path)}</Text>
    <View class="flex-row flex-wrap gap-2">
      {props.onClose ? <Button class={action} onPress={props.onClose}><Text class="text-foreground">{t('gitView.common.close')}</Text></Button> : null}
      <Button class={action} disabled={busy()} onPress={() => void load()}><Text class="text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
      <Button class={action} onPress={() => { void Clipboard.writeText(props.path).catch(cause => error.set(String(cause))); }}><Text class="text-foreground">{t('mobile.files.copyPathAria')}</Text></Button>
      {content()?.kind === 'text' ? <>
        {props.targetLine === undefined && /\.(md|mdx|markdown)$/i.test(props.path) ? <Button class={action} onPress={() => source.set(!source())}><Text class="text-foreground">{t(source() ? 'mobile.files.html.viewPreviewAria' : 'mobile.files.html.viewSourceAria')}</Text></Button> : null}
        {/\.html?$/i.test(props.path) ? <Button testID="resource-html-preview" class={action} disabled={busy()} onPress={() => { void previewHTML(); }}><Text class="text-foreground">{t('mobile.files.html.viewPreviewAria')}</Text></Button> : null}
        <Button class={action} onPress={() => { void Clipboard.writeText(content()?.text || '').catch(cause => error.set(String(cause))); }}><Text class="text-foreground">{t('mobile.files.copyContent')}</Text></Button>
      </> : null}
      <Button class={action} disabled={busy() || !content()} onPress={() => void perform('save')}><Text class="text-foreground">{t('sessions.scheduledTasks.editor.actions.save')}</Text></Button>
      <Button class={action} disabled={busy() || !content()} onPress={() => void perform('share')}><Text class="text-foreground">{t('sessions.sidebar.session.menu.share')}</Text></Button>
    </View>
    {busy() ? <Text class="text-muted-foreground">{t('common.loading')}</Text> : null}
    {error() ? <Text class="text-destructive">{error()}</Text> : null}
    {/\.eficy$/i.test(props.path) ? <Text class="text-muted-foreground">{t('mobile.files.error.readUnavailable')}</Text> : null}
    {content()?.kind === 'text' ? <If when={props.targetLine !== undefined} else={<Scroll class="flex-1"><TextView selectable links="report" markdown={rich() ? content()?.text : undefined} document={rich() ? undefined : { blocks: [{ type: 'codeBlock', code: content()?.text || '', language: props.path.split('.').pop() }] }} renderImage={image => <ResourceInlineImage directory={props.directory} path={props.path} source={image.src} expectedHost={expectedHost} />} onLinkPress={event => {
      if (!active()) return;
      const path = resolveResourceLink(props.path, event.url, props.directory);
      if (path) props.onOpen?.(path);
      else if (resourceWebPreviewIntent({ directory: props.directory, href: event.url }).supported) void previewHTML(event.url);
    }} /></Scroll>}>
      <If when={targetIndex() < 0}><Text class="text-muted-foreground">{t('diffView.actions.openFileAtFirstChangedLine')} · {t('common.unavailable')}</Text></If>
      <List testID="resource-source-lines" class="flex-1" ref={value => { lineList = value; }} each={lines()} keyExtractor={(_, index) => String(index)} initialScrollIndex={Math.max(0, targetIndex())} onLayout={revealLine}>{(line, index) => <View selectable testID={`resource-line-${index() + 1}`} class={index() === targetIndex() ? 'flex-row gap-3 px-2 py-0.5 bg-accent' : 'flex-row gap-3 px-2 py-0.5'}><Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('code'), width: 48 }}>{index() + 1}</Text><Text class="flex-1 text-foreground" style={nativeChatTextStyle('code')}>{line() || ' '}</Text></View>}</List>
    </If> : null}
    {content()?.kind === 'image' ? <Button class="flex-1" disabled={busy() || !resourceCanPreview(content()!)} onPress={() => void perform('preview')}><Image class="w-full h-64" src={content()?.thumbnail} /><Text class="text-foreground">{t('mobile.files.html.fullscreenAria')}</Text></Button> : null}
    {content() && ['pdf', 'video', 'audio'].includes(content()!.kind) && resourceCanPreview(content()!) ? <Button testID="resource-media-preview" class={action} disabled={busy()} onPress={() => void perform('preview')}><Text class="text-foreground">{t('mobile.files.html.viewPreviewAria')}</Text></Button> : null}
    {content()?.kind === 'binary' || content()?.preview === 'unsupported' ? <Text testID="resource-preview-unavailable" class="text-muted-foreground">{t('mobile.files.error.readUnavailable')}</Text> : null}
  </View>;
}

export function resolveResourceLink(base: string, href: string, root: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(href)) return null;
  try { const path = resourcePath(href.startsWith('/') ? decodeURIComponent(href) : base.slice(0, base.lastIndexOf('/') + 1) + decodeURIComponent(href)); return resourceWithin(path, resourcePath(root)) ? path : null; } catch { return null; }
}
function ResourceInlineImage(props: { directory: string; path: string; source: string; expectedHost: RuntimeScope | null }) {
  const path = resolveResourceLink(props.path, props.source, props.directory);
  return path ? <ResourcePreview directory={props.directory} path={path} expectedHost={props.expectedHost} /> : <Text>{t('mobile.files.error.readUnavailable')}</Text>;
}
