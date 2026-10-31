import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { SettingsSidebarItem } from './SettingsSidebarItem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('compact collections opt in without changing default row geometry', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const select = vi.fn();
  try {
    await act(async () => root.render(<>
      <SettingsSidebarItem title="Default entity" onSelect={select} rowId="default" />
      <SettingsSidebarItem compact title={<span className="truncate">Long package name</span>} onSelect={select} rowId="compact" selected />
    </>));
    expect(host.querySelector('[data-row-id="default"]')?.classList.contains('yuri-settings-group-row')).toBe(true);
    expect(host.querySelector('[data-row-id="compact"]')?.classList.contains('yuri-settings-group-row')).toBe(false);
    const button = host.querySelector<HTMLButtonElement>('[data-row-id="compact"] button')!;
    const row = host.querySelector('[data-row-id="compact"]')!;
    expect(row.classList.contains('py-2')).toBe(false);
    expect(row.classList.contains('px-3')).toBe(false);
    expect(button.classList.contains('py-2')).toBe(true);
    expect(button.classList.contains('px-3')).toBe(true);
    expect(button.getAttribute('aria-current')).toBe('true');
    await act(async () => button.click());
    expect(select).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
