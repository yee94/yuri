import { colorScheme, Image, token, View } from 'nsh';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeAgentPaletteTokens } from './appearance';
import type { MobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';
import yuriDark from '../ui/src/lib/theme/themes/yuri-2-dark.json';
import yuriLight from '../ui/src/lib/theme/themes/yuri-2-light.json';

const statusColor = (name: 'info' | 'warning') => nativeAgentPaletteTokens()[`--status-${name}`] ?? (colorScheme() === 'dark' ? yuriDark : yuriLight).colors.status[name];

/** Same geometry and semantic colors as Web SessionBusyIndicator (14pt, 28% arc). */
function busyRing() {
  const size = 14, stroke = 1.5, radius = (size - stroke) / 2, circumference = 2 * Math.PI * radius;
  const border = String(token('border'));
  const foreground = String(token('muted-foreground'));
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="${radius}" fill="none" stroke="${border}" stroke-width="${stroke}"/><circle cx="7" cy="7" r="${radius}" fill="none" stroke="${foreground}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circumference * .28} ${circumference * .72}"/></svg>`);
}

export function ProjectsSessionIndicator(props: { indicator: MobileSessionIndicator; sessionID: string }) {
  const label = () => props.indicator === 'question' ? t('sessions.sidebar.session.status.questionRequired')
    : props.indicator === 'permission' ? t('sessions.sidebar.session.status.permissionRequired')
      : props.indicator === 'running' ? t('sessions.sidebar.session.status.active')
        : props.indicator === 'completed-unread' ? t('sessions.sidebar.session.status.unread') : undefined;
  return <View testID={`projects-indicator-${props.sessionID}-${props.indicator}`} class="items-center justify-center" style={{ width: 12, height: 12 }} accessibilityLabel={label()}>
    <If when={props.indicator === 'question'} else={
      <If when={props.indicator === 'permission'} else={
        <If when={props.indicator === 'running'} else={
          <View class="rounded-full" style={{ width: 5, height: 5, backgroundColor: props.indicator === 'completed-unread' ? statusColor('info') : String(token('muted-foreground')), opacity: props.indicator === 'completed-unread' ? 1 : .35 }} />
        }><View class="animate-spin"><Image src={busyRing()} style={{ width: 14, height: 14 }} /></View></If>
      }><Icon name="shield" size={14} color={String(token('destructive'))} /></If>
    }><Icon name="question" size={14} color={statusColor('warning')} /></If>
  </View>;
}
