import type { GuiPluginHost } from '../../ui/src/lib/gui-plugins/host';
import { createViewExportAPI } from '../../ui/src/lib/view-export/api';
import type { ViewExportEvent } from '../../ui/src/lib/view-export/types';
import type { RuntimeScope } from '../runtime-scope';
import type { GuiPluginReplyPort } from '../gui-plugin-channel';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (code: string) => Object.assign(new Error(code), { code });
type Toasts = ReturnType<NonNullable<ConstructorParameters<typeof GuiPluginHost>[0]['toasts']>>;
type ToastOptions = Parameters<Toasts['show']>[0];
function checked(value: unknown): unknown {
  if (!record(value) || typeof value.ok !== 'boolean') throw failure('GUI_PLUGIN_INVALID_OUTPUT');
  if (!value.ok) throw failure(record(value.error) && typeof value.error.code === 'string' ? value.error.code : 'GUI_PLUGIN_FAILED');
  return value.value;
}

/** Device operations never enter the Host SDK/RPC lane. Sync SDK methods use
 * the same main-frame-only structured prompt boundary as persistent storage. */
export function createGuiPluginDevice(input: {
  scope: RuntimeScope; window: Window; port: GuiPluginReplyPort; isCurrent(): boolean;
  prompt(name: string, value: string): string | null;
}) {
  let closed = false, toastOwners = 0;
  const check = () => { if (closed || !input.isCurrent()) throw failure('GUI_PLUGIN_ABORTED'); };
  const sync = (method: string, value: unknown) => {
    check();
    const response = input.prompt('yuri.gui.device.v1', JSON.stringify({ expectedHost: input.scope, method, input: value }));
    if (response === null) throw failure('GUI_PLUGIN_UNAVAILABLE');
    return checked(JSON.parse(response));
  };
  const request = async (method: string, value?: unknown) => {
    check();
    const result = checked(await input.port.postMessage({ name: 'device', expectedHost: input.scope, method, input: value ?? {} }));
    check(); return result;
  };
  const viewExport = createViewExportAPI(async () => ({
    request: (method, value) => request(method, value),
    async subscribe(listener) {
      const receive = (event: Event) => { if (!closed && input.isCurrent()) listener((event as CustomEvent<ViewExportEvent>).detail); };
      input.window.addEventListener('yuri.gui.device.progress', receive);
      return () => input.window.removeEventListener('yuri.gui.device.progress', receive);
    },
  }));
  const system = {
    async copy(text: string) { await request('copy', { text }); },
    openExternal(url: string) { sync('openExternal', { url }); },
    async save(file: { name: string; content: string }) {
      const saved = await request('save', file);
      if (typeof saved !== 'boolean') throw failure('GUI_PLUGIN_INVALID_OUTPUT');
      return saved;
    },
  };
  const toasts = (owner: AbortSignal): Toasts => {
    const identity = String(++toastOwners);
    const handles = new Map<string, { dismiss(): void }>();
    owner.addEventListener('abort', () => { for (const handle of [...handles.values()]) handle.dismiss(); }, { once: true });
    return { show(value: ToastOptions) {
      if (owner.aborted) return { dismiss() {} };
      const id = sync('toast.show', { owner: identity, toast: value });
      if (typeof id !== 'string') throw failure('GUI_PLUGIN_INVALID_OUTPUT');
      const handle = { dismiss() { handles.delete(id); if (!closed && input.isCurrent()) sync('toast.dismiss', { id }); } };
      handles.set(id, handle); return handle;
    } };
  };
  return { system, toasts, viewExport, close() { closed = true; } };
}
