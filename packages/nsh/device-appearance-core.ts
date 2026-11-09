export type DeviceAppearance = { codeFontSize: number; editorFontSize: number; fileEditorKeymap: 'default' | 'vim' };
export const deviceAppearanceKey = 'device-appearance-v1';

function deviceCodeFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 50 || value > 200) throw new Error('device-appearance-invalid');
  return value;
}

export function deviceEditorFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('device-appearance-invalid');
  return Math.max(9, Math.min(32, Math.round(value)));
}

export function deviceFileEditorKeymap(value: unknown): DeviceAppearance['fileEditorKeymap'] {
  if (value !== 'default' && value !== 'vim') throw new Error('device-appearance-invalid');
  return value;
}

/** Like Web's persisted UI typography, device-local and shared across Host switches. */
export function createDeviceAppearance(input: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
  changed: (value: DeviceAppearance) => void;
}) {
  let value: DeviceAppearance | null = null, flight: Promise<unknown> = Promise.resolve();
  const decode = (raw: string | null): DeviceAppearance => {
    if (raw === null) return { codeFontSize: 100, editorFontSize: 13, fileEditorKeymap: 'default' };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('device-appearance-invalid');
    const record = parsed as Record<string, unknown>;
    const editorFontSize = record.editorFontSize;
    if (editorFontSize !== undefined && (typeof editorFontSize !== 'number' || !Number.isInteger(editorFontSize) || editorFontSize < 9 || editorFontSize > 32)) throw new Error('device-appearance-invalid');
    return { codeFontSize: deviceCodeFontSize(record.codeFontSize), editorFontSize: editorFontSize ?? 13, fileEditorKeymap: record.fileEditorKeymap === undefined ? 'default' : deviceFileEditorKeymap(record.fileEditorKeymap) };
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = flight.then(work, work); flight = next; return next;
  };
  return {
    snapshot: () => value,
    load: () => serialize(async () => {
      const next = decode(await input.get(deviceAppearanceKey));
      value = next; input.changed(next); return next;
    }),
    saveCodeFontSize: (size: number) => serialize(async () => {
      const codeFontSize = deviceCodeFontSize(size);
      // Read before writing even on a cold save. A failed read cannot erase persisted preferences.
      const previous = decode(await input.get(deviceAppearanceKey));
      const next = { ...previous, codeFontSize };
      await input.set(deviceAppearanceKey, JSON.stringify(next));
      value = next; input.changed(next); return next;
    }),
    saveEditorFontSize: (size: number) => serialize(async () => {
      const editorFontSize = deviceEditorFontSize(size);
      const previous = decode(await input.get(deviceAppearanceKey));
      const next = { ...previous, editorFontSize };
      await input.set(deviceAppearanceKey, JSON.stringify(next));
      value = next; input.changed(next); return next;
    }),
    saveFileEditorKeymap: (keymap: DeviceAppearance['fileEditorKeymap']) => serialize(async () => {
      const fileEditorKeymap = deviceFileEditorKeymap(keymap);
      const previous = decode(await input.get(deviceAppearanceKey));
      const next = { ...previous, fileEditorKeymap };
      await input.set(deviceAppearanceKey, JSON.stringify(next));
      value = next; input.changed(next); return next;
    }),
  };
}
