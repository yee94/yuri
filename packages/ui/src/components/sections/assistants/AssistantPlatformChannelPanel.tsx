import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  useAssistantChannel,
  type AssistantChannelProvider,
} from '@/queries/assistantChannelQueries';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';

const fieldKeys: Record<AssistantChannelProvider, {
  clientID: I18nKey;
  secret: I18nKey;
  ownerID: I18nKey;
  ownerHelp: I18nKey;
  ownerHelpUrl: string;
}> = {
  wecom: {
    clientID: 'assistants.channels.field.wecom.clientID',
    secret: 'assistants.channels.field.wecom.secret',
    ownerID: 'assistants.channels.field.wecom.ownerID',
    ownerHelp: 'assistants.channels.field.wecom.ownerHelp',
    ownerHelpUrl: 'https://github.com/WecomTeam/aibot-node-sdk#basemessage消息体基础结构',
  },
  feishu: {
    clientID: 'assistants.channels.field.feishu.clientID',
    secret: 'assistants.channels.field.feishu.secret',
    ownerID: 'assistants.channels.field.feishu.ownerID',
    ownerHelp: 'assistants.channels.field.feishu.ownerHelp',
    ownerHelpUrl: 'https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id',
  },
  dingtalk: {
    clientID: 'assistants.channels.field.dingtalk.clientID',
    secret: 'assistants.channels.field.dingtalk.secret',
    ownerID: 'assistants.channels.field.dingtalk.ownerID',
    ownerHelp: 'assistants.channels.field.dingtalk.ownerHelp',
    ownerHelpUrl: 'https://open.dingtalk.com/document/dingstart/robot-receive-message',
  },
};

const channelErrorKey = (code: string | null): I18nKey => {
  if (code === 'invalid_credentials' || code === 'auth_failed' || code === 'unauthorized') return 'assistants.channels.error.invalidCredentials';
  if (code === 'auth_expired') return 'assistants.channels.error.authExpired';
  if (code === 'channel_in_use') return 'assistants.channels.error.channelInUse';
  if (code === 'owner_required' || code === 'invalid_owner') return 'assistants.channels.error.ownerRequired';
  if (code === 'delivery_unknown') return 'assistants.channels.error.deliveryUnknown';
  if (code === 'connection_replaced') return 'assistants.channels.error.connectionReplaced';
  if (code === 'account_in_use' || code === 'already_bound') return 'assistants.channels.error.accountInUse';
  if (code === 'binding_changed') return 'assistants.weixin.error.bindingChanged';
  if (code === 'discovery_timeout') return 'assistants.channels.discovery.timeout';
  return 'assistants.channels.error.generic';
};

