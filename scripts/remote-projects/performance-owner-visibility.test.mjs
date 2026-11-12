import { expect, it } from 'vitest';
import { ownerNodeVisible } from './performance-owner-visibility.mjs';

const fixture = () => {
  const parent = { style: { visibility: 'visible', display: 'block', opacity: '1' } };
  const rect = { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 };
  const node = { parentElement: parent, style: parent.style, getBoundingClientRect: () => rect,
    contains: other => other === node };
  const document = { getElementById: () => null, elementFromPoint: () => node,
    defaultView: { innerWidth: 1280, innerHeight: 900, getComputedStyle: element => element.style } };
  return { node, parent, rect, document };
};

it('rejects a mounted target beneath the startup overlay even when dimensions and visibility match', () => {
  const { node, document } = fixture(); document.getElementById = () => ({});
  expect(ownerNodeVisible(node, document)).toBe(false);
});
it.each([{ opacity: '0' }, { display: 'none' }, { visibility: 'hidden' }])('rejects a hidden ancestor %j', style => {
  const { node, parent, document } = fixture(); parent.style = { ...parent.style, ...style };
  expect(ownerNodeVisible(node, document)).toBe(false);
});
it('rejects an unrelated covering element, including a non-startup overlay', () => {
  const { node, document } = fixture(); document.elementFromPoint = () => ({ contains: () => false });
  expect(ownerNodeVisible(node, document)).toBe(false);
});
it('rejects offscreen and empty targets', () => {
  const { node, rect, document } = fixture(); rect.top = 901;
  expect(ownerNodeVisible(node, document)).toBe(false); rect.top = 10; rect.width = 0;
  expect(ownerNodeVisible(node, document)).toBe(false);
});
it('accepts an unobscured target as DOM-eligible, not as a paint assertion', () => {
  const { node, document } = fixture(); expect(ownerNodeVisible(node, document)).toBe(true);
  document.elementFromPoint = () => ({ contains: other => other === node });
  expect(ownerNodeVisible(node, document)).toBe(true);
});
