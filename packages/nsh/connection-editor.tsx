import { cleanup, effect, signal, Text, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from './i18n';
import { connectionSnapshotFrom, native } from './runtime';
import { SettingsGroup, SettingsInput, settingsAction } from './settings-controls';
import { connectionEditorDirty, connectionEditorFailureKey, connectionEditorInput, createConnectionEditor, createConnectionEditorLeaveGuard, type ConnectionEditorDescriptor, type ConnectionEditorMutation, type ConnectionEditorNavigation, type ConnectionEditorSnapshot } from './connection-editor-core';
export type { ConnectionEditorNavigation } from './connection-editor-core';

export type NativeConnectionEditorProps = {
  id: string;
  mode: 'rename' | 'edit';
  active?: boolean;
  current?: () => boolean;
  onSaved: (snapshot: ConnectionEditorSnapshot) => void;
  onCancel: () => void;
  onReauthorize?: (target: ConnectionEditorMutation) => void;
  /** NavPage owns back/swipe flags; cancel calls onCancel only after this guard admits leaving. */
  onNavigation?: (navigation: ConnectionEditorNavigation) => void;
};

/** Mount once per requested ID/mode; never rehydrate fields when a connection list refreshes. */
export function NativeConnectionEditor(props: NativeConnectionEditorProps) {
  let alive = true;
  cleanup(() => { alive = false; });
  const current = () => alive && props.active !== false && (props.current?.() ?? true);
  const baseline = signal<ConnectionEditorDescriptor | undefined>(undefined);
  const label = signal(''), url = signal(''), busy = signal(false), error = signal('');
  const confirming = signal(false), committed = signal(false);
  const disabled = () => busy() || confirming() || committed();
  const dirty = () => !committed() && connectionEditorDirty(baseline(), label(), props.mode === 'edit' ? url() : undefined);
  const leave = createConnectionEditorLeaveGuard({ dirty, busy, current, onLeave: props.onCancel,
    onConfirming: value => { if (alive) confirming.set(value); },
    confirmDiscard: async () => {
      const answer = await AlertDialog.show({ title: t('filesView.unsaved.title'), description: t('sessions.scheduledTasks.workspace.confirm.discardChanges'), actions: [
        { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        { id: 'discard', label: t('filesView.unsaved.discard'), role: 'destructive' },
      ] });
      return answer.action === 'discard';
    },
  });
  async function back() {
    try { await leave.back(); }
    catch (failure) { if (current()) error.set(t(connectionEditorFailureKey(failure))); }
  }
  effect(() => { confirming(); props.onNavigation?.({ blocked: leave.blocked(), back: () => { void back(); } }); });
  const editor = createConnectionEditor({ read: id => native('connection.editor', { id }), write: async (method, input) => connectionSnapshotFrom(await native(method, input)), current });
  async function load() {
    if (busy() || !current()) return;
    busy.set(true); error.set('');
    try {
      const value = await editor.load(props.id);
      if (!value || !current()) return;
      baseline.set(value); label.set(value.label); url.set(value.url);
    } catch (failure) { if (current()) error.set(t(connectionEditorFailureKey(failure))); }
    finally { if (alive) busy.set(false); }
  }
  async function save() {
    if (disabled() || !baseline() || !current()) return;
    busy.set(true); error.set('');
    let value: ConnectionEditorSnapshot | undefined;
    try {
      value = await editor.save(label(), props.mode === 'edit' ? url() : undefined);
    } catch (failure) { if (current()) error.set(t(connectionEditorFailureKey(failure))); }
    finally { if (alive) busy.set(false); }
    // The write has already committed. Presentation callbacks must not be caught as write failures.
    if (value && current()) { committed.set(true); props.onSaved(value); }
  }
  function reauthorize() {
    const value = baseline();
    if (!value || disabled() || !current()) return;
    try { props.onReauthorize?.(connectionEditorInput(value, label(), url())); }
    catch (failure) { error.set(t(connectionEditorFailureKey(failure))); }
  }
  void load();
  return <View class="gap-4">
    <SettingsGroup title={t(props.mode === 'rename' ? 'mobile.connect.history.rename' : 'mobile.instances.editTitle')}>
      <If when={!!baseline()}>
        <SettingsInput testID="connection-editor-label" title={t('mobile.instances.label.label')} value={label()} disabled={disabled()} onChange={next => { if (!disabled()) label.set(next); }} />
        <If when={props.mode === 'edit'}>
          <SettingsInput testID="connection-editor-url" title={t('mobile.connect.url.label')} value={url()} disabled={disabled() || baseline()?.transport === 'relay'} onChange={next => { if (!disabled()) url.set(next); }} />
          <Text class="text-xs text-muted-foreground">{t('mobile.instances.nativeEditor.pairingRequired')}</Text>
          <If when={!!props.onReauthorize}><Button testID="connection-editor-reauthorize" class={settingsAction} disabled={disabled()} onPress={reauthorize}><Text class="text-foreground">{t('mobile.instances.nativeEditor.reauthorize')}</Text></Button></If>
        </If>
      </If>
      <If when={!!error()}><Text testID="connection-editor-error" class="text-sm text-destructive">{error()}</Text></If>
      <If when={!baseline() && !!error()}><Button class={settingsAction} disabled={busy()} onPress={() => { void load(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
      <Button testID="connection-editor-save" class={settingsAction} disabled={disabled() || !baseline() || !label().trim()} onPress={() => { void save(); }}><Text class="text-foreground">{t('mobile.instances.saveEdit')}</Text></Button>
      <Button testID="connection-editor-cancel" class={settingsAction} disabled={busy() || confirming()} onPress={() => { void back(); }}><Text class="text-foreground">{t('mobile.instances.cancelEdit')}</Text></Button>
    </SettingsGroup>
  </View>;
}
