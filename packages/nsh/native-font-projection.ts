import type { AppliedNativeAppearance } from './appearance-core';

export type NativeFontState = {
  fontRevision?: number;
  fontTicket?: number;
  fontStatus?: 'ready' | 'loading' | 'failed' | 'unsupported';
};
export type NativeFontEvent = Required<NativeFontState> & {
  hostID: string;
  uiFontFamily: string;
  monoFontFamily: string;
  assistantFontFamilies: { light: string; dark: string };
  unsupportedFonts: string[];
};

/** Data-only font projection. Neither events nor retries can carry a palette. */
export function nativeFontEvent(payload: unknown): NativeFontEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const family = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9 -]{1,96}(?:, (?:system-ui|monospace))?$/.test(value);
  const assistants = value.assistantFontFamilies as Record<string, unknown> | undefined;
  if (typeof value.hostID !== 'string' || value.hostID.length > 512 || !value.hostID
    || !Number.isSafeInteger(value.fontRevision) || (value.fontRevision as number) < 0
    || !Number.isSafeInteger(value.fontTicket) || (value.fontTicket as number) < 1
    || !['ready', 'loading', 'failed', 'unsupported'].includes(String(value.fontStatus))
    || !family(value.uiFontFamily) || !family(value.monoFontFamily)
    || !assistants || !family(assistants.light) || !family(assistants.dark)
    || !Array.isArray(value.unsupportedFonts) || value.unsupportedFonts.length > 4 || !value.unsupportedFonts.every(family)) return null;
  return {
    hostID: value.hostID, fontRevision: value.fontRevision as number, fontTicket: value.fontTicket as number,
    fontStatus: value.fontStatus as NativeFontEvent['fontStatus'], uiFontFamily: value.uiFontFamily, monoFontFamily: value.monoFontFamily,
    assistantFontFamilies: { light: assistants.light, dark: assistants.dark }, unsupportedFonts: [...value.unsupportedFonts],
  };
}

export function adoptNativeFontEvent(current: AppliedNativeAppearance | null, event: NativeFontEvent, hostID: string | undefined, generation: number): AppliedNativeAppearance | null {
  if (!current || event.hostID !== hostID || current.sourceHost?.hostID !== hostID || current.sourceHost.generation !== generation
    || current.fontRevision !== event.fontRevision || current.fontTicket !== event.fontTicket) return current;
  if (current.fontStatus === event.fontStatus && current.uiFontFamily === event.uiFontFamily && current.monoFontFamily === event.monoFontFamily
    && current.assistantFontFamilies.light === event.assistantFontFamilies.light && current.assistantFontFamilies.dark === event.assistantFontFamilies.dark
    && current.unsupportedFonts.join('\0') === event.unsupportedFonts.join('\0')) return current;
  return { ...current, uiFontFamily: event.uiFontFamily, monoFontFamily: event.monoFontFamily,
    assistantFontFamilies: event.assistantFontFamilies, unsupportedFonts: event.unsupportedFonts, fontStatus: event.fontStatus };
}
