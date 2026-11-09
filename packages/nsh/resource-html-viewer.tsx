import { cleanup, effect, signal, untracked, View, Text } from 'nsh';
import type { JSX } from 'nsh/types';
import { Button, Dialog, NavPage, NavStack, createNavStack } from 'nsh/base';
import { t } from './i18n';
import { Icon } from './Icon';
import { createResourceHtmlViewer, type ResourceHtmlInput, type ResourceHtmlMount, type ResourceHtmlDialog, type ResourceHtmlViewerController } from './resource-html-viewer-state';

type ResourceHtmlViewerProps = {
  input: ResourceHtmlInput;
  title: string;
  /** Keep the lifecycle root while a changed path falls back to a non-HTML body. */
  inlineVisible?: boolean;
  identifyMount(): string;
  closePreview(owner: string): Promise<void>;
  renderPreview(mountIdentity: ResourceHtmlMount): JSX.Element;
  renderSource(): JSX.Element;
  renderStatus(): JSX.Element;
  renderActions(presentationOwner?: ResourceHtmlDialog): JSX.Element;
  /** Native phase: register this exact dialog controller through responder ancestry. */
  presentationAnchor(owner: ResourceHtmlDialog, lifecycle: { readonly closing: boolean; readonly closeAttempt: number; opened(): void; closed(): void; failed(attempt: number): void }): JSX.Element;
  onBack(): void;
  /** Parent retains this controller until async disposal/retirement is acknowledged. */
  controllerReady?(controller: ResourceHtmlViewerController): void;
};

/** Display/lifecycle only. The caller remains the only read/stat/lease/GUI owner. */
export function ResourceHtmlViewer(props: ResourceHtmlViewerProps) {
  const state = signal<ReturnType<ResourceHtmlViewerController['state']>>({ mode: 'preview', eligible: false, transitioning: false, mount: null, dialog: null, error: '' });
  const controller = createResourceHtmlViewer({ identifyMount: props.identifyMount, closePreview: props.closePreview, changed: value => state.set(value), back: props.onBack });
  let displayLive = true;
  cleanup(() => { displayLive = false; controller.detachDisplay(); void controller.dispose().catch(() => {}); });
  props.controllerReady?.(controller);
  effect(() => { if (!displayLive) return; const value = props.input; untracked(() => { void controller.update(value); }); });
  const failure = () => <If when={!!state().error}><Text testID="resource-html-close-error" class="text-destructive">{t('mobile.files.error.readUnavailable')}</Text><Button testID="resource-html-retry" onPress={() => { void controller.retry(); }}><Text class="text-foreground">{t('contextPanel.preview.actions.retry')}</Text></Button></If>;
  const actions = (owner?: ResourceHtmlDialog) => <View testID="resource-html-actions" class={owner ? 'flex-row items-center gap-2' : 'w-full min-w-0 gap-2'}>
    <View class="flex-row flex-wrap items-center gap-2"><If when={state().eligible}><Button testID="resource-html-mode" class="min-h-11 min-w-11 items-center justify-center" disabled={state().transitioning || !!state().error} onPress={() => { void controller.toggleMode(); }} accessibilityLabel={t(state().mode === 'preview' ? 'mobile.files.html.viewSourceAria' : 'mobile.files.html.viewPreviewAria')}><Icon name={state().mode === 'preview' ? 'file-code' : 'eye'} size={18} /></Button>
      <If when={!owner}><Button testID="resource-html-fullscreen" class="min-h-11 min-w-11 items-center justify-center" disabled={state().transitioning || !!state().error} onPress={() => { void controller.setFullscreen(true); }} accessibilityLabel={t('mobile.files.html.fullscreenAria')}><Icon name="fullscreen" size={18} /></Button></If>
    </If></View><View class={owner ? '' : 'w-full min-w-0'} style={{ pointerEvents: state().transitioning ? 'none' : 'auto' }}>{props.renderActions(owner)}</View>
  </View>;
  const body = (presentation: 'inline' | 'fullScreen') => <View class="flex-1">
    {props.renderStatus()}
    <Each of={state().mount?.presentation === presentation ? [state().mount!] : []} key={value => value.owner}>{value => props.renderPreview(value())}</Each>
    <If when={!state().mount && (state().mode === 'source' || !state().eligible)}>{() => props.renderSource()}</If>
    {failure()}
  </View>;
  return <View testID="resource-html-viewer" class={props.inlineVisible === false ? '' : 'flex-1'}>
    <If when={props.inlineVisible !== false && !state().dialog}>{actions()}{body('inline')}</If>
    <Each of={state().dialog ? [state().dialog!.generation] : []} key={value => value}>{ticket => {
      const generation = ticket(), owner = state().dialog!, title = props.title, nav = createNavStack(['html']);
      const anchor = props.presentationAnchor(owner, {
        get closing() { return state().dialog?.generation === generation && !state().dialog!.open; },
        get closeAttempt() { return state().dialog?.generation === generation ? state().dialog!.closeAttempt : 0; },
        opened() { void controller.dialogOpened(generation); }, closed() { void controller.dialogClosed(generation); },
        failed(attempt) { controller.dialogFailed(generation, attempt); },
      }), content = body('fullScreen');
      const page = <NavPage title={title} headerBackTitle="" popOnBack={false} popOnSwipe={false} class="flex-1 bg-background"
           headerLeft={<Button testID="resource-html-back" class="min-h-11 min-w-11 items-center justify-center" disabled={state().transitioning} accessibilityLabel={t('mobile.files.html.exitFullscreenAria')} onPress={() => { void controller.back(generation); }}><Icon name="arrow-left" size={20} /></Button>}
           onBackPress={() => { void controller.back(generation); }} headerRight={actions(owner)}>{content}</NavPage>;
      const display = <View class="flex-1">{anchor}<NavStack state={nav} class="flex-1">{() => page}</NavStack></View>;
      return <Dialog testID="resource-html-dialog" presentation="fullScreen" open
        closeOnSwipe={false} closeOnBackdropPress={false} closeOnEscape={false} class="flex-1 bg-background"
        onCancel={() => { void controller.back(generation); }} onOpen={() => { void controller.dialogOpened(generation); }} onClose={() => { void controller.dialogClosed(generation); }}>
        {display}
      </Dialog>;
    }}</Each>
  </View>;
}
