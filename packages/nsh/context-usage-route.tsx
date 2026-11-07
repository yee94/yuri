import { cleanup, colorScheme, effect, lifecycle, locale, signal, untracked } from 'nsh';
import type { AppliedNativeAppearance } from './appearance-core';
import type { ChatTarget } from './model';
import type { ContextUsageScope } from './context-usage-core';
import { language } from './i18n';
import { createPageOperations } from './page-operations';
import { NativeContextUsagePage } from './context-usage';
import { createContextUsageRoute, type ContextUsageChat } from './context-usage-route-core';

export interface ContextUsageRouteProps {
  chat: ContextUsageChat;
  target: ChatTarget;
  scope: ContextUsageScope;
  current: () => boolean;
  active: boolean;
  /** The single current-Host root appearance snapshot, not a page-local theme/default. */
  appearance: AppliedNativeAppearance | null;
  read?: (path: string) => Promise<unknown>;
}

/** Owns its system NavPage; main mounts this directly, never inside a second page. */
export function ContextUsageRoute(props: ContextUsageRouteProps) {
  const operations = createPageOperations(() => props.active && props.current());
  const revision = signal(0);
  const route = signal<ReturnType<typeof createContextUsageRoute> | null>(null);
  let assigned: ReturnType<typeof operations.operation>;
  effect(() => {
    const lane = operations.operation(), scope = props.chat.messageScope;
    const active = props.active && lifecycle() === 'active' && props.current();
    untracked(() => {
      if (assigned !== lane) {
        route()?.dispose(); assigned = lane;
        route.set(lane ? createContextUsageRoute({ chat: props.chat, target: props.target, scope, current: () => assigned === lane && lane.current() && props.current(),
          read: props.read ?? lane.request, showAssistantTps: props.appearance?.showAssistantTps === true, changed: () => revision.update(value => value + 1) }) : null);
      }
      route()?.setActive(active);
    });
  });
  cleanup(() => route()?.dispose());
  return <NativeContextUsagePage scope={route()?.current() ? props.chat.messageScope : null} active={props.active} current={() => route()?.current() === true}
    projection={route() ? { owner: route()!.owner, revision: revision() } : undefined} showAssistantTps={props.appearance?.showAssistantTps === true}
    timeFormat={props.appearance?.timeFormatPreference ?? 'auto'} locale={language() === 'system' ? locale() : language()}
    palette={props.appearance?.contextUsageTokens[colorScheme()] ?? {}} onRetry={() => { void route()?.retry(); }} />;
}
