import { expect, test } from 'vitest';
import { createNativeShortcutRoutingPlan, nativeShortcutBindings, type NativeShortcutBinding } from './desktop-shortcuts-core';

test('routing exposes the actual admitted plan, not menu-owned or unavailable actions', () => {
  const routing = createNativeShortcutRoutingPlan(), scope = {};
  const plan = nativeShortcutBindings({ apple: true, settingsOpen: false, actions: {
    open_command_palette: { run() {} }, cycle_agent: { run() {} }, next_terminal_tab: { run() {}, enabled: false },
  }, menuOwnedActions: ['open_command_palette'] });
  const current = routing.replace(plan, scope);
  expect(current.map(row => [row.actionId, row.keystroke, row.direction])).toEqual([
    ['cycle_agent', 'tab', 1], ['cycle_agent', 'shift+tab', -1],
  ]);
  expect(Object.isFrozen(current)).toBe(true);
  expect(current.every(Object.isFrozen)).toBe(true);
  expect(routing.resolve(current[1], scope)).toBe(current[1]);
  expect(routing.resolve(current[1], {})).toBeNull();
});

test('untrusted id/stroke/direction payloads must resolve back to an original snapshot item', () => {
  const routing = createNativeShortcutRoutingPlan(), scope = 'host/route';
  const current = routing.replace([{ actionId: 'cycle_agent', keystroke: 'shift+tab', direction: -1 }], scope);
  const binding = current[0];
  for (const forged of [
    { ...binding }, { ...binding, actionId: 'abort_run' }, { ...binding, keystroke: 'tab' }, { ...binding, direction: 1 as const },
    null, undefined, 'shift+tab', 42,
  ]) expect(routing.resolve(forged as NativeShortcutBinding, scope)).toBeNull();
  expect(Reflect.set(binding, 'actionId', 'abort_run')).toBe(false);
  expect(Reflect.set(binding, 'direction', 1)).toBe(false);
  expect(routing.resolve(binding, scope)).toBe(binding);
});

test('replace and retire revoke prior callbacks, including same action/stroke after scope ABA', () => {
  const routing = createNativeShortcutRoutingPlan();
  const input = [{ actionId: 'open_command_palette', keystroke: 'cmd+p' }];
  const old = routing.replace(input, 'A')[0];
  expect(routing.resolve(input[0], 'A')).toBeNull();
  const next = routing.replace([{ actionId: 'open_command_palette', keystroke: 'alt+f8' }], 'A')[0];
  expect(routing.resolve(old, 'A')).toBeNull(); expect(routing.resolve(next, 'A')).toBe(next);
  routing.replace(input, 'B');
  const restored = routing.replace(input, 'A')[0];
  expect(routing.resolve(old, 'A')).toBeNull(); expect(routing.resolve(restored, 'A')).toBe(restored);
  routing.retire();
  expect(routing.bindings()).toEqual([]); expect(routing.resolve(restored, 'A')).toBeNull();
});

test('50 reads and exact dispatch validations do not replace or enumerate the plan', () => {
  const routing = createNativeShortcutRoutingPlan();
  const current = routing.replace([{ actionId: 'next_terminal_tab', keystroke: 'cmd+shift+]' }], 'scope');
  for (let index = 0; index < 50; index++) {
    expect(routing.bindings()).toBe(current);
    expect(routing.resolve(current[0], 'scope')).toBe(current[0]);
  }
  expect(routing.bindings()).toBe(current);
});
