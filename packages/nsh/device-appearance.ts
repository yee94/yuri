import { signal, Storage } from 'nsh';
import { createDeviceAppearance, type DeviceAppearance } from './device-appearance-core';

export const deviceAppearance = signal<DeviceAppearance | null>(null);
export const deviceAppearanceError = signal('');
const deviceAppearanceStore = createDeviceAppearance({
  get: key => Storage.getItem(key), set: (key, value) => Storage.setItem(key, value),
  changed: value => { deviceAppearance.set(value); deviceAppearanceError.set(''); },
});

export async function loadDeviceAppearance() {
  try { return await deviceAppearanceStore.load(); }
  catch (error) { deviceAppearanceError.set('device-appearance-read-failed'); throw error; }
}

export async function saveDeviceCodeFontSize(size: number) {
  try { return await deviceAppearanceStore.saveCodeFontSize(size); }
  catch (error) { deviceAppearanceError.set('device-appearance-write-failed'); throw error; }
}

export async function saveDeviceEditorFontSize(size: number) {
  try { return await deviceAppearanceStore.saveEditorFontSize(size); }
  catch (error) { deviceAppearanceError.set('device-appearance-write-failed'); throw error; }
}

export async function saveDeviceFileEditorKeymap(keymap: DeviceAppearance['fileEditorKeymap']) {
  try { return await deviceAppearanceStore.saveFileEditorKeymap(keymap); }
  catch (error) { deviceAppearanceError.set('device-appearance-write-failed'); throw error; }
}
