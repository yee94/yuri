import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsSwitch } from './SettingsSwitch';
import { SettingsToggleRow } from './SettingsGroup';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key.endsWith('.on') ? '开启' : '关闭' }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const option = (value: boolean) => host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[value ? 1 : 0]!;

it('sets explicit values exactly once inside an interactive legacy row', async () => {
  const change = vi.fn();
  const parentClick = vi.fn();
  const parentKey = vi.fn();
  function Fixture() {
    const [checked, setChecked] = React.useState(false);
    return <div role="button" tabIndex={0} onClick={parentClick} onKeyDown={parentKey}>
      <SettingsSwitch checked={checked} ariaLabel="设置" onChange={(value) => { change(value); setChecked(value); }} />
    </div>;
  }
  await act(async () => root.render(<Fixture />));
  expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('设置');
  await act(async () => option(false).click());
  expect(change).not.toHaveBeenCalled();
  await act(async () => option(true).click());
  expect(change.mock.calls).toEqual([[true]]);
  expect(option(true).getAttribute('aria-checked')).toBe('true');
  await act(async () => option(true).click());
  expect(change).toHaveBeenCalledTimes(1);
  act(() => option(true).focus());
  act(() => {
    option(true).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
  await act(async () => {});
  expect(change.mock.calls).toEqual([[true], [false]]);
  expect(document.activeElement).toBe(option(false));
  expect(parentClick).not.toHaveBeenCalled();
  expect(parentKey).not.toHaveBeenCalled();
});

it('keeps both options disabled and reflects externally changed values', async () => {
  const change = vi.fn();
  await act(async () => root.render(<SettingsSwitch checked={false} disabled onChange={change} ariaLabel="设置" />));
  expect(option(false).disabled).toBe(true);
  expect(option(true).disabled).toBe(true);
  await act(async () => option(true).click());
  expect(change).not.toHaveBeenCalled();
  await act(async () => root.render(<SettingsSwitch checked disabled onChange={change} ariaLabel="设置" />));
  expect(option(true).getAttribute('aria-checked')).toBe('true');
});

it('preserves row activation without duplicating segmented activation', async () => {
  const change = vi.fn();
  function Fixture() {
    const [checked, setChecked] = React.useState(false);
    return <SettingsToggleRow checked={checked} onChange={(value) => { change(value); setChecked(value); }} label="设置" ariaLabel="设置" />;
  }
  await act(async () => root.render(<Fixture />));
  await act(async () => option(true).click());
  expect(change.mock.calls).toEqual([[true]]);
  await act(async () => host.querySelector<HTMLElement>('.yuri-settings-split-row-copy')!.click());
  expect(change.mock.calls).toEqual([[true], [false]]);
  await act(async () => host.querySelector<HTMLElement>('.yuri-settings-group-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(change.mock.calls).toEqual([[true], [false], [true]]);
});
