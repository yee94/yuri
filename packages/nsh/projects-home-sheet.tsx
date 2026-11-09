import { effect, signal, Text, untracked, View, windowSize } from 'nsh';
import { Button, createNavStack, NavStack } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';
import { ProjectDetail, type ProjectsNavigation } from './projects';
import { ProjectDirectoryPage } from './projects-directory';
import { SettingsProjects, type ProjectSettingsNavigation } from './settings-projects';
import { app, epoch } from './state';
import type { Project } from './model';
import { nativeChatTextStyle, nativeDensity } from './appearance';

export type ProjectHomeSheetIntent = { kind: 'edit' | 'worktrees' | 'new-worktree'; project: Project } | { kind: 'directory' };

/** A single system presentation owns homepage options; the main NavStack never moves. */
export function ProjectsHomeSheet(props: {
  intent: ProjectHomeSheetIntent;
  active?: boolean;
  onReplace: (intent: ProjectHomeSheetIntent) => void;
  onClosed: () => void;
  navigation: ProjectsNavigation;
}) {
  const open = signal(true), guard = signal<ProjectSettingsNavigation>({ blocked: false, back: () => {} });
  const generation = epoch(), hostID = app.connection()?.id;
  const current = () => props.active !== false && generation === epoch() && hostID === app.connection()?.id;
  let afterClose: (() => void) | undefined;
  effect(() => { if (!current()) untracked(() => { afterClose = undefined; open.set(false); }); });
  const close = (next?: () => void) => { if (!open()) return; afterClose = current() ? next : undefined; open.set(false); };
  const requestClose = () => { if (guard().blocked) guard().back(); else close(); };
  const replace = (intent: ProjectHomeSheetIntent) => { if (current() && open() && !guard().blocked) { guard.set({ blocked: false, back: () => {} }); props.onReplace(intent); } };
  const title = () => props.intent.kind === 'edit' ? t('projectEditDialog.title') : props.intent.kind === 'directory' ? t('directoryExplorerDialog.title') : t(props.intent.kind === 'new-worktree' ? 'session.newWorktree.title' : 'mobile.projectEdit.worktreesTitle');
  return <NativeSheet testID="projects-home-options-sheet" open={open()} detents={[.72, .98]} initialDetent={props.intent.kind === 'new-worktree' ? 0 : 1}
    viewportDetents={props.intent.kind === 'new-worktree'} popupStyle={props.intent.kind === 'new-worktree' ? { height: windowSize().height * .72, paddingTop: 32 * nativeDensity().scale } : undefined}
    closeOnSwipe={!guard().blocked} closeOnBackdropPress={!guard().blocked} closeOnEscape={!guard().blocked}
    onOpenChange={event => { if (!event.open && !guard().blocked) close(); }}
    onClose={() => { const next = afterClose; afterClose = undefined; props.onClosed(); if (current()) next?.(); }} popupClass="bg-background">
    <View class="flex-row items-center" style={props.intent.kind === 'new-worktree' ? { paddingHorizontal: 16 * nativeDensity().scale, paddingBottom: 8 * nativeDensity().scale, minHeight: 40, gap: 8 * nativeDensity().scale } : { paddingHorizontal: 20 * nativeDensity().scale, paddingBottom: 12 * nativeDensity().scale, gap: 12 * nativeDensity().scale }}>
      <Text class={`flex-1 font-semibold text-foreground ${props.intent.kind === 'new-worktree' ? '' : 'text-lg'}`} style={props.intent.kind === 'new-worktree' ? { ...nativeChatTextStyle('uiLabel'), lineHeight: (nativeChatTextStyle('uiLabel').fontSize ?? 13) * 1.5 } : undefined}>{title()}</Text>
      <Button testID="projects-home-options-close" class="items-center justify-center" style={{ minHeight: props.intent.kind === 'new-worktree' ? 36 : 44, minWidth: props.intent.kind === 'new-worktree' ? 36 : 44 }} accessibilityLabel={t('mobile.surface.closeAria')} onPress={requestClose}><Icon name="close" size={20} /></Button>
    </View>
    <Each of={[props.intent]}>{intent => {
      const target = intent();
      const navigation = createNavStack([target]);
      const onNavigation = (value: ProjectSettingsNavigation) => { if (props.intent === target && current()) guard.set(value); };
      if (target.kind === 'edit') return <SettingsProjects page="projects" entity={target.project.id} directory={target.project.path}
        onNavigation={onNavigation} onBack={() => close()} onOpen={() => {}} onConnect={() => {}} />;
      return <NavStack state={navigation} class="flex-1">{() => target.kind === 'directory'
        ? <ProjectDirectoryPage headerVisible={false} onPendingChange={pending => onNavigation({ blocked: pending, back: () => {} })}
          onAdded={(project, options) => { if (options.openDraft) close(() => props.navigation.onNewSession?.(project)); }} />
        : <ProjectDetail {...props.navigation} project={target.project} initialCreateWorktree={target.kind === 'new-worktree'} sheet
          onSheetClose={() => close()} onPendingChange={pending => onNavigation({ blocked: pending, back: () => {} })}
          onEditProject={project => replace({ kind: 'edit', project })}
          onOpenChat={value => close(() => props.navigation.onOpenChat(value))}
          onOpenFiles={directory => close(() => props.navigation.onOpenFiles(directory))}
          onOpenChanges={directory => close(() => props.navigation.onOpenChanges(directory))}
          onNewSession={project => close(() => props.navigation.onNewSession?.(project))}
          onWorktreeCreated={(project, directory) => close(() => props.navigation.onWorktreeCreated?.(project, directory))} />}</NavStack>;
    }}</Each>
  </NativeSheet>;
}
