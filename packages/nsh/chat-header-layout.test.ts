import { expect, test } from 'vitest';
import { chatHeaderGeometry, chatHeaderLayout, chatMetadataGeometry } from './chat-header-layout';

test('402pt Touch header budgets the complete 204pt title without overlapping 41pt controls', () => {
  const geometry = chatHeaderGeometry(402);
  expect(geometry.left).toBe(16);
  expect(geometry.buttonTop).toBeCloseTo(12.3);
  expect(geometry.height).toBeCloseTo(61.5);
  expect(geometry.trailingLeft).toBe(296);
  expect(geometry.trailingWidth).toBe(90);
  expect(geometry.titleWidth).toBeCloseTo(218.5);
  expect(geometry.titleWidth).toBeGreaterThan(204);
  expect(geometry.titleRight).toBeLessThan(geometry.trailingLeft);
  expect(geometry.titleLeft).toBeGreaterThan(geometry.left + chatHeaderLayout.button);
});

test('402x874 iOS metadata excludes 62pt status and 34pt home area, including popup padding', () => {
  const panel = chatMetadataGeometry(402, 874, 62, 34);
  expect(panel.contentHeight).toBe(778);
  expect(panel.maxHeight).toBeCloseTo(560.16);
  expect(panel.scrollMaxHeight + 16).toBeCloseTo(panel.maxHeight);
  expect(panel.width).toBeCloseTo(377.4);
  expect(panel.top).toBeCloseTo(65.6);
  expect(Math.abs(panel.top - 65.383)).toBeLessThan(1);
  expect(panel.top + panel.maxHeight + panel.margin).toBeLessThan(panel.contentHeight);
});

test('narrow and safe-inset layouts truncate only inside the title lane, never the controls', () => {
  for (const width of [320, 375, 402, 430, 844]) {
    const geometry = chatHeaderGeometry(width, 2, width > 500 ? 44 : 0, width > 500 ? 44 : 0);
    expect(geometry.titleWidth).toBeGreaterThan(0);
    expect(geometry.titleRight).toBeLessThan(geometry.trailingLeft);
    expect(geometry.trailingLeft + geometry.trailingWidth).toBe(width - geometry.right);
  }
});
