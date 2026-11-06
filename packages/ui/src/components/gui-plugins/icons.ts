import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';

const aliases: Record<string, IconName> = { globe: 'global', server: 'server', 'circle-check': 'checkbox-circle', 'circle-x': 'close-circle', 'window-analytics': 'bar-chart-box' };

export function guiPluginIcon(name?: string): IconName | undefined {
  return name ? aliases[name] ?? (Object.hasOwn(iconSpriteData, name) ? name as IconName : undefined) : undefined;
}
