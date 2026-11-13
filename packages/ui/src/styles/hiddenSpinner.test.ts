import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = [readFileSync(join(here, '../index.css'), 'utf8'), readFileSync(join(here, 'mobile.css'), 'utf8')].join('\n');
const playStateRules = [...css.matchAll(/([^{}]+)\{([^{}]*animation-play-state\s*:[^{}]*)\}/g)]
    .map((match) => `${match[1]}{${match[2]}}`).join('\n');
const mounted: HTMLElement[] = [];

afterEach(() => {
    for (const node of mounted) node.remove();
    mounted.length = 0;
});

function mount(html: string): HTMLElement {
    const style = document.createElement('style');
    style.textContent = `.animate-spin { animation-play-state: running; } ${playStateRules}`;
    const host = document.createElement('div');
    host.innerHTML = html;
    document.head.append(style);
    document.body.append(host);
    mounted.push(style, host);
    return host;
}

test('parked root-tab spinners pause, then resume before a back reveal', () => {
    const host = mount('<div data-mobile-navigation-parked="true"><span class="animate-spin"></span></div><span class="animate-spin" data-visible></span>');
    const underlay = host.firstElementChild!;
    const spinner = underlay.firstElementChild!;
    expect(getComputedStyle(spinner).animationPlayState).toBe('paused');
    expect(getComputedStyle(host.querySelector('[data-visible]')!).animationPlayState).toBe('running');

    underlay.setAttribute('data-mobile-back-revealing', 'true');
    expect(getComputedStyle(spinner).animationPlayState).toBe('running');
    underlay.removeAttribute('data-mobile-back-revealing');
    expect(getComputedStyle(spinner).animationPlayState).toBe('paused');
    underlay.removeAttribute('data-mobile-navigation-parked');
    expect(getComputedStyle(spinner).animationPlayState).toBe('running');
});

test('reserved history status pauses only when its authoritative busy state is false', () => {
    const host = mount('<div class="chat-scroll"><div role="status" aria-busy="false"><span class="animate-spin"></span></div><div aria-busy="false"><span class="animate-spin" data-unrelated></span></div></div>');
    const status = host.querySelector('[role="status"]')!;
    const spinner = status.firstElementChild!;
    expect(getComputedStyle(spinner).animationPlayState).toBe('paused');
    expect(getComputedStyle(host.querySelector('[data-unrelated]')!).animationPlayState).toBe('running');

    status.setAttribute('aria-busy', 'true');
    expect(getComputedStyle(spinner).animationPlayState).toBe('running');
    status.removeAttribute('aria-busy');
    expect(getComputedStyle(spinner).animationPlayState).toBe('running');
    status.setAttribute('aria-busy', 'false');
    expect(getComputedStyle(spinner).animationPlayState).toBe('paused');
    expect(status.firstElementChild).toBe(spinner);
});
