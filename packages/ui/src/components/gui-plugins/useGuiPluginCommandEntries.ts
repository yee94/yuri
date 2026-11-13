import { useMemo } from 'react';
import { useEvent } from '@reactuses/core';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { toast } from '@/components/ui';

export function useGuiPluginCommandEntries(query: string, onSelect: () => void) {
  const { host, snapshot } = useGuiPlugins();
  const { t } = useI18n();
  const commands = useMemo(() => query.trim()
    ? scoreByFuzzyQuery([...snapshot.commands], query.trim(), (command) => `${command.title} ${command.description ?? ''}`, { threshold: 0.4 }).map(({ item }) => item)
    : snapshot.commands, [snapshot.commands, query]);
  const run = useEvent(async (key: string) => {
    onSelect();
    try { await host?.runCommand(key); } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('guiPlugins.error'));
    }
  });
  return { commands, run };
}
