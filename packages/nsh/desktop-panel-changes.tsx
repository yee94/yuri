import { cleanup, computed, effect, host, lifecycle, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { bindRequest } from './runtime';
import { runtimeEventFrom } from './model';
import { createChangesReader, type ChangesSource } from './chat-changes-model';
import type { DesktopPanelScope } from './desktop-panel-model';
import { DesktopDiffDocument } from './desktop-diff-document';
import { NativeDesktopDiffList } from './desktop-diff-list';
import { desktopDiffListFiles, type DesktopDiffScope } from './desktop-diff-list-core';
import type { DesktopDiffFocus, DesktopDiffLayout, DesktopDiffPreferences } from './desktop-diff-model';

const action = 'min-h-8 px-2 rounded-md bg-secondary hover:bg-accent active:bg-accent disabled:opacity-40 flex-row items-center justify-center gap-1.5';
export type DesktopChangesProps = {
  scope: DesktopPanelScope; source: ChangesSource; current: () => boolean; active: boolean;
  onOpenDiff: (source: ChangesSource) => void; onOpenFile: (path: string, line?: number) => void;
  preferences?: DesktopDiffPreferences;
  filePreferences?: (path: string) => DesktopDiffPreferences | undefined;
  onLayoutChange?: (paths: readonly string[], layout: DesktopDiffLayout) => void;
  onWrapLinesChange?: (wrap: boolean) => void;
  onOpenEditor?: (path: string, line: number) => void;
  onFocusStatus?: (focus: DesktopDiffFocus) => void;
  /** ContextPanel hides this sidebar; opt in only for the standalone Diff surface. */
  showFileSidebar?: boolean;
  /** Web file-diff tabs hide the global toolbar, but still consume its preferences. */
  singleFileView?: boolean;
  /** Existing catalog projection takes precedence over the original reader inventory. */
  files?: readonly { path: string; staged: boolean; status: string; isNew?: boolean }[];
  /** Existing catalog owner can explicitly invalidate bodies without changing metadata. */
  refreshRevision?: string | number;
};

/** A fixed captured source, never a Sheet. Historical sources can only take the
 * existing historical reader's exact snapshot / session+message read lane. */
export function NativeDesktopChanges(props: DesktopChangesProps) {
  return <Each of={[props.source]} key={source => source}>{source => <DesktopChangesSurface {...props} source={source()} />}</Each>;
}

function DesktopChangesSurface(props: DesktopChangesProps) {
  const revision = signal(0);
  const patchRevision = signal(0);
  let alive = true;
  const source = props.source;
  const active = computed(() => alive && props.source === source && props.current() && props.active && lifecycle() === 'active');
  const reader = createChangesReader(source, bindRequest(props.scope.host), active, () => untracked(() => revision.set(revision() + 1)));
  const state = () => { revision(); return reader.state(); };
  const snapshot = computed(() => state().snapshot);
  const scope = signal<DesktopDiffScope>(source.kind === 'turn' ? 'turn' : source.staged ? 'staged' : 'working');
  const filesFor = (scope: DesktopDiffScope) => {
    if (source.kind === 'turn' ? scope !== 'turn' : scope === 'turn') return [];
    return props.files?.filter(file => file.staged === (scope === 'staged')) ?? desktopDiffListFiles(source, snapshot(), scope);
  };
  const choices = computed(() => (['working', 'staged', 'turn'] as const).map(scope => ({ scope, available: source.kind === 'turn' ? scope === 'turn' : scope !== 'turn', count: filesFor(scope).length })));
  const invalidate = () => patchRevision.set(patchRevision() + 1);
  async function reload(explicitInvalidate = false) {
    if (!active()) return;
    if (props.singleFileView) {
      if (source.path) await reader.select(source.path, source.kind === 'workspace' && source.staged === true);
      return;
    }
    if (source.kind === 'turn' || props.files !== undefined) { invalidate(); return; }
    if (state().loading) { if (explicitInvalidate) invalidate(); return; }
    const prior = state().snapshot;
    await reader.refresh();
    // Status identity is not a patch revision: a second M/M can hold new text.
    // Adopt the authoritative catalog first; failed GETs retain its prior value.
    if (active() && (explicitInvalidate || prior !== null && state().snapshot !== prior && !state().error)) invalidate();
  }
  effect(() => {
    const visible = active(), single = props.singleFileView, supplied = props.files !== undefined;
    untracked(() => {
      if (!visible) { reader.cancel(); return; }
      if (single) { if (source.path && !state().diff && !state().diffError) void reload(); }
      else if (source.kind === 'workspace' && !supplied && !state().error) void reload();
    });
  });
  // Only the visible workspace inventory subscribes/polls. Historical sources
  // never refresh current Git; list demand alone selects workspace bodies.
  effect(() => {
    if (!active() || source.kind !== 'workspace' || props.singleFileView) return;
    const timer = setInterval(() => { if (props.files === undefined && active() && !state().error && !state().loading) void reload(); }, 10_000);
    const stop = host.on('runtime.event', payload => {
      if (!active()) return;
      const event = runtimeEventFrom(payload);
      if (event?.key === 'global' && (!event.directory || event.directory === source.directory) && (event.type === 'reconnected' || /^(vcs\.|yuri:git-|yuri:workspace-)/.test(event.type))) {
        if (props.files !== undefined) invalidate();
        else void reload(true);
      }
    });
    cleanup(() => { clearInterval(timer); stop(); });
  });
  cleanup(() => { alive = false; reader.cancel(); });
  return <View testID={source.path ? 'desktop-panel-diff' : 'desktop-panel-changes'} class="flex-1 bg-background">
    <View class="min-h-9 px-2 flex-row items-center gap-2 border-b border-border/30">
      <Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{source.kind === 'turn' ? t('diffView.scope.lastTurn') : source.path ? t(scope() === 'staged' ? 'diffView.scope.staged' : 'contextPanel.mode.workingDiff') : state().snapshot?.current || t('chat.pendingChanges.changedInWorkspace')}</Text>
      <Button testID={source.path ? 'desktop-diff-refresh' : 'desktop-changes-refresh'} class={action} disabled={state().loading || state().diffLoading || !active()} onPress={() => { void reload(); }}><Icon name="refresh" size={14} /><Text class="text-xs text-foreground">{t(state().error || state().diffError ? 'diffView.actions.retry' : 'mobile.files.refreshAria')}</Text></Button>
    </View>
    <If when={state().loading || props.singleFileView && state().diffLoading}><Text class="px-3 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
    <If when={!!state().error || props.singleFileView && !!state().diffError}><Text role="alert" class="px-3 text-xs text-destructive">{state().error || state().diffError}</Text></If>
    <If when={!props.singleFileView}><NativeDesktopDiffList source={source} reader={reader} scope={scope()} snapshot={snapshot()} files={props.files}
      refreshRevision={JSON.stringify([patchRevision(), props.refreshRevision])} current={active} active={active()} targetPath={source.path} targetLine={source.targetLine}
      scopeChoices={choices()} onScopeChange={value => { if (active() && choices().some(choice => choice.scope === value && choice.available)) scope.set(value); }}
      showFileSidebar={props.showFileSidebar} preferences={props.preferences} filePreferences={props.filePreferences} onLayoutChange={props.onLayoutChange} onWrapLinesChange={props.onWrapLinesChange}
      onOpenFile={props.onOpenFile} onOpenEditor={props.onOpenEditor} onFocusStatus={props.onFocusStatus} /></If>
    <If when={props.singleFileView && !!source.path}><View class="flex-1 flex-row">
      <View class="flex-1">
      <Each of={state().diff ? [state().diff!] : []} key={diff => diff}>{diff => <DesktopDiffDocument diff={diff()} current={() => active() && state().diff === diff()} historical={source.kind === 'turn'} targetLine={source.targetLine}
        fullContext={source.kind === 'workspace' ? { snapshot: state().fullContext, loading: state().fullContextLoading, error: state().fullContextError, load: () => reader.loadFullContext(), cancel: () => reader.cancelFullContext() } : undefined}
        isNew={props.files?.find(file => file.path === diff().path)?.isNew ?? state().snapshot?.files.some(file => file.path === diff().path && (file.index === 'A' || file.working_dir === 'A' || file.index === '?'))}
        singleFileView preferences={props.filePreferences?.(diff().path) ?? props.preferences} onLayoutChange={props.onLayoutChange ? layout => { if (active()) props.onLayoutChange?.([diff().path], layout); } : undefined} onWrapLinesChange={props.onWrapLinesChange ? wrap => { if (active()) props.onWrapLinesChange?.(wrap); } : undefined}
        onOpenFile={line => { if (active()) props.onOpenFile(diff().path, line); }} onOpenEditor={props.onOpenEditor ? line => { if (active()) props.onOpenEditor?.(diff().path, line); } : undefined} onFocusStatus={props.onFocusStatus} />}</Each>
      </View>
    </View></If>
  </View>;
}
