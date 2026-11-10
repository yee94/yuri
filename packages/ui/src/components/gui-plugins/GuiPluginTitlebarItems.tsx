import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { guiPluginIcon } from './icons';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import type { GuiPluginHost, GuiPluginSnapshot } from '@/lib/gui-plugins/host';
import { cn } from '@/lib/utils';

function TitlebarEntry({ item, host, mobile, sidebar }: {
  item: GuiPluginSnapshot['titlebarItems'][number]; host: GuiPluginHost; mobile: boolean; sidebar: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const icon = guiPluginIcon(item.icon);
  const image = item.icon?.startsWith('data:image/') && item.icon !== failedSrc ? item.icon : undefined;
  const hasIcon = Boolean(icon || image);
  const content = <>
    {item.busy ? <Icon name="loader-4" className={cn(sidebar ? 'size-4' : 'size-3.5', 'shrink-0 animate-spin motion-reduce:animate-none')} />
      : icon ? <Icon name={icon} className={sidebar ? 'size-4 shrink-0' : 'size-3.5'} />
        : image ? <img key={image} src={image} alt="" draggable={false} className={cn(sidebar ? 'size-4' : 'size-3.5', 'shrink-0 object-contain')}
          onError={() => setFailedSrc(image)} />
          : sidebar ? <span aria-hidden="true" className="size-4 shrink-0" /> : null}
    {sidebar || !hasIcon ? <span className={sidebar ? 'truncate' : 'max-w-24 truncate'}>{item.label}</span> : null}
  </>;
  return item.actionable ? <Button size={sidebar || mobile ? 'sm' : 'xs'} variant={sidebar ? 'ghost' : 'default'}
    className={cn('aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground',
      sidebar && 'w-full justify-start px-2 font-normal', sidebar && mobile && 'h-11')}
    title={item.label} aria-label={item.title ?? item.label} aria-pressed={item.pressed}
    aria-busy={Boolean(item.busy)} disabled={Boolean(item.busy)}
    onClick={() => void host.runTitlebarItem(item.key)}>{content}</Button>
    : <span role="status" title={item.label} aria-label={item.title ?? item.label} aria-busy={Boolean(item.busy)}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted-foreground', sidebar ? 'w-full text-sm' : 'bg-muted text-xs')}>{content}</span>;
}

export function GuiPluginTitlebarItems({ mobile = false, sidebar = false }: { mobile?: boolean; sidebar?: boolean }) {
  const { host, snapshot } = useGuiPlugins();
  if (!host || snapshot.titlebarItems.length === 0) return null;

  return <div data-gui-titlebar-items={!sidebar || undefined} data-gui-sidebar-items={sidebar || undefined}
    className={sidebar ? 'app-region-no-drag space-y-0.5' : 'app-region-no-drag flex min-w-0 max-w-32 items-center gap-1 overflow-x-auto scrollbar-hidden'}>
    {snapshot.titlebarItems.map((item) => <TitlebarEntry key={item.key} item={item} host={host} mobile={mobile} sidebar={sidebar} />)}
  </div>;
}
