import React from 'react';
import { useI18n } from '@/lib/i18n';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import { useGuiPluginCommandEntries } from './useGuiPluginCommandEntries';

export function GuiPluginCommands({ query, onSelect }: { query: string; onSelect: () => void }) {
  const { commands, run } = useGuiPluginCommandEntries(query, onSelect);
  const { t } = useI18n();
  const [expandedQuery, setExpandedQuery] = React.useState<string | null>(null);
  if (!commands.length) return null;
  const visible = expandedQuery === query ? commands : commands.slice(0, 5);
  return (
    <CommandGroup heading={<span className="flex items-baseline gap-2">
      <span>{t('guiPlugins.commands')}</span>
      <span className="yuri-global-search-group-count">{commands.length}</span>
    </span>}>
      {visible.map((command) => <CommandItem key={command.key} value={`gui-plugin:${command.key}`}
        className="yuri-global-search-compact min-h-9 gap-4 rounded-lg px-3 py-2 typography-meta" onSelect={() => void run(command.key)}>
        <span className="yuri-global-search-result-title min-w-0 flex-1 truncate">{command.title}</span>
        {command.description ? <span className="yuri-global-search-result-detail max-w-[50%] truncate text-muted-foreground">{command.description}</span> : null}
      </CommandItem>)}
      {visible.length < commands.length ? <CommandItem value="gui-plugin:show-more" onSelect={() => setExpandedQuery(query)}>
        {t('commandPalette.group.showMore', { count: commands.length - visible.length })}
      </CommandItem> : null}
    </CommandGroup>
  );
}
