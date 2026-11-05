import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession } from '@/components/ui/chromeCdpHarness';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test.skip('Settings controls keep solid hover/focus backgrounds across themes and layouts', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const generator = new CSSVariableGenerator();
  const root = evidenceRoot();
  const chrome = await openChromeSession();
  try {
    const file = join(root, 'settings-controls.html');
    const controls = [
      renderToStaticMarkup(createElement(Input, { id: 'empty', 'aria-label': 'API key' })),
      renderToStaticMarkup(createElement(Input, { id: 'filled', defaultValue: 'https://api.example.com/v1', 'aria-label': 'Base URL' })),
      renderToStaticMarkup(createElement(Input, { id: 'numeric', type: 'number', placeholder: '' })),
      renderToStaticMarkup(createElement(Select, { defaultValue: 'test' }, createElement(SelectTrigger, { id: 'select' }, 'OpenAI'))),
      '<div id="number" data-slot="number-input" tabindex="0"><button style="border-right: 1px solid">−</button><input data-slot="number-input-value" value="4096" class="w-14 bg-transparent" /><button style="border-left: 1px solid">+</button></div>',
      '<button id="inline" class="yuri-settings-inline-value">Default</button>',
    ];
    const filter = renderToStaticMarkup(createElement(Input, { id: 'filter', bordered: true, placeholder: 'Filter models...', className: 'pl-8 w-full' }));
    const standalone = renderToStaticMarkup(createElement(Input, { id: 'standalone', placeholder: 'Search settings' }));
    const credential = renderToStaticMarkup(createElement(Input, { id: 'credential', type: 'password' }));
    const outside = renderToStaticMarkup(createElement(Input, { id: 'outside', placeholder: 'Outside Settings' }));
    const outsideBordered = renderToStaticMarkup(createElement(Input, { id: 'outside-bordered', bordered: true }));
    const outsideBorderless = renderToStaticMarkup(createElement(Input, { id: 'outside-borderless', bordered: false }));
    const disabled = renderToStaticMarkup(createElement(Input, { id: 'disabled', disabled: true }));
    const sidebarSearch = renderToStaticMarkup(createElement(SettingsSidebarLayout, null,
      createElement(Input, { id: 'sidebar-search', placeholder: 'Search providers' }),
      createElement(Input, { id: 'sidebar-borderless', bordered: false, placeholder: 'Explicitly borderless' })));
    const ids = ['empty', 'filled', 'numeric', 'select', 'number', 'inline', 'filter', 'standalone', 'credential', 'sidebar', 'sidebar-search', 'sidebar-borderless'];
    const borderedIds = ['empty', 'numeric', 'filter', 'standalone', 'credential', 'sidebar', 'sidebar-search'];
    writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
      :root { ${generator.generate(getDefaultTheme(false))} }
      html.dark { ${generator.generate(getDefaultTheme(true))} }
      body { padding: 16px; background: var(--surface-background); color: var(--surface-foreground); }
      * { transition: none !important; }
      #expected { background: var(--interactive-hover); }
      #expected-error { box-shadow: inset 0 0 0 1px var(--status-error); }
      #expected-sidebar { border: 1px solid var(--form-surface-border); }
      </style></head><body><main class="yuri-settings-workspace">
      <div class="yuri-settings-group-card">${controls.map((control, index) => `
        <div class="yuri-settings-group-row yuri-settings-split-row">
          <label class="yuri-settings-split-row-copy">Field ${index + 1}</label>
          <div class="yuri-settings-split-row-control">${control}</div>
        </div>`).join('')}
        <div class="yuri-settings-group-row flex items-center gap-2"><div class="relative min-w-0 flex-1">${filter}</div><span>all</span></div>
        <div class="yuri-settings-channel-form"><div class="yuri-settings-group-row"><div class="yuri-settings-split-row-control">${credential}</div></div></div>
      </div><div class="py-2">${standalone}</div><div>${disabled}</div>
      <button id="sidebar" class="yuri-settings-sidebar-picker h-8 w-full">Project</button>
      ${sidebarSearch}
      </main>${outside}${outsideBordered}${outsideBorderless}<div id="expected" hidden></div><div id="expected-error" hidden></div><div id="expected-sidebar" hidden></div></body></html>`);
    const page = await openPageSession(chrome, { width: 1000, height: 900, standalone: false });
    await page.navigateFile(file);
    for (const width of [350, 1000]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 350 });
      for (const dark of [false, true]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 890 });
        const result = await page.evaluate<{ expected: string; sidebarBorder: string; outsideShadow: string; outsideBorders: string[]; options: (string | null)[]; leaked: boolean; controls: { id: string; border: string; width: string; background: string; shadow: string; outline: string }[] }>(`(() => {
          document.documentElement.classList.toggle('dark', ${dark});
          document.querySelector('main').classList.toggle('yuri-settings-workspace-desktop', ${width > 350});
          return {
            expected: getComputedStyle(document.getElementById('expected')).backgroundColor,
            sidebarBorder: getComputedStyle(document.getElementById('expected-sidebar')).borderTopColor,
            outsideShadow: getComputedStyle(document.getElementById('outside')).boxShadow,
            outsideBorders: ['outside-bordered', 'outside-borderless'].map(id => getComputedStyle(document.getElementById(id)).borderTopColor),
            options: ['filter', 'sidebar-borderless', 'sidebar-search'].map(id => document.getElementById(id).getAttribute('data-bordered')),
            leaked: Boolean(document.querySelector('input[bordered]')),
            controls: ${JSON.stringify(ids)}.map(id => {
              const style = getComputedStyle(document.getElementById(id));
              return { id, border: style.borderTopColor, width: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle };
            }),
          };
        })()`);
        expect(result.expected).not.toBe('rgba(0, 0, 0, 0)');
        expect(result.sidebarBorder).not.toBe('rgba(0, 0, 0, 0)');
        expect(result.outsideShadow).not.toBe('none');
        expect(result.outsideBorders).toEqual([result.sidebarBorder, 'rgba(0, 0, 0, 0)']);
        expect(result.options).toEqual(['true', 'false', null]);
        expect(result.leaked).toBe(false);
        for (const control of result.controls) {
          expect(control.border).toBe(borderedIds.includes(control.id) ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
          expect(control.width).toBe('1px');
          expect(control.background).toBe('rgba(0, 0, 0, 0)');
          expect(control.shadow).toBe('none');
          expect(control.outline).toBe('none');
        }
        for (const id of ids) {
          const bounds = await page.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
            const rect = document.getElementById('${id}').getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })()`);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
          const hovered = await page.evaluate<{ border: string; background: string; shadow: string; outline: string; dividers: string[]; width: number; height: number }>(`(() => {
            const control = document.getElementById('${id}');
            const style = getComputedStyle(control);
            const rect = control.getBoundingClientRect();
            return {
              border: style.borderTopColor, background: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle,
              dividers: Array.from(control.querySelectorAll('button')).map((button, index) => getComputedStyle(button)[index === 0 ? 'borderRightColor' : 'borderLeftColor']),
              width: rect.width, height: rect.height,
            };
          })()`);
          expect(hovered.border).toBe(borderedIds.includes(id) ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
          expect(hovered.background).toBe(result.expected);
          expect(hovered.shadow).toBe('none');
          expect(hovered.outline).toBe('none');
          expect(hovered.width).toBe(bounds.width);
          expect(hovered.height).toBe(bounds.height);
          for (const divider of hovered.dividers) expect(divider).toBe('rgba(0, 0, 0, 0)');
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
          await page.evaluate(`(() => {
            const control = document.getElementById('${id}');
            (control.querySelector('button') ?? control).focus();
          })()`);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 890 });
          const pointerFocused = await page.evaluate<{ background: string; border: string; focused: boolean; shadow: string; outline: string }>(`(() => {
            const control = document.getElementById('${id}');
            const style = getComputedStyle(control);
            return { background: style.backgroundColor, border: style.borderTopColor, focused: control.matches(':focus-within'), shadow: style.boxShadow, outline: style.outlineStyle };
          })()`);
          expect(pointerFocused.focused).toBe(true);
          expect(pointerFocused.background).toBe(result.expected);
          expect(pointerFocused.border).toBe(borderedIds.includes(id) ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
          expect(pointerFocused.shadow).toBe('none');
          expect(pointerFocused.outline).toBe('none');
          await page.evaluate('document.activeElement.blur()');
          expect(await page.evaluate<string>(`getComputedStyle(document.getElementById('${id}')).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          const keyboardFocused = await page.evaluate<{ background: string; border: string; visible: boolean; shadow: string; outline: string; targetShadow: string; targetOutline: string }>(`(() => {
            const control = document.getElementById('${id}');
            const target = control.querySelector('input') ?? control.querySelector('button') ?? control;
            target.focus();
            const style = getComputedStyle(control);
            const targetStyle = getComputedStyle(target);
            return { background: style.backgroundColor, border: style.borderTopColor, visible: target.matches(':focus-visible'), shadow: style.boxShadow, outline: style.outlineStyle, targetShadow: targetStyle.boxShadow, targetOutline: targetStyle.outlineStyle };
          })()`);
          expect(keyboardFocused.visible).toBe(true);
          expect(keyboardFocused.background).toBe(result.expected);
          expect(keyboardFocused.border).toBe(borderedIds.includes(id) ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
          expect(keyboardFocused.shadow).toBe('none');
          expect(keyboardFocused.outline).toBe('none');
          expect(keyboardFocused.targetShadow).toBe('none');
          expect(keyboardFocused.targetOutline).toBe('none');
          await page.evaluate('document.activeElement.blur()');
          if (['select', 'inline', 'sidebar'].includes(id)) {
            const open = await page.evaluate<{ background: string; border: string; shadow: string; outline: string }>(`(() => {
              const control = document.getElementById('${id}');
              const attribute = '${id}' === 'sidebar' ? 'data-state' : 'data-popup-open';
              control.setAttribute(attribute, 'open');
              const style = getComputedStyle(control);
              const result = { background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow, outline: style.outlineStyle };
              control.removeAttribute(attribute);
              return result;
            })()`);
            expect(open).toEqual({ background: result.expected, border: id === 'sidebar' ? result.sidebarBorder : 'rgba(0, 0, 0, 0)', shadow: 'none', outline: 'none' });
          }
        }
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 890 });
        const focused = await page.evaluate<{ before: number[]; after: number[]; shadow: string; background: string }>(`(() => {
          const input = document.getElementById('empty');
          const bounds = () => { const rect = input.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; };
          const before = bounds();
          input.focus();
          const style = getComputedStyle(input);
          const result = { before, after: bounds(), shadow: style.boxShadow, background: style.backgroundColor };
          input.blur();
          return result;
        })()`);
        expect(focused.after).toEqual(focused.before);
        expect(focused.shadow).toBe('none');
        expect(focused.background).toBe(result.expected);
        for (const id of ['empty', 'numeric', 'credential', 'filter', 'sidebar-search', 'sidebar-borderless']) {
          const before = await page.evaluate<{ valueAttribute: string | null; placeholder: string; width: number; height: number }>(`(() => {
            const input = document.getElementById('${id}');
            input.focus();
            const rect = input.getBoundingClientRect();
            return { valueAttribute: input.getAttribute('value'), placeholder: input.placeholder, width: rect.width, height: rect.height };
          })()`);
          expect(before.placeholder).not.toBe('');
          if (['empty', 'numeric', 'credential'].includes(id)) expect(before.placeholder).toBe(' ');
          if (id === 'filter') expect(before.placeholder).toBe('Filter models...');
          const readValueStyle = () => page.evaluate<{ value: string; valueAttribute: string | null; empty: boolean; border: string; background: string; shadow: string; outline: string; width: number; height: number }>(`(() => {
            const input = document.getElementById('${id}');
            const style = getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return { value: input.value, valueAttribute: input.getAttribute('value'), empty: input.matches(':placeholder-shown'),
              border: style.borderTopColor, background: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle,
              width: rect.width, height: rect.height };
          })()`);
          await page.send('Input.insertText', { text: '0' });
          const typed = await readValueStyle();
          expect(typed.value).toBe('0');
          expect(typed.empty).toBe(false);
          expect(typed.border).toBe(['filter', 'sidebar-search'].includes(id) ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
          expect(typed.valueAttribute).toBe(before.valueAttribute);
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          const cleared = await readValueStyle();
          expect(cleared.value).toBe('');
          expect(cleared.empty).toBe(true);
          expect(cleared.border).toBe(id === 'sidebar-borderless' ? 'rgba(0, 0, 0, 0)' : result.sidebarBorder);
          expect(cleared.background).toBe(result.expected);
          expect(cleared.shadow).toBe('none');
          expect(cleared.outline).toBe('none');
          expect([cleared.width, cleared.height]).toEqual([before.width, before.height]);
          for (const value of ['42', '']) {
            await page.evaluate(`document.getElementById('${id}').value = '${value}'`);
            const assigned = await readValueStyle();
            const hasBorder = value === '' ? id !== 'sidebar-borderless' : ['filter', 'sidebar-search'].includes(id);
            expect(assigned.border).toBe(hasBorder ? result.sidebarBorder : 'rgba(0, 0, 0, 0)');
            expect(assigned.valueAttribute).toBe(before.valueAttribute);
          }
          await page.evaluate('document.activeElement.blur()');
        }
        const invalid = await page.evaluate<{ expected: string; rest: string; focused: string }>(`(() => {
          const input = document.getElementById('filled');
          input.setAttribute('aria-invalid', 'true');
          const rest = getComputedStyle(input).boxShadow;
          input.focus();
          const focused = getComputedStyle(input).boxShadow;
          input.blur();
          input.removeAttribute('aria-invalid');
          return { expected: getComputedStyle(document.getElementById('expected-error')).boxShadow, rest, focused };
        })()`);
        expect(invalid.rest).toBe(invalid.expected);
        expect(invalid.focused).toBe(invalid.expected);
        const disabledStyle = await page.evaluate<{ background: string; shadow: string; focused: boolean }>(`(() => {
          const input = document.getElementById('disabled');
          input.focus();
          const style = getComputedStyle(input);
          return { background: style.backgroundColor, shadow: style.boxShadow, focused: document.activeElement === input };
        })()`);
        expect(disabledStyle).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none', focused: false });
        if (keepEvidence()) {
          await page.screenshotPng(join(root, `settings-${width}-${dark ? 'dark' : 'light'}.png`));
          await page.evaluate('document.getElementById("filter").focus()');
          await page.screenshotPng(join(root, `settings-filter-focused-${width}-${dark ? 'dark' : 'light'}.png`));
          await page.evaluate('document.activeElement.blur()');
        }
      }
    }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test.skip('Settings plain, select, URL and inset-action fields have equal edges without text overlap', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const generator = new CSSVariableGenerator();
  const root = evidenceRoot();
  const chrome = await openChromeSession();
  try {
    const field = (id: string, disabled = false) => createElement(Input, { id, type: 'password', disabled,
      defaultValue: 'fixture-long-key-with-enough-text-to-fill-the-field',
      endAdornment: createElement(Button, { id: `${id}-toggle`, type: 'button', variant: 'ghost', size: 'icon', disabled, 'aria-label': 'Show key' }, '◉') });
    const markup = renderToStaticMarkup(createElement(SettingsGroup, { cardClassName: 'yuri-settings-equal-controls', children: [
      createElement(SettingsRow, { key: 'name', label: 'Name', children: createElement(Input, { id: 'name' }) }),
      createElement(SettingsRow, { key: 'protocol', label: 'Protocol', children: createElement(Select, { defaultValue: 'test', children:
        createElement(SelectTrigger, { id: 'protocol', children: createElement(SelectValue, { children: 'OpenAI Chat Completions' }) }) }) }),
      createElement(SettingsRow, { key: 'url', label: 'Base URL', children: createElement(Input, { id: 'url', placeholder: 'https://api.example.com' }),
        footer: createElement('p', { className: 'mt-1 break-all text-right typography-meta text-muted-foreground' }, 'Request URL: https://api.example.com/gateway/long-provider-route/v1/chat/completions') }),
      createElement(SettingsRow, { key: 'key', label: 'API key', children: field('key') }),
      createElement(SettingsRow, { key: 'disabled', label: 'Disabled key', children: field('disabled-key', true) }),
    ] }));
    const file = join(root, 'settings-inset-controls.html');
    writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
      :root { ${generator.generate(getDefaultTheme(false))} }
      html.dark { ${generator.generate(getDefaultTheme(true))} }
      body { padding: 16px; background: var(--surface-background); color: var(--surface-foreground); }
      * { transition: none !important; }
      #expected { background: var(--interactive-hover); }
      </style></head><body><main class="yuri-settings-workspace">${markup}</main><div id="expected" hidden></div></body></html>`);
    const page = await openPageSession(chrome, { width: 1000, height: 900, standalone: false });
    await page.navigateFile(file);
    for (const width of [350, 640, 1000]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 350 });
      for (const dark of [false, true]) {
        for (const scale of [0.85, 1.2]) {
          await page.evaluate(`(() => {
            document.documentElement.classList.toggle('dark', ${dark});
            document.documentElement.classList.toggle('mobile-pointer', ${width === 350});
            document.documentElement.style.setProperty('--user-padding-scale', '${scale}');
            document.querySelector('main').classList.toggle('yuri-settings-workspace-desktop', ${width !== 350});
          })()`);
          for (const previewVisible of [false, true]) {
            const geometry = await page.evaluate<{ edges: number[][]; input: number[]; button: number[]; textEnd: number; overflow: boolean; preview: number[]; rowContent: number[] }>(`(() => {
              const footer = document.querySelector('[data-slot="settings-row-footer"]');
              footer.hidden = ${!previewVisible};
              const rect = element => { const r = element.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
              const input = document.getElementById('key');
              const style = getComputedStyle(input);
              const row = footer.parentElement;
              const rowStyle = getComputedStyle(row);
              return { edges: ['name', 'protocol', 'url', 'key'].map(id => rect(document.getElementById(id))),
                input: rect(input), button: rect(document.getElementById('key-toggle')),
                textEnd: input.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
                preview: rect(footer), rowContent: [row.getBoundingClientRect().left + parseFloat(rowStyle.paddingLeft), row.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight)],
                overflow: document.documentElement.scrollWidth > innerWidth };
            })()`);
            for (const edge of geometry.edges) {
              expect(edge[0]).toBeCloseTo(geometry.input[0], 1);
              expect(edge[2]).toBeCloseTo(geometry.input[2], 1);
              expect(edge[3] - edge[1]).toBe(36);
            }
            expect(geometry.button[0]).toBeGreaterThanOrEqual(geometry.input[0]);
            expect(geometry.button[1]).toBeGreaterThanOrEqual(geometry.input[1]);
            expect(geometry.button[2]).toBeLessThanOrEqual(geometry.input[2]);
            expect(geometry.button[3]).toBeLessThanOrEqual(geometry.input[3]);
            expect(geometry.textEnd).toBeLessThan(geometry.button[0]);
            expect(geometry.overflow).toBe(false);
            if (previewVisible) {
              expect(geometry.preview[0]).toBeCloseTo(geometry.rowContent[0], 1);
              expect(geometry.preview[2]).toBeCloseTo(geometry.rowContent[1], 1);
              expect(geometry.preview[0]).toBeLessThan(geometry.edges[2][0]);
              expect(geometry.preview[1]).toBeGreaterThanOrEqual(geometry.edges[2][3]);
            }
          }
          const button = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.getElementById('key-toggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...button });
          expect(await page.evaluate<string>(`getComputedStyle(document.getElementById('key')).backgroundColor`))
            .toBe(await page.evaluate<string>(`getComputedStyle(document.getElementById('expected')).backgroundColor`));
          await page.evaluate(`document.getElementById('key').focus()`);
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 890 });
          const focus = await page.evaluate<{ id: string; background: string; expected: string; shadow: string; outline: string }>(`(() => {
            const style = getComputedStyle(document.getElementById('key-toggle'));
            return { id: document.activeElement.id, background: getComputedStyle(document.getElementById('key')).backgroundColor,
              expected: getComputedStyle(document.getElementById('expected')).backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle };
          })()`);
          expect(focus.id).toBe('key-toggle');
          expect(focus.background).toBe(focus.expected);
          expect(focus.shadow).toBe('none');
          expect(focus.outline).toBe('none');
          await page.evaluate('document.activeElement.blur()');
          const disabled = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.getElementById('disabled-key-toggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...disabled });
          expect(await page.evaluate<string>(`getComputedStyle(document.getElementById('disabled-key')).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
          if (keepEvidence() && scale === 1.2) await page.screenshotPng(join(root, `inset-controls-${width}-${dark ? 'dark' : 'light'}.png`));
        }
      }
    }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test.skip('Settings Textarea shares hover/focus backgrounds without outlines or outer padding', async () => {
  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const generator = new CSSVariableGenerator();
  const root = evidenceRoot();
  const chrome = await openChromeSession();
  try {
    const file = join(root, 'settings-textareas.html');
    const editors = [
      { id: 'embedded', embedded: true },
      { id: 'normal' },
      { id: 'simple', simple: true },
      { id: 'disabled', embedded: true, disabled: true },
      { id: 'error', embedded: true, hasError: true },
      { id: 'invalid', embedded: true, 'aria-invalid': true as const },
    ];
    const markup = editors.map(({ id, ...props }) => `<section id="${id}" class="yuri-settings-group-card"><div class="yuri-settings-group-row">${renderToStaticMarkup(createElement(Textarea, {
      ...props, rows: 2, defaultValue: 'First line\nSecond line', 'aria-label': id,
    }))}</div></section>`).join('');
    const outside = renderToStaticMarkup(createElement(Textarea, { rows: 2, defaultValue: 'Outside Settings' }));
    writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
      :root { ${generator.generate(getDefaultTheme(false))} }
      html.dark { ${generator.generate(getDefaultTheme(true))} }
      body { padding: 16px; background: var(--surface-background); color: var(--surface-foreground); }
      * { transition: none !important; }
      #hover-token { background: var(--interactive-hover); border-radius: var(--form-control-radius); }
      #error-token { box-shadow: inset 0 0 0 1px var(--status-error); }
      </style></head><body><main class="yuri-settings-workspace">${markup}</main>
      <section id="outside">${outside}</section>
      <div id="hover-token" hidden></div><div id="error-token" hidden></div>
      <section id="direct" class="yuri-settings-workspace" hidden><div class="yuri-settings-group-card p-3">${outside}</div></section>
      <section id="labeled" class="yuri-settings-workspace" hidden><div class="yuri-settings-group-row yuri-settings-split-row"><div class="yuri-settings-split-row-copy">Label</div><div class="yuri-settings-split-row-control">${outside}</div></div></section>
      <script>window.readEditor = id => {
        const section = document.getElementById(id);
        const surface = section.querySelector('[data-slot="textarea"]');
        const input = section.querySelector('textarea');
        const style = getComputedStyle(surface);
        const inputStyle = getComputedStyle(input);
        const rect = surface.getBoundingClientRect();
        return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius,
          outline: inputStyle.outlineStyle, innerShadow: inputStyle.boxShadow, align: inputStyle.textAlign,
          value: input.value, height: rect.height, width: rect.width, x: rect.x, y: rect.y,
          resizeHandle: Boolean(section.querySelector('[role="separator"]')),
          outerPadding: getComputedStyle(surface.closest('.yuri-settings-group-row') ?? surface.parentElement).padding };
      };</script></body></html>`);
    const page = await openPageSession(chrome, { width: 1000, height: 1100, standalone: false });
    await page.navigateFile(file);
    type EditorStyle = { background: string; shadow: string; radius: string; outline: string; innerShadow: string; align: string; value: string; height: number; width: number; x: number; y: number; resizeHandle: boolean; outerPadding: string };
    for (const width of [350, 1000]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 350 });
      for (const dark of [false, true]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 1090 });
        const expected = await page.evaluate<{ background: string; error: string; radius: string }>(`(() => {
          document.documentElement.classList.toggle('dark', ${dark});
          document.documentElement.classList.toggle('mobile-pointer', ${width === 350});
          return { background: getComputedStyle(document.getElementById('hover-token')).backgroundColor,
            radius: getComputedStyle(document.getElementById('hover-token')).borderRadius,
            error: getComputedStyle(document.getElementById('error-token')).boxShadow };
        })()`);
        const outsideBefore = await page.evaluate<EditorStyle>('window.readEditor("outside")');
        for (const { id, simple, disabled, hasError, ...props } of editors) {
          const invalid = hasError || props['aria-invalid'];
          const rest = await page.evaluate<EditorStyle>(`window.readEditor('${id}')`);
          expect(rest.background).toBe('rgba(0, 0, 0, 0)');
          expect(rest.shadow).toBe(invalid ? expected.error : 'none');
          expect(rest.outline).toBe('none');
          expect(rest.radius).toBe(expected.radius);
          expect(rest.outerPadding).toBe('0px');
          expect(rest.height).toBeGreaterThan(36);
          expect(rest.align).not.toBe('right');
          expect(rest.value).toBe('First line\nSecond line');
          expect(rest.resizeHandle).toBe(!simple);
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rest.x + rest.width / 2, y: rest.y + rest.height / 2 });
          const hover = await page.evaluate<EditorStyle>(`window.readEditor('${id}')`);
          expect(hover.background).toBe(disabled ? rest.background : expected.background);
          expect(hover.shadow).toBe(rest.shadow);
          if (!disabled) {
            await page.evaluate(`document.querySelector('#${id} textarea').focus()`);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 1090 });
            const focused = await page.evaluate<EditorStyle>(`window.readEditor('${id}')`);
            expect(focused.shadow).toBe(rest.shadow);
            expect(focused.background).toBe(expected.background);
            expect(focused.outline).toBe('none');
            if (!simple) expect(focused.innerShadow).toBe('none');
            expect([focused.width, focused.height]).toEqual([rest.width, rest.height]);
            await page.evaluate(`document.querySelector('#${id} textarea').blur()`);
          }
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 1090 });
        }
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('#direct .yuri-settings-group-card')).padding`)).toBe('0px');
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('#labeled .yuri-settings-group-row')).padding`)).not.toBe('0px');
        expect(await page.evaluate<EditorStyle>('window.readEditor("outside")')).toEqual(outsideBefore);
        if (keepEvidence()) await page.screenshotPng(join(root, `textareas-${width}-${dark ? 'dark' : 'light'}.png`));
      }
    }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
