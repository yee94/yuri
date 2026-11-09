import { colorScheme, View } from 'nsh';
import { Icon } from './Icon';
import { nativeAppearance } from './appearance';
import { ProjectsSessionIndicator } from './projects-attention-indicator';
import { t } from './i18n';
import yuriDark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import yuriLight from '../ui/src/lib/theme/themes/yuri-2-light.json';
import type { MobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';

export const desktopSidebarTheme = () => nativeAppearance.current()?.webTheme?.[colorScheme()] ?? (colorScheme() === 'dark' ? yuriDark : yuriLight);

/** PC marker geometry and colors; shared native ring keeps its exact 14pt arc. */
export function DesktopSidebarIndicator(props: { indicator: MobileSessionIndicator; sessionID: string }) {
  return <If when={props.indicator === 'running'} else={<View testID={`projects-indicator-${props.sessionID}-${props.indicator}`} class="items-center justify-center" style={{ width: 14, height: 14 }} accessibilityLabel={t(props.indicator === 'question' ? 'sessions.sidebar.session.status.questionRequired' : 'sessions.sidebar.session.status.unread')}>
    <If when={props.indicator === 'question'} else={<View class="rounded-full" style={{ width: 8, height: 8, backgroundColor: desktopSidebarTheme().colors.status.info }} />}><Icon name="question" size={14} color={desktopSidebarTheme().colors.primary.base} /></If>
  </View>}><ProjectsSessionIndicator indicator="running" sessionID={props.sessionID} /></If>;
}
