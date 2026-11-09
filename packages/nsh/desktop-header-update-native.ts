import type { PageOperation } from './page-operations';
import { bindRawRequest, native } from './runtime';
import { aboutReadResponse, createSettingsAbout, type AboutDependencies } from './settings-about-core';
import { aboutDiagnosticsCall } from './settings-about-diagnostics';
import { createDesktopHeaderUpdateOwner } from './desktop-header-update';

/** Root supplies its EXISTING Host operation; no PageOperation, timer or request is created here. */
export function createNativeDesktopHeaderUpdateOwner(options: { current(): boolean; operation: PageOperation | null; admitted?(): boolean }) {
  let assigned = options.operation, alive = true, retired = false;
  const current = () => {
    if (!alive || retired) return false;
    if (!options.current()) retired = true;
    return !retired;
  };
  function dependencies(operation: PageOperation | null): AboutDependencies {
    const send = bindRawRequest(operation?.scope ?? null);
    const admitted = () => assigned === operation && operation?.current() === true && options.admitted?.() !== false && current();
    return {
      current: admitted, hostID: operation?.scope?.hostID ?? null,
      async read(path) {
        if (!admitted()) throw new Error('about_operation_stale');
        const result = await send(path);
        if (!admitted()) throw new Error('about_operation_stale');
        return aboutReadResponse(path, result);
      },
      call: (name, body) => aboutDiagnosticsCall(async (method, input) => {
        if (!admitted()) throw new Error('about_operation_stale');
        const result = await native(method, input);
        if (!admitted()) throw new Error('about_operation_stale');
        return result;
      }, name, body),
      // The native Host declares client updates unsupported and no Host-update origin grant.
      // A functioning GET/POST route is not authority to attach submitUpdate here.
    };
  }
  const about = createSettingsAbout(dependencies(assigned));
  const owner = createDesktopHeaderUpdateOwner({ about, current });
  return {
    ...owner,
    updateOperation(operation: PageOperation | null) {
      if (!current() || assigned === operation) return;
      assigned = operation;
      about.replaceLane(dependencies(operation));
    },
    dispose() { if (!owner.dispose()) return false; alive = false; return true; },
    retire() { alive = false; retired = true; owner.retire(); },
  };
}
