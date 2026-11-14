import { Image, Text, View, signal } from 'nsh';
import { Button, Input, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { PrimaryButton, QuietButton, alpha, fontSize } from '../core/ui';
import {
  disconnectChannel,
  readChannel,
  readWeixin,
  saveChannel,
  weixinAction,
  type ChannelProvider,
  type ChannelStatus,
  type WeixinStatus,
} from './data';

export type ChannelID = 'wechat' | ChannelProvider;

const popup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;
const field = {
  minHeight: 46,
  borderRadius: 12,
  paddingHorizontal: 12,
  fontSize: 15,
  color: colors.foreground(),
  backgroundColor: colors.muted(),
  placeholderColor: colors.mutedForeground(),
} as const;

const channelTitle = (channel: ChannelID) =>
  channel === 'wechat'
    ? t('assistants.weixin.title')
    : channel === 'wecom'
      ? t('assistants.channels.wecom.title')
      : channel === 'feishu'
        ? t('assistants.channels.feishu.title')
        : t('assistants.channels.dingtalk.title');

const channelStatusLabel = (status: string): string => {
  switch (status) {
    case 'connected':
      return t('assistants.channels.status.connected');
    case 'connecting':
      return t('assistants.channels.status.connecting');
    case 'reconnecting':
      return t('assistants.channels.status.reconnecting');
    case 'error':
      return t('assistants.channels.status.error');
    case 'disabled':
      return t('assistants.channels.status.disabled');
    case 'disconnected':
      return t('assistants.channels.status.disconnected');
    case 'unsupported':
      return t('assistants.channels.status.unsupported');
    default:
      return '';
  }
};

const weixinStatusLabel = (status: string): string => {
  switch (status) {
    case 'connected':
      return t('assistants.weixin.status.connected');
    case 'waiting':
      return t('assistants.weixin.status.waiting');
    case 'scanned':
      return t('assistants.weixin.status.scanned');
    case 'verify':
      return t('assistants.weixin.status.verify');
    case 'reconnecting':
      return t('assistants.weixin.status.reconnecting');
    case 'expired':
      return t('assistants.weixin.status.expired');
    case 'error':
      return t('assistants.weixin.status.error');
    case 'disabled':
      return t('assistants.weixin.status.disabled');
    case 'unsupported':
      return t('assistants.weixin.status.unsupported');
    default:
      return t('assistants.weixin.status.disconnected');
  }
};

/** One bot's message channel: platform credentials or the WeChat QR handshake. */
export function AssistantChannelSheet(props: {
  open: () => boolean;
  assistantID: string;
  channel: () => ChannelID;
  onClose: () => void;
}) {
  const loaded = signal(false);
  const busy = signal(false);
  const failure = signal('');
  const status = signal('');
  const configured = signal(false);
  const hasSecret = signal(false);
  const clientID = signal('');
  const savedClientID = signal('');
  const ownerID = signal('');
  const qrCode = signal('');
  const secret = signal('');

  const channel = props.channel();
  const isWechat = channel === 'wechat';

  const refresh = async () => {
    failure.set('');
    if (isWechat) {
      const value: WeixinStatus = await readWeixin(props.assistantID);
      status.set(value.status);
      qrCode.set(value.qrCode);
      failure.set(value.error ?? '');
    } else {
      const value: ChannelStatus = await readChannel(props.assistantID, channel);
      status.set(value.status);
      configured.set(value.configured);
      hasSecret.set(value.hasSecret);
      clientID.set(value.clientID);
      savedClientID.set(value.clientID);
      ownerID.set(value.ownerID);
      failure.set(value.error ?? '');
    }
    loaded.set(true);
  };
  if (!loaded() && !busy()) void refresh();

  const run = async (task: () => Promise<void>) => {
    if (busy()) return;
    busy.set(true);
    failure.set('');
    try {
      await task();
      await refresh();
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  const save = () =>
    run(async () => {
      const nextClientID = clientID().trim();
      const nextOwnerID = ownerID().trim();
      const needsSecret = !hasSecret() || nextClientID !== savedClientID();
      if (!nextClientID || !nextOwnerID) throw new Error(t('assistants.channels.error.ownerRequired'));
      if (needsSecret && !secret().trim()) throw new Error(t('assistants.channels.field.secretRequired'));
      await saveChannel(props.assistantID, channel as ChannelProvider, {
        clientID: nextClientID,
        ownerID: nextOwnerID,
        ...(secret().trim() ? { clientSecret: secret().trim() } : {}),
      });
      secret.set('');
    });

  const connect = () =>
    run(async () => {
      const value = await weixinAction(props.assistantID, 'login');
      status.set(value.status);
      qrCode.set(value.qrCode);
      failure.set(value.error ?? '');
    });

  const disconnect = () =>
    run(async () => {
      if (isWechat) {
        const value = await weixinAction(props.assistantID, 'disconnect');
        status.set(value.status);
        qrCode.set(value.qrCode);
        return;
      }
      await disconnectChannel(props.assistantID, channel as ChannelProvider);
      configured.set(false);
    });

  const labels =
    channel === 'wecom'
      ? {
          clientID: t('assistants.channels.field.wecom.clientID'),
          secret: t('assistants.channels.field.wecom.secret'),
          ownerID: t('assistants.channels.field.wecom.ownerID'),
        }
      : channel === 'feishu'
        ? {
            clientID: t('assistants.channels.field.feishu.clientID'),
            secret: t('assistants.channels.field.feishu.secret'),
            ownerID: t('assistants.channels.field.feishu.ownerID'),
          }
        : {
            clientID: t('assistants.channels.field.dingtalk.clientID'),
            secret: t('assistants.channels.field.dingtalk.secret'),
            ownerID: t('assistants.channels.field.dingtalk.ownerID'),
          };

  return (
    <Sheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.onClose();
      }}
      popupStyle={popup}
      backdropStyle={backdrop}
    >
      <View style={{ padding: 18, gap: 12, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>{channelTitle(channel)}</Text>
        <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), lineHeight: 17 }}>
          {isWechat ? t('assistants.weixin.description') : t('assistants.channels.dialog.description')}
        </Text>

        <If when={!!status()}>
          <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
            {isWechat ? weixinStatusLabel(status()) : channelStatusLabel(status())}
          </Text>
        </If>

        <If when={isWechat}>
          <If when={!!qrCode()}>
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <Image src={qrCode()} style={{ width: 180, height: 180, borderRadius: 12 }} />
            </View>
          </If>
          <If when={status() === 'connected'}>
            <QuietButton label={() => t('assistants.weixin.disconnect')} onPress={() => void disconnect()} />
          </If>
          <If when={status() !== 'connected' && status() !== 'unsupported' && status() !== 'disabled'}>
            <PrimaryButton label={() => t('assistants.weixin.connect')} onPress={() => void connect()} busy={busy} />
          </If>
        </If>

        <If when={!isWechat && status() !== 'unsupported' && status() !== 'disabled'}>
          <Input
            value={clientID()}
            onChange={(event) => clientID.set(event.value)}
            placeholder={labels.clientID}
            accessibilityLabel={labels.clientID}
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
          <Input
            value={secret()}
            onChange={(event) => secret.set(event.value)}
            placeholder={hasSecret() ? t('assistants.channels.field.secretKeep') : labels.secret}
            accessibilityLabel={labels.secret}
            autoCapitalize="none"
            autoCorrect={false}
            masked
            style={field}
          />
          <Input
            value={ownerID()}
            onChange={(event) => ownerID.set(event.value)}
            placeholder={labels.ownerID}
            accessibilityLabel={labels.ownerID}
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
          <PrimaryButton
            label={() => t('assistants.channels.actions.save')}
            busy={busy}
            disabled={() => !clientID().trim() || !ownerID().trim()}
            onPress={() => void save()}
          />
          <If when={configured()}>
            <QuietButton
              label={() => t('assistants.channels.actions.disconnect')}
              onPress={() => void disconnect()}
            />
          </If>
        </If>

        <If when={!!failure()}>
          <Text style={{ fontSize: fontSize.entityMeta, color: colors.destructive() }}>{failure()}</Text>
        </If>
        <Button onPress={props.onClose} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 15, color: colors.mutedForeground() }}>{t('gitView.common.cancel')}</Text>
        </Button>
      </View>
    </Sheet>
  );
}
