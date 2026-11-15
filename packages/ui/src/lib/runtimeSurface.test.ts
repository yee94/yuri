import { afterEach, expect, test, vi } from 'vitest';
import { isMobileSurfaceRuntime } from './runtimeSurface';

const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');

const probe = (width: number) => {
    const read = vi.fn(() => width);
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: read });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
    window.dispatchEvent(new Event('resize'));
    return read;
};

afterEach(() => {
    delete window.__YURI_SURFACE__;
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
    if (originalTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', originalTouchPoints);
    else Reflect.deleteProperty(navigator, 'maxTouchPoints');
    window.dispatchEvent(new Event('resize'));
});

test('render-path callers do not re-probe viewport geometry until it changes', () => {
    const phone = probe(390);
    for (let index = 0; index < 50; index += 1) expect(isMobileSurfaceRuntime()).toBe(true);
    expect(phone).toHaveBeenCalledTimes(1);

    const wide = probe(1280);
    for (let index = 0; index < 50; index += 1) expect(isMobileSurfaceRuntime()).toBe(false);
    expect(wide).toHaveBeenCalledTimes(1);
});

test('an explicit host surface wins immediately over a cached probe', () => {
    probe(1280);
    expect(isMobileSurfaceRuntime()).toBe(false);
    window.__YURI_SURFACE__ = 'mobile';
    expect(isMobileSurfaceRuntime()).toBe(true);
    delete window.__YURI_SURFACE__;
    expect(isMobileSurfaceRuntime()).toBe(false);
});
