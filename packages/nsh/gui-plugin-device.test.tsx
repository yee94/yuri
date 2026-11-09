import { expect, it, vi } from 'vitest';
import { createGuiPluginDevice } from './gui-plugin-browser/device';
import { guiPluginResourceURL, installGuiPluginResourceURLs, rewriteGuiPluginSrcset } from './gui-plugin-browser/resource-urls';

const scope = { hostID: 'device', lease: 'receipt' };
it('system operations and official export API use the device port with precise results, progress and cancel', async () => {
  const messages: Record<string, unknown>[] = [];
  let resolve!: (value: unknown) => void;
  const pending = new Promise(resolveNow => { resolve = resolveNow; });
  const device = createGuiPluginDevice({ scope, window, isCurrent: () => true,
    prompt: () => '{"ok":true,"value":true}', port: { async postMessage(input) {
      messages.push(input);
      if (input.method === 'capabilities') return { ok: true, value: { version: 1, exportPDF: true, exportLongImage: true, limits: { maxHTMLBytes: 100000, maxWidth: 2048, maxHeight: 32768, maxPixels: 8388608 } } };
      if (input.method === 'exportPDF') return pending;
      return { ok: true, value: true };
    } },
  });
  await device.system.copy('原文'); expect(await device.system.save({ name: 'result.html', content: '<p>原文</p>' })).toBe(true);
  const controller = new AbortController(), progress = vi.fn();
  const exported = device.viewExport.exportPDF({ filename: 'report.pdf', snapshot: { html: '<p>report</p>', width: 300, height: 900 } }, { signal: controller.signal, onProgress: progress });
  await vi.waitFor(() => expect(messages.some(message => message.method === 'exportPDF')).toBe(true));
  const request = messages.find(message => message.method === 'exportPDF')!.input as { taskId: string };
  window.dispatchEvent(new CustomEvent('yuri.gui.device.progress', { detail: { taskId: 'other', stage: 'saving' } }));
  window.dispatchEvent(new CustomEvent('yuri.gui.device.progress', { detail: { taskId: request.taskId, stage: 'rendering', completed: 300, total: 900 } }));
  expect(progress).toHaveBeenCalledOnce(); controller.abort();
  expect(messages.at(-1)).toMatchObject({ method: 'cancel', input: { taskId: request.taskId }, expectedHost: scope });
  resolve({ ok: true, value: { status: 'saved' } });
  expect(await exported).toEqual({ status: 'saved' }); // A committed native save wins over late cancel.
  device.close(); await expect(device.system.copy('late')).rejects.toMatchObject({ code: 'GUI_PLUGIN_ABORTED' });
});
it('native cancellation, save errors, synchronous toast handles and owner cleanup are explicit', async () => {
  const sync: { method: string }[] = [];
  const device = createGuiPluginDevice({ scope, window, isCurrent: () => true,
    prompt: (_, value) => { const input = JSON.parse(value); sync.push(input); return JSON.stringify({ ok: true, value: input.method === 'toast.show' ? 'toast-id' : true }); },
    port: { async postMessage(input) { return input.method === 'save' ? { ok: true, value: false } : { ok: false, error: { code: 'EXPORT_SAVE_FAILED' } }; } },
  });
  expect(await device.system.save({ name: 'x.txt', content: '' })).toBe(false);
  await expect(device.system.copy('x')).rejects.toMatchObject({ code: 'EXPORT_SAVE_FAILED' });
  const owner = new AbortController(); device.toasts(owner.signal).show({ title: 'literal <script>', persistent: true });
  device.system.openExternal('https://example.invalid/'); owner.abort();
  expect(sync.map(input => input.method)).toEqual(['toast.show', 'openExternal', 'toast.dismiss']); device.close();
});
it('different plugin toast owners cannot share a native handle or dismiss each other on abort', () => {
  const requests: { method: string; input: { owner?: string; id?: string } }[] = [];
  const device = createGuiPluginDevice({ scope, window, isCurrent: () => true, port: { async postMessage() { throw Error('No Host or async device request'); } },
    prompt: (_, value) => {
      const request = JSON.parse(value); requests.push(request);
      return JSON.stringify({ ok: true, value: request.method === 'toast.show' ? 'toast-' + request.input.owner : true });
    },
  });
  const a = new AbortController(), b = new AbortController();
  device.toasts(a.signal).show({ title: 'same' }); device.toasts(b.signal).show({ title: 'same' });
  expect(requests[0].input.owner).not.toBe(requests[1].input.owner);
  a.abort(); expect(requests.at(-1)?.input.id).toBe('toast-' + requests[0].input.owner);
  b.abort(); expect(requests.at(-1)?.input.id).toBe('toast-' + requests[1].input.owner); device.close();
});
it('file and localhost iframe URLs stay tokenless and DOM resources are rewritten and detached', async () => {
  const input = { origin: 'yuri-plugin://owner', directory: '/work', path: '/work/report.html' };
  expect(guiPluginResourceURL('images/a.png', input)).toBe('yuri-plugin://owner/__gui/files/work/images/a.png');
  expect(guiPluginResourceURL('/api/fs/serve/work/icon.svg', input)).toBe('yuri-plugin://owner/__gui/files/work/icon.svg');
  expect(guiPluginResourceURL('http://localhost:3000/view?q=ok', input)).toMatch(/^yuri-plugin:\/\/owner\/__gui\/loopback\/[\w-]+\/view\?q=ok$/);
  expect(() => guiPluginResourceURL('https://external.invalid/image.png', input)).toThrow('GUI_RESOURCE_EXTERNAL_ORIGIN_CORE_GAP');
  expect(() => guiPluginResourceURL('http://localhost/?yuri_url_token=secret', input)).toThrow('GUI_RESOURCE_CREDENTIAL_URL');
  expect(() => guiPluginResourceURL('ws://localhost:3000/socket', input)).toThrow('GUI_RESOURCE_WEBSOCKET_CORE_GAP');
  expect(guiPluginResourceURL('https://host.invalid/api/fs/serve/work/font.woff2', input)).toMatch(/^yuri-plugin:\/\/owner\/__gui\/host\/[\w-]+\/api\/fs\/serve\/work\/font.woff2$/);
  const observed = installGuiPluginResourceURLs({ window, directory: '/work', path: '/work/report.html' });
  const image = document.createElement('img'); image.setAttribute('src', '/api/fs/serve/work/icon.svg'); document.body.append(image);
  await vi.waitFor(() => expect(image.getAttribute('src')).toContain('/__gui/files/work/icon.svg'));
  observed.close(); image.setAttribute('src', 'unmapped.svg'); await Promise.resolve(); expect(image.getAttribute('src')).toBe('unmapped.svg'); image.remove();
});
it('resource fetch preserves cancellation and headers, refuses external/mutation requests before IO and restores its owner', async () => {
  const original = window.fetch, nativeFetch = vi.fn(async () => new Response('captured bytes'));
  window.fetch = nativeFetch;
  const installed = installGuiPluginResourceURLs({ window, directory: '/work', path: '/work/report.html' });
  try {
    const controller = new AbortController();
    const request = new Request(window.location.origin + '/api/fs/serve/work/icon.svg', { headers: { accept: 'image/svg+xml' }, signal: controller.signal });
    const response = await window.fetch(request);
    expect(await response.text()).toBe('captured bytes');
    expect(nativeFetch).toHaveBeenCalledWith(expect.stringContaining('/__gui/files/work/icon.svg'), expect.objectContaining({ credentials: 'omit', redirect: 'error', headers: request.headers, signal: request.signal }));
    await expect(window.fetch('https://external.invalid/image.png')).rejects.toMatchObject({ code: 'GUI_RESOURCE_EXTERNAL_ORIGIN_CORE_GAP' });
    await expect(window.fetch('/api/fs/serve/work/icon.svg', { method: 'POST' })).rejects.toMatchObject({ code: 'GUI_RESOURCE_METHOD_CORE_GAP' });
    expect(nativeFetch).toHaveBeenCalledOnce();
    installed.close(); expect(window.fetch).toBe(nativeFetch);
  } finally { installed.close(); window.fetch = original; }
});
it('srcset preserves data candidates and descriptors while routing each Host file candidate', () => {
  const resolve = (value: string) => guiPluginResourceURL(value, { origin: 'yuri-plugin://owner', directory: '/work', path: '/work/report.html' });
  expect(rewriteGuiPluginSrcset('images/a.png 1x, /api/fs/serve/work/b.png 2x, data:image/png;base64,AAA 3x', resolve)).toBe('yuri-plugin://owner/__gui/files/work/images/a.png 1x, yuri-plugin://owner/__gui/files/work/b.png 2x, data:image/png;base64,AAA 3x');
});
it('a child realm fetch accepts its own URL/Request brands and rejects unbranded objects before IO', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const child = frame.contentWindow as Window & typeof globalThis;
  expect(child).toBeTruthy();
  expect(child.URL).not.toBe(URL);
  const previous = child.fetch, nativeFetch = vi.fn(async () => new Response('child bytes'));
  child.fetch = nativeFetch;
  const installed = installGuiPluginResourceURLs({ window, directory: '/work', path: '/work/report.html' });
  try {
    frame.dispatchEvent(new Event('load'));
    const url = new child.URL(window.location.origin + '/api/fs/serve/work/child.svg');
    expect(url instanceof URL).toBe(false);
    expect(await (await child.fetch(url)).text()).toBe('child bytes');
    expect(nativeFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/__gui/files/work/child.svg'), expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }));
    const controller = new child.AbortController();
    const request = new child.Request(url, { headers: { accept: 'image/svg+xml' }, signal: controller.signal });
    await child.fetch(request);
    expect(nativeFetch).toHaveBeenLastCalledWith(expect.stringContaining('/__gui/files/work/child.svg'), expect.objectContaining({ headers: request.headers, signal: request.signal, credentials: 'omit', redirect: 'error' }));
    const unchecked = child.fetch as (input: unknown) => Promise<Response>;
    await expect(unchecked({ url: url.href, method: 'GET' })).rejects.toMatchObject({ code: 'GUI_RESOURCE_INVALID_INPUT' });
    const fakeURL = Object.create(child.URL.prototype);
    Object.defineProperty(fakeURL, 'href', { value: url.href });
    await expect(unchecked(fakeURL)).rejects.toMatchObject({ code: 'GUI_RESOURCE_INVALID_INPUT' });
    const fakeRequest = Object.create(child.Request.prototype);
    Object.defineProperties(fakeRequest, { url: { value: url.href }, method: { value: 'GET' }, headers: { value: request.headers }, signal: { value: request.signal } });
    await expect(unchecked(fakeRequest)).rejects.toMatchObject({ code: 'GUI_RESOURCE_INVALID_INPUT' });
    await expect(child.fetch(url, { method: 'POST' })).rejects.toMatchObject({ code: 'GUI_RESOURCE_METHOD_CORE_GAP' });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    installed.close(); expect(child.fetch).toBe(nativeFetch);
  } finally { installed.close(); child.fetch = previous; frame.remove(); }
});
it('URL/Request prototype lookalikes cannot forge fetch input, and own properties cannot shadow native slots', async () => {
  const original = window.fetch, nativeFetch = vi.fn(async () => new Response('native slots'));
  window.fetch = nativeFetch;
  const installed = installGuiPluginResourceURLs({ window, directory: '/work', path: '/work/report.html' });
  const approved = window.location.origin + '/api/fs/serve/work/real.txt';
  const unchecked = window.fetch as (value: unknown) => Promise<Response>;
  try {
    const fakeURL = Object.create(window.URL.prototype);
    Object.defineProperty(fakeURL, 'href', { value: approved });
    await expect(unchecked(fakeURL)).rejects.toMatchObject({ code: 'GUI_RESOURCE_INVALID_INPUT' });
    const fakeRequest = Object.create(window.Request.prototype);
    Object.defineProperties(fakeRequest, { url: { value: approved }, method: { value: 'GET' }, headers: { value: new Headers() }, signal: { value: new AbortController().signal } });
    await expect(unchecked(fakeRequest)).rejects.toMatchObject({ code: 'GUI_RESOURCE_INVALID_INPUT' });
    expect(nativeFetch).not.toHaveBeenCalled();
    const url = new window.URL(approved);
    Object.defineProperty(url, 'href', { value: 'https://external.invalid/forged' });
    await window.fetch(url);
    expect(nativeFetch).toHaveBeenLastCalledWith(expect.stringContaining('/__gui/files/work/real.txt'), expect.anything());
    const request = new window.Request(approved, { headers: { accept: 'text/plain' } });
    const realHeaders = request.headers, realSignal = request.signal;
    Object.defineProperties(request, { url: { value: 'https://external.invalid/forged' }, method: { value: 'POST' }, headers: { value: new Headers({ bad: 'shadow' }) }, signal: { value: new AbortController().signal } });
    await window.fetch(request);
    expect(nativeFetch).toHaveBeenLastCalledWith(expect.stringContaining('/__gui/files/work/real.txt'), expect.objectContaining({ method: 'GET', headers: realHeaders, signal: realSignal, credentials: 'omit', redirect: 'error' }));
    const mutation = new window.Request(approved, { method: 'POST' });
    Object.defineProperty(mutation, 'method', { value: 'GET' });
    await expect(window.fetch(mutation)).rejects.toMatchObject({ code: 'GUI_RESOURCE_METHOD_CORE_GAP' });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  } finally { installed.close(); window.fetch = original; }
});
it('absolute Host HTML mapping retains an opaque identity and directory for every relative resource', () => {
  const input = { origin: 'yuri-plugin://owner', directory: '/work', path: '/work/report.html' };
  const page = guiPluginResourceURL('https://host.invalid/api/fs/serve/work/reports/attack.html#section', input);
  expect(page).toMatch(/^yuri-plugin:\/\/owner\/__gui\/host\/[\w-]+\/api\/fs\/serve\/work\/reports\/attack.html#section$/);
  for (const name of ['safe.js', 'safe.mjs', 'safe.css', 'probe.txt']) {
    expect(new URL('./' + name, page).href).toBe(page.replace('attack.html#section', name));
  }
});
