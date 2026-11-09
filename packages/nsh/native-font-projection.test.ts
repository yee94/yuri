import { expect, test } from 'vitest';
import { appearanceFromSettings, type AppliedNativeAppearance } from './appearance-core';
import { adoptNativeFontEvent, nativeFontEvent, type NativeFontEvent } from './native-font-projection';

const event: NativeFontEvent = { hostID: 'one', fontRevision: 7, fontTicket: 11, fontStatus: 'ready',
  uiFontFamily: 'Inter', monoFontFamily: 'Fira Code Light', assistantFontFamilies: { light: 'Inter', dark: 'Inter' }, unsupportedFonts: [] };
async function snapshot(): Promise<AppliedNativeAppearance> {
  return { ...await appearanceFromSettings({ uiFont: 'inter', monoFont: 'fira-code' }, async () => ({ themes: [] })),
    uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [],
    fontRevision: 7, fontTicket: 11, fontStatus: 'loading', sourceHost: { hostID: 'one', url: 'https://one.example', generation: 5 } };
}
test('font completion adopts only fonts, preserves palette/source references and does no work for duplicate events', async () => {
  const value = await snapshot();
  const next = adoptNativeFontEvent(value, event, 'one', 5)!;
  expect(next.uiFontFamily).toBe('Inter'); expect(next.monoFontFamily).toBe('Fira Code Light');
  for (const key of Object.keys(value) as Array<keyof AppliedNativeAppearance>) {
    if (['uiFontFamily', 'monoFontFamily', 'assistantFontFamilies', 'unsupportedFonts', 'fontStatus'].includes(key)) continue;
    expect(next[key], key).toBe(value[key]);
  }
  for (let count = 0; count < 200; count++) expect(adoptNativeFontEvent(next, event, 'one', 5)).toBe(next);
});
test('late completion cannot cross Host, lease generation, native reset revision or selection ticket', async () => {
  const value = await snapshot();
  for (const stale of [{ ...event, hostID: 'old' }, { ...event, fontRevision: 6 }, { ...event, fontTicket: 10 }]) {
    expect(adoptNativeFontEvent(value, stale, 'one', 5)).toBe(value);
  }
  expect(adoptNativeFontEvent(value, event, 'two', 5)).toBe(value);
  expect(adoptNativeFontEvent(value, event, 'one', 6)).toBe(value);
  expect(adoptNativeFontEvent(null, event, 'one', 5)).toBeNull();
});
test('wire parser rejects malformed names/status/revisions and cannot transport palette or raw errors', () => {
  expect(nativeFontEvent({ ...event, cssVars: { light: { background: 'poison' } }, error: 'secret-url-sentinel' })).toEqual(event);
  for (const patch of [{ fontRevision: true }, { fontTicket: 0 }, { fontStatus: 'unknown' }, { uiFontFamily: 'url(https://secret.example)' },
    { unsupportedFonts: ['raw\nname'] }, { assistantFontFamilies: {} }, { hostID: '' }]) expect(nativeFontEvent({ ...event, ...patch })).toBeNull();
});
