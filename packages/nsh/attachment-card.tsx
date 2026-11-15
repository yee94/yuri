import { cleanup, computed, effect, Image, lifecycle, signal, Text, View, untracked, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { nativeAttachmentImage, nativeAttachmentName, nativeAttachmentSource, scheduleAttachmentRead } from './attachment-presentation';
import { NativeContentImage } from './native-image-preview';
import { ResourceRasterPresentation } from './resource-raster-presentation';
import { ResourceSVGImage } from './resource-svg';
import { bindContactAttachmentRead, bindResourceRead } from './resources-request';
import type { ResourceContent } from './resources-model';
import { app } from './state';
import { native } from './runtime';
import { sameRuntimeScope, runtimeScopeFrom } from './runtime-scope';
import { id, type ChatTarget, type Row } from './model';
import { t } from './i18n';

type AttachmentCardProps = { file: Row; target: ChatTarget; current: () => boolean; compact?: boolean; onOpen?: () => void; onRemove?: () => void; removeDisabled?: boolean; removeTestID?: string };

/** A renewed native authority retires the old leaf before a new read can start. */
export function NativeAttachmentCard(props: AttachmentCardProps) {
  const scope = computed(() => JSON.stringify(app.runtimeScope()));
  return <Each of={[scope()]}>{() => <AttachmentCardOwner file={props.file} target={props.target} current={props.current} compact={props.compact}
    onOpen={props.onOpen} onRemove={props.onRemove} removeDisabled={props.removeDisabled} removeTestID={props.removeTestID} />}</Each>;
}

/** One mounted source owns its exact read and lease. No file bytes or credentials enter URLs. */
function AttachmentCardOwner(props: AttachmentCardProps) {
  const scope = runtimeScopeFrom(app.runtimeScope()), origin = app.connection()?.url ?? '';
  const source = computed(() => nativeAttachmentSource(props.file, props.target, scope?.hostID ?? '', origin));
  const image = () => nativeAttachmentImage(props.file);
  const name = () => nativeAttachmentName(props.file) || t('chat.chatInput.fileFallback');
  const content = signal<ResourceContent | null>(null), error = signal(false), loading = signal(false);
  let revision = 0, alive = true, requestID: string | undefined, held: string | undefined;
  const active = () => alive && props.current() && lifecycle() === 'active' && sameRuntimeScope(scope, app.runtimeScope());
  function release(lease: string) { void native('resources.close', { lease }).catch(() => {}).then(() => native('resources.release', { lease })).catch(() => {}); }
  function clear() {
    revision++;
    if (requestID) void native('resources.cancel', { requestId: requestID }).catch(() => {});
    requestID = undefined;
    if (held) release(held);
    held = undefined; content.set(null); loading.set(false);
  }
  async function load() {
    if (!active() || !image() || loading()) return;
    const input = source();
    if (input.kind === 'direct') return;
    if (input.kind === 'unavailable') { error.set(true); return; }
    const ticket = ++revision, requestId = id();
    const current = () => active() && ticket === revision;
    loading.set(true); error.set(false); requestID = requestId;
    try {
      const next = await scheduleAttachmentRead(current, async () => (input.kind === 'contact'
        ? bindContactAttachmentRead(scope, native)(input.file, requestId)
        : bindResourceRead(scope, native)(input.path, requestId))) as ResourceContent;
      if (!current()) { release(next.lease); return; }
      if (held) release(held);
      held = next.lease; content.set(next);
      if (next.kind !== 'svg' && (next.kind !== 'image' || !next.thumbnail)) error.set(true);
    } catch { if (current()) error.set(true); }
    finally { if (current()) { requestID = undefined; loading.set(false); } }
  }
  effect(() => {
    const input = source(), visible = active(), isImage = image();
    untracked(() => { clear(); error.set(false); if (visible && isImage && input.kind !== 'direct') void load(); });
  });
  cleanup(() => { alive = false; clear(); });
  const src = () => { const input = source(); return active() ? input.kind === 'direct' ? input.src : content()?.kind === 'svg' ? `resource:${content()!.lease}` : content()?.thumbnail ?? '' : ''; };
  const renderImage = computed(() => {
    const value = content();
    if (!value || !scope) return undefined;
    const valid = () => active() && content()?.lease === value.lease;
    return (fullscreen: boolean) => value.kind === 'svg'
      ? <ResourceSVGImage class="w-full h-full" config={{ lease: value.lease, expectedHost: scope, active: valid() }} />
      : fullscreen ? <ResourceRasterPresentation config={{ lease: value.lease, expectedHost: scope, active: valid() }} />
      : <Image src={value.thumbnail ?? ''} class="w-full h-full" style={{ objectFit: 'contain' }} />;
  });
  return <View testID="native-attachment" class={props.compact ? 'max-w-full' : 'w-full min-w-0'}>
    <If when={image()} else={<Button testID="attachment-file-open" class="flex-row items-center gap-2 px-3 py-2 rounded-xl bg-secondary" disabled={!active() || !props.onOpen} onPress={() => { if (active()) props.onOpen?.(); }}>
      <Icon name="attachment-2" size={16} /><Text class="text-sm text-foreground" style={{ flexShrink: 1, numberOfLines: 1, textOverflow: 'ellipsis' }}>{name()}</Text>
    </Button>}>
      <View style={{ maxWidth: '100%', alignSelf: 'flex-start' }}>
      <NativeContentImage testID="attachment-image" src={src()} label={name()} active={active()} current={active} compact={props.compact}
        width={content()?.width} height={content()?.height} frameWidth={props.compact ? 64 : windowSize().width} frameHeight={props.compact ? 64 : 160}
        renderImage={renderImage()} />
      <If when={loading()}><View class="absolute inset-0 items-center justify-center" style={{ pointerEvents: 'none' }}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></View></If>
      <If when={error()}><View class="absolute inset-0 items-center justify-center"><Button testID="attachment-preview-retry" class="min-h-9 px-2" onPress={() => { void load(); }}><Text class="text-xs text-destructive" style={{ textAlign: 'center' }}>{props.compact ? t('chat.questionDelegate.retry') : `${t('mobile.files.error.readUnavailable')} · ${t('chat.questionDelegate.retry')}`}</Text></Button></View></If>
      </View>
    </If>
    <If when={!!props.onRemove}><Button testID={props.removeTestID} disabled={props.removeDisabled || !active()} class="absolute top-0 right-0 min-w-8 min-h-8 rounded-full bg-secondary items-center justify-center" accessibilityLabel={t('chat.chatInput.actions.attachCancel')} onPress={() => { if (active() && !props.removeDisabled) props.onRemove?.(); }}><Icon name="close" size={14} /></Button></If>
  </View>;
}
