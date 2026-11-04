import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { useDeviceInfo } from '@/lib/device';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { projectQuotaCredentialStatus, quotaCredentialQueryOptions, type QuotaCredentialProvider } from './quotaCredentialQueries';

export function QuotaCredentials({ providerId, providerName }: { providerId: QuotaCredentialProvider; providerName: string }) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const cache = useQueryClient();
  const options = quotaCredentialQueryOptions(providerId);
  const query = useQuery(options);
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const lifetime = React.useRef<AbortController | null>(null);
  const pending = React.useRef(false);
  const route = `/api/quota/credentials/${providerId}`;
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [providerId]);

  const changeOpen = useEvent((next: boolean) => {
    if (pending.current) return;
    setOpen(next);
    setValues(next && query.data?.workspaceId ? { workspaceId: query.data.workspaceId } : {});
    setError('');
    setConfirmDelete(false);
  });

  const request = useEvent(async (action: 'save' | 'validate' | 'import' | 'delete') => {
    if (pending.current) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const generation = getRuntimeGeneration();
    const transport = getRuntimeTransportIdentity();
    const directory = opencodeClient.getDirectory();
    const isCurrent = () => !controller.signal.aborted && lifetime.current === controller
      && getRuntimeGeneration() === generation && getRuntimeTransportIdentity() === transport
      && opencodeClient.getDirectory() === directory;
    pending.current = true;
    setBusy(true); setError('');
    try {
      await cache.cancelQueries({ queryKey: options.queryKey, exact: true });
      if (!isCurrent()) return;
      const response = await runtimeFetch(`${route}${action === 'validate' || action === 'import' ? `/${action}` : ''}`, {
        method: action === 'save' ? 'PUT' : action === 'delete' ? 'DELETE' : 'POST', signal: controller.signal,
        ...(action === 'save' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) } : {}),
      });
      if (!response.ok) throw new Error('Credential operation failed');
      const payload: unknown = await response.json();
      if (!isCurrent()) return;
      if (action === 'validate' && (!payload || typeof payload !== 'object' || !('valid' in payload) || payload.valid !== true)) {
        throw new Error('Invalid validation response');
      }
      if (action !== 'validate') {
        cache.setQueryData(options.queryKey, projectQuotaCredentialStatus(payload));
        setValues({}); setConfirmDelete(false); setOpen(false);
      }
      toast.success(t(action === 'validate' ? 'settings.providers.quota.validated' : action === 'delete'
        ? 'settings.providers.quota.deleted' : 'settings.providers.page.quotaCredentials.saved', { provider: providerName }));
    } catch {
      if (isCurrent()) setError(t('settings.providers.quota.failed'));
    } finally {
      pending.current = false;
      if (isCurrent()) setBusy(false);
    }
  });

  const field = (name: string, label: string, placeholder: string) => (
    <SettingsRow key={name} label={label}>
      <Input aria-label={label} required={name !== 'refreshToken'} type={name === 'workspaceId' ? 'text' : 'password'}
        autoComplete="off" value={values[name] ?? ''} disabled={busy}
        onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
        placeholder={placeholder} className="w-full font-mono text-xs" />
    </SettingsRow>
  );

  return <>
    <SettingsRow itemId={`providers.${providerId}-credentials`} label={t('settings.providers.quota.title')}>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span className="typography-meta text-muted-foreground">{t(query.isError ? 'settings.providers.quota.loadFailed' : query.isPending
          ? 'settings.providers.page.state.loading' : query.data.configured ? 'settings.providers.quota.configured' : 'settings.providers.quota.optional')}</span>
        <Button variant="ghost" size="xs" disabled={query.isPending} onClick={() => query.isError ? void query.refetch() : changeOpen(true)}>
          {t(query.isError ? 'settings.providers.quota.retry' : 'settings.providers.quota.manage')}<Icon name="arrow-right-s" className="size-3.5" />
        </Button>
      </div>
    </SettingsRow>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className={`yuri-settings-workspace ${isMobile ? 'yuri-settings-workspace-mobile' : 'yuri-settings-workspace-desktop'} max-w-lg`}>
        <DialogHeader>
          <DialogTitle>{providerName} · {t('settings.providers.quota.title')}</DialogTitle>
          <DialogDescription>{t('settings.providers.quota.description')}</DialogDescription>
        </DialogHeader>
        <form className="yuri-settings-section-stack" onSubmit={(event) => { event.preventDefault(); void request('save'); }}>
          <SettingsGroup>
            {providerId === 'opencode-go' && field('workspaceId', t('settings.providers.page.openCodeGo.workspaceId'), 'wrk_…')}
            {providerId === 'opencode-go' && field('authCookie', t('settings.providers.page.openCodeGo.authCookie'), 'auth=…')}
            {providerId === 'ollama-cloud' && field('cookie', t('settings.providers.page.openCodeGo.authCookie'), 'session=…')}
            {providerId === 'cursor' && field('accessToken', t('settings.providers.quota.accessToken'), '')}
            {providerId === 'cursor' && field('refreshToken', t('settings.providers.quota.refreshToken'), '')}
          </SettingsGroup>
          {providerId === 'opencode-go' && <p className="typography-meta text-muted-foreground">{t('settings.providers.page.openCodeGo.help')}</p>}
          {(providerId === 'cursor' || query.data?.configured) && <div className="flex flex-wrap items-center gap-2">
            {providerId === 'cursor' && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void request('import')}>{t('settings.providers.quota.importCursor')}</Button>}
            {query.data?.configured && <>
              <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void request('validate')}>{t('settings.providers.page.openCodeGo.validate')}</Button>
              <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setConfirmDelete((value) => !value)}>{t('settings.providers.page.openCodeGo.delete')}</Button>
            </>}
          </div>}
          {confirmDelete && <div className="flex flex-wrap items-center justify-between gap-2 typography-meta">
            <span>{t('settings.providers.quota.deleteHint')}</span>
            <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => void request('delete')}>{t('settings.common.actions.delete')}</Button>
          </div>}
          {error && <p role="alert" className="typography-meta text-status-error">{error}</p>}
          <DialogFooter>
            <Button type="button" size="sm" disabled={busy} onClick={() => changeOpen(false)}>{t('settings.common.actions.cancel')}</Button>
            <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>{t(busy ? 'settings.providers.page.actions.saving' : 'settings.providers.page.openCodeGo.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
