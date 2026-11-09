import { expect, test } from 'vitest';
import { desktopChatContentWidth, desktopChatGeometry, desktopChatReserveRight, desktopChatRowSpacing } from './desktop-chat-layout-core';

test('Web window breakpoints, wide columns, padding scale and unknown first frame remain bounded', () => {
  expect(desktopChatGeometry(1068)).toMatchObject({ columnMax: 800, columnInset: 24, composerBottom: 16, composerRadius: 24 });
  expect(desktopChatGeometry(800)).toMatchObject({ columnMax: 800, columnInset: 16 });
  expect(desktopChatGeometry(1599).columnMax).toBe(800); expect(desktopChatGeometry(1600).columnMax).toBe(960);
  expect(desktopChatGeometry(1599, true).columnMax).toBe(1024); expect(desktopChatGeometry(1600, true).columnMax).toBe(1152);
  expect(desktopChatGeometry(1068, false, 1.5).columnInset).toBe(36);
  for (const width of [0, NaN, -1, Infinity]) expect(desktopChatGeometry(width).columnMax).toBe(800);
});

test('actual pane width bounds transcript content without a zero-width first-frame override', () => {
  expect(desktopChatContentWidth(808, 1068)).toBe(752);
  expect(desktopChatContentWidth(408, 1068)).toBe(360);
  expect(desktopChatContentWidth(540, 800)).toBe(508);
  expect(desktopChatContentWidth(1440, 1700)).toBe(912);
  for (const width of [0, -1, NaN, Infinity]) expect(desktopChatContentWidth(width, 0)).toBeUndefined();
});

test('row spacing follows real user/header/continued/live terminal branches rather than a blanket gap', () => {
  expect(desktopChatRowSpacing({ role: 'user' })).toEqual({ paddingTop: 24, paddingBottom: 0 });
  expect(desktopChatRowSpacing({ role: 'assistant', header: true, continued: true })).toEqual({ paddingTop: 24, paddingBottom: 0 });
  expect(desktopChatRowSpacing({ role: 'assistant', continued: true })).toEqual({ paddingTop: 0, paddingBottom: 0 });
  expect(desktopChatRowSpacing({ role: 'assistant', working: true })).toEqual({ paddingTop: 0, paddingBottom: 4 });
  expect(desktopChatRowSpacing({ role: 'assistant' })).toEqual({ paddingTop: 0, paddingBottom: 32 });
  expect(desktopChatRowSpacing({ role: 'notice' })).toEqual({ paddingTop: 6, paddingBottom: 6 });
});

test('reservation is applied once before the column maximum and window breakpoint remains independent of pane', () => {
  expect(desktopChatContentWidth(740, 1000, false, 1, 210)).toBe(498);
  expect(desktopChatContentWidth(1180, 1440, false, 1, 210)).toBe(752);
  expect(desktopChatContentWidth(1180, 1440, true, 1, 210)).toBe(922);
  expect(desktopChatContentWidth(780, 1440, false, 1, 210)).toBe(522);
  expect(desktopChatContentWidth(198, 1440, false, 1, 210)).toBe(150);
  for (const reserve of [undefined, 0, -210, NaN, Infinity, -Infinity]) {
    expect(desktopChatContentWidth(808, 1068, false, 1, reserve)).toBe(752);
    expect(desktopChatReserveRight(reserve, 808, 49)).toBe(0);
  }
  expect(desktopChatReserveRight(210, 198, 49)).toBe(0);
  expect(desktopChatReserveRight(210, 0, 49)).toBe(0);
  expect(desktopChatReserveRight(Number.MAX_VALUE, 780, 49)).toBe(0);
  expect(desktopChatContentWidth(780, 1440, false, 1, 731)).toBe(1);
  for (const width of [1, 32, 48, 49, 50, 198, 780, 1180]) {
    for (const reserve of [0, 210, Number.MAX_VALUE]) expect(desktopChatContentWidth(width, 1440, false, 1, reserve)).toBeGreaterThan(0);
  }
});
