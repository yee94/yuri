import { Scroll, signal, Text, View } from 'nsh';
import { AlertDialog, Button, TextView } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { t } from './i18n';
import { text, type Row } from './model';
import { SettingsFeedback, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime, type SettingsOperation } from './settings-controls';
import { scopedSettingsPath, settingsObject } from './settings-protocol';

export function SettingsSkillFiles(props: { name: string; directory?: string; files: Row[]; create?: boolean; disabled?: boolean; readOnly?: boolean; onDraft: (files: { path: string; content: string }[]) => void }) {
  const state = settingsPageLifetime(), files = signal(props.files), editor = signal(false), path = signal(''), content = signal(''), existing = signal(false);

  const pending = signal<{ path: string; content: string }[]>([]);
  const endpoint = (file: string) => scopedSettingsPath(`/api/config/skills/${encodeURIComponent(props.name)}/files/${encodeURIComponent(file)}`, props.directory);
  async function open(file?: Row, operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    await state.perform(async (operation) => {
      const filePath = text(file?.path);
      path.set(filePath); existing.set(!!file); content.set('');
      if (file) {
        if (props.create) content.set(pending().find(item => item.path === filePath)?.content || '');
        else {
          const body = settingsObject(await operation.request(endpoint(filePath)));
          if (!operation.current()) return;
          content.set(text(body.content));
        }
      }
      editor.set(true);
    }, operation);
  }
  async function save(operation: SettingsOperation | null = state.operation()) {
    if (!operation?.current()) return;
    if (props.readOnly || props.disabled) return;
    await state.perform(async (operation) => {
      const nextPath = path().trim();
      if (!nextPath || nextPath.startsWith('/') || nextPath.includes('\\') || nextPath.split('/').some(part => part === '..' || part === '.')) throw new Error(t('settings.skills.page.toast.fileNameRequired'));
      if (!existing() && files().some(item => item.path === nextPath)) throw new Error(t('settings.skills.page.toast.fileExists'));
      if (props.create) {
        const next = [...pending().filter(item => item.path !== nextPath), { path: nextPath, content: content() }];
        pending.set(next); props.onDraft(next);
      } else await operation.transaction(endpoint(nextPath), 'PUT', { content: content() });
      if (!existing()) files.set([...files(), { path: nextPath, name: nextPath }]);
      editor.set(false); state.notice.set(t('settings.skills.page.toast.fileUpdated', { path: nextPath }));
    }, operation);
  }
  return <SettingsGroup title={t('settings.skills.page.section.supportingFiles')}>
    <SettingsFeedback state={state} />
    <If when={!editor()}>
      <Each of={files()}>{file => <View class="flex-row gap-2 items-center"><Button class="flex-1 min-h-12" disabled={state.busy() || props.disabled} onPress={() => { void open(file()); }}><Text class="text-foreground">{text(file().path)}</Text></Button><If when={!props.readOnly}><Button class={settingsAction} disabled={state.busy() || props.disabled} onPress={() => { void state.perform(async (operation) => {
        if (props.readOnly || props.disabled) return;
        const filePath = text(file().path);
        const choice = await AlertDialog.show({ title: t('settings.skills.page.deleteFileDialog.title'), description: t('settings.skills.page.deleteFileDialog.description', { path: filePath }), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'delete', label: t('settings.common.actions.delete'), role: 'destructive' }] });
        if (choice.action !== 'delete' || !operation.current()) return;
        if (props.create) { const next = pending().filter(item => item.path !== filePath); pending.set(next); props.onDraft(next); }
        else await operation.transaction(endpoint(filePath), 'DELETE');
        files.set(files().filter(item => item.path !== filePath));
      }); }}><Text class="text-destructive">{t('settings.common.actions.delete')}</Text></Button></If></View>}</Each>
      <If when={!props.readOnly}><Button class={settingsAction} disabled={state.busy() || props.disabled} onPress={() => { void open(); }}><Text class="text-foreground">{t('settings.skills.page.actions.addFile')}</Text></Button></If>
    </If>
    <Sheet open={editor()} onOpenChange={event => editor.set(event.open)} closeOnSwipe popupClass="bg-background rounded-t-3xl" popupStyle={{ height: '80%' }} backdropClass="bg-background/50"><Scroll class="flex-1" contentClass="p-5 gap-4 pb-10">
      <Text class="text-lg font-semibold text-foreground">{t('settings.skills.page.section.supportingFiles')}</Text>
      <SettingsFeedback state={state} />
      <SettingsInput title={t('settings.skills.page.fileDialog.field.filePath')} value={path()} disabled={existing() || state.busy()} onChange={next => path.set(next)} />
      <If when={props.readOnly}><TextView markdown={content()} selectable class="text-foreground" /></If>
      <If when={!props.readOnly}><SettingsInput title={t('settings.skills.page.fileDialog.field.content')} value={content()} multiline disabled={state.busy() || props.disabled} onChange={next => content.set(next)} /><Button class={settingsAction} disabled={state.busy() || props.disabled} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button></If>
      <Button class={settingsAction} disabled={state.busy()} onPress={() => editor.set(false)}><Text class="text-foreground">{t('settings.common.actions.cancel')}</Text></Button>
    </Scroll></Sheet>
  </SettingsGroup>;
}
