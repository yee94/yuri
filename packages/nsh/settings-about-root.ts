import { cleanup, effect, lifecycle, untracked } from 'nsh';
import { app, epoch, isCurrentHostScope } from './state';
import { native } from './runtime';
import { createAboutDiagnosticsRoot } from './settings-about-diagnostics';

/** Mount once at application root. Reuses observeRuntime's existing event sink. */
export function createNativeAboutDiagnosticsRoot() {
  const root = createAboutDiagnosticsRoot({ call: native, scope: () => {
    const hostID = app.connection()?.id, generation = epoch();
    return hostID && isCurrentHostScope(generation, hostID) ? { hostID, generation } : null;
  } });
  cleanup(() => root.dispose());
  effect(() => {
    app.connection(); epoch();
    if (lifecycle() === 'active') untracked(() => { void root.refresh(); });
  });
  return root;
}
