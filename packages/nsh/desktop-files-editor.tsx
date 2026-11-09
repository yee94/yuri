import { cleanup, Clipboard, computed, effect, keymap, lifecycle, signal, Text, untracked, View } from 'nsh';
import { Button, Editor, type EditorRef } from 'nsh/base';
import { t } from './i18n';
import { bindRequest } from './runtime';
import { ResourcePreview } from './resources';
import { nativeChatTextStyle } from './appearance';
import { desktopEditorDirty, type DesktopEditorError } from './desktop-files-editor-model';
import type { NativeDesktopEditors } from './desktop-files-editor-owner';
import type { DesktopPanelScope } from './desktop-panel-model';

const action = 'min-h-8 px-3 rounded-md bg-secondary text-foreground hover:bg-accent disabled:opacity-40 items-center justify-center';
function errorLabel(error: DesktopEditorError) {
  if (error === 'conflict') return t('gitView.history.actions.conflictToastTitle');
  if (error === 'read') return t('filesView.error.readFileFailed');
  if (error === 'capacity' || error === 'stale') return t('common.unavailable');
  return t('filesView.toast.saveFailed');
}

/** Read-only media still uses the protected resource preview. Text stays in the
 * window-owned document even when this native Editor is hidden or unmounted. */
type EditorProps = { owner: NativeDesktopEditors; scope: DesktopPanelScope; path: string; targetLine?: number; active: boolean; current: () => boolean; onOpen: (path: string, line?: number) => void };
export function NativeDesktopFileEditor(props: EditorProps) {
  const revision = signal(0);
  cleanup(props.owner.subscribe(() => untracked(() => revision.set(revision() + 1))));
  const journal = () => { revision(); return props.owner.journalState(); };
  return <If when={journal().hydrated} else={<View class="p-3 gap-2"><Text class="text-sm text-muted-foreground">{journal().error ? t('chat.newSessionDraft.operationFailed') : t('common.loading')}</Text><Button class={action} onPress={() => { void props.owner.journal?.retry(); }}><Text>{t('diffView.actions.retry')}</Text></Button></View>}><DesktopHydratedEditor {...props} /></If>;
}
function DesktopHydratedEditor(props: EditorProps) {
  const handle = signal(props.owner.model.acquire(props.scope, props.path));
  return <If when={!!handle()} else={<View testID="desktop-editor-capacity" class="p-3 gap-2"><Text role="alert" class="text-sm text-destructive">{t('common.unavailable')} · desktop_editor_capacity</Text><Button class={action} disabled={!props.active || !props.current()} onPress={() => handle.set(props.owner.model.acquire(props.scope, props.path))}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View>}><Each of={handle() ? [handle()!] : []} key={value => value.document.key}>{value => <DesktopFileEditorView {...props} handle={value()} />}</Each></If>;
}

