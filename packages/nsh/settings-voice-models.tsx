import { cleanup, effect, lifecycle, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { AlertDialog, Button, Progress, Radio, RadioGroup } from 'nsh/base';
import { t } from './i18n';
import type { request } from './runtime';
import { SettingsChoice, SettingsGroup, settingsAction, settingsPageLifetime } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createVoiceModelManager, voiceLocalModels, type VoiceModelStatus } from './settings-voice-models-core';

const kokoroVoices = ['Alloy (af)', 'Bella (af)', 'Nicole (af)', 'Sarah (af)', 'Sky (af)', 'Adam (am)', 'Michael (am)', 'Emma (bf)', 'Isabella (bf)', 'George (bm)', 'Lewis (bm)'];

/** Only manages Host files. It never synthesizes audio or changes a provider. */
export function SettingsVoiceModels(props: {
  stt: boolean; tts: boolean; selectedModel: string; voice: number; disabled: boolean;
  active?: boolean; current: () => boolean; target?: string; onReveal?: (node: ViewRef) => void;
  onSelect: (id: string) => void; onVoice: (id: number) => void;
  send?: typeof request;
}) {
  const revision = signal(0);
  const lifetime = settingsPageLifetime(() => props.active !== false && props.current());
  const initial = lifetime.operation();
  const send = props.send ?? initial?.request ?? (async () => { throw new Error('Runtime changed'); });
  const manager = createVoiceModelManager({ send, current: props.send ? props.current : initial?.current ?? (() => false), changed: () => revision.set(revision() + 1) });
  lifetime.observeOperation(operation => { if (!props.send) manager.replaceLane(operation); });
  const snapshot = () => { revision(); return manager.snapshot(); };
  const failureText = (message?: string) => message?.startsWith('voice-model-') ? t('common.unavailable') : message ?? '';
  effect(() => {
    const active = (props.active ?? true) && lifecycle() === 'active' && (props.stt || props.tts) && props.current() && (props.send ? true : lifetime.current());
    untracked(() => manager.activate(active));
  });
  cleanup(manager.dispose);
  const status = (id: string) => snapshot().models.find(model => model.id === id);
  const blocked = (model?: VoiceModelStatus) => props.disabled || !(props.active ?? true) || lifecycle() !== 'active' || !props.current() || !props.send && !lifetime.operation()?.scope || snapshot().loading || !!snapshot().pending || !!snapshot().error || !model;
  async function remove(id: string) {
    const operation = manager.captureLane();
    if (!operation?.current()) return;
    if (blocked(status(id))) return;
    const choice = await AlertDialog.show({ title: t('settings.voice.page.stt.modelDelete'), description: id,
      actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'delete', label: t('settings.common.actions.delete'), role: 'destructive' }] });
    if (choice.action === 'delete' && operation.current() && !blocked(status(id))) await manager.mutate(id, 'DELETE');
  }
  const modelRow = (entry: typeof voiceLocalModels[number]) => <View testID={`voice-local-row-${entry.id}`} class="gap-2 py-2">
    <View class="flex-row items-center gap-2">
      <If when={entry.kind === 'stt'}><Radio testID={`voice-local-select-${entry.id}`} class="flex-1 min-h-11 flex-row items-center gap-2" checked={props.selectedModel === entry.id} disabled={props.disabled} accessibilityLabel={entry.label ? t(entry.label) : entry.id} onChange={() => props.onSelect(entry.id)}><View class="size-4 rounded-full border border-border items-center justify-center"><If when={props.selectedModel === entry.id}><View class="size-2 rounded-full bg-foreground" /></If></View><Text class="flex-1 text-sm text-foreground">{entry.label ? t(entry.label) : entry.id}</Text></Radio></If>
      <If when={entry.kind === 'tts'}><Text class="flex-1 text-sm text-foreground">{entry.name}</Text></If>
      <Text class="text-xs text-muted-foreground">{entry.sizeMB} MB</Text>
    </View>
    <If when={!!entry.badge}><Text class="text-xs text-muted-foreground">{entry.badge ? t(entry.badge) : ''}</Text></If>
    <If when={entry.kind === 'stt'}><View class="flex-row flex-wrap items-center gap-4"><View class="flex-row items-center gap-1.5"><Progress value={(entry.accuracy ?? 0) * 20} accessibilityLabel={`${t('settings.voice.page.stt.meta.accuracy')}: ${entry.accuracy}/5`} trackClass="h-1.5 w-12 overflow-hidden rounded-full bg-border" indicatorClass="h-full rounded-full bg-foreground" /><Text class="text-xs text-muted-foreground">{t('settings.voice.page.stt.meta.accuracy')}</Text></View><View class="flex-row items-center gap-1.5"><Progress value={(entry.speed ?? 0) * 20} accessibilityLabel={`${t('settings.voice.page.stt.meta.speed')}: ${entry.speed}/5`} trackClass="h-1.5 w-12 overflow-hidden rounded-full bg-border" indicatorClass="h-full rounded-full bg-foreground" /><Text class="text-xs text-muted-foreground">{t('settings.voice.page.stt.meta.speed')}</Text></View></View></If>
    <If when={!!status(entry.id)}>
      <Text testID={`voice-local-state-${entry.id}`} class="text-xs text-muted-foreground">{t(status(entry.id)?.downloading ? 'settings.voice.page.stt.modelDownloading' : status(entry.id)?.installed ? 'settings.voice.page.stt.modelInstalled' : 'settings.voice.page.stt.modelNotInstalled')}</Text>
      <If when={status(entry.id)?.downloading}><Progress testID={`voice-local-progress-${entry.id}`} value={status(entry.id)?.downloadProgress ?? undefined} indeterminate={status(entry.id)?.downloadProgress === null} accessibilityLabel={t('settings.voice.page.stt.modelDownloading')} trackClass="h-1 overflow-hidden rounded-full bg-border" indicatorClass={status(entry.id)?.downloadProgress === null ? 'h-full w-1/3 rounded-full bg-foreground' : 'h-full rounded-full bg-foreground'}><If when={typeof status(entry.id)?.downloadProgress === 'number'}><Text class="text-xs text-muted-foreground">{t('settings.voice.page.stt.modelDownloadingProgress', { percent: status(entry.id)?.downloadProgress ?? 0 })}</Text></If></Progress></If>
      <If when={!status(entry.id)?.downloading}><Button testID={`voice-local-${status(entry.id)?.installed ? 'delete' : 'download'}-${entry.id}`} class={settingsAction} disabled={blocked(status(entry.id))} onPress={() => { if (status(entry.id)?.installed) void remove(entry.id); else void manager.mutate(entry.id, 'POST'); }}><Text class={status(entry.id)?.installed ? 'text-destructive' : 'text-foreground'}>{snapshot().pending === entry.id ? t('common.loading') : t(status(entry.id)?.installed ? 'settings.voice.page.stt.modelDelete' : status(entry.id)?.downloadError || snapshot().operationError?.id === entry.id ? 'chat.questionDelegate.retry' : 'settings.voice.page.stt.modelDownload')}</Text></Button></If>
    </If>
    <If when={!!status(entry.id)?.downloadError}><Text testID={`voice-local-download-error-${entry.id}`} class="text-sm text-destructive">{status(entry.id)?.downloadError}</Text></If>
    <If when={!status(entry.id) && !snapshot().loading}><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></If>
    <If when={snapshot().operationError?.id === entry.id}><Text testID={`voice-local-action-error-${entry.id}`} class="text-sm text-destructive">{failureText(snapshot().operationError?.message)}</Text></If>
  </View>;
  return <View class="gap-5">
    <Text class="text-xs text-muted-foreground">{t('settings.voice.nativeModels.hostStorage')}</Text>
    <If when={snapshot().loading}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
    <If when={!!snapshot().error}><Text testID="voice-local-status-error" class="text-sm text-destructive">{failureText(snapshot().error)}</Text></If>
    <Button testID="voice-local-refresh" class={settingsAction} disabled={snapshot().loading || !!snapshot().pending || !(props.active ?? true)} onPress={() => { void manager.refresh(); }}><Text class="text-foreground">{t('chat.questionDelegate.refreshStatus')}</Text></Button>
    <If when={props.stt}><SettingsTarget id="voice.sttLocalModel" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.voice.page.section.speechRecognition')}><RadioGroup><Each of={voiceLocalModels.filter(model => model.kind === 'stt')}>{entry => modelRow(entry())}</Each></RadioGroup></SettingsGroup></SettingsTarget></If>
    <If when={props.tts}><SettingsTarget id="voice.localTtsVoiceId" target={props.target} onReveal={props.onReveal}><SettingsGroup title={t('settings.voice.page.section.playbackAndSummary')}><Each of={voiceLocalModels.filter(model => model.kind === 'tts')}>{entry => modelRow(entry())}</Each><SettingsChoice testID="voice-local-speaker" title={t('settings.voice.page.field.voice')} value={String(props.voice)} items={kokoroVoices.map((title, id) => ({ value: String(id), title }))} disabled={props.disabled} onChange={value => props.onVoice(Number(value))} /></SettingsGroup></SettingsTarget></If>
  </View>;
}
