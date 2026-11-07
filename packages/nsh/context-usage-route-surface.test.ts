import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { appearanceFromSettings } from './appearance-core';
import { getDefaultTheme } from '../ui/src/lib/theme/themes';

const root = path.dirname(fileURLToPath(import.meta.url));

describe('production route assembly and current-Host theme authority (no native engine)', () => {
  it('root parser supplies real custom primary/warning in fixed and system modes without changing neutral action tokens', async () => {
    const custom = structuredClone(getDefaultTheme(true)); custom.metadata = { ...custom.metadata, id: 'context-custom', name: 'Actual custom Host theme' };
    custom.colors.primary.base = '#123456'; custom.colors.status.warning = '#654321';
    for (const useSystemTheme of [false, true]) {
      const appearance = await appearanceFromSettings({ themeId: custom.metadata.id, themeVariant: 'dark', darkThemeId: custom.metadata.id, useSystemTheme }, async () => ({ themes: [custom] }));
      expect(appearance.contextUsageTokens.dark).toMatchObject({ primary: '#123456', warning: '#654321', success: custom.colors.status.success, subtle: custom.colors.surface.subtle });
      expect(appearance.cssVars.dark.primary).toBe(appearance.cssVars.dark.foreground);
      expect(appearance.contextUsageTokens.dark.primary).not.toBe(appearance.cssVars.dark.primary);
      if (!useSystemTheme) expect(appearance.contextUsageTokens.light).toEqual(appearance.contextUsageTokens.dark);
    }
  });
  it.each(['system', 'fr'])('actual route uses native locale/selected language %s, root authority, one owner and a read-only retry', async selected => {
    const source = ts.transpileModule(readFileSync(path.join(root, 'context-usage-route.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    const owner = {}, setActive = vi.fn(), retry = vi.fn(), dispose = vi.fn(), current = () => true;
    const route = { owner, setActive, retry, dispose, current };
    const create = vi.fn(() => route), effects: Array<() => void> = [], cleanups: Array<() => void> = [], request = vi.fn();
    let foreground = true;
    const native = {
      cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => void) => work(),
      lifecycle: () => foreground ? 'active' : 'inactive', locale: () => 'zh-TW', colorScheme: () => 'dark',
      signal: (initial: unknown) => { let value = initial; return Object.assign(() => value, { set: (next: unknown) => { value = next; }, update: (work: (input: unknown) => unknown) => { value = work(value); } }); },
    };
    const captureHostRequest = vi.fn(() => request);
    const lane = { request: captureHostRequest(), current };
    const modules: Record<string, unknown> = { nsh: native, './i18n': { language: () => selected }, './state': { captureHostRequest }, './page-operations': { createPageOperations: () => ({ operation: () => lane }) }, './context-usage': { NativeContextUsagePage: 'production-page' }, './context-usage-route-core': { createContextUsageRoute: create } };
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(source, { exports, require: (id: string) => { if (!(id in modules)) throw new Error('Route imported a root/browser owner: ' + id); return modules[id]; }, jsx: (type: unknown, props: unknown) => ({ type, props }) });
    const appearance = await appearanceFromSettings({ themeVariant: 'dark' }, async () => ({ themes: [] }));
    const props = { chat: {}, target: { kind: 'session', id: 'actual', directory: '/actual' }, scope: { hostID: 'actual', generation: 1, sessionID: 'actual', directory: '/actual' }, current, active: true, appearance };
    props.chat = { messageScope: props.scope };
    const render = exports.ContextUsageRoute as (input: typeof props) => { type: string; props: { projection: { owner: unknown }; locale: string; palette: unknown; timeFormat: string; onRetry: () => void } };
    const output = render(props);
    expect(captureHostRequest).toHaveBeenCalledOnce();
    expect(output.type).toBe('production-page'); expect(output.props.projection.owner).toBe(owner);
    expect(output.props.locale).toBe(selected === 'system' ? 'zh-TW' : 'fr'); expect(output.props.palette).toBe(appearance.contextUsageTokens.dark);
    expect(output.props.timeFormat).toBe('auto'); expect(create).toHaveBeenCalledWith(expect.objectContaining({ chat: props.chat, target: props.target, scope: props.scope, read: request }));
    output.props.onRetry(); expect(retry).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
    props.active = false; effects.forEach(work => work()); expect(setActive).toHaveBeenLastCalledWith(false);
    props.active = true; foreground = false; effects.forEach(work => work()); expect(setActive).toHaveBeenLastCalledWith(false);
    foreground = true; effects.forEach(work => work()); expect(setActive).toHaveBeenLastCalledWith(true);
    cleanups.forEach(work => work()); expect(dispose).toHaveBeenCalledOnce();
  });
});
