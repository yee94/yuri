import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { refreshOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { providerSourceQueryOptions } from './providerSourceQueries';
import { CustomProviderModelDialog, type CustomProviderModelDraft } from './CustomProviderModelDialog';

export function ProviderModelEditor({ providerId, model, inputModalities, onClose }: {
  providerId: string; model: CustomProviderModelDraft; inputModalities: readonly string[]; onClose: () => void;
}) {
  const { t } = useI18n();
  const cache = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const lifetime = React.useRef<AbortController | null>(null);
  const pending = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const save = useEvent(async (draft: CustomProviderModelDraft) => {
    const controller = lifetime.current;
    if (pending.current || !controller || controller.signal.aborted) return;
    const directory = opencodeClient.getDirectory();
    const generation = getRuntimeGeneration();
    const transportIdentity = getRuntimeTransportIdentity();
    const current = () => !controller.signal.aborted && getRuntimeGeneration() === generation
      && getRuntimeTransportIdentity() === transportIdentity && opencodeClient.getDirectory() === directory;
    pending.current = true; setBusy(true); setError('');
    let written = false;
    try {
      const response = await runtimeFetch('/api/config/providers/model', { method: 'PUT', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory, providerId, modelId: model.id,
          name: draft.name, tools: draft.tools, vision: draft.vision, inputModalities,
          context: draft.context ? Number(draft.context) : null, output: draft.output ? Number(draft.output) : null }) });
      if (!response.ok) throw new Error('save');
      if (!current()) return;
      written = true;
      await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: directory, transportIdentity });
      if (!current()) return;
      void cache.invalidateQueries({ queryKey: providerSourceQueryOptions(directory).queryKey, exact: true });
      onClose();
    } catch {
      if (current()) setError(t(written ? 'settings.providers.custom.refreshFailed' : 'settings.providers.custom.saveFailed'));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  });
  return <CustomProviderModelDialog model={model} existingIds={[]} isEditing fixedId busy={busy} saveError={error}
    onSave={(draft) => void save(draft)} onClose={onClose} />;
}
