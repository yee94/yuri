import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestBrowserAddressFocus, subscribeBrowserAddressFocus } from './browserAddressFocus';

const createInput = (value = 'https://example.com/') => {
  const input = document.createElement('input');
  input.value = value;
  document.body.appendChild(input);
  return input;
};

describe('browser address focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  test('focuses and selects the address of an active pane', () => {
    const input = createInput();
    const unsubscribe = subscribeBrowserAddressFocus(() => input);

    requestBrowserAddressFocus();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    unsubscribe();
  });

  test('a request raised before the pane became active is consumed on subscribe', () => {
    const input = createInput();

    requestBrowserAddressFocus();
    expect(document.activeElement).not.toBe(input);

    const unsubscribe = subscribeBrowserAddressFocus(() => input);
    expect(document.activeElement).toBe(input);
    unsubscribe();
  });

  test('is consumed once, so a later activation does not steal focus', () => {
    const first = createInput();
    const second = createInput();
    const unsubscribeFirst = subscribeBrowserAddressFocus(() => first);

    requestBrowserAddressFocus();
    const unsubscribeSecond = subscribeBrowserAddressFocus(() => second);

    expect(document.activeElement).toBe(first);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('a request that nobody claimed in time is dropped', () => {
    const input = createInput();

    requestBrowserAddressFocus();
    vi.advanceTimersByTime(3001);
    const unsubscribe = subscribeBrowserAddressFocus(() => input);

    expect(document.activeElement).not.toBe(input);
    unsubscribe();
  });

  test('stays pending until a pane has an address input to focus', () => {
    const input = createInput();
    const unmounted = subscribeBrowserAddressFocus(() => null);

    requestBrowserAddressFocus();
    unmounted();
    const unsubscribe = subscribeBrowserAddressFocus(() => input);

    expect(document.activeElement).toBe(input);
    unsubscribe();
  });

  test('an unsubscribed pane no longer reacts', () => {
    const input = createInput();
    subscribeBrowserAddressFocus(() => input)();

    requestBrowserAddressFocus();

    expect(document.activeElement).not.toBe(input);
  });
});
