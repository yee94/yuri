import { cleanup, colorScheme, computed, effect, lifecycle, locale, signal, untracked, Text, View } from 'nsh';
import type { AppliedNativeAppearance } from './appearance-core';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createDesktopContextOwner, desktopContextIdentity, desktopContextMatches, type DesktopContextChat, type DesktopContextOwner } from './desktop-context-core';
import { DesktopContextContent } from './desktop-context-content';
import { language, t } from './i18n';

export type DesktopContextAppearance = Pick<AppliedNativeAppearance, 'showAssistantTps' | 'timeFormatPreference' | 'contextUsageTokens'>;

export interface NativeDesktopContextProps {
  scope: DesktopPanelScope;
  /** Main's mountedChats entry for this exact session/directory. Never construct another Chat. */
  chat: DesktopContextChat | null;
  current: () => boolean;
  /** Selected Context tab, visible workbench and foreground window. Inactive reads nothing. */
  active: boolean;
  /** Modal occlusion revokes interaction without destroying the retained projection. */
  interactive?: boolean;
  read: (path: string) => Promise<unknown>;
  appearance: DesktopContextAppearance | null;
  onOwner?: (owner: DesktopContextOwner | null) => void;
}

/** Workbench content only: no NavPage, Sheet, duplicate toolbar or secondary transport. */
export function NativeDesktopContext(props: NativeDesktopContextProps) {
  const admitted = () => props.chat !== null && desktopContextMatches(props.scope, props.chat);
  return <If when={!!props.scope.sessionID} else={<View testID="desktop-context-empty" class="flex-1 items-center justify-center p-6"><Text class="text-xs text-muted-foreground">{t('contextSidebar.empty.openSession')}</Text></View>}>
    <Each of={admitted() ? [props.chat!] : []} key={chat => desktopContextIdentity(props.scope, chat)}>{chat => <DesktopContextBinding {...props} chat={chat()} />}</Each>
    <If when={!admitted()}><View testID="desktop-context-unavailable" class="flex-1 items-center justify-center p-6"><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></View></If>
  </If>;
}

function DesktopContextBinding(props: NativeDesktopContextProps & { chat: DesktopContextChat }) {
  const chat = untracked(() => props.chat), identity = untracked(() => desktopContextIdentity(props.scope, chat));
  const read = untracked(() => props.read);
  const revision = signal(0);
  const current = () => props.current() && props.chat === chat && desktopContextIdentity(props.scope, chat) === identity;
  const projection = createDesktopContextOwner({ scope: props.scope, chat, current, read,
    showAssistantTps: props.appearance?.showAssistantTps === true, changed: () => revision.update(value => value + 1) });
  const publish = untracked(() => props.onOwner);
  untracked(() => publish?.(projection));
  cleanup(() => { projection.dispose(); publish?.(null); });
  const active = computed(() => props.active && lifecycle() === 'active' && current());
  const interactive = computed(() => active() && props.interactive !== false);
  effect(() => {
    const visible = active(), enabled = interactive(), show = props.appearance?.showAssistantTps === true;
    untracked(() => { projection.setDemand(visible, enabled); projection.setShowAssistantTps(show); });
  });
  return <If when={current()} else={<View testID="desktop-context-retired" class="flex-1" />}>
    <DesktopContextContent projection={projection} revision={revision()} interactive={interactive()}
      showAssistantTps={props.appearance?.showAssistantTps === true} timeFormat={props.appearance?.timeFormatPreference ?? 'auto'}
      locale={language() === 'system' ? locale() : language()} palette={props.appearance?.contextUsageTokens[colorScheme()] ?? {}} />
  </If>;
}
