import { Storage, signal } from 'nsh';

/**
 * Web's `fontSize` / `codeFontSize` live in the browser's UI store. The phone
 * keeps the same two percentages in the app's own storage.
 */
export const interfaceFontSize = signal(100);
export const codeFontSize = signal(100);

const KEY = 'yuri.settings.typography';
let loaded = false;

const clamp = (value: number) => Math.max(50, Math.min(200, Math.round(value)));

export function loadTypography(): void {
  if (loaded) return;
  loaded = true;
  void Storage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      const row = JSON.parse(raw) as { fontSize?: unknown; codeFontSize?: unknown };
      if (typeof row.fontSize === 'number') interfaceFontSize.set(clamp(row.fontSize));
      if (typeof row.codeFontSize === 'number') codeFontSize.set(clamp(row.codeFontSize));
    })
    .catch(() => {});
}

function persist() {
  void Storage.setItem(
    KEY,
    JSON.stringify({ fontSize: interfaceFontSize(), codeFontSize: codeFontSize() }),
  ).catch(() => {});
}

export function setInterfaceFontSize(value: number): void {
  interfaceFontSize.set(clamp(value));
  persist();
}

export function setCodeFontSize(value: number): void {
  codeFontSize.set(clamp(value));
  persist();
}
