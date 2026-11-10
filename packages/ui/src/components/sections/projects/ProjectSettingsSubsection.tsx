import React from 'react';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';

type ProjectSettingsSubsectionProps = {
  title: string;
  settingsItem?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  count?: number;
};

export const ProjectSettingsSubsection: React.FC<ProjectSettingsSubsectionProps> = ({
  title,
  settingsItem,
  children,
  collapsible = false,
  count,
}) => {
  const [open, setOpen] = React.useState(false);

  if (collapsible) {
    return (
      <Collapsible open={open} onOpenChange={setOpen} data-settings-item={settingsItem}>
        <SettingsGroup>
          <div className="yuri-settings-group-row flex items-center gap-2">
            <CollapsibleTrigger className="min-w-0 flex-1 gap-2 p-0 hover:bg-transparent focus-visible:ring-[var(--interactive-focus-ring)]">
              <span className="typography-ui-label min-w-0 truncate">{title}</span>
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                {count !== undefined ? <span className="typography-meta tabular-nums">{count}</span> : null}
                <span className="flex size-9 shrink-0 items-center justify-center">
                  <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-4" />
                </span>
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent keepMounted>
            <div className="yuri-settings-group-row">{children}</div>
          </CollapsibleContent>
        </SettingsGroup>
      </Collapsible>
    );
  }

  return (
    <SettingsGroup label={title} itemId={settingsItem}>
      <div className="yuri-settings-group-row">{children}</div>
    </SettingsGroup>
  );
};
