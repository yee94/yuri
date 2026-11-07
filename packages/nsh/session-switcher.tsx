import { NavPage } from 'nsh/base';
import { t } from './i18n';
import type { ChatTarget } from './model';
import { ProjectsHome, type ProjectsNavigation } from './projects';
import { createSessionSwitcherSelection } from './session-switcher-actions';

export interface NativeSessionSwitcherProps {
  navigation: ProjectsNavigation;
  currentTarget?: ChatTarget;
  current: () => boolean;
  /** Pop this route only, never popToRoot/replace the retained Chat. */
  onClose: () => void;
}

/** The mobile project/session catalog already exists; reuse all of its actions and recovery. */
export function NativeSessionSwitcherPage(props: NativeSessionSwitcherProps) {
  const select = createSessionSwitcherSelection({ currentTarget: props.currentTarget, current: props.current, close: props.onClose, openChat: props.navigation.onOpenChat });
  return <NavPage title={t('commandPalette.item.showSessionSwitcher')} headerBackTitle="" hidesBottomBarWhenPushed class="flex-1 bg-background">
    <ProjectsHome {...props.navigation} onOpenChat={select} />
  </NavPage>;
}
