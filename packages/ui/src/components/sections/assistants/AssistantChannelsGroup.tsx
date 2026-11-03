import React from 'react';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import { AssistantChannelDialog } from './AssistantChannelDialog';
import {
  assistantChannelEntries,
  type AssistantChannelID,
} from './assistantChannelBrand';

export function AssistantChannelsGroup({ assistantID }: { assistantID: string }) {
  const { t } = useI18n();
  const [openChannel, setOpenChannel] = React.useState<AssistantChannelID | null>(null);

  return (
    <>
      <SettingsGroup
        label={t('assistants.channels.title')}
        description={t('assistants.channels.description')}
      >
        <SettingsRow className="yuri-settings-split-row-stacked" copyClassName="hidden" controlClassName="w-full">
          <div className="grid w-full grid-cols-2 gap-2">
            {assistantChannelEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setOpenChannel(entry.id)}
                aria-haspopup="dialog"
                aria-expanded={openChannel === entry.id}
                className="group flex min-h-20 w-full min-w-0 items-center gap-3 rounded-xl bg-transparent px-3 py-2.5 text-left ring-1 ring-inset ring-border/60 transition-colors hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              >
                <img src={entry.logo} alt="" aria-hidden className="size-8 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate typography-ui-label text-foreground">{t(entry.nameKey)}</span>
                  <span className="mt-0.5 block truncate typography-meta text-muted-foreground">{t(entry.summaryKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>
      <AssistantChannelDialog
        assistantID={assistantID}
        channel={openChannel ?? 'wechat'}
        open={openChannel !== null}
        onOpenChange={(next) => { if (!next) setOpenChannel(null); }}
      />
    </>
  );
}
