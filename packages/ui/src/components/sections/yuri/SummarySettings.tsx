import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

const DEFAULT_SUMMARY_COMMIT_PROMPT = 'You are generating a Conventional Commits subject line from the diffs of the selected files.';

const DEFAULT_SESSION_TITLE_PROMPT = [
  'You are a title generator. Output ONLY a thread title.',
  'Name the main subject of the work.',
  'Keep that subject across follow-ups, polish, commit, push, tidy, and review.',
  'Switch only when the user clearly starts a different topic.',
  'One line, no explanation.',
  'Hard limit: never exceed 6 CJK characters (or 6 words for English). No modifiers. No verbs.',
  'Use the language of the user messages.',
  'Keep technical terms, numbers, filenames, and HTTP codes exact.',
  'Never include tool names, summarizing, or generating.',
  'Always output a meaningful title.',
].join('\n');

type SummarySettingsPayload = {
  summaryProviderID?: string;
  summaryModelID?: string;
  summaryCommitPrompt?: string;
  summarySessionTitlePrompt?: string;
};

export const SummarySettings: React.FC = () => {
  const { t } = useI18n();
  // Same catalog as the Assistant model picker; generation goes through the
  // same LLM gateway, which checks the location-less connected catalog.
  const [summaryProviderID, setSummaryProviderID] = React.useState('');
  const [summaryModelID, setSummaryModelID] = React.useState('');
  const [summaryCommitPrompt, setSummaryCommitPrompt] = React.useState(DEFAULT_SUMMARY_COMMIT_PROMPT);
  const [summarySessionTitlePrompt, setSummarySessionTitlePrompt] = React.useState(DEFAULT_SESSION_TITLE_PROMPT);
  const [savedPrompts, setSavedPrompts] = React.useState({
    commit: DEFAULT_SUMMARY_COMMIT_PROMPT,
    title: DEFAULT_SESSION_TITLE_PROMPT,
  });
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSavingPrompts, setIsSavingPrompts] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
  const [testError, setTestError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    const loadSettings = async () => {
      try {
        let data: SummarySettingsPayload | null = null;
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
          const result = await runtimeSettings.load();
          const settings = result?.settings as SummarySettingsPayload | undefined;
          if (settings) data = settings;
        }
        if (!data) {
          const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) data = await response.json() as SummarySettingsPayload;
        }
        if (!active || !data) return;
        if (typeof data.summaryProviderID === 'string') setSummaryProviderID(data.summaryProviderID);
        if (typeof data.summaryModelID === 'string') setSummaryModelID(data.summaryModelID);
        setSummaryCommitPrompt(data.summaryCommitPrompt ?? DEFAULT_SUMMARY_COMMIT_PROMPT);
        setSummarySessionTitlePrompt(data.summarySessionTitlePrompt ?? DEFAULT_SESSION_TITLE_PROMPT);
        setSavedPrompts({
          commit: data.summaryCommitPrompt ?? DEFAULT_SUMMARY_COMMIT_PROMPT,
          title: data.summarySessionTitlePrompt ?? DEFAULT_SESSION_TITLE_PROMPT,
        });
      } catch (error) {
        console.warn('Failed to load summary settings:', error);
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void loadSettings();
    return () => {
      active = false;
    };
  }, []);

  const saveModel = useEvent(async (providerID: string, modelID: string) => {
    setSummaryProviderID(providerID);
    setSummaryModelID(modelID);
    try {
      await updateDesktopSettings({
        summaryModelMode: 'provider',
        summaryProviderID: providerID.trim(),
        summaryModelID: modelID.trim(),
      });
    } catch (error) {
      console.warn('Failed to save summary model:', error);
      toast.error(t('settings.yuri.defaults.summary.saveFailed'));
    }
  });

  const savePrompts = useEvent(async () => {
    setIsSavingPrompts(true);
    try {
      await updateDesktopSettings({
        summaryCommitPrompt,
        summarySessionTitlePrompt,
      });
      setSavedPrompts({ commit: summaryCommitPrompt, title: summarySessionTitlePrompt });
    } catch (error) {
      console.warn('Failed to save summary prompts:', error);
      toast.error(t('settings.yuri.defaults.summary.saveFailed'));
    } finally {
      setIsSavingPrompts(false);
    }
  });

  const testConnection = useEvent(async () => {
    if (isTesting) return;
    setTestError(null);
    setIsTesting(true);
    try {
      const response = await runtimeFetch('/api/small-model/test', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'provider',
          providerID: summaryProviderID,
          modelID: summaryModelID,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: unknown; code?: unknown; message?: unknown } | null;
      if (response.ok && payload?.ok === true) {
        toast.success(t('settings.yuri.defaults.summary.testConnectionOk'));
        return;
      }
      const description = t('settings.yuri.defaults.summary.testError.provider', {
        code: typeof payload?.code === 'string' ? payload.code : 'generation_failed',
      });
      setTestError(typeof payload?.message === 'string' && payload.message.trim() ? `${description}\n${payload.message}` : description);
    } catch {
      setTestError(t('settings.yuri.defaults.summary.testError.provider', { code: 'network_error' }));
    } finally {
      setIsTesting(false);
    }
  });

  if (isLoading) return null;

  const promptsDirty = summaryCommitPrompt !== savedPrompts.commit
    || summarySessionTitlePrompt !== savedPrompts.title;

  return (
    <div className="yuri-settings-section-stack">
      <SettingsGroup
        description={testError ? <span role="alert" className="whitespace-pre-wrap break-words text-[var(--status-error)]">{testError}</span> : undefined}
      >
        <SettingsRow
          itemId="summary-ai.configuration"
          label={t('settings.yuri.defaults.summary.providerModel')}
          description={t('settings.yuri.defaults.summary.description')}
          className="yuri-settings-split-row-stacked yuri-settings-summary-model"
        >
          <ModelSelector
            providerId={summaryProviderID}
            modelId={summaryModelID}
            placeholder={t('settings.yuri.defaults.summary.providerModelDefault')}
            onChange={(providerID, modelID) => void saveModel(providerID, modelID)}
            className="yuri-settings-inline-value"
          />
          <Button data-settings-item="summary-ai.test-connection" variant="outline" size="sm" onClick={() => void testConnection()} disabled={isTesting}>
            {isTesting ? t('settings.yuri.defaults.summary.testingConnection') : t('settings.yuri.defaults.summary.testConnection')}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        label={t('settings.yuri.defaults.summary.promptTitle')}
        actions={(
          <Button size="sm" onClick={() => void savePrompts()} disabled={isSavingPrompts || !promptsDirty} aria-busy={isSavingPrompts}>
            {isSavingPrompts ? t('settings.common.actions.saving') : t('settings.yuri.defaults.summary.save')}
          </Button>
        )}
      >
        <SettingsRow
          label={t('settings.yuri.defaults.summary.commitPrompt')}
          className="yuri-settings-split-row-stacked"
          controlClassName="w-full max-w-none justify-self-stretch"
        >
          <Textarea
            embedded
            value={summaryCommitPrompt}
            onChange={(event) => setSummaryCommitPrompt(event.target.value)}
            aria-label={t('settings.yuri.defaults.summary.commitPrompt')}
            outerClassName="h-64"
            className="font-mono typography-meta"
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.yuri.defaults.summary.sessionTitlePrompt')}
          className="yuri-settings-split-row-stacked"
          controlClassName="w-full max-w-none justify-self-stretch"
        >
          <Textarea
            embedded
            value={summarySessionTitlePrompt}
            onChange={(event) => setSummarySessionTitlePrompt(event.target.value)}
            aria-label={t('settings.yuri.defaults.summary.sessionTitlePrompt')}
            outerClassName="h-64"
            className="font-mono typography-meta"
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
};
