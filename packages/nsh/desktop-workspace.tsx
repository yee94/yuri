import { cleanup, signal, Storage, Text, View, type JSX } from 'nsh';
import { Button, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { createDesktopLayoutPersistence, desktopLayoutFrom, desktopWorkspaceGeometry, type DesktopLayout, type DesktopLayoutStorage } from './desktop-layout-core';
import { t } from './i18n';

export function createDesktopLayout(storage: DesktopLayoutStorage = Storage) {
  const state = signal(desktopLayoutFrom(null)), error = signal(false);
  const persistence = createDesktopLayoutPersistence(storage, value => state.set(value), () => error.set(true));
  void persistence.restore();
  cleanup(persistence.dispose);
  return {
    state, error,
    set(patch: Partial<DesktopLayout>) { error.set(false); void persistence.set(patch); },
    retry() { error.set(false); void persistence.retry(); },
    toggleSidebar() { void persistence.set({ sidebarOpen: !state().sidebarOpen }); },
    togglePanel() { void persistence.set({ panelOpen: !state().panelOpen }); },
    toggleTerminal() { void persistence.set({ terminalOpen: !state().terminalOpen }); },
    flush: persistence.flush,
    canClose: persistence.canClose,
  };
}

/** NSH owns resize gestures and accessibility; JS only persists completed sizes. */
export function NativeDesktopWorkspace(props: {
  layout: ReturnType<typeof createDesktopLayout>;
  titlebar: JSX.Element;
  sidebar: JSX.Element;
  children: JSX.Element;
  panel?: JSX.Element;
  panelAvailable?: boolean;
  terminal?: JSX.Element;
  terminalAvailable?: boolean;
}) {
  const width = signal(0);
  const state = props.layout.state;
  const panelOpen = () => state().panelOpen && (props.panelAvailable ?? props.panel !== undefined);
  const terminalOpen = () => state().terminalOpen && (props.terminalAvailable ?? props.terminal !== undefined);
  const geometry = () => desktopWorkspaceGeometry(width(), { ...state(), panelOpen: panelOpen() });
  return <View testID="desktop-workspace" class="flex-1 bg-background" onLayout={event => width.set(event.bounds.size.width)}>
    {props.titlebar}
    <If when={props.layout.error()}><View role="alert" class="flex-row items-center px-3 gap-2">
      <Text class="text-destructive text-sm flex-1">{t('common.unavailable')}</Text>
      <Button onPress={props.layout.retry}><Text class="text-foreground text-sm">{t('chat.questionDelegate.retry')}</Text></Button>
    </View></If>
    <ResizablePanelGroup testID="desktop-columns" axis="horizontal" class="flex-1" handleClass="bg-border group-hover:bg-muted-foreground" handleAccessibilityLabel={t('sidebar.resize.leftPanelAria')}>
      <ResizablePanel testID="desktop-sidebar-panel" visible={state().sidebarOpen} size={state().sidebarWidth} minSize={260} maxSize={500} fixed class="bg-sidebar"
        onResize={event => props.layout.set({ sidebarWidth: event.size })}>
        {props.sidebar}
      </ResizablePanel>
      <ResizablePanel testID="desktop-main-panel" minSize={0}>
        <ResizablePanelGroup axis="vertical" class="flex-1" handleClass="bg-border group-hover:bg-muted-foreground" handleAccessibilityLabel={t('terminalView.bottomDock.resizeAria')}>
          <ResizablePanel minSize={0} visible={!state().terminalExpanded || !terminalOpen()}>
            <ResizablePanelGroup axis="horizontal" class="flex-1" handleClass="bg-border group-hover:bg-muted-foreground" handleAccessibilityLabel={t('contextPanel.actions.resizePanelAria')}>
              <ResizablePanel testID="desktop-chat-panel" minSize={350} visible={geometry().contentVisible}>{props.children}</ResizablePanel>
              <ResizablePanel testID="desktop-context-panel" minSize={0} maxSize={geometry().contentVisible ? 1400 : undefined} size={geometry().panel} visible={panelOpen()}
                onResize={event => props.layout.set({ panelWidth: event.size })}>{props.panel}</ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizablePanel testID="desktop-terminal-panel" minSize={120} size={state().terminalExpanded ? undefined : state().terminalHeight}
            visible={terminalOpen()} onResize={event => props.layout.set({ terminalHeight: event.size })}>{props.terminal}</ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  </View>;
}
