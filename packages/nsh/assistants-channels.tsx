import { cleanup, effect, Image, lifecycle, locale, openUrl, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, Dialog, Input } from 'nsh/base';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { admitAssistantMutation, assistantRequest, assistantURL, type AssistantFence } from './assistants-core';
import { language, t } from './i18n';
import { Icon } from './Icon';
import { list, record, text, type Row } from './model';
import { app, captureHostRequest, epoch } from './state';
import { assistantQRSvg } from './assistants-qr';
import wechatMark from '../ui/src/assets/brand/channels/wechat.svg';
import wecomMark from '../ui/src/assets/brand/channels/wecom.svg';
import feishuMark from '../ui/src/assets/brand/channels/feishu.svg';
import dingtalkMark from '../ui/src/assets/brand/channels/dingtalk.svg';

type Channel = 'weixin' | 'wecom' | 'feishu' | 'dingtalk';
const channels: Channel[] = ['weixin', 'wecom', 'feishu', 'dingtalk'];
const marks = { weixin: wechatMark, wecom: wecomMark, feishu: feishuMark, dingtalk: dingtalkMark };
const wireLanguage = () => language() === 'system' ? locale() : language();
const helpURLs = { wecom: 'https://github.com/WecomTeam/aibot-node-sdk#basemessage消息体基础结构', feishu: 'https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id', dingtalk: 'https://open.dingtalk.com/document/dingstart/robot-receive-message' };
const titleKey = (provider: Channel): I18nKey => provider === 'weixin' ? 'assistants.weixin.title' : `assistants.channels.${provider}.title`;
const action = 'min-h-11 py-3 px-4 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';
const field = 'min-h-12 p-3 rounded-xl bg-secondary text-foreground';
function errorKey(error: string, weixin: boolean): I18nKey {
  if (error.includes('binding_changed')) return 'assistants.weixin.error.bindingChanged';
  if (error.includes('account_in_use') || error.includes('already_bound')) return weixin ? 'assistants.weixin.error.accountInUse' : 'assistants.channels.error.accountInUse';
  if (error.includes('auth_expired')) return weixin ? 'assistants.weixin.error.authExpired' : 'assistants.channels.error.authExpired';
  if (error.includes('delivery_unknown')) return weixin ? 'assistants.weixin.error.deliveryUnknown' : 'assistants.channels.error.deliveryUnknown';
  if (weixin && error.includes('reply_unavailable')) return 'assistants.weixin.error.replyUnavailable';
  if (error.includes('channel_in_use')) return weixin ? 'assistants.weixin.error.channelInUse' : 'assistants.channels.error.channelInUse';
  if (error.includes('connection_replaced')) return 'assistants.channels.error.connectionReplaced';
  if (error.includes('invalid_credentials') || error.includes('unauthorized')) return 'assistants.channels.error.invalidCredentials';
  if (error.includes('discovery_timeout')) return 'assistants.channels.discovery.timeout';
  return weixin ? 'assistants.weixin.error.generic' : 'assistants.channels.error.generic';
}
export function AssistantChannels(props: { bot: Row }) {
  const selected = signal<Channel | null>(null);
  return <View class="gap-2">
    <Text class="text-xs text-muted-foreground">{t('assistants.channels.title')}</Text>
    <View class="bg-card rounded-2xl p-4 flex-row flex-wrap gap-3">
      <Each of={channels}>{provider => <Button testID={`assistant-channel-${provider()}`} class="w-32 min-h-20 p-3 rounded-xl bg-secondary items-center justify-center gap-2" accessibilityLabel={t(titleKey(provider()))} onPress={() => selected.set(provider())}><Image src={marks[provider()]} style={{ width: 28, height: 28, objectFit: 'contain' }} /><Text class="text-foreground">{t(titleKey(provider()))}</Text></Button>}</Each>
    </View>
    <If when={selected() !== null}>
      <Dialog presentation="pageSheet" class="flex-1 bg-background p-5 gap-4" closeOnEscape closeOnBackdropPress onOpenChange={event => { if (!event.open) selected.set(null); }}>
        <View class="flex-row items-center gap-3"><Text class="flex-1 text-xl font-semibold text-foreground">{t(titleKey(selected()!))}</Text><Button testID="assistant-channel-close" class={action} onPress={() => selected.set(null)} accessibilityLabel={t('settings.common.actions.cancel')}><Icon name="close" /></Button></View>
        <ChannelPanel bot={props.bot} provider={selected()!} onClose={() => selected.set(null)} />
      </Dialog>
    </If>
  </View>;
}

