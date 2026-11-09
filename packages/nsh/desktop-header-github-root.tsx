import { cleanup, openUrl, signal, Text, untracked, View, type JSX, type ViewRef } from 'nsh';
import { createDesktopHeaderGitHubRootController, type DesktopHeaderGitHubRootOptions } from './desktop-header-github-root-core';
import type { DesktopHeaderGitHubOperation } from './desktop-header-github-core';
import { SettingsGitHub } from './settings-github';
import { publishSettingsEditor } from './desktop-settings-publisher';
import { t } from './i18n';

export type DesktopSettingsGitHubContext = {
  current: () => boolean; active: () => boolean; directory: () => string;
  operation: () => DesktopHeaderGitHubOperation | null;
  target?: string; onReveal?: (node: ViewRef) => void;
};
export type DesktopSettingsGitHubSlot = (context: DesktopSettingsGitHubContext) => JSX.Element;

/** Called once by the actual window root. Settings invokes the slot only in its
 * real Git fragment, under its existing publisher; no parallel OAuth owner. */
export function createNativeDesktopHeaderGitHubRoot(options: DesktopHeaderGitHubRootOptions & { open?: (url: string) => Promise<boolean> }) {
  const revision = signal(0);
  const owner = createDesktopHeaderGitHubRootController({ ...options, changed() {
    untracked(() => revision.set(revision() + 1)); options.changed?.();
  } });
  const header = { ...owner.header,
    state() { revision(); return owner.header.state(); },
    available() { revision(); return owner.header.available(); },
    visible() { revision(); return owner.header.visible(); },
  };
  function Fragment(props: { context: DesktopSettingsGitHubContext }) {
    const context = props.context;
    const bridge = owner.settings({ ...context, interactive: context.active }, options.open ?? (async url => (await openUrl(url)).opened));
    if (!bridge) return <View testID="desktop-settings-github-unavailable"><Text class="text-muted-foreground">{t('settings.view.unavailable.description')}</Text></View>;
    publishSettingsEditor({ current: context.current, scope: context.operation, dirty: () => false, stamp: () => [],
      pending: () => { revision(); return !bridge.canRelease(); },
    });
    cleanup(() => { bridge.detach(); });
    return <SettingsGitHub active={context.active()} target={context.target} onReveal={context.onReveal} dependencies={bridge.dependencies} />;
  }
  const settings: DesktopSettingsGitHubSlot = context => <Fragment context={context} />;
  cleanup(() => { if (!owner.dispose()) owner.retire(); });
  return { ...owner, header, settings, canClose() { revision(); return owner.canClose(); } };
}