export function AssistantPlatformChannelPanel({
  assistantID,
  provider,
  onClose,
}: {
  assistantID: string;
  provider: AssistantChannelProvider;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { query, mutation, discovery } = useAssistantChannel(assistantID, provider);
  const state = query.data;
  const [clientID, setClientID] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [ownerID, setOwnerID] = React.useState('');
  const seeded = React.useRef(false);
  const discoveryController = React.useRef<AbortController | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);
  const [transferSource, setTransferSource] = React.useState<NonNullable<NonNullable<typeof state>['transferSources']>[number] | null>(null);
  const labels = fieldKeys[provider];
  const pending = mutation.isPending;
  const runtimeGeneration = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeGeneration,
    getRuntimeGeneration,
  );

  React.useEffect(() => {
    discoveryController.current?.abort();
    setClientSecret('');
    setOwnerID('');
    setConfirmingDisconnect(false);
    setTransferSource(null);
  }, [runtimeGeneration]);

  React.useEffect(() => () => { discoveryController.current?.abort(); }, []);

  React.useEffect(() => {
    if (!state || seeded.current) return;
    seeded.current = true;
    setClientID(state.clientID ?? '');
    setOwnerID(state.ownerID ?? '');
  }, [state]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!state || pending) return;
    const nextClientID = clientID.trim();
    const nextOwnerID = ownerID.trim();
    if (!nextClientID || !nextOwnerID || discovery.isPending) return;
    if ((!state.hasSecret || nextClientID !== state.clientID) && !clientSecret.trim()) return;
    mutation.mutate({
      type: 'save',
      clientID: nextClientID,
      ownerID: nextOwnerID,
      ...(clientSecret ? { clientSecret } : {}),
    }, { onSuccess: (result) => {
      if (!result?.configured) return;
      setClientSecret('');
      toast.success(t('assistants.channels.saved'));
      onClose();
    } });
  };
  const discover = () => {
    discoveryController.current?.abort();
    const controller = new AbortController();
    discoveryController.current = controller;
    discovery.mutate({ clientID: clientID.trim(), ...(clientSecret ? { clientSecret } : {}), signal: controller.signal }, {
      onSuccess: (result) => {
        if (controller.signal.aborted || discoveryController.current !== controller) return;
        setOwnerID(result.ownerID);
      },
    });
  };
  const cancelDiscovery = () => {
    discoveryController.current?.abort();
    discoveryController.current = null;
    discovery.reset();
  };
  const retry = () => mutation.mutate({ type: 'retry' });
  const disconnect = () => {
    mutation.mutate({ type: 'disconnect' }, { onSuccess: () => setConfirmingDisconnect(false) });
  };

  if (query.isPending) {
    return <SettingsGroup>
      <SettingsRow label={t('common.loading')}>
        <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" />
      </SettingsRow>
    </SettingsGroup>;
  }

  if (query.isError && !state) {
    return <SettingsGroup>
      <SettingsRow
        label={t('assistants.channels.attention')}
        description={t('assistants.channels.error.generic')}
      >
        <Button size="sm" onClick={() => { void query.refetch(); }}>{t('assistants.actions.retry')}</Button>
      </SettingsRow>
    </SettingsGroup>;
  }

  if (!state || state.status === 'unsupported' || state.status === 'disabled') {
    return <SettingsGroup>
      <SettingsRow description={t(`assistants.channels.status.${state?.status ?? 'unsupported'}`)}>{null}</SettingsRow>
    </SettingsGroup>;
  }

  const needsSecret = !state.hasSecret || clientID.trim() !== (state.clientID ?? '');
  const nextClientID = clientID.trim();
  const canDiscover = Boolean(nextClientID && (!needsSecret || clientSecret.trim())) && !pending;
  const canSave = canDiscover && Boolean(ownerID.trim()) && !discovery.isPending;
  const configured = state.configured;
  const sources = !configured ? (state.transferSources ?? []).filter((source) => !nextClientID || source.clientID === nextClientID) : [];
  const canRetry = configured && state.status !== 'connecting';
  const discoveryError = discovery.error?.name !== 'AbortError' && discovery.error?.message !== 'cancelled'
    ? discovery.error?.message : undefined;
  const code = discoveryError || mutation.error?.message || state.error;
  const errorKey = code ? channelErrorKey(code)
    : query.isError ? 'assistants.channels.error.generic' as I18nKey : null;

  return (
    <form className="yuri-settings-section-stack yuri-settings-channel-form" onSubmit={save}>
      <SettingsGroup>
        <SettingsRow
          label={t(labels.clientID)}
          className="yuri-settings-split-row-stacked"
        >
          <Input
            value={clientID}
            onChange={(event) => { cancelDiscovery(); setClientID(event.target.value); setOwnerID(''); }}
            aria-label={t(labels.clientID)}
            autoComplete="off"
            maxLength={512}
            required
          />
        </SettingsRow>
        <SettingsRow
          label={t(labels.secret)}
          description={t(needsSecret ? 'assistants.channels.field.secretRequired' : 'assistants.channels.field.secretKeep')}
          className="yuri-settings-split-row-stacked"
        >
          <Input
            type="password"
            value={clientSecret}
            onChange={(event) => { cancelDiscovery(); setClientSecret(event.target.value); }}
            aria-label={t(labels.secret)}
            autoComplete="new-password"
            maxLength={4096}
            required={needsSecret}
          />
        </SettingsRow>
        <SettingsRow
          label={t(labels.ownerID)}
          description={<span id={`${assistantID}-${provider}-owner-help`}>
            {t('assistants.channels.field.ownerDescription')}
            <span className="block">{t(labels.ownerHelp)}{' '}
              <a
                href={labels.ownerHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
                onClick={(event) => { event.preventDefault(); void openExternalUrl(labels.ownerHelpUrl); }}
              >{t('assistants.channels.field.ownerHelpLink')}</a>
            </span>
          </span>}
          className="yuri-settings-split-row-stacked"
        >
          <Input
            value={ownerID}
            onChange={(event) => { cancelDiscovery(); setOwnerID(event.target.value); }}
            aria-label={t(labels.ownerID)}
            aria-describedby={`${assistantID}-${provider}-owner-help`}
            autoComplete="off"
            maxLength={512}
            required
          />
        </SettingsRow>
        {!ownerID.trim() ? <SettingsRow
          className="yuri-settings-split-row-stacked"
          description={t(discovery.isPending ? 'assistants.channels.discovery.waiting' : 'assistants.channels.discovery.hint')}
        >
          <Button size="sm" disabled={!canDiscover || discovery.isPending} aria-busy={discovery.isPending} onClick={discover}>
            {discovery.isPending ? <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            {t('assistants.channels.discovery.start')}
          </Button>
          {discovery.isPending ? <Button size="sm" variant="ghost" onClick={cancelDiscovery}>{t('settings.common.actions.cancel')}</Button> : null}
        </SettingsRow> : null}
      </SettingsGroup>

      <SettingsGroup>
        {sources.map((source) => <SettingsRow key={source.assistantID}
          className="yuri-settings-split-row-stacked"
          label={t('assistants.weixin.transferFrom', { name: source.name })}
          description={transferSource?.assistantID === source.assistantID ? t('assistants.weixin.transferWarning') : undefined}
        >
          {transferSource?.assistantID === source.assistantID ? <>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setTransferSource(null)}>{t('settings.common.actions.cancel')}</Button>
            <Button size="sm" disabled={pending || discovery.isPending || transferSource.revision !== source.revision} aria-busy={pending} onClick={() => {
              mutation.mutate({ type: 'transfer', sourceAssistantID: transferSource.assistantID, revision: transferSource.revision }, {
                onSuccess: (result) => {
                  setTransferSource(null);
                  setClientSecret('');
                  if (result) { setClientID(result.clientID ?? ''); setOwnerID(result.ownerID ?? ''); }
                },
              });
            }}>{t('assistants.weixin.transferConfirm')}</Button>
          </> : <Button size="sm" disabled={pending} onClick={() => setTransferSource({ ...source })}>{t('assistants.weixin.transfer')}</Button>}
        </SettingsRow>)}
        <SettingsRow
          label={t(`assistants.channels.status.${state.status}`)}
          description={errorKey && !(sources.length && errorKey === 'assistants.channels.error.accountInUse') ? t(errorKey) : undefined}
          className="yuri-settings-split-row-stacked"
        >
          {canRetry ? <Button size="sm" variant="ghost" disabled={pending || discovery.isPending} onClick={retry}>{t('assistants.channels.actions.retry')}</Button> : null}
          {configured && !confirmingDisconnect ? <Button size="sm" variant="ghost" disabled={pending || discovery.isPending} onClick={() => setConfirmingDisconnect(true)}>{t('assistants.channels.actions.disconnect')}</Button> : null}
        </SettingsRow>
        {configured && confirmingDisconnect ? <SettingsRow
          className="yuri-settings-split-row-stacked"
          description={t('assistants.channels.disconnectWarning')}
        >
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingDisconnect(false)}>{t('settings.common.actions.cancel')}</Button>
          <Button size="sm" variant="destructive" disabled={pending || discovery.isPending} onClick={disconnect} aria-busy={pending}>
            {t('assistants.channels.actions.confirmDisconnect')}
          </Button>
        </SettingsRow> : null}
      </SettingsGroup>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
        <Button type="submit" size="sm" disabled={!canSave} aria-busy={pending}>
          {pending ? <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          {t('assistants.channels.actions.save')}
        </Button>
      </div>
    </form>
  );
}
