import { afterEach, expect, test, vi } from 'vitest';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { renderPreviewScreenshot, type PreviewElementMetadata } from './screenshot-capture';

const state = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: state.capture }));
const target: PreviewElementMetadata = { frame: 'top', tag: 'div', text: '', selector: 'div', path: 'div',
  bounds: { x: 0, y: 0, width: 10, height: 10 }, center: { x: 5, y: 5 }, attributes: {}, computedStyle: {}, ancestry: [] };
afterEach(() => { vi.restoreAllMocks(); state.capture.mockReset(); });

function boundary() {
  let current = true;
  const fetch = vi.fn();
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => current,
    sdk: () => opencodeClient.getSdkClient(), fetch, service: () => { throw new Error('Unexpected service'); } });
  return { fetch, entry: registry.resolve({ hubId: 'hub', hostId: 'host', directory: '/raw' }), retire: () => { current = false; } };
}

test('a retired project cannot start an annotation capture', async () => {
  const scope = boundary(); scope.retire();
  await expect(renderPreviewScreenshot(document.createElement('iframe'), target, scope.entry)).rejects.toThrow();
  expect(state.capture).not.toHaveBeenCalled(); expect(scope.fetch).not.toHaveBeenCalled();
});

test('a native screenshot completed after a Host departure is discarded without Hub resource fallback', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let resolve!: (value: unknown) => void;
  state.capture.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const scope = boundary();
  const capture = renderPreviewScreenshot(document.createElement('iframe'), target, scope.entry);
  scope.retire();
  resolve({ mime: 'image/png', base64: 'unused', width: 10, height: 10 });
  expect(await capture).toBeNull();
  expect(scope.fetch).not.toHaveBeenCalled();
});
