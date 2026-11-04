import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { SettingsJsonEditor } from '@/components/sections/shared/SettingsJsonEditor';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
}

export function GlobalConfigPage() {
  const { t } = useI18n();
  const [target, setTarget] = React.useState<'opencode' | null>(null);
  const [content, setContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);

  const load = useEvent(async () => {
    setIsLoading(true);
    try {
      const response = await runtimeFetch('/api/config/global/opencode');
      if (!response.ok) {
        throw new Error(await readError(response, t('settings.globalConfig.toast.loadFailed')));
      }
      const data = await response.json() as { content?: unknown; fileName?: unknown };
      const nextContent = typeof data.content === 'string' ? data.content : '';
      setContent(nextContent);
      setSavedContent(nextContent);
      setFileName(typeof data.fileName === 'string' ? data.fileName : '');
    } catch (error) {
      setContent('');
      setSavedContent('');
      setFileName('');
      toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  });

  React.useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      setIsLoading(true);
      try {
        const response = await runtimeFetch('/api/config/global');
        if (!response.ok) {
          throw new Error(await readError(response, t('settings.globalConfig.toast.loadFailed')));
        }
        const data = await response.json() as { targets?: unknown };
        const hasOpenCode = Array.isArray(data.targets) && data.targets.some((entry) => (
          entry && typeof entry === 'object' && entry.target === 'opencode' && typeof entry.fileName === 'string'
        ));
        if (cancelled) return;
        setTarget(hasOpenCode ? 'opencode' : null);
      } catch (error) {
        if (!cancelled) {
          setTarget(null);
          toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.loadFailed'));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void discover();
    return () => { cancelled = true; };
  }, [t]);

  React.useEffect(() => {
    if (target) void load();
  }, [load, target, t]);

  const handleSave = async () => {
    if (!target) return;
    setIsSaving(true);
    try {
      const response = await runtimeFetch(`/api/config/global/${target}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, t('settings.globalConfig.toast.saveFailed')));
      }
      const data = await response.json() as { content?: unknown };
      const nextContent = typeof data.content === 'string' ? data.content : content;
      setContent(nextContent);
      setSavedContent(nextContent);
      toast.success(t('settings.globalConfig.toast.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="yuri-settings-page-content mx-auto w-full max-w-4xl px-3 pt-3 pb-0 sm:px-6 sm:pt-8">
        <SettingsGroup
          itemId="global-config.editor"
          actions={target ? <Button onClick={handleSave} disabled={isLoading || isSaving || content === savedContent} size="sm" aria-busy={isSaving}>{isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}</Button> : undefined}
          label={t('settings.globalConfig.title')}
        >
          {target ? (
            <>
              <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-1">
                <span className="typography-meta truncate text-muted-foreground">{fileName}</span>
                <Button variant="ghost" size="xs" onClick={() => void load()} disabled={isLoading || isSaving}>
                  {t('settings.globalConfig.actions.reload')}
                </Button>
              </div>
              <div className="h-[clamp(520px,75dvh,960px)] overflow-hidden bg-background">
                <SettingsJsonEditor
                  value={content}
                  onChange={setContent}
                  readOnly={isLoading}
                  fileName={fileName || 'opencode.json'}
                  ariaLabel={fileName || 'opencode.json'}
                  className="h-full"
                />
              </div>
            </>
          ) : (
            <div className="min-h-12" aria-busy={isLoading} />
          )}
        </SettingsGroup>
      </div>
    </ScrollableOverlay>
  );
}
