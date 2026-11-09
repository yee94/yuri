import { cleanup, effect, host, lifecycle, Scroll, signal, Text, untracked, View, type ScrollRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { nativeDensity } from './appearance';
import { t } from './i18n';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { text, type Row } from './model';
import { native } from './runtime';
import { app, captureHostOperation, epoch, loadConnections, switchConnection } from './state';
import type { SettingsCallbacks, SettingsRoute } from './settings';
import { SettingsChoice, SettingsFeedback, SettingsGroup, SettingsInput, SettingsToggle, settingsAction, settingsOperationLifetime, type SettingsHostOperation, type SettingsOperation } from './settings-controls';
import { settingsObject } from './settings-protocol';
import { SettingsDefaults } from './settings-defaults';
import { createSettingsTargetNavigation } from './settings-search-core';
import { settingsBasicFields, settingsBasicTarget } from './settings-basics-core';
import { SettingsTarget } from './settings-target';
import { SettingsPreferences } from './settings-preferences';
import { SettingsAbout } from './settings-about';
import { SettingsNotifications } from './notification-settings';
import { SettingsVoiceModels } from './settings-voice-models';
import { speechDefaults } from '../ui/src/lib/voice/speechSettings';
import { SettingsSessionRetentionSection } from './settings-retention';
import type { RetentionController } from './settings-retention-controller';
import { SettingsVoiceTests } from './settings-voice-test';
import { createSettingsVoiceConfirmation } from './settings-voice-confirm';
import { createSettingsVoiceRecognitionAdapter } from './settings-voice-recognition';
import type { VoiceTestAsrAdapter, VoiceTestConfirmation, VoiceTestKind } from './settings-voice-test-core';
import { publishSettingsEditor } from './desktop-settings-publisher';
import { SettingsSessions } from './settings-sessions';
import { SettingsVoiceCatalog } from './settings-voice-catalog';

function optionTitle(key: string, value: string) {
  const labels: Record<string, Record<string, I18nKey>> = {
    sessionRetentionAction: { archive: 'settings.yuri.sessionRetention.action.archive', delete: 'settings.yuri.sessionRetention.action.delete' },
    followUpBehavior: { steer: 'settings.yuri.visual.option.followUpBehavior.steer.label', queue: 'settings.yuri.visual.option.followUpBehavior.queue.label' },
    chatRenderMode: { sorted: 'settings.yuri.visual.option.chatRenderMode.sorted.label', live: 'settings.yuri.visual.option.chatRenderMode.live.label' },
    timeFormatPreference: { auto: 'settings.yuri.visual.option.timeFormat.auto.label', '12h': 'settings.yuri.visual.option.timeFormat.12h.label', '24h': 'settings.yuri.visual.option.timeFormat.24h.label' },
    weekStartPreference: { auto: 'settings.yuri.visual.option.weekStart.auto.label', sunday: 'settings.yuri.visual.option.weekStart.sunday.label', monday: 'settings.yuri.visual.option.weekStart.monday.label' },
    ttsInputMode: { final: 'settings.voice.page.field.ttsInputModeFinal', sanitized: 'settings.voice.page.field.ttsInputModeSanitized', raw: 'settings.voice.page.field.ttsInputModeRaw', summarized: 'settings.voice.page.field.ttsInputModeSummarized' },
  };
  if (key === 'responseStylePreset') return t(`settings.behavior.page.responseStyle.option.${value}` as I18nKey);
  if ((key === 'sttProvider' || key === 'voiceProvider') && value === 'volcengine') return t('settings.voice.volcengine.name');
  if ((key === 'sttProvider' || key === 'voiceProvider') && value === 'openai-compatible') return t('settings.voice.page.provider.custom');
  if ((key === 'sttProvider' || key === 'voiceProvider') && ['local', 'browser', 'say'].includes(value)) return t(`settings.voice.page.provider.${value}` as I18nKey);
  const label = labels[key]?.[value];
  return label ? t(label) : value === 'openai' ? 'OpenAI' : value;
}

export function SettingsBasics(props: SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean; retention?: RetentionController; operationToken?: SettingsHostOperation | null }) {
  if (props.page === 'appearance' || props.page === 'chat') return <SettingsPreferences {...props} />;
  if (props.page === 'about') return <SettingsAbout target={props.target} active={props.active} />;
  if (props.page === 'notifications') return <SettingsNotifications target={props.target} active={props.active} />;
  const mountedHost = app.connection();
  const mountedIdentity = mountedHost ? [mountedHost.id, mountedHost.url, mountedHost.authorizationID] : null;
  let retiredHost = false;
  const pageActive = () => props.active !== false && lifecycle() === 'active';
  const state = settingsOperationLifetime(props.operationToken === undefined ? captureHostOperation() : props.operationToken, pageActive), data = signal<Row>({}), changes = signal<Row>({});
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, state.current, () => state.operation()?.current ?? (() => false));
  const prompt = signal(''), initialPrompt = signal('');
  const initialData = signal<Row>({});
  const pageFields = settingsBasicFields(props.page);
   const isLocalPage = ['instances', 'assistants', 'summary-ai'].includes(props.page);
  const supported = isLocalPage || !!pageFields.length;
  const voiceRevision = signal(0), voiceTestVersion = signal(0), recognitionReady = signal(false);
  const recognitionError = signal(false), recognitionAttempt = signal(0);
  const voiceCurrent = () => props.page === 'voice' && props.active === true && lifecycle() === 'active' && state.current();
  const catalogProvider = () => props.target === 'voice.sayVoice' ? 'say' : props.target === 'voice.browserVoice' ? 'browser' : data().voiceProvider ?? speechDefaults.voiceProvider;
  const catalogVoiceKey = () => catalogProvider() === 'say' ? 'sayVoice' : 'browserVoice';
  const initialOperation = state.operation();
  const voice = props.page === 'voice' ? createSettingsVoiceConfirmation({ send: initialOperation?.request ?? (async () => { throw new Error('settings_operation_stale'); }), current: initialOperation?.current ?? (() => false), active: voiceCurrent,
    changed: value => { data.set(value.data); changes.set(value.changes); voiceRevision.set(value.draftRevision); state.ready.set(value.ready); },
    invalidField: key => { const field = pageFields.find(field => field.key === key)!; return `${t(field.title)}: ${field.min ?? 0}–${field.max ?? '∞'}`; },
  }) : null;
  publishSettingsEditor({ current: state.current, scope: state.operation, pending: () => state.busy() || voice?.pending() === true,
    dirty: () => { const edits = changes(); return prompt() !== initialPrompt() || (voice ? voice.dirty() : Object.entries(edits).some(([key, value]) => !Object.is(value, initialData()[key]))); },
    stamp: () => [changes(), prompt()],
  });
  type RecognitionAdapter = Awaited<ReturnType<typeof createSettingsVoiceRecognitionAdapter>>;
  let recognition: RecognitionAdapter | null = null, recognitionGeneration = 0;
  const retiredRecognition = new Set<RecognitionAdapter>();
  let recognitionCleanup: Promise<void> = Promise.resolve();
  const testerFlights = new Set<Promise<unknown>>();
  const failedTesterCleanup = new Map<string, () => Promise<unknown>>();
  async function testerSettled() {
    // Cleanup can enqueue release after stop/late prepare. Drain that existing
    // work before installing another capability owner; no new timer or request.
    do { await Promise.allSettled([...testerFlights]); await Promise.resolve(); } while (testerFlights.size);
    if (failedTesterCleanup.size) throw new Error('voice-test-cleanup-failed');
  }
  function testerCall(operation: SettingsOperation | null) {
    return (name: string, input: Record<string, unknown>) => {
      const cleanup = name === 'speech.stop' || name === 'speech.release';
      if (!cleanup && !operation?.current()) return Promise.reject(new Error('settings_operation_stale'));
      const cleanupKey = cleanup ? JSON.stringify([name, input.owner, input.revision]) : '';
      const flight = native(name, input);
      testerFlights.add(flight);
      void flight.then(() => { testerFlights.delete(flight); if (cleanup) failedTesterCleanup.delete(cleanupKey); }, () => {
        testerFlights.delete(flight);
        if (cleanup) failedTesterCleanup.set(cleanupKey, () => testerCall(operation)(name, input));
      });
      return flight;
    };
  }
  async function retryRecognition() {
    const operation = state.operation();
    if (!operation?.current()) return;
    try {
      await Promise.all([...failedTesterCleanup.values()].map(retry => retry()));
      if (operation.current()) recognitionAttempt.set(recognitionAttempt() + 1);
    } catch { if (operation.current()) recognitionError.set(true); }
  }
  function retireRecognition(previous: RecognitionAdapter | null) {
    if (previous) retiredRecognition.add(previous);
    recognitionCleanup = recognitionCleanup.catch(() => {}).then(async () => {
      for (const adapter of [...retiredRecognition]) { await adapter.dispose(); retiredRecognition.delete(adapter); }
    });
    return recognitionCleanup;
  }
  function update(key: string, value: unknown) { const operation = state.operation(); if (!operation?.current()) return; if (voice) { voice.update(key, value); return; } data.set({ ...data(), [key]: value }); changes.set({ ...changes(), [key]: value }); }
  async function load(captured = state.operation()) {
    await state.perform(async operation => {
      if (voice) { await voice.load(); return; }
      if (props.page === 'instances') await loadConnections();
      else if (props.page === 'assistants' || props.page === 'summary-ai') { /* These pages own their loading or navigation. */ }
      else if (supported) {
        const result = settingsObject(await operation.request(props.page === 'voice' ? '/api/voice/settings' : '/api/config/settings'));
        if (!operation.current()) return;
        initialData.set(result);
        data.set({ ...Object.fromEntries(pageFields.filter(field => field.kind !== 'secret').map(field => field.key).filter(key => key in result).map(key => [key, result[key]])), ...changes() });
        if (props.page === 'behavior') {
          const document = settingsObject(await operation.request('/api/behavior/agents-md'));
          if (!operation.current()) return;
          if (prompt() === initialPrompt()) prompt.set(text(document.content)); initialPrompt.set(text(document.content));
        }
      }
      if (operation.current()) state.ready.set(true);
    }, captured);
  }
  effect(() => {
    const connection = app.connection(); app.runtimeScope(); epoch();
    const confirmed = props.operationToken === undefined ? captureHostOperation() : props.operationToken;
    const admitted = confirmed?.current() === true;
    untracked(() => {
      if (connection && (!mountedIdentity || connection.id !== mountedIdentity[0] || connection.url !== mountedIdentity[1] || connection.authorizationID !== mountedIdentity[2])) retiredHost = true;
      const previous = state.operation();
      if (retiredHost || !admitted || !confirmed) {
        if (previous) { state.retireOperation(); voice?.replaceLane(null); voiceTestVersion.set(voiceTestVersion() + 1); }
        return;
      }
      // A route cover changes active, not Host authority or the retained editor.
      if (previous && previous.generation === confirmed.generation && previous.scope?.hostID === confirmed.scope?.hostID && previous.scope?.lease === confirmed.scope?.lease) return;
      const next = state.replaceOperation(confirmed);
      voice?.replaceLane(next ? { send: next.request, current: next.current } : null);
      voiceTestVersion.set(voiceTestVersion() + 1);
      if (!voice && next?.current()) void load(next);
    });
  });
  if (!voice) void load();
  if (voice) {
    let loadedOperation: SettingsOperation | null = null;
    effect(() => {
      const operation = state.operation(), active = voiceCurrent();
      untracked(() => {
        voice.activate(active);
        if (active && (operation !== loadedOperation || !state.ready())) { loadedOperation = operation; void load(operation); }
      });
    });
    effect(() => {
      const operation = state.operation(), active = voiceCurrent() && state.ready();
      recognitionAttempt();
      untracked(() => {
        const generation = ++recognitionGeneration, previous = recognition;
        recognition = null; recognitionReady.set(false); recognitionError.set(false);
        // The controller owns its session cancellation as well. Capability
        // acquisition and subscriptions are separately scoped to the real page.
        void (async () => {
          try {
            try { await retireRecognition(previous); await testerSettled(); }
            catch { if (generation === recognitionGeneration && operation?.current()) recognitionError.set(true); return; }
            if (!active || !operation?.current() || generation !== recognitionGeneration) return;
            const acquired = await createSettingsVoiceRecognitionAdapter({ call: native, expectedHost: operation.scope, on: (name, callback) => host.on(name, callback),
              current: () => generation === recognitionGeneration && operation.current(),
              invalidated: () => { if (generation === recognitionGeneration && operation.current()) voiceTestVersion.set(voiceTestVersion() + 1); },
             });
            if (generation !== recognitionGeneration || !operation.current()) { await retireRecognition(acquired); return; }
            recognition = acquired; recognitionReady.set(true); voiceTestVersion.set(voiceTestVersion() + 1);
          } catch { if (generation === recognitionGeneration && operation?.current()) recognitionError.set(true); }
        })();
      });
    });
    cleanup(() => { recognitionGeneration++; voice.dispose(); const previous = recognition; recognition = null; void retireRecognition(previous).catch(() => {}); });
  }
  async function confirmVoice(kind: VoiceTestKind, captured = state.operation()): Promise<VoiceTestConfirmation | null> {
    let receipt: VoiceTestConfirmation | null = null;
    if (!voice || !captured?.scope || !captured.current() || !voiceCurrent()) return null;
    await state.perform(async operation => {
      try { receipt = await voice.confirm(kind); }
      catch { throw new Error(t('settings.voice.volcengine.saveFailed')); }
      if (receipt && operation.current()) state.notice.set(t('filesView.editor.saved'));
    }, captured);
    return captured.current() ? receipt : null;
  }
  async function save() {
    if (voice) { await confirmVoice('tts'); return; }
    await state.perform(async operation => {
      const snapshot = { ...changes() };
      for (const field of pageFields) if (field.kind === 'number' && field.key in snapshot) {
        const value = Number(snapshot[field.key]);
        if (snapshot[field.key] === '' || !Number.isFinite(value) || value < (field.min ?? 0) || value > (field.max ?? Infinity)) throw new Error(`${t(field.title)}: ${field.min ?? 0}–${field.max ?? '∞'}`);
        snapshot[field.key] = field.max ? Math.round(value) : value;
      }
      if (pageFields.some(field => field.local && field.key in snapshot)) throw new Error(t('settings.view.unavailable.description'));
      if (props.page === 'behavior' && prompt() !== initialPrompt()) {
        const content = prompt() && !prompt().endsWith('\n') ? prompt() + '\n' : prompt();
        await operation.transaction('/api/behavior/agents-md', 'PUT', { content });
        // This document is already committed even if the settings write below fails.
        initialPrompt.set(prompt());
        changes.set({ ...changes(), globalBehaviorPrompt: content });
        snapshot.globalBehaviorPrompt = content;
      }
      if (Object.keys(snapshot).length) await operation.transaction(props.page === 'voice' ? '/api/voice/settings' : '/api/config/settings', 'PUT', snapshot);
      if (!operation.current()) return;
      initialData.set({ ...initialData(), ...snapshot });
      for (const field of pageFields) if (field.kind === 'secret') data.set({ ...data(), [field.key]: '' });
      changes.set({}); initialPrompt.set(prompt());
      state.notice.set(t(props.page === 'behavior' ? 'settings.behavior.page.toast.saved' : 'filesView.editor.saved'));
    });
  }
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <SettingsFeedback state={state} retry={!state.ready() ? () => { void load(); } : undefined} />
    <If when={props.page === 'voice' && recognitionError()}><View class="gap-2"><Text class="text-sm text-destructive">{t('common.unavailable')}</Text><Button testID="settings-voice-recognition-retry" class={settingsAction} disabled={!voiceCurrent()} onPress={() => { void retryRecognition(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></View></If>
    <If when={props.page === 'sessions' || props.page === 'summary-ai'}><SettingsDefaults {...props} onReveal={node => { void navigation.reveal(node); }} /></If>
    <If when={props.page === 'sessions'}><SettingsSessions operation={state.operation} active={pageActive} target={props.target} onReveal={node => { void navigation.reveal(node); }} /></If>
    <If when={props.page === 'sessions' && !!props.retention}><SettingsSessionRetentionSection controller={props.retention!} active={props.active === true} target={props.target} onReveal={node => { void navigation.reveal(node); }} /></If>
    <If when={props.page === 'instances'}>
      <Button class={settingsAction} onPress={props.onConnect}><Text class="text-foreground">{t('mobile.instances.addTitle')}</Text></Button>
      <SettingsGroup title={t('mobile.connect.saved.title')}><Each of={app.connections()}>{connection => <View class="gap-2 py-2"><Button class="min-h-12 gap-1" disabled={state.busy()} onPress={() => { void state.perform(async () => { await switchConnection(connection().id); props.onBack(); }); }}><Text class="text-base text-foreground">{connection().label}</Text><Text class="text-xs text-muted-foreground">{connection().url}</Text><Text class="text-xs text-muted-foreground">{t(app.connection()?.id === connection().id ? 'mobile.instances.status.connected' : 'mobile.instances.status.saved')}</Text></Button>
        <If when={!!props.onEditConnection}><View class="flex-row gap-2"><Button testID={`connection-rename-${connection().id}`} class={settingsAction} disabled={state.busy()} onPress={() => props.onEditConnection?.(connection().id, 'rename')}><Text class="text-foreground">{t('mobile.connect.history.rename')}</Text></Button><Button testID={`connection-edit-${connection().id}`} class={settingsAction} disabled={state.busy()} onPress={() => props.onEditConnection?.(connection().id, 'edit')}><Text class="text-foreground">{t('mobile.instances.edit')}</Text></Button></View></If>
         <Button class={settingsAction} disabled={state.busy()} onPress={() => { void state.perform(async operation => { const choice = await AlertDialog.show({ title: t('mobile.instances.confirmDeleteAria', { label: connection().label }), actions: [{ id: 'cancel', label: t('mobile.instances.cancelEdit'), role: 'cancel' }, { label: t('mobile.instances.delete'), role: 'destructive', id: 'delete' }] }); if (choice.action !== 'delete' || !operation.current()) return; await native('connection.remove', { id: connection().id }); if (operation.current()) await loadConnections(); }); }}><Text class="text-destructive">{t('mobile.instances.delete')}</Text></Button></View>}</Each></SettingsGroup>
    </If>
    <If when={props.page === 'assistants'}><Button class={settingsAction} onPress={() => props.onAssistants?.()}><Text class="text-foreground">{t('mobile.tabs.assistant')}</Text></Button></If>
    <If when={props.page === 'behavior' && state.ready()}><SettingsTarget id="behavior.system-prompt" target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsGroup title={t('settings.behavior.page.section.systemPrompt')}><SettingsInput testID="settings-behavior-prompt" title={t('settings.behavior.page.section.systemPrompt')} multiline value={prompt()} disabled={state.busy()} onChange={next => prompt.set(next)} /></SettingsGroup></SettingsTarget></If>
    <If when={state.ready() && pageFields.length > 0}>
      <SettingsGroup title={t('settings.view.home.title')}><Each of={pageFields.filter(field => !field.managed)}>{field => <SettingsTarget id={settingsBasicTarget(props.page, field())} target={props.target} onReveal={node => { void navigation.reveal(node); }}>
        <If when={field().local}><Text class="text-sm text-foreground">{t(field().title)}</Text><Text class="text-xs text-muted-foreground">{t('settings.view.unavailable.description')}</Text></If>
        <If when={!field().local}>
        <If when={field().kind === 'boolean'}><SettingsToggle title={t(field().title)} value={data()[field().key] === true} disabled={state.busy()} onChange={next => update(field().key, next)} /></If>
        <If when={field().kind !== 'boolean' && !field().options}><SettingsInput testID={`settings-basics-${field().key}`} title={t(field().title)} value={data()[field().key] === undefined ? '' : String(data()[field().key])} multiline={field().kind === 'multiline'} masked={field().kind === 'secret'} disabled={state.busy()} onChange={next => update(field().key, next)} /></If>
        <If when={!!field().options}><SettingsChoice title={t(field().title)} value={text(data()[field().key])} disabled={state.busy()} items={(field().options || []).map(value => ({ value, title: optionTitle(field().key, value) }))} onChange={next => update(field().key, next)} /></If>
        </If>
      </SettingsTarget>}</Each></SettingsGroup>
      <If when={props.page === 'voice' && ((data().sttProvider ?? speechDefaults.sttProvider) === 'local' || (data().voiceProvider ?? speechDefaults.voiceProvider) === 'local' || props.target === 'voice.sttLocalModel' || props.target === 'voice.localTtsVoiceId')}><SettingsVoiceModels stt={(data().sttProvider ?? speechDefaults.sttProvider) === 'local' || props.target === 'voice.sttLocalModel'} tts={(data().voiceProvider ?? speechDefaults.voiceProvider) === 'local' || props.target === 'voice.localTtsVoiceId'} selectedModel={text(data().sttLocalModel) || speechDefaults.sttLocalModel} voice={typeof data().localTtsVoiceId === 'number' ? data().localTtsVoiceId as number : speechDefaults.localTtsVoiceId} disabled={state.busy()} active={props.active} current={state.current} target={props.target} onReveal={node => { void navigation.reveal(node); }} onSelect={value => update('sttLocalModel', value)} onVoice={value => update('localTtsVoiceId', value)} /></If>
      <If when={props.page === 'voice'}><SettingsTarget id={`voice.${catalogVoiceKey()}`} target={props.target} onReveal={node => { void navigation.reveal(node); }}><SettingsVoiceCatalog provider={catalogProvider} value={() => text(data()[catalogVoiceKey()])} active={voiceCurrent} operation={state.operation} disabled={state.busy} onChange={update} /></SettingsTarget></If>
      <If when={props.page === 'voice'}><Each of={[voiceTestVersion()]} key={version => version}>{() => {
        const operation = state.operation(), adapter: VoiceTestAsrAdapter | null = recognition;
        const current = () => !!operation?.scope && operation.current() && voiceCurrent();
        return <SettingsVoiceTests tts asr active={props.active === true} current={current} disabled={state.busy() || !recognitionReady()} dirty={Object.keys(changes()).length > 0} draftRevision={voiceRevision()} confirm={kind => confirmVoice(kind, operation)} asrAdapter={adapter} call={testerCall(operation)} />;
      }}</Each></If>
      <Button testID="settings-basics-save" class={settingsAction} disabled={state.busy()} onPress={() => { void save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
    </If>
    <If when={!supported}><SettingsGroup title={t('settings.view.unavailable.title')}><Text class="text-muted-foreground">{t('settings.view.unavailable.description')}</Text></SettingsGroup></If>
  </Scroll>;
}
