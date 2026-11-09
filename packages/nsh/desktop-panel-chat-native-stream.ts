import type { DesktopPanelChatStream } from './desktop-panel-chat-source';
import type { RuntimeScope } from './runtime-scope';

type NativeCall = (name: string, input: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function desktopPanelChatStreamSupported(value: unknown): boolean {
  const root = object(value), panel = object(root?.panelChat);
  return root?.schemaVersion === 1 && panel?.supported === true && panel.maxStreams === 4
    && panel.keyFormat === 'panel-chat:<owner>:<activation>' && panel.maxID === Number.MAX_SAFE_INTEGER
    && panel.path === '/api/event' && panel.requiresExpectedHost === true
    && Array.isArray(panel.queryKeys) && panel.queryKeys.length === 1 && panel.queryKeys[0] === 'directory';
}

function check(key: string, scope: RuntimeScope) {
  const ids = /^panel-chat:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/.exec(key);
  if (!ids || !ids.slice(1).every(value => Number.isSafeInteger(Number(value))) || !scope?.hostID || !scope.lease) throw new Error('runtime_host_scope_invalid');
}

/** Native capability discovery only. No stream starts until the existing display owner asks. */
export async function loadDesktopPanelChatNativeStream(call: NativeCall): Promise<DesktopPanelChatStream | undefined> {
  let capability: unknown;
  try { capability = await call('runtime.stream.capabilities', {}); } catch { return undefined; }
  if (!desktopPanelChatStreamSupported(capability)) return undefined;
  return {
    start(input) {
      check(input.key, input.expectedHost);
      const encoded = input.path.startsWith('/api/event?directory=') ? input.path.slice('/api/event?directory='.length) : '';
      let directory = '';
      try { directory = decodeURIComponent(encoded); } catch { throw new Error('unsupported_event_stream'); }
      if (!directory || /[\x00-\x1f\x7f-\x9f]/.test(directory) || encodeURIComponent(directory) !== encoded) throw new Error('unsupported_event_stream');
      return call('runtime.stream', { path: input.path, key: input.key, expectedHost: { ...input.expectedHost } });
    },
    stop(input) {
      check(input.key, input.expectedHost);
      return call('runtime.stop', { key: input.key, expectedHost: { ...input.expectedHost } });
    },
  };
}
