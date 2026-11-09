import { cleanup, effect, host, lifecycle } from 'nsh';
import { native } from './runtime';
import { authorizationCacheCleanupBridge, createAuthorizationCacheCleanupRoot, type AuthorizationCacheCleanupRootOptions } from './authorization-cache-cleanup';

export type NativeAuthorizationCacheCleanupRootProps = {
  retire: AuthorizationCacheCleanupRootOptions['retire'];
  onReady: AuthorizationCacheCleanupRootOptions['onReady'];
  onState?: AuthorizationCacheCleanupRootOptions['onState'];
  onRetryAvailable?: (retry: (() => Promise<void>) | null) => void;
  bridge?: AuthorizationCacheCleanupRootOptions['bridge'];
};

/** Production-only root. Mount outside the one-way business startup gate. */
export function NativeAuthorizationCacheCleanupRoot(props: NativeAuthorizationCacheCleanupRootProps) {
  const root = createAuthorizationCacheCleanupRoot({
    bridge: props.bridge ?? authorizationCacheCleanupBridge((name, body) => native(name, body)),
    retire: props.retire,
    subscribe: callback => host.on('authorization.cache.pending', callback),
    onReady: props.onReady,
    onState: state => props.onState?.(state),
  });
  // start subscribes synchronously; the first sweep starts in a microtask.
  void root.start();
  props.onRetryAvailable?.(root.retry);
  let wasActive = lifecycle() === 'active';
  effect(() => {
    const active = lifecycle() === 'active';
    if (active && !wasActive) void root.retry();
    wasActive = active;
  });
  cleanup(() => { root.dispose(); props.onRetryAvailable?.(null); });
  return null;
}
