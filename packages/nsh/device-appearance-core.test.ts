import { expect, it, vi } from 'vitest';
import { createDeviceAppearance, deviceAppearanceKey } from './device-appearance-core';
import { appearanceFromSettings, nativeFullThemeCSS, nativeTypographyStyle } from './appearance-core';

it('device code scale stays unknown until read, defaults only on missing data, and writes serially after reading', async () => {
  let raw: string | null = null;
  const changes: number[] = [], calls: string[] = [];
  const store = createDeviceAppearance({ get: async key => { expect(key).toBe(deviceAppearanceKey); calls.push('get'); return raw; },
    set: async (_key, next) => { calls.push('set'); raw = next; }, changed: value => changes.push(value.codeFontSize) });
  expect(store.snapshot()).toBeNull();
  expect(await store.load()).toEqual({ codeFontSize: 100, editorFontSize: 13, fileEditorKeymap: 'default' });
  await Promise.all([store.saveCodeFontSize(150), store.saveCodeFontSize(200)]);
  expect(JSON.parse(raw!)).toEqual({ codeFontSize: 200, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(changes).toEqual([100, 150, 200]);
  expect(calls).toEqual(['get', 'get', 'set', 'get', 'set']);
});

it('old code-only records default editor size only after successful read and both local keys survive interleaved saves and reload', async () => {
  let raw = '{"codeFontSize":125}', release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const create = () => createDeviceAppearance({ get: async () => raw, set: async (_key, next) => { if (++writes === 1) await blocked; raw = next; }, changed: () => {} });
  const store = create();
  expect(store.snapshot()).toBeNull();
  expect(await store.load()).toEqual({ codeFontSize: 125, editorFontSize: 13, fileEditorKeymap: 'default' });
  const editor = store.saveEditorFontSize(17.6), code = store.saveCodeFontSize(175);
  release(); await Promise.all([editor, code]);
  expect(JSON.parse(raw)).toEqual({ codeFontSize: 175, editorFontSize: 18, fileEditorKeymap: 'default' });
  await Promise.all([store.saveCodeFontSize(150), store.saveEditorFontSize(24)]);
  expect(await create().load()).toEqual({ codeFontSize: 150, editorFontSize: 24, fileEditorKeymap: 'default' });
});

it.each([[8, 9], [9.4, 9], [13.5, 14], [31.8, 32], [40, 32]])('editor size rounds and clamps %s to %s without changing code size', async (size, expected) => {
  let raw = '{"codeFontSize":155,"editorFontSize":20}';
  const store = createDeviceAppearance({ get: async () => raw, set: async (_key, next) => { raw = next; }, changed: () => {} });
  expect(await store.saveEditorFontSize(size)).toEqual({ codeFontSize: 155, editorFontSize: expected, fileEditorKeymap: 'default' });
  expect(JSON.parse(raw)).toEqual(store.snapshot());
});

it('editor read/corruption/write failures preserve both prior fields and failed queued writes do not poison the next save', async () => {
  let raw = '{"codeFontSize":125,"editorFontSize":19}', failRead = false, failWrite = true;
  const set = vi.fn(async (_key, next) => { if (failWrite) throw new Error('disk'); raw = next; });
  const store = createDeviceAppearance({ get: async () => { if (failRead) throw new Error('read'); return raw; }, set, changed: () => {} });
  const prior = await store.load();
  failRead = true; await expect(store.saveEditorFontSize(21)).rejects.toThrow('read');
  failRead = false;
  for (raw of ['broken', '{"codeFontSize":125,"editorFontSize":null}', '{"codeFontSize":125,"editorFontSize":"18"}', '{"codeFontSize":125,"editorFontSize":8}', '{"codeFontSize":125,"editorFontSize":33}', '{"codeFontSize":125,"editorFontSize":13.5}']) {
    await expect(store.saveEditorFontSize(21)).rejects.toThrow();
    await expect(store.saveCodeFontSize(150)).rejects.toThrow();
    expect(store.snapshot()).toBe(prior);
  }
  expect(set).not.toHaveBeenCalled();
  raw = '{"codeFontSize":125,"editorFontSize":19}';
  await expect(store.saveEditorFontSize(21)).rejects.toThrow('disk'); expect(store.snapshot()).toBe(prior);
  failWrite = false; await store.saveCodeFontSize(175); await store.saveEditorFontSize(23);
  expect(JSON.parse(raw)).toEqual({ codeFontSize: 175, editorFontSize: 23, fileEditorKeymap: 'default' });
  for (const invalid of [NaN, Infinity, -Infinity]) await expect(store.saveEditorFontSize(invalid)).rejects.toThrow('invalid');
});

it('keymap defaults only after successful legacy read and three interleaved local saves preserve every field on reopen', async () => {
  let raw = '{"codeFontSize":125,"editorFontSize":24}';
  const create = () => createDeviceAppearance({ get: async () => raw, set: async (_key, next) => { raw = next; }, changed: () => {} });
  const store = create(); expect(store.snapshot()).toBeNull();
  expect(await store.load()).toEqual({ codeFontSize: 125, editorFontSize: 24, fileEditorKeymap: 'default' });
  await Promise.all([store.saveFileEditorKeymap('vim'), store.saveCodeFontSize(175), store.saveEditorFontSize(19)]);
  expect(await create().load()).toEqual({ codeFontSize: 175, editorFontSize: 19, fileEditorKeymap: 'vim' });
  await Promise.all([store.saveEditorFontSize(22), store.saveFileEditorKeymap('default'), store.saveCodeFontSize(150)]);
  expect(JSON.parse(raw)).toEqual({ codeFontSize: 150, editorFontSize: 22, fileEditorKeymap: 'default' });
});

it('invalid keymap, corrupted record and read/write failure preserve all prior keys without a default or failed-write publication', async () => {
  let raw = '{"codeFontSize":175,"editorFontSize":24,"fileEditorKeymap":"vim"}', failRead = false, failWrite = false;
  const set = vi.fn(async (_key, next) => { if (failWrite) throw new Error('write'); raw = next; });
  const changed = vi.fn();
  const store = createDeviceAppearance({ get: async () => { if (failRead) throw new Error('read'); return raw; }, set, changed });
  const prior = await store.load(); failRead = true;
  await expect(store.load()).rejects.toThrow('read'); await expect(store.saveFileEditorKeymap('default')).rejects.toThrow('read');
  failRead = false;
  for (const keymap of ['emacs', '', null, false, 0, { value: 'vim' }]) {
    raw = JSON.stringify({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: keymap });
    await expect(store.load()).rejects.toThrow('invalid');
    await expect(store.saveCodeFontSize(150)).rejects.toThrow('invalid');
    await expect(store.saveEditorFontSize(20)).rejects.toThrow('invalid');
    await expect(store.saveFileEditorKeymap('default')).rejects.toThrow('invalid');
    expect(store.snapshot()).toBe(prior);
  }
  expect(set).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledOnce();
  raw = JSON.stringify(prior); failWrite = true;
  await expect(store.saveFileEditorKeymap('default')).rejects.toThrow('write'); expect(store.snapshot()).toBe(prior);
  expect(changed).toHaveBeenCalledOnce(); failWrite = false;
  await store.saveFileEditorKeymap('default'); expect(JSON.parse(raw)).toEqual({ ...prior, fileEditorKeymap: 'default' });
});

it('read/malformed/write failures preserve prior and never overwrite unread stored preferences', async () => {
  let raw = '{"codeFontSize":125}', readFailure = false;
  const set = vi.fn(async (_key: string, _value: string) => { throw new Error('disk'); });
  const changed = vi.fn();
  const store = createDeviceAppearance({ get: async () => { if (readFailure) throw new Error('offline'); return raw; }, set, changed });
  const prior = await store.load();
  readFailure = true;
  await expect(store.saveCodeFontSize(150)).rejects.toThrow('offline');
  await expect(store.load()).rejects.toThrow('offline');
  expect(set).not.toHaveBeenCalled();
  readFailure = false; raw = 'broken';
  await expect(store.saveCodeFontSize(150)).rejects.toThrow();
  expect(set).not.toHaveBeenCalled();
  raw = '{"codeFontSize":125}';
  await expect(store.saveCodeFontSize(150)).rejects.toThrow('disk');
  expect(store.snapshot()).toBe(prior); expect(changed).toHaveBeenCalledOnce();
  for (const size of [49, 201, NaN, Infinity]) await expect(store.saveCodeFontSize(size)).rejects.toThrow('invalid');
});

it('code scale is independent of Host/UI scale; canonical Host ignores a fabricated device field', async () => {
  const host = await appearanceFromSettings({ fontSize: 200, codeFontSize: 50, terminalFontSize: 24 }, async () => ({}));
  expect(host.codeFontSize).toBeUndefined(); expect(host.terminalFontSize).toBe(24);
  const applied = { ...host, codeFontSize: 150, uiFontFamily: 'system-ui', monoFontFamily: 'Mono', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] };
  expect(nativeTypographyStyle(applied, 'code')).toEqual({ fontSize: 19.5, fontFamily: 'Mono' });
  expect(nativeTypographyStyle(applied, 'markdown').fontSize).toBe(30);
  expect(nativeFullThemeCSS(applied, 'light', () => '')).toContain('19.5 * var(--dpt, 1px)');
  expect((await appearanceFromSettings({}, async () => ({}))).terminalFontSize).toBe(13);
  for (const size of [null, '13', 8, 53, NaN, Infinity]) await expect(appearanceFromSettings({ terminalFontSize: size }, async () => ({}))).rejects.toThrow('terminal');
});
