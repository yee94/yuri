import { cleanup, effect, host, lifecycle, List, signal, Text, untracked, View } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { assistantRequest, readAssistantSnapshot, snapshotBots, type AssistantFence } from './assistants-core';
import { AssistantAvatar } from './assistants-avatar-live';
import { Icon } from './Icon';
import { t } from './i18n';
import { runtimeEventFrom, text, type Row } from './model';
import { app, captureHostRequest, epoch } from './state';

export type AssistantSettingsProps = { onCreate: () => void; onEdit: (bot: Row) => void; active?: boolean };

/** Settings owns configuration selection; it never opens a contact chat on row press. */
export function AssistantSettings(props: AssistantSettingsProps) {
  const request = captureHostRequest();
  const captured = epoch(), connectionID = app.connection()?.id;
  let alive = true, sequence = 0, revision = -1;
  const fence: AssistantFence = { current: () => alive && !!connectionID && captured === epoch() && connectionID === app.connection()?.id, request };
  const active = () => fence.current() && props.active !== false && lifecycle() === 'active';
  const loading = signal(true), error = signal(''), supported = signal<boolean | null>(null), enabled = signal(false);
  async function load() {
    if (!active()) return;
    const attempt = ++sequence;
    loading.set(true);
    try {
      const capability = await assistantRequest(fence, '/api/yuri/assistants/capability');
      if (attempt !== sequence || !fence.current()) return;
      if (typeof capability.supported !== 'boolean' || typeof capability.enabled !== 'boolean') throw new Error(t('assistants.state.unavailable'));
      supported.set(capability.supported);
      if (!capability.supported || !capability.enabled) { enabled.set(false); error.set(''); return; }
      const snapshot = await readAssistantSnapshot(fence);
      if (attempt !== sequence || !fence.current() || Number(snapshot.revision) < revision) return;
      revision = Number(snapshot.revision);
      enabled.set(snapshot.enabled === true); app.bots.set(snapshotBots(snapshot)); error.set('');
    } catch (failure) {
      if (attempt === sequence && fence.current()) error.set(failure instanceof Error ? failure.message : String(failure));
    } finally { if (attempt === sequence && fence.current()) loading.set(false); }
  }
  effect(() => { if (active()) untracked(() => { void load(); }); else { sequence++; loading.set(false); } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = host.on('runtime.event', value => {
    const event = runtimeEventFrom(value);
    if (!active() || timer || event?.key !== 'global' || !['assistants-changed', 'yuri:assistants-changed', 'event-stream-ready', 'yuri:event-stream-ready', 'reconnected'].includes(event.type)) return;
    timer = setTimeout(() => { timer = undefined; if (active()) void load(); }, 120);
  });
  cleanup(() => { alive = false; sequence++; stop(); if (timer) clearTimeout(timer); });
  return <NavPage title={t('assistants.title')} headerBackTitle="" class="flex-1 bg-background" headerRight={<Button testID="assistant-settings-create" class="min-w-11 min-h-11 items-center justify-center" disabled={!enabled() || !active()} accessibilityLabel={t('assistants.settings.create')} onPress={props.onCreate}><Icon name="add" /></Button>}>
    <List testID="assistant-settings-catalog" class="flex-1" contentClass="p-5 gap-3 pb-8" each={enabled() ? app.bots() : []} keyExtractor={bot => text(bot.id)} refreshing={loading()} onRefresh={() => { void load(); }}
      header={() => <View class="gap-3"><Text class="text-xs text-muted-foreground">{t('assistants.settings.listTitle')}</Text><If when={!!error()}><Text role="alert" class="text-destructive">{error()}</Text><Button testID="assistant-settings-retry" accessibilityLabel={t('assistants.actions.retry')} disabled={loading()} onPress={() => { void load(); }}><Text class="text-foreground">{t('assistants.actions.retry')}</Text></Button></If></View>}
      empty={() => <If when={!loading() && !error()}><View class="p-4 gap-3 rounded-2xl bg-card"><Text class="text-muted-foreground">{t(supported() === false ? 'assistants.state.unsupportedDescription' : !enabled() ? 'assistants.state.instanceDisabledDescription' : 'assistants.settings.empty')}</Text><If when={enabled()}><Button onPress={props.onCreate}><Text class="text-foreground">{t('assistants.settings.create')}</Text></Button></If></View></If>}>
      {bot => <Button testID={`assistant-settings-edit-${text(bot().id)}`} class="min-h-16 p-4 rounded-2xl bg-card flex-row items-center gap-3 active:bg-accent" disabled={!active()} onPress={() => props.onEdit(bot())}><AssistantAvatar bot={bot()} size={32} active={false} /><Text class="flex-1 text-foreground font-semibold">{text(bot().name)}</Text><Icon name="arrow-right-s" size={18} /></Button>}
    </List>
  </NavPage>;
}
