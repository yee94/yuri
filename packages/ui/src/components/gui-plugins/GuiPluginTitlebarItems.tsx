import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { usePluginRegistryQuery } from '@/queries/pluginQueries';

const iconAliases: Record<string, IconName> = { globe: 'global', server: 'server', 'circle-check': 'checkbox-circle', 'circle-x': 'close-circle' };

function PackageIcon({ src, fallback }: { src: string; fallback: React.ReactNode }) {
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const mask = `url(${JSON.stringify(src)}) center / contain no-repeat`;
  return <>
    {status !== 'failed' && <img src={src} crossOrigin="anonymous" alt="" aria-hidden="true" hidden
      onLoad={() => setStatus('ready')} onError={() => setStatus('failed')} />}
    {status === 'ready' ? <span aria-hidden="true" data-gui-package-icon className="inline-block size-3.5 shrink-0"
      style={{ backgroundColor: 'currentColor', mask, WebkitMask: mask, maskMode: 'alpha' }} /> : fallback}
  </>;
}

export function GuiPluginTitlebarItems({ mobile = false }: { mobile?: boolean }) {
  const { host, snapshot } = useGuiPlugins();
  if (!host || snapshot.titlebarItems.length === 0) return null;
  return <TitlebarItems mobile={mobile} />;
}

function TitlebarItems({ mobile }: { mobile: boolean }) {
  const { host, snapshot, inventory } = useGuiPlugins();
  const sources = inventory.flatMap(({ id, source }) => {
    if (!snapshot.titlebarItems.some((item) => item.pluginId === id) || !source || (source.type !== 'package' && source.type !== 'local')) return [];
    return [{ id, spec: source.type === 'package' ? source.target : source.path }];
  });
  const registry = usePluginRegistryQuery(sources.map(({ spec }) => spec));
  const icons = new Map(sources.map(({ id, spec }) => {
    const result = registry.data?.[spec];
    return [id, result && 'icon' in result ? result.icon : undefined];
  }));

  return <div data-gui-titlebar-items className="app-region-no-drag flex min-w-0 max-w-32 items-center gap-1 overflow-x-auto scrollbar-hidden">
    {snapshot.titlebarItems.map((item) => {
      const icon = item.icon && (iconAliases[item.icon] ?? (Object.hasOwn(iconSpriteData, item.icon) ? item.icon as IconName : undefined));
      const packageIcon = icons.get(item.pluginId);
      const fallback = icon ? <Icon name={icon} className="size-3.5" /> : <span className="max-w-24 truncate">{item.label}</span>;
      const content = <>
        {item.busy ? <Icon name="loader-4" className="size-3.5 animate-spin motion-reduce:animate-none" />
          : packageIcon ? <PackageIcon key={packageIcon} src={packageIcon} fallback={fallback} /> : fallback}
        {item.busy && !icon ? <span className="max-w-24 truncate">{item.label}</span> : null}
      </>;
      return item.actionable ? <Button key={item.key} size={mobile ? 'sm' : 'xs'}
        className="aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground"
        title={item.label} aria-label={item.title ?? item.label} aria-pressed={item.pressed}
        aria-busy={Boolean(item.busy)} disabled={Boolean(item.busy)}
        onClick={() => void host?.runTitlebarItem(item.key)}>{content}</Button>
        : <span key={item.key} role="status" title={item.label} aria-label={item.title ?? item.label} aria-busy={Boolean(item.busy)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{content}</span>;
    })}
  </div>;
}
