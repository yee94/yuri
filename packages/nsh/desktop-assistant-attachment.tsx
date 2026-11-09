import { cleanup, computed, effect, lifecycle, locale, signal, Text, untracked, View } from 'nsh';
import { Button, Progress } from 'nsh/base';
import { isVideoSource } from '../ui/src/components/chat/video';
import { assistantAttachmentDescriptor, type AssistantAttachmentDescriptor } from './assistant-attachment-model';
import { nativeChatTextStyle } from './appearance';
import { createDesktopAssistantAttachmentDownload } from './desktop-files-download';
import { historyImportProgressTokens } from './history-import';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { text, type Row } from './model';
import { native } from './runtime';
import { sameRuntimeScope } from './runtime-scope';
import { app, captureHostOperation } from './state';

type Props = {
  file: Row;
  assistantID: string;
  current(): boolean;
  onSelecting?(owner: object, selecting: boolean): void;
};
const action = 'min-h-8 px-2 rounded-md hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40 items-center justify-center self-start';

/** Contact URLs never grant Host filesystem authority. Only canonical descriptors
 * enter the existing native save owner; image/video preview remains a separate seam. */
export function NativeDesktopAssistantAttachment(props: Props) {
  const descriptor = computed(() => {
    try { return assistantAttachmentDescriptor({ assistantID: props.assistantID, ...props.file }, props.assistantID); }
    catch { return null; }
  });
  const downloadable = () => {
    const file = descriptor();
    return file && !file.mime.startsWith('image/') && !isVideoSource(file.filename ?? '', file.mime) ? file : null;
  };
  const keys = computed(() => {
    const file = downloadable(), scope = app.runtimeScope();
    return file && scope ? [JSON.stringify([scope, file])] : [];
  });
  return <If when={keys().length > 0} else={<View testID="desktop-assistant-attachment-unavailable" class="bg-muted min-w-0" style={{ borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 4 }}>
    <View class="flex-row items-center gap-2.5"><Icon name="file-text" size={16} /><Text class="text-foreground" style={{ ...nativeChatTextStyle('uiLabel'), numberOfLines: 1 }}>{text(props.file.filename) || t('assistants.contact.attachment.file')}</Text></View>
    <Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t('common.unavailable')}</Text>
  </View>}><Each of={keys()}>{() => <NativeAttachmentDownload attachment={downloadable()!} current={props.current} onSelecting={props.onSelecting} />}</Each></If>;
}

function NativeAttachmentDownload(props: { attachment: AssistantAttachmentDescriptor; current(): boolean; onSelecting?: Props['onSelecting'] }) {
  const attachment = props.attachment, operation = captureHostOperation(), host = operation.scope!;
  const revision = signal(0), probing = signal(false), unavailable = signal(false);
  const modalOwner = {};
  let alive = true;
  const authorityCurrent = () => alive && operation.current() && sameRuntimeScope(host, app.runtimeScope()) && lifecycle() === 'active';
  const current = () => authorityCurrent() && (props.current() || download.state().phase === 'choosing');
  const download = createDesktopAssistantAttachmentDownload(host, attachment, native, current, () => untracked(() => revision.set(revision() + 1)));
  const state = () => { revision(); return download.state(); };
  const loading = () => probing() || ['choosing', 'saving', 'checking'].includes(state().phase);
  const name = () => attachment.filename || t('assistants.contact.attachment.file');
  const mb = (bytes: number) => new Intl.NumberFormat(language() === 'system' ? locale() : language(), { maximumFractionDigits: 2 }).format(bytes / 1_000_000);
  effect(() => {
    const selecting = state().phase === 'choosing';
    untracked(() => props.onSelecting?.(modalOwner, selecting));
  });
  effect(() => {
    const active = props.current() && authorityCurrent();
    untracked(() => { if (active && ['choosing', 'saving', 'checking'].includes(download.state().phase)) void download.probe(); });
  });
  cleanup(() => { alive = false; download.dispose(); props.onSelecting?.(modalOwner, false); });
  async function save() {
    if (!props.current() || !authorityCurrent() || loading() || !['idle', 'saved'].includes(state().phase)) return;
    probing.set(true);
    try {
      await download.probe();
      if (!props.current() || !authorityCurrent()) return;
      unavailable.set(!download.state().available);
      if (download.state().available) await download.save();
    } finally { if (alive) probing.set(false); }
  }
  return <View testID={'desktop-assistant-attachment-' + attachment.attachmentID} class="bg-muted min-w-0" style={{ borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 4 }}>
    <View class="flex-row items-center gap-2.5"><Icon name="file-text" size={16} /><Text class="text-foreground" style={{ ...nativeChatTextStyle('uiLabel'), numberOfLines: 1 }}>{name()}</Text></View>
    <If when={loading()}><Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t('common.loading')}</Text></If>
    <If when={state().phase !== 'idle' && state().phase !== 'choosing'}>
      <Progress testID="desktop-assistant-attachment-progress" value={state().total !== null && state().total! > 0 ? Math.min(state().phase === 'saved' ? 100 : 99, state().received / state().total! * 100) : 0}
        indeterminate={state().total === null && state().phase === 'saving'} accessibilityLabel={t('backgroundTasks.download')}
        trackClass="h-1 overflow-hidden rounded-full" trackStyle={{ backgroundColor: historyImportProgressTokens().track }}
        indicatorClass={'h-full rounded-full' + (state().total === null ? ' w-1/3' : '')}
        indicatorStyle={{ backgroundColor: ['error', 'unknown'].includes(state().phase) ? historyImportProgressTokens().error : historyImportProgressTokens().fill }} />
      <Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t(state().total === null ? 'backgroundTasks.downloadedUnknownTotal' : 'backgroundTasks.downloaded', { completed: mb(state().received), total: mb(state().total ?? 0) })}</Text>
    </If>
    <If when={unavailable()}><Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t('common.unavailable')}</Text></If>
    <If when={state().phase === 'error' || state().phase === 'unknown'}><Text role="alert" class="text-destructive" style={nativeChatTextStyle('micro')}>{t(state().phase === 'unknown' ? 'chat.questionDelegate.uncertain' : 'assistants.contact.attachment.loadFailed')}</Text></If>
    <If when={!loading() && ['idle', 'saved'].includes(state().phase)}><Button testID="desktop-assistant-attachment-download" class={action} disabled={!props.current() || !authorityCurrent() || unavailable()} onPress={() => { void save(); }}><Text class="text-foreground">{t('assistants.contact.attachment.download')}</Text></Button></If>
    <If when={state().phase === 'unknown'}><Button testID="desktop-assistant-attachment-inspect" class={action} disabled={!props.current() || !authorityCurrent()} onPress={() => { void download.inspect(); }}><Text>{t('chat.questionDelegate.refreshStatus')}</Text></Button></If>
    <If when={state().phase === 'error'}><Button testID="desktop-assistant-attachment-resume" class={action} disabled={!props.current() || !authorityCurrent() || !state().resumable} onPress={() => { void download.resume(); }}><Text>{t('backgroundTasks.resume')}{state().resumable ? '' : ' · ' + t('common.unavailable')}</Text></Button></If>
    <If when={['saving', 'checking', 'error', 'unknown'].includes(state().phase)}><Button testID="desktop-assistant-attachment-cancel" class={action} disabled={!props.current() || !authorityCurrent()} onPress={() => { void download.cancel(); }}><Text>{t('gitView.common.cancel')}</Text></Button></If>
  </View>;
}
