import { expect, test, vi } from 'vitest';
import { createNativeDesktopComposerShortcutOwner, nativeDesktopNextModelVariant, type NativeDesktopComposerShortcutOwner, type NativeDesktopComposerShortcutRegistration } from './desktop-composer-actions';
import type { NativeShortcutIntent } from './desktop-shortcuts-core';

test('composer descriptors keep identity and recheck inactive, IME, overlay, pending and retired ownership', async () => {
  let active = true, composing = false, overlay = false, pending = false;
  const run = vi.fn();
  const registration = createNativeDesktopComposerShortcutOwner({ current: () => active, composing: () => composing, overlayOpen: () => overlay, actions: {
    cycle_agent: { get enabled() { return !pending; }, run },
  } });
  const owner = registration.owner, action = owner.actions.cycle_agent!;
  const intent: NativeShortcutIntent = { source: 'keyboard', direction: -1 };
  await action.run(intent);
  expect(run).toHaveBeenLastCalledWith(intent);
  expect(Object.keys(owner.actions)).toEqual(['cycle_agent']);
  for (const gate of ['inactive', 'IME', 'overlay', 'pending'] as const) {
    active = gate !== 'inactive'; composing = gate === 'IME'; overlay = gate === 'overlay'; pending = gate === 'pending';
    expect(action.enabled).toBe(false);
    await action.run(intent);
    expect(run).toHaveBeenCalledTimes(1);
    expect(owner.actions.cycle_agent).toBe(action);
  }
  active = true; composing = overlay = pending = false;
  registration.retire();
  expect(owner.current()).toBe(false);
  expect(action.enabled).toBe(false);
  await action.run(intent);
  expect(run).toHaveBeenCalledTimes(1);
});

test('a retired owner event cannot clear a newer registration and its retained action is inert', () => {
  const oldRun = vi.fn(), nextRun = vi.fn();
  const create = (run: () => void) => createNativeDesktopComposerShortcutOwner({ current: () => true, composing: () => false, overlayOpen: () => false, actions: { focus_input: { run } } });
  const old = create(oldRun), next = create(nextRun);
  let active: NativeDesktopComposerShortcutOwner | null = null;
  const publish = (event: NativeDesktopComposerShortcutRegistration) => {
    if (event.type === 'register') active = event.owner;
    else if (active === event.owner) active = null;
  };
  publish({ type: 'register', owner: old.owner });
  publish({ type: 'register', owner: next.owner });
  old.retire(); publish({ type: 'retire', owner: old.owner });
  expect(active).toBe(next.owner);
  old.owner.actions.focus_input!.run(); next.owner.actions.focus_input!.run();
  expect(oldRun).not.toHaveBeenCalled(); expect(nextRun).toHaveBeenCalledTimes(1);
});

test('only shared catalog IDs can be published; unknown actions are not silent success', () => {
  expect(() => createNativeDesktopComposerShortcutOwner({ current: () => true, composing: () => false, overlayOpen: () => false,
    actions: { not_a_real_action: { run() {} } },
  })).toThrow('unknown-composer-shortcut:not_a_real_action');
});

test('variant cycling follows Web order, skips Default on wrap and leaves unknown models untouched', () => {
  const providers = [{ id: 'fixture', models: { model: { variants: { low: {}, high: {} } }, plain: {} } }];
  const model = { providerID: 'fixture', id: 'model' };
  expect(nativeDesktopNextModelVariant(providers, model)).toBe('low');
  expect(nativeDesktopNextModelVariant(providers, { ...model, variant: 'low' })).toBe('high');
  expect(nativeDesktopNextModelVariant(providers, { ...model, variant: 'high' })).toBe('low');
  expect(nativeDesktopNextModelVariant(providers, { ...model, variant: 'removed' })).toBe('low');
  expect(nativeDesktopNextModelVariant(providers, { ...model, id: 'plain' })).toBeUndefined();
  expect(nativeDesktopNextModelVariant(providers, { ...model, providerID: 'other' })).toBeUndefined();
});

test('50 closed-picker gate snapshots enumerate zero entries in a 300-model catalog', () => {
  let enumerations = 0;
  const models = new Proxy(Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`model-${index}`, { variants: { low: {}, high: {} } }])), {
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    get(target, key, receiver) { enumerations++; return Reflect.get(target, key, receiver); },
  });
  const providers = [{ id: 'fixture', models }], model = { providerID: 'fixture', id: 'model-299', variant: 'low' };
  const run = vi.fn(() => nativeDesktopNextModelVariant(providers, model));
  const { owner } = createNativeDesktopComposerShortcutOwner({ current: () => true, composing: () => false, overlayOpen: () => false,
    actions: { cycle_thinking_variant: { get enabled() { return !!model.id; }, run } },
  });
  for (let index = 0; index < 50; index++) expect(owner.actions.cycle_thinking_variant!.enabled).toBe(true);
  expect(enumerations).toBe(0);
  owner.actions.cycle_thinking_variant!.run({ source: 'menu' });
  expect(run).toHaveReturnedWith('high'); expect(enumerations).toBe(1);
  const before = enumerations;
  for (let index = 0; index < 50; index++) expect(owner.actions.cycle_thinking_variant!.enabled).toBe(true);
  expect(enumerations).toBe(before);
});
