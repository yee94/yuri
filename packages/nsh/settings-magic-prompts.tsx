import { Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsEntityLayout, SettingsGroup, SettingsInput, settingsAction, settingsPageLifetime } from './settings-controls';
import { nativeMagicDescriptions, nativeMagicPlaceholders } from './settings-magic-defaults';
import { createMagicPromptsEditor, emptyMagicPromptsSnapshot, magicPromptGroups, type MagicPromptEntry } from './settings-magic-state';
import { publishSettingsEditor } from './desktop-settings-publisher';

export function SettingsMagicPrompts(props: SettingsCallbacks & SettingsRoute) {
  const lifetime = settingsPageLifetime(), snapshot = signal(emptyMagicPromptsSnapshot());
  const initial = lifetime.operation();
  const editor = createMagicPromptsEditor(initial?.request ?? (async () => { throw new Error('Runtime changed'); }), initial?.current ?? (() => false), next => snapshot.set(next));
  lifetime.observeOperation(operation => { editor.replaceLane(operation); if (operation) void editor.load(); });
  const entry = magicPromptGroups.flatMap(group => [...group.entries]).find(item => item.id === props.entity);
  const disabled = () => !!snapshot().busy;
  publishSettingsEditor({ current: lifetime.current, scope: lifetime.operation, pending: disabled,
    dirty: () => { snapshot(); return Object.keys(snapshot().drafts).some(id => editor.dirty(id)); }, stamp: () => [snapshot().drafts],
  });
  void editor.load();
  const feedback = () => <View class="gap-2">
    <If when={snapshot().busy === 'load'}><Text class="text-muted-foreground">{t('settings.magicPrompts.page.loading.text')}</Text></If>
    <If when={!!snapshot().error}><View class="gap-2"><Text class="text-sm text-destructive">{t(snapshot().error!)}</Text><If when={!!snapshot().detail}><Text class="text-xs text-destructive">{snapshot().detail}</Text></If><If when={!snapshot().ready}><Button class={settingsAction} disabled={disabled()} onPress={() => { void editor.load(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If></View></If>
    <If when={!!snapshot().notice}><Text class="text-sm text-muted-foreground">{t(snapshot().notice!)}</Text></If>
  </View>;
  const resetAll = () => <Button testID="magic-reset-all" class={settingsAction} disabled={!snapshot().ready || disabled() || !Object.keys(snapshot().overrides).length} onPress={() => { void editor.resetAll(); }}><Text class="text-foreground">{t(snapshot().busy === 'all' ? 'settings.magicPrompts.page.actions.resetting' : 'settings.magicPrompts.page.actions.resetAllOverrides')}</Text></Button>;
  const promptList = () => <Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    <If when={!props.entity}>{feedback()}</If>
    <Text class="text-sm text-muted-foreground">{t('settings.magicPrompts.sidebar.description')}</Text>
    <Each of={magicPromptGroups}>{group => <SettingsGroup title={t(`settings.magicPrompts.sidebar.group.${group().group}`)}><Each of={group().entries as readonly MagicPromptEntry[]}>{item => <Button testID={`magic-group-${item().id}`} selected={props.entity === item().id} disabled={!lifetime.current() || disabled()} class="min-h-12 py-3 selected:bg-accent" onPress={() => { if (lifetime.current()) props.onOpen({ page: 'magic-prompts', entity: item().id }); }}><Text class="text-foreground">{t(`settings.magicPrompts.sidebar.item.${item().label}`)}</Text></Button>}</Each></SettingsGroup>}</Each>
    <If when={!props.entity}>{resetAll()}</If>
  </Scroll>;
  return <SettingsEntityLayout editing={!!props.entity} list={promptList}><Scroll class="flex-1 min-w-0 min-h-0" contentClass="p-5 gap-5 pb-10">
    {feedback()}
    <If when={!!props.entity && !entry}><Text class="text-destructive">{t('settings.view.unavailable.description')}</Text></If>
    <If when={!!entry && snapshot().ready}>
      <View class="gap-2"><Text class="text-xl font-semibold text-foreground">{entry ? t(`settings.magicPrompts.page.group.${entry.section}.title`) : ''}</Text><Text class="text-sm text-muted-foreground">{entry ? t(`settings.magicPrompts.page.group.${entry.section}.description`) : ''}</Text></View>
      <Each of={['visible', 'instructions'] as const}>{block => {
        const id = () => `${props.entity}.${block()}`;
        const dirty = () => { snapshot(); return editor.dirty(id()); };
        const overridden = () => { snapshot(); return editor.overridden(id()); };
        const draft = () => { snapshot(); return editor.value(id()); };
        const invalid = () => block() === 'visible' && !draft().trim();
        return <SettingsGroup title={t(block() === 'visible' ? 'settings.magicPrompts.page.block.visiblePrompt' : 'settings.magicPrompts.page.block.instructions')}>
          <Text class="text-xs text-muted-foreground">{nativeMagicDescriptions[id()]}</Text>
          <If when={(nativeMagicPlaceholders[id()] || []).length > 0}><Text class="text-xs text-muted-foreground">{t('settings.magicPrompts.page.placeholdersLabel')} {(nativeMagicPlaceholders[id()] || []).map(key => `{{${key}}}`).join(', ')}</Text></If>
          <SettingsInput testID={`magic-draft-${block()}`} title={t(block() === 'visible' ? 'settings.magicPrompts.page.block.visiblePrompt' : 'settings.magicPrompts.page.block.instructions')} value={draft()} multiline disabled={disabled()} onChange={next => editor.setDraft(id(), next)} />
          <If when={invalid()}><Text class="text-sm text-destructive">{t('settings.magicPrompts.page.validation.visiblePromptRequired')}</Text></If>
          <Text class="text-xs text-muted-foreground">{t(dirty() ? 'settings.magicPrompts.page.status.unsavedChanges' : overridden() ? 'settings.magicPrompts.page.status.usingSavedOverride' : 'settings.magicPrompts.page.status.usingBuiltinDefault')}</Text>
          <View class="gap-2"><Button testID={`magic-reset-${block()}`} class={settingsAction} disabled={disabled() || !overridden()} onPress={() => { void editor.reset(id()); }}><Text class="text-foreground">{t('settings.magicPrompts.page.actions.resetToDefault')}</Text></Button><Button testID={`magic-save-${block()}`} class={settingsAction} disabled={disabled() || !dirty() || invalid()} onPress={() => { void editor.save(id()); }}><Text class="text-foreground">{t('settings.magicPrompts.page.actions.save')}</Text></Button></View>
        </SettingsGroup>;
      }}</Each>
    </If>
    {resetAll()}
  </Scroll></SettingsEntityLayout>;
}
