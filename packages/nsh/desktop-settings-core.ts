import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { SettingsPageID, SettingsRoute } from './settings';
import { searchSettingsFields } from './settings-search-core';

export const desktopSettingsNavigationLimits = { min: 176, max: 280, initial: 224 } as const;
export const desktopSettingsWindowLimits = { widthRatio: .9, heightRatio: .85, maxWidth: 1200, maxHeight: 900 } as const;
export function clampDesktopSettingsNavigation(width: number) {
  return Number.isFinite(width) ? Math.min(desktopSettingsNavigationLimits.max, Math.max(desktopSettingsNavigationLimits.min, width)) : desktopSettingsNavigationLimits.initial;
}
export function desktopSettingsGeometry(width: number, height: number) {
  return {
    width: Number.isFinite(width) ? Math.min(desktopSettingsWindowLimits.maxWidth, Math.max(0, width) * desktopSettingsWindowLimits.widthRatio) : 0,
    height: Number.isFinite(height) ? Math.min(desktopSettingsWindowLimits.maxHeight, Math.max(0, height) * desktopSettingsWindowLimits.heightRatio) : 0,
  };
}

type DesktopSettingsGroup = 'connection' | 'personalization' | 'workspace' | 'opencode' | 'content' | 'system';
type Entry = { page: SettingsPageID; title: I18nKey; group: DesktopSettingsGroup };
export type DesktopSettingsRow = {
  value: string;
  title: string;
  subtitle?: string;
  group: DesktopSettingsGroup;
  route: SettingsRoute;
};

/** The caller supplies SETTINGS_ENTRIES; this pure module never imports native pages. */
export function desktopSettingsRows(entries: readonly Entry[], query: string, translate: (key: I18nKey) => string, visiblePages?: readonly SettingsPageID[]): DesktopSettingsRow[] {
  const available = entries.filter(entry => !visiblePages || visiblePages.includes(entry.page));
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const fields = searchSettingsFields(query, translate, 'macos');
  const rows: DesktopSettingsRow[] = [];
  for (const entry of available) {
    const title = translate(entry.title);
    if (terms.every(term => title.toLocaleLowerCase().includes(term))) rows.push({ value: `page:${entry.page}`, title, group: entry.group, route: { page: entry.page } });
    for (const field of fields.filter(item => item.page === entry.page)) {
      rows.push({ value: `field:${field.id}`, title: translate(field.title), subtitle: title, group: entry.group, route: { page: entry.page, target: field.id } });
    }
  }
  return rows;
}

/** Page navigation clears entity/create/target, but never loses the captured directory. */
export function desktopSettingsDestination(current: SettingsRoute, destination: SettingsRoute): SettingsRoute {
  return { ...destination, directory: destination.directory ?? current.directory };
}
export function desktopSettingsRouteKey(route: SettingsRoute) {
  return JSON.stringify([route.page, route.entity, route.create, route.target, route.directory]);
}

export type DesktopSettingsIntent = { kind: 'close' } | { kind: 'navigate'; route: SettingsRoute };
export type DesktopSettingsGuardSnapshot = {
  open: boolean;
  active: boolean;
  pending: boolean;
  dirty: boolean;
  nestedPickerOpen: boolean;
  scopeKey?: string | number;
  route: SettingsRoute;
};

/** A request is permission to call the owner, never permission to dismiss locally.
 * Owners must invalidate on scope/route changes, including close/reopen (ABA). */
export function createDesktopSettingsGuard(options: {
  snapshot: () => DesktopSettingsGuardSnapshot;
  confirmDiscard?: (intent: DesktopSettingsIntent) => boolean | Promise<boolean>;
  onClose: () => void;
  onNavigate: (route: SettingsRoute) => void;
  onError?: (error: unknown) => void;
  onBusy?: (busy: boolean) => void;
}) {
  let generation = 0, flight: number | undefined, alive = true;
  const admitted = (value: DesktopSettingsGuardSnapshot) => alive && value.open && value.active && !value.pending && !value.nestedPickerOpen;
  // Dirty is an admission hint, not a route generation. A real owner may clear
  // its draft after approval; that must not invalidate its own confirmation.
  const key = (value: DesktopSettingsGuardSnapshot) => JSON.stringify([value.open, value.active, value.pending, value.nestedPickerOpen, value.scopeKey, desktopSettingsRouteKey(value.route)]);
  function invalidate() {
    generation++;
    if (flight !== undefined) { flight = undefined; options.onBusy?.(false); }
  }
  return {
    invalidate,
    dispose() { alive = false; invalidate(); },
    async request(intent: DesktopSettingsIntent): Promise<boolean> {
      const before = options.snapshot();
      if (flight !== undefined || !admitted(before)) return false;
      const destination = intent.kind === 'navigate' ? desktopSettingsDestination(before.route, intent.route) : undefined;
      if (destination && desktopSettingsRouteKey(destination) === desktopSettingsRouteKey(before.route)) return false;
      if (before.dirty && !options.confirmDiscard) return false;
      const captured = ++generation, identity = key(before);
      flight = captured; options.onBusy?.(true);
      try {
        const confirmed = !before.dirty || await options.confirmDiscard!(destination ? { kind: 'navigate', route: destination } : intent);
        const after = options.snapshot();
        if (!confirmed || captured !== generation || !admitted(after) || key(after) !== identity) return false;
        if (destination) options.onNavigate(destination); else options.onClose();
        return true;
      } catch (error) {
        if (alive && captured === generation) options.onError?.(error);
        return false;
      } finally {
        if (flight === captured) { flight = undefined; if (alive) options.onBusy?.(false); }
      }
    },
  };
}
