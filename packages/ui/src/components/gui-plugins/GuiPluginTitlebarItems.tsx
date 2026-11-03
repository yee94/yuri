import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { cn } from '@/lib/utils';

const iconAliases: Record<string, IconName> = { globe: 'global', server: 'server', 'circle-check': 'checkbox-circle', 'circle-x': 'close-circle', 'window-analytics': 'bar-chart-box' };

export function GuiPluginTitlebarItems({ mobile = false, sidebar = false }: { mobile?: boolean; sidebar?: boolean }) {
  const { host, snapshot } = useGuiPlugins();
  if (!host || snapshot.titlebarItems.length === 0) return null;

  return <div data-gui-titlebar-items={!sidebar || undefined} data-gui-sidebar-items={sidebar || undefined}
    className={sidebar ? 'app-region-no-drag space-y-0.5' : 'app-region-no-drag flex min-w-0 max-w-32 items-center gap-1 overflow-x-auto scrollbar-hidden'}>
    {snapshot.titlebarItems.map((item) => {
      const icon = item.icon && (iconAliases[item.icon] ?? (Object.hasOwn(iconSpriteData, item.icon) ? item.icon as IconName : undefined));
      const content = <>
        {item.busy ? <Icon name="loader-4" className={cn(sidebar ? 'size-4' : 'size-3.5', 'shrink-0 animate-spin motion-reduce:animate-none')} />
          : icon ? <Icon name={icon} className={sidebar ? 'size-4 shrink-0' : 'size-3.5'} />
            : sidebar ? <span aria-hidden="true" className="size-4 shrink-0" /> : null}
        {sidebar || !icon ? <span className={sidebar ? 'truncate' : 'max-w-24 truncate'}>{item.label}</span> : null}
      </>;
      return item.actionable ? <Button key={item.key} size={sidebar || mobile ? 'sm' : 'xs'} variant={sidebar ? 'ghost' : 'default'}
        className={cn('aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground',
          sidebar && 'w-full justify-start px-2 font-normal', sidebar && mobile && 'h-11')}
        title={item.label} aria-label={item.title ?? item.label} aria-pressed={item.pressed}
        aria-busy={Boolean(item.busy)} disabled={Boolean(item.busy)}
        onClick={() => void host.runTitlebarItem(item.key)}>{content}</Button>
        : <span key={item.key} role="status" title={item.label} aria-label={item.title ?? item.label} aria-busy={Boolean(item.busy)}
          className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted-foreground', sidebar ? 'w-full text-sm' : 'bg-muted text-xs')}>{content}</span>;
    })}
  </div>;
}
