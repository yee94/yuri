import React from 'react';
import QRCode from 'qrcode';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useAssistantWeixin } from '@/queries/assistantWeixinQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

const errorKey = (code: string): I18nKey => {
  if (code === 'account_in_use' || code === 'already_bound') return 'assistants.weixin.error.accountInUse';
  if (code === 'auth_expired') return 'assistants.weixin.error.authExpired';
  if (code === 'delivery_unknown') return 'assistants.weixin.error.deliveryUnknown';
  if (code === 'reply_unavailable') return 'assistants.weixin.error.replyUnavailable';
  if (code === 'channel_in_use') return 'assistants.weixin.error.channelInUse';
  return 'assistants.weixin.error.generic';
};

export function AssistantChannelsGroup({ assistantID }: { assistantID: string }) {
  const { t } = useI18n();
  return <SettingsGroup label={t('assistants.channels.title')} description={t('assistants.weixin.description')}>
    <WeixinChannelRows key={`${getRuntimeTransportIdentity()}:${assistantID}`} assistantID={assistantID} />
  </SettingsGroup>;
}

function WeixinChannelRows({ assistantID }: { assistantID: string }) {
  const { t } = useI18n();
  const { query, mutation } = useAssistantWeixin(assistantID);
  const [qr, setQR] = React.useState<{ value: string; url: string } | null>(null);
  const [qrError, setQRError] = React.useState(false);
  const [code, setCode] = React.useState('');
  const state = query.data;
  const value = state?.qrCode ?? '';
  const pending = mutation.isPending;
  const waiting = state?.status === 'waiting' || state?.status === 'scanned' || state?.status === 'verify';
  const bound = state?.status === 'connected' || state?.status === 'reconnecting';
  React.useEffect(() => {
    if (!value) return;
    let disposed = false;
    void QRCode.toDataURL(value, { width: 640, margin: 4, errorCorrectionLevel: 'M' }).then((url) => {
      if (!disposed) { setQR({ value, url }); setQRError(false); }
    }).catch(() => { if (!disposed) setQRError(true); });
    return () => { disposed = true; };
  }, [value]);
  const connect = useEvent(() => mutation.mutate({ type: 'login' }));
  const disconnect = useEvent(() => mutation.mutate({ type: 'disconnect' }));
  const retry = useEvent(() => mutation.mutate({ type: 'retry' }));
  const verify = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate({ type: 'verify', code }, { onSuccess: () => setCode('') });
  });
  const refresh = useEvent(() => { void query.refetch(); });
  const error = mutation.error?.message || state?.error || (query.isError || qrError ? 'channel_error' : null);

  return (
    <>
      <SettingsRow
        label={<span className="inline-flex items-center gap-2"><Icon name="chat-thread" className="size-4" />{t('assistants.weixin.title')}</span>}
        description={state ? t(`assistants.weixin.status.${state.status}`) : t('common.loading')}
      >
        {query.isPending ? <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" />
          : state?.status === 'unsupported' ? null
            : bound || waiting ? <Button size="sm" variant="ghost" disabled={pending} onClick={disconnect}>{t(bound ? 'assistants.weixin.disconnect' : 'settings.common.actions.cancel')}</Button>
              : <>
                {state?.status === 'expired' || state?.status === 'error' ? <Button size="sm" variant="ghost" disabled={pending} onClick={disconnect}>{t('assistants.weixin.disconnect')}</Button> : null}
                <Button size="sm" disabled={pending} onClick={state ? connect : refresh} aria-busy={pending}>
                {pending ? <Icon name="loader-4" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                {t(state ? 'assistants.weixin.connect' : 'assistants.actions.retry')}
              </Button></>}
      </SettingsRow>
      {waiting ? <SettingsRow controlClassName="flex-col items-center" label={t('assistants.weixin.scan')}>
        {value && qr?.value === value ? <img src={qr.url} alt={t('assistants.weixin.qrAlt')} className="size-48 max-w-full rounded-lg" width={192} height={192} />
          : <span className="flex size-48 items-center justify-center"><Icon name="loader-4" className="size-5 animate-spin motion-reduce:animate-none" /></span>}
        {state?.status === 'verify' ? <form onSubmit={verify} className="flex w-full min-w-0 items-center gap-2">
          <Input aria-label={t('assistants.weixin.verify')} placeholder={t('assistants.weixin.verify')} inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={12} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
          <Button type="submit" size="sm" disabled={pending || code.length < 4}>{t('assistants.weixin.verifySubmit')}</Button>
        </form> : null}
      </SettingsRow> : null}
      {error ? <SettingsRow description={t(errorKey(error))}>
        <span role="status" className="typography-meta text-[var(--status-warning)]">{t('assistants.weixin.attention')}</span>
        {bound && error !== 'auth_expired' && error !== 'channel_in_use' ? <Button size="sm" onClick={retry} disabled={pending}>{t('assistants.actions.retry')}</Button> : null}
      </SettingsRow> : null}
    </>
  );
}
