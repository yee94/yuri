import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';

export type CustomProviderModelDraft = {
  key: string; id: string; name: string; context: string; output: string; tools: boolean; vision: boolean;
};

export function CustomProviderModelDialog({ model, existingIds, isEditing, busy = false, saveError, fixedId = false, onSave, onClose }: {
  model: CustomProviderModelDraft;
  existingIds: readonly string[];
  isEditing: boolean;
  busy?: boolean;
  saveError?: string;
  fixedId?: boolean;
  onSave: (model: CustomProviderModelDraft) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [draft, setDraft] = React.useState(model);
  const [error, setError] = React.useState('');
  const update = (patch: Partial<CustomProviderModelDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const id = draft.id.trim();
    const limits = [draft.context, draft.output].filter(Boolean).map(Number);
    if (!id || /[\s#]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
      || limits.some((value) => !Number.isSafeInteger(value) || value <= 0)
      || (draft.context && draft.output && Number(draft.output) > Number(draft.context))) {
      setError(t('settings.providers.custom.invalidModel'));
      return;
    }
    if (existingIds.includes(id)) {
      setError(t('settings.providers.custom.invalidModels'));
      return;
    }
    onSave({ ...draft, id, name: draft.name.trim() });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent presentation="default" className={`yuri-settings-workspace ${isMobile ? 'yuri-settings-workspace-mobile' : 'yuri-settings-workspace-desktop'} max-w-lg`} aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t(isEditing ? 'settings.providers.custom.editModel' : 'settings.providers.custom.addModel')}</DialogTitle></DialogHeader>
        <form className="yuri-settings-section-stack" onSubmit={submit}>
          <SettingsGroup>
            <SettingsRow label={t('settings.providers.custom.modelId')}>
              <Input aria-label={t('settings.providers.custom.modelId')} autoFocus={!fixedId} readOnly={fixedId} required pattern="[^\s#]+" value={draft.id}
                onChange={(event) => update({ id: event.target.value })} />
            </SettingsRow>
            <SettingsRow label={t('settings.providers.custom.modelName')}>
              <Input aria-label={t('settings.providers.custom.modelName')} value={draft.name} placeholder={draft.id}
                onChange={(event) => update({ name: event.target.value })} />
            </SettingsRow>
          </SettingsGroup>
          <details className="group yuri-settings-section-stack">
            <summary className="cursor-pointer typography-meta text-muted-foreground marker:text-muted-foreground">
              {t('settings.providers.custom.moreSettings')}
            </summary>
            <SettingsGroup>
            <SettingsRow label={t('settings.providers.custom.context')}>
              <NumberInput aria-label={t('settings.providers.custom.context')} min={1} step={1} value={draft.context ? Number(draft.context) : undefined}
                onValueChange={(value) => update({ context: String(value) })} onClear={() => update({ context: '' })} />
            </SettingsRow>
            <SettingsRow label={t('settings.providers.custom.output')}>
              <NumberInput aria-label={t('settings.providers.custom.output')} min={1} step={1} value={draft.output ? Number(draft.output) : undefined}
                max={draft.context ? Number(draft.context) : undefined} onValueChange={(value) => update({ output: String(value) })}
                onClear={() => update({ output: '' })} />
            </SettingsRow>
            <SettingsToggleRow label={t('settings.providers.custom.tools')} ariaLabel={t('settings.providers.custom.tools')}
              checked={draft.tools} onChange={(tools) => update({ tools })} />
            <SettingsToggleRow label={t('settings.providers.custom.vision')} ariaLabel={t('settings.providers.custom.vision')}
              checked={draft.vision} onChange={(vision) => update({ vision })} />
            </SettingsGroup>
          </details>
          {(error || saveError) && <p role="alert" className="typography-meta text-status-error">{error || saveError}</p>}
          <DialogFooter>
            <Button type="button" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
            <Button type="submit" disabled={busy} aria-busy={busy}>{t(busy ? 'settings.providers.page.actions.saving' : isEditing ? 'settings.common.actions.saveChanges' : 'settings.providers.custom.addModel')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