function DesktopFileEditorView(props: EditorProps & { handle: NonNullable<ReturnType<NativeDesktopEditors['model']['acquire']>> }) {
  const handle = props.handle;
  const document = handle.document, revision = signal(0), focused = signal(false), localError = signal('');
  let alive = true, ref: EditorRef | undefined;
  const active = computed(() => alive && props.active && props.current() && lifecycle() === 'active');
  const operation = () => ({ scope: props.scope, current: () => alive && props.current() && lifecycle() === 'active', request: bindRequest(props.scope.host) });
  const stop = document.subscribe(() => untracked(() => revision.set(revision() + 1)));
  const state = () => { revision(); return document.state(); };
  const loaded = computed(() => state().loaded);
  let revealed = '';
  function reveal() {
    const target = props.targetLine, identity = String(target ?? '');
    if (ref && loaded() && target !== undefined && target > 0 && identity !== revealed) { revealed = identity; ref.goToLine(Math.trunc(target) - 1); }
  }
  const unbind = props.owner.bind(document, operation);
  cleanup(() => { alive = false; focused.set(false); unbind(); stop(); handle.release(); });
  effect(() => {
    const visible = active();
    untracked(() => { if (visible && !state().error && !state().loading && !props.owner.model.protected(document)) void props.owner.model.load(document, operation()); });
  });
  effect(() => { props.targetLine; loaded(); untracked(reveal); });
  const bindSave = computed(() => active() && focused() && !state().readOnly);
  effect(() => {
    if (!bindSave()) return;
    cleanup(keymap.bind('mod+s', () => { if (active()) void props.owner.save(document); }, { when: 'always' }));
  });
  return <View testID="desktop-panel-file-content" class="flex-1">
    <If when={state().loaded && state().readOnly} else={<>
      <View class="min-h-10 px-3 py-1 gap-2 flex-row flex-wrap items-center border-b border-border/30">
        <Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{document.path}</Text>
        <Text testID="desktop-editor-status" class="text-xs text-muted-foreground">{t(state().saving ? 'filesView.editor.saving' : desktopEditorDirty(state()) || state().pending ? 'filesView.unsaved.title' : state().loaded && !state().error ? 'filesView.editor.saved' : 'filesView.editor.manualSave')}</Text>
        <Button testID="desktop-editor-refresh" class={action} disabled={!active() || state().loading || state().saving || !!state().pending} onPress={() => { void props.owner.refresh(document); }}><Text class="text-xs text-foreground">{t('mobile.files.refreshAria')}</Text></Button>
        <Button testID="desktop-editor-copy" class={action} disabled={!state().loaded} onPress={() => { void Clipboard.writeText(state().text).catch(() => localError.set(t('filesView.toast.saveFailed'))); }}><Text class="text-xs text-foreground">{t('filesView.editor.copyFileContents')}</Text></Button>
        <Button testID="desktop-editor-save" class={action} disabled={!active() || state().loading || state().saving || !state().loaded || !desktopEditorDirty(state()) && !state().pending} onPress={() => { void props.owner.save(document); }}><Text class="text-xs text-foreground">{t(state().pending ? 'diffView.actions.retry' : 'filesView.editor.saveFile')}</Text></Button>
      </View>
      <If when={state().durability === 'error'}><View class="px-3 gap-1"><Text role="alert" class="text-xs text-destructive">{t('chat.newSessionDraft.operationFailed')} · {props.owner.journalState().error}</Text><Button testID="desktop-editor-journal-retry" class={action} onPress={() => { void props.owner.journal?.retry(); }}><Text>{t('diffView.actions.retry')}</Text></Button></View></If>
      <If when={state().loading}><Text class="px-3 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!state().error || !!localError()}><View class="px-3 gap-1"><Text testID="desktop-editor-error" role="alert" class="text-xs text-destructive">{localError() || errorLabel(state().error)}{state().detail ? ' · ' + state().detail : ''}</Text><If when={!state().loaded}><Button testID="desktop-editor-read-retry" class={action} disabled={!active() || state().loading} onPress={() => { void props.owner.model.load(document, operation()); }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></If></View></If>
      <If when={state().loaded && state().base !== null}><Editor testID="desktop-file-editor" class="flex-1 bg-background text-foreground" value={state().text} language={document.path} readOnly={!active() || state().discarding} lineNumbers
        fontFamily={nativeChatTextStyle('code').fontFamily} fontSize={nativeChatTextStyle('code').fontSize} lineHeight={nativeChatTextStyle('code').lineHeight}
        ref={value => { ref = value; reveal(); }}
        onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} onChange={event => { if (!active() || !props.owner.model.edit(document, event.value)) ref?.setValue(state().text); }} /></If>
    </>}><View class="flex-1 p-3"><ResourcePreview directory={props.scope.directory} path={props.path} targetLine={props.targetLine} expectedHost={props.scope.host} active={props.active && props.current()} onOpen={props.onOpen} /></View></If>
  </View>;
}
