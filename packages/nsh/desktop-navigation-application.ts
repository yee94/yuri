import { cleanup, effect } from 'nsh';
import { app, captureHostOperation } from './state';
import { attachDesktopNavigationPersistence } from './desktop-navigation-state';
import { desktopNavigationPartition, type DesktopNavigationAuthority, type DesktopNavigationStorage } from './desktop-navigation-state-core';
import { createDesktopNavigationRestoreAdmission, projectDesktopNavigation } from './desktop-navigation-application-core';

export { projectDesktopNavigation, resolveDesktopNavigation, createDesktopNavigationRestoreAdmission } from './desktop-navigation-application-core';
export type { ResolvedNavigation, DesktopNavigationOperation } from './desktop-navigation-application-core';

/** Production defaults use actual adopted native Host + captureHostOperation's bound GET
 * request/current gate. No app.sessions cache, stream, draft disposal, or Host selection.
 * Attach once at the desktop root. Main's rawApply builds raw Routes synchronously from
 * ResolvedNavigation; optional authorize is its existing async dirty/navigation guard.
 * At EVERY user intent, call userNavigated before awaits and retain captureAuthority;
 * saveRoute only after successful nav or actual composer directory publication, never
 * every text edit. Native close admission awaits flush(), not disposing close(). */
export function attachDesktopNavigationApplication(options: {
  rawApply: Parameters<typeof createDesktopNavigationRestoreAdmission>[0]['rawApply'];
  authorize?: Parameters<typeof createDesktopNavigationRestoreAdmission>[0]['authorize'];
  captureOperation?: Parameters<typeof createDesktopNavigationRestoreAdmission>[0]['captureOperation'];
  authority?: () => DesktopNavigationAuthority;
  storage?: DesktopNavigationStorage;
}) {
  const authority = options.authority ?? (() => ({ connection: app.connection(), runtimeScope: app.runtimeScope(), confirmed: captureHostOperation().current() }));
  const admission = createDesktopNavigationRestoreAdmission({ ...options, captureOperation: options.captureOperation ?? captureHostOperation });
  let previous: string | undefined;
  effect(() => {
    const value = authority(), signature = JSON.stringify([desktopNavigationPartition(value), value.runtimeScope]);
    if (previous !== undefined && previous !== signature) admission.retire();
    previous = signature;
  });
  const persistence = attachDesktopNavigationPersistence({ authority, storage: options.storage,
    requestRestore: admission.requestRestore, onRestore: admission.onRestore });
  cleanup(admission.dispose);
  return {
    ...persistence,
    pendingResolvedCount: admission.pendingResolvedCount,
    userNavigated() { admission.retire(); persistence.userNavigated(); },
    save(target: Parameters<typeof persistence.save>[0], expected: DesktopNavigationAuthority) { admission.retire(); return persistence.save(target, expected); },
    saveRoute(route: Parameters<typeof projectDesktopNavigation>[0], expected: DesktopNavigationAuthority, actualDraftDirectory?: string) {
      const projection = projectDesktopNavigation(route, actualDraftDirectory);
      if (!projection) return false;
      admission.retire(); return persistence.save(projection, expected);
    },
    async close() { const closed = await persistence.close(); if (closed) admission.dispose(); return closed; },
    dispose() { admission.dispose(); return persistence.dispose(); },
  };
}