function ChannelPanel(props: { bot: Row; provider: Channel; onClose: () => void }) {
  const request = captureHostRequest();
  const captured = epoch(), connectionID = app.connection()?.id, weixin = props.provider === 'weixin';
  let alive = true, seeded = false, sequence = 0, discoverySequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = signal<Row | null>(null), error = signal(''), busy = signal(false), loading = signal(false), discovering = signal(false);
  const clientID = signal(''), secret = signal(''), ownerID = signal(''), code = signal(''), qr = signal('');
  const fence: AssistantFence = { current: () => alive && captured === epoch() && connectionID === app.connection()?.id, request };
  effect(() => {
    app.connection();
    if (fence.current()) return;
    discoverySequence++; secret.set(''); ownerID.set(''); code.set(''); qr.set('');
  });
  cleanup(() => { alive = false; sequence++; discoverySequence++; secret.set(''); code.set(''); qr.set(''); if (timer) clearTimeout(timer); });
  const path = assistantURL(text(props.bot.id), weixin ? '/weixin' : `/channels/${props.provider}`);
  const unavailable = () => !fence.current() || !state() || state()?.status === 'disabled' || state()?.status === 'unsupported';
  const needsSecret = () => state()?.hasSecret !== true || text(state()?.clientID) !== clientID().trim();
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!fence.current() || lifecycle() !== 'active') return;
    const status = text(state()?.status);
    const delay = ['waiting', 'scanned', 'verify', 'connecting'].includes(status) ? 2000 : ['connected', 'reconnecting'].includes(status) ? 15000 : 0;
    if (!delay) return;
    timer = setTimeout(() => { timer = undefined; if (!fence.current()) return; if (lifecycle() === 'active') void load(); else schedule(); }, delay);
  }
  function accept(value: Row, replaceFields = false) {
    const statuses = weixin ? ['disconnected', 'waiting', 'scanned', 'verify', 'connected', 'reconnecting', 'expired', 'error', 'unsupported', 'disabled'] : ['disconnected', 'connecting', 'connected', 'reconnecting', 'error', 'disabled', 'unsupported'];
    if (!statuses.includes(text(value.status)) || !weixin && value.status !== 'unsupported' && (value.provider !== props.provider || typeof value.configured !== 'boolean' || typeof value.hasSecret !== 'boolean')) throw new Error('invalid_response');
    state.set(value);
    qr.set('');
    if (weixin && text(value.qrCode)) qr.set('data:image/svg+xml,' + encodeURIComponent(assistantQRSvg(text(value.qrCode))));
    if (!seeded || replaceFields) { clientID.set(text(value.clientID)); ownerID.set(text(value.ownerID)); seeded = true; }
    if (replaceFields) { secret.set(''); code.set(''); }
    schedule();
  }
  async function load(replaceFields = false, duringWrite = false) {
    if (!fence.current() || busy() && !duringWrite || lifecycle() !== 'active') return;
    const attempt = ++sequence;
    loading.set(true);
    try {
      const value = await assistantRequest(fence, path);
      if (!fence.current() || attempt !== sequence) return;
      accept(value, replaceFields); error.set('');
    } catch (failure) {
      if (!fence.current() || attempt !== sequence) return;
      const status = record(failure).status;
      if (status === 404 || status === 501) accept({ status: 'unsupported' });
      else { error.set(failure instanceof Error ? failure.message : String(failure)); schedule(); }
    } finally { if (fence.current() && attempt === sequence) loading.set(false); }
  }
  function cancelDiscovery() { discoverySequence++; discovering.set(false); }
  async function perform(suffix: string, method: string, body?: Row, close = false) {
    if (busy() || discovering() || !fence.current()) return;
    busy.set(true); error.set('');
    if (timer) { clearTimeout(timer); timer = undefined; }
    sequence++;
    try {
      await admitAssistantMutation(fence);
      if (!fence.current()) return;
      if (unavailable()) throw new Error('assistant_disabled');
      const result = await assistantRequest(fence, path + suffix, method, body);
      if (!fence.current()) return;
      if (!text(result.status)) {
        await load(suffix === '/transfer' || method === 'DELETE', true);
        if (!fence.current()) return;
      } else accept(result, suffix === '/transfer' || method === 'DELETE');
      if (suffix === '/verify') code.set('');
      if (close && state()?.configured === true) { secret.set(''); props.onClose(); }
    } catch (failure) { if (fence.current()) error.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (fence.current()) { loading.set(false); busy.set(false); schedule(); } }
  }
  async function save() {
    if (!clientID().trim() || !ownerID().trim() || needsSecret() && !secret().trim() || discovering()) return;
    await perform('', 'PUT', { clientID: clientID().trim(), ownerID: ownerID().trim(), ...(secret() ? { clientSecret: secret() } : {}), language: wireLanguage() }, true);
    if (!fence.current()) return;
  }
  async function disconnect() {
    const answer = await AlertDialog.show({ title: t(weixin ? 'assistants.weixin.disconnect' : 'assistants.channels.actions.confirmDisconnect'), description: t('assistants.channels.disconnectWarning'), actions: [{ id: 'cancel', role: 'cancel', label: t('settings.common.actions.cancel') }, { id: 'remove', role: 'destructive', label: t(weixin ? 'assistants.weixin.disconnect' : 'assistants.channels.actions.confirmDisconnect') }] });
    if (!fence.current() || answer.action !== 'remove') return;
    await perform('', 'DELETE');
    if (!fence.current()) return;
  }
  async function discover() {
    if (busy() || discovering() || unavailable() || !clientID().trim() || needsSecret() && !secret().trim()) return;
    const attempt = ++discoverySequence;
    discovering.set(true); error.set('');
    try {
      await admitAssistantMutation(fence);
      if (!fence.current() || attempt !== discoverySequence) return;
      const result = await assistantRequest(fence, path + '/discover', 'POST', { clientID: clientID().trim(), ...(secret() ? { clientSecret: secret() } : {}) });
      if (!fence.current() || attempt !== discoverySequence) return;
      if (!text(result.ownerID)) throw new Error('invalid_response');
      ownerID.set(text(result.ownerID));
    } catch (failure) { if (fence.current() && attempt === discoverySequence) error.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (fence.current() && attempt === discoverySequence) discovering.set(false); }
  }
  async function transfer(source: Row) {
    const revision = text(source.revision), sourceID = text(source.assistantID);
    const answer = await AlertDialog.show({ title: t('assistants.weixin.transfer'), description: t('assistants.weixin.transferWarning'), actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'transfer', label: t('assistants.weixin.transferConfirm') }] });
    if (!fence.current() || answer.action !== 'transfer' || discovering()) return;
    if (!list(state()?.transferSources).some(item => item.assistantID === sourceID && item.revision === revision)) { error.set('binding_changed'); return; }
    await perform('/transfer', 'POST', { sourceAssistantID: sourceID, revision, ...(weixin ? { language: wireLanguage() } : {}) });
    if (!fence.current()) return;
  }
  async function openHelp() {
    if (!fence.current() || weixin) return;
    try {
      const result = await openUrl(helpURLs[props.provider as Exclude<Channel, 'weixin'>]);
      if (!fence.current()) return;
      if (!result.opened) error.set('channel_error');
    } catch { if (fence.current()) error.set('channel_error'); }
  }
  effect(() => {
    const active = lifecycle() === 'active' && fence.current();
    if (active) untracked(() => { void load(); });
    else if (timer) { clearTimeout(timer); timer = undefined; }
  });
  const statusKey = (): I18nKey => {
    const status = text(state()?.status);
    if (weixin) {
      const keys: Record<string, I18nKey> = { disconnected: 'assistants.weixin.status.disconnected', waiting: 'assistants.weixin.status.waiting', scanned: 'assistants.weixin.status.scanned', verify: 'assistants.weixin.status.verify', connected: 'assistants.weixin.status.connected', reconnecting: 'assistants.weixin.status.reconnecting', expired: 'assistants.weixin.status.expired', error: 'assistants.weixin.status.error', unsupported: 'assistants.weixin.status.unsupported', disabled: 'assistants.weixin.status.disabled' };
      return keys[status] || 'common.loading';
    }
    const keys: Record<string, I18nKey> = { disabled: 'assistants.channels.status.disabled', unsupported: 'assistants.channels.status.unsupported', disconnected: 'assistants.channels.status.disconnected', connecting: 'assistants.channels.status.connecting', connected: 'assistants.channels.status.connected', reconnecting: 'assistants.channels.status.reconnecting', error: 'assistants.channels.status.error' };
    return keys[status] || 'common.loading';
  };
  return <Scroll class="flex-1" contentClass="gap-4 pb-8">
    <Text class="text-muted-foreground">{t(statusKey())}</Text>
    <If when={!!error() || !!state()?.error}><Text class="text-destructive">{t(errorKey(error() || text(state()?.error), weixin))}</Text></If>
    <If when={(!state() || !!error()) && !loading()}><Button testID="assistant-channel-refresh" class={action} disabled={busy() || discovering()} onPress={() => { void load(); }}><Text class="text-foreground">{t('assistants.actions.retry')}</Text></Button></If>
    <If when={!unavailable() && !weixin}>
      <Text class="text-sm text-foreground">{t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.clientID`)}</Text>
      <Input testID="assistant-channel-client" class={field} value={clientID()} disabled={busy()} autoCapitalize="none" autoCorrect={false} onChange={event => { cancelDiscovery(); clientID.set(event.value); ownerID.set(''); }} accessibilityLabel={t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.clientID`)} />
      <Text class="text-sm text-foreground">{t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.secret`)}</Text>
      <Input testID="assistant-channel-secret" class={field} value={secret()} disabled={busy()} masked autoCapitalize="none" autoCorrect={false} onChange={event => { cancelDiscovery(); secret.set(event.value); }} accessibilityLabel={t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.secret`)} />
      <Text class="text-xs text-muted-foreground">{t(needsSecret() ? 'assistants.channels.field.secretRequired' : 'assistants.channels.field.secretKeep')}</Text>
      <Text class="text-sm text-foreground">{t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.ownerID`)}</Text>
      <Input testID="assistant-channel-owner" class={field} value={ownerID()} disabled={busy()} autoCapitalize="none" autoCorrect={false} onChange={event => { cancelDiscovery(); ownerID.set(event.value); }} accessibilityLabel={t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.ownerID`)} />
      <Text class="text-xs text-muted-foreground">{t('assistants.channels.field.ownerDescription')}</Text>
      <Text class="text-xs text-muted-foreground">{t(`assistants.channels.field.${props.provider as Exclude<Channel, 'weixin'>}.ownerHelp`)}</Text>
      <Button class={action} onPress={() => { void openHelp(); }}><Text class="text-foreground">{t('assistants.channels.field.ownerHelpLink')}</Text></Button>
      <If when={!ownerID().trim()}><Text class="text-xs text-muted-foreground">{t(discovering() ? 'assistants.channels.discovery.waiting' : 'assistants.channels.discovery.hint')}</Text><Button class={action} disabled={busy() || !discovering() && (!clientID().trim() || needsSecret() && !secret().trim())} onPress={() => { if (discovering()) cancelDiscovery(); else void discover(); }}><Text class="text-foreground">{t(discovering() ? 'settings.common.actions.cancel' : 'assistants.channels.discovery.start')}</Text></Button></If>
      <Button testID="assistant-channel-save" class={action} disabled={busy() || discovering() || !clientID().trim() || !ownerID().trim() || needsSecret() && !secret().trim()} onPress={() => { void save(); }}><Text class="text-foreground">{t('assistants.channels.actions.save')}</Text></Button>
    </If>
    <If when={!unavailable() && weixin}>
      <If when={state()?.status !== 'connected' && state()?.status !== 'reconnecting' && !['waiting', 'scanned', 'verify'].includes(text(state()?.status))}><Button class={action} disabled={busy()} onPress={() => { void perform('/login', 'POST', { language: wireLanguage() }); }}><Text class="text-foreground">{t('assistants.weixin.connect')}</Text></Button></If>
      <If when={['waiting', 'scanned', 'verify'].includes(text(state()?.status))}><Text class="text-muted-foreground">{t('assistants.weixin.scan')}</Text><If when={!!qr()}><Image src={qr()} style={{ width: 224, height: 224, objectFit: 'contain' }} accessibilityLabel={t('assistants.weixin.qrAlt')} /></If></If>
      <If when={state()?.status === 'verify'}><Input class={field} value={code()} accessibilityLabel={t('assistants.weixin.verify')} onChange={event => code.set(event.value.replace(/\D/g, '').slice(0, 12))} /><Button class={action} disabled={busy() || code().length < 4} onPress={() => { void perform('/verify', 'POST', { code: code() }); }}><Text class="text-foreground">{t('assistants.weixin.verifySubmit')}</Text></Button></If>
    </If>
    <If when={!unavailable() && (state()?.configured === true || ['connected', 'reconnecting', 'waiting', 'scanned', 'verify'].includes(text(state()?.status)))}><Button class={action} disabled={busy() || discovering() || state()?.status === 'connecting'} onPress={() => { void perform('/retry', 'POST', weixin ? { language: wireLanguage() } : undefined); }}><Text class="text-foreground">{t('assistants.channels.actions.retry')}</Text></Button><Button class={action} disabled={busy() || discovering()} onPress={() => { void disconnect(); }}><Text class="text-destructive">{t(weixin ? 'assistants.weixin.disconnect' : 'assistants.channels.actions.disconnect')}</Text></Button></If>
    <If when={!unavailable() && weixin && ['expired', 'error'].includes(text(state()?.status))}><Button class={action} disabled={busy()} onPress={() => { void disconnect(); }}><Text class="text-destructive">{t('assistants.weixin.disconnect')}</Text></Button></If>
    <If when={!unavailable() && state()?.configured !== true && !['connected', 'reconnecting', 'waiting', 'scanned', 'verify'].includes(text(state()?.status))}><Each of={list(state()?.transferSources).filter(source => weixin || !clientID().trim() || source.clientID === clientID().trim())}>{source => <View class="gap-2"><Text class="text-muted-foreground">{t('assistants.weixin.transferFrom', { name: text(source().name) })}</Text><Button class={action} disabled={busy() || discovering()} onPress={() => { void transfer(source()); }}><Text class="text-foreground">{t('assistants.weixin.transfer')}</Text></Button></View>}</Each></If>
  </Scroll>;
}
