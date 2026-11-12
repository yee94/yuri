import type { DesktopSettings } from '@/lib/desktop';

export type HubProjectLayout = NonNullable<DesktopSettings['hubProjectLayout']>;

export function parseHubProjectLayout(value: unknown): HubProjectLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Hub project layout');
  const layout = value as Record<string, unknown>;
  if (typeof layout.hubId !== 'string' || !layout.hubId.trim()
    || !Array.isArray(layout.order) || layout.order.some((id) => typeof id !== 'string' || !id.trim())
    || !layout.collapsed || typeof layout.collapsed !== 'object' || Array.isArray(layout.collapsed)
    || Object.entries(layout.collapsed).some(([id, collapsed]) => !id.trim() || typeof collapsed !== 'boolean')) {
    throw new Error('Invalid Hub project layout');
  }
  return { hubId: layout.hubId, order: [...new Set(layout.order as string[])], collapsed: Object.fromEntries(Object.entries(layout.collapsed)) as Record<string, boolean> };
}
