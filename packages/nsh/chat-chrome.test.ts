import { afterEach, expect, test, vi } from 'vitest';
import { createChatChromeState, createNativeChatChrome, type ChatChromeState } from './chat-chrome';

afterEach(() => vi.useRealTimers());
const frame = (distance: number, content = 5000, height = 700) => ({ offset: { y: content - height - distance }, contentSize: { height: content }, size: { height } });

test('user scrolling compacts both chrome surfaces and restores only near latest', () => {
  vi.useFakeTimers(); let state: ChatChromeState = createChatChromeState();
  const chrome = createNativeChatChrome(next => { state = next; });
  chrome.scroll(frame(0)); chrome.begin(frame(0));
  for (let distance = 10; distance <= 160; distance += 10) chrome.scroll(frame(distance));
  chrome.end(); vi.advanceTimersByTime(240);
  expect(state.swap).toMatchObject({ rest: 'compact', progress: 1 });
  expect(state.dock).toBe(1);
  chrome.begin(frame(160)); chrome.scroll(frame(130)); chrome.end();
  expect(state.swap.progress).toBe(1);
  chrome.begin(frame(130)); chrome.scroll(frame(100)); chrome.scroll(frame(50)); chrome.scroll(frame(0)); chrome.end();
  expect(state.swap).toMatchObject({ rest: 'expanded', progress: 0 });
  expect(state.dock).toBe(0); chrome.dispose();
});

test('streaming, viewport changes, programmatic scroll and history compensation do not compact', () => {
  let state: ChatChromeState = createChatChromeState();
  const chrome = createNativeChatChrome(next => { state = next; });
  chrome.scroll(frame(0)); chrome.scroll(frame(200));
  expect(state.swap.progress).toBe(0);
  chrome.begin(frame(200)); chrome.scroll(frame(800, 7000));
  expect(state.swap.progress).toBe(0);
  chrome.scroll(frame(900, 7000, 400));
  expect(state.swap.progress).toBe(0); chrome.dispose();
});

test('editing/IME pins expanded, explicit compact editing restores, disposal cancels snapping', () => {
  vi.useFakeTimers(); const states: ChatChromeState[] = [];
  const chrome = createNativeChatChrome(next => states.push(next));
  chrome.scroll(frame(0)); chrome.begin(frame(0)); chrome.scroll(frame(200));
  chrome.pin(true); expect(states.at(-1)?.swap).toMatchObject({ pinned: true, progress: 0 });
  chrome.scroll(frame(400)); expect(states.at(-1)?.swap.progress).toBe(0);
  chrome.pin(false); chrome.end(); chrome.expand();
  expect(states.at(-1)?.swap.progress).toBe(0);
  chrome.dispose(); const count = states.length; vi.runAllTimers(); expect(states).toHaveLength(count);
});

test('50 idle or identical scroll frames publish no presentation work', () => {
  let publications = 0;
  const chrome = createNativeChatChrome(() => publications++);
  chrome.scroll(frame(0)); chrome.begin(frame(0));
  for (let index = 0; index < 50; index++) chrome.scroll(frame(0));
  expect(publications).toBe(0); chrome.dispose();
});
