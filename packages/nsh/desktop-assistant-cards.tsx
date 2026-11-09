import { cleanup, colorScheme, computed, effect, Image, lifecycle, reduceMotion, signal, Text, token, untracked, View, type JSX, type TextStyle } from 'nsh';
import { Button } from 'nsh/base';
import { assistantAvatarSvg } from '../ui/src/lib/assistant-avatar/engine';
import { resolveAssistantAvatar } from '../ui/src/lib/assistant-avatar/recipe';
import { nativeAssistantAvatarClock, type NativeAvatarLease } from './assistants-avatar-clock';
import { nativeAppearance, nativeChatTextStyle } from './appearance';
import { NativeProviderLogo } from './provider-logo';
import { Icon } from './Icon';
import { t } from './i18n';
import type { Row } from './model';
import { desktopAssistantCardNavigable, desktopAssistantCardProvider, desktopAssistantScheduleCard, desktopAssistantSessionCard } from './desktop-assistant-card-model';

export type NativeDesktopAssistantCardProps = {
  /** Original content part; never rewritten for presentation or navigation. */
  card: Row;
  assistant?: Readonly<Row> | null;
  session?: Readonly<Row> | null;
  task?: Readonly<Row> | null;
  branch?: string | null;
  liveStatus?: { readonly type?: string } | null;
  /** Same scope as the existing native avatar clock: JSON.stringify([epoch, connectionID]). */
  avatarClockScope?: string;
  /** Exact retained owner identity AND foreground/modal admission. Rechecked at activation. */
  current: () => boolean;
  /** Existing owner resolves actual directory/catalog/task and guards its navigation. */
  onOpen: (card: Row) => void;
};

const string = (value: unknown) => typeof value === 'string' ? value : '';
function alpha(color: string, opacity: number) {
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(color);
  return match ? `#${match[1]}${Math.round((match[2] ? parseInt(match[2], 16) : 255) * opacity).toString(16).padStart(2, '0')}` : color;
}
function labelStyle(factor = 1, lineHeight = 16): TextStyle {
  const style = nativeChatTextStyle('uiLabel');
  return { ...style, fontSize: (style.fontSize ?? 14) * factor, lineHeight, numberOfLines: 1 };
}
function statusColor(status: string | null) {
  const colors = nativeAppearance.current()?.webTheme?.[colorScheme()].colors.status;
  if (status === 'busy') return colors?.info || token('ring');
  if (status === 'retry' || status === 'question') return colors?.warning || token('foreground');
  if (status === 'error') return token('destructive');
  if (status === 'complete' || status === 'idle') return token('success');
  return token('muted-foreground');
}

/** Same renderer and singleton working clock as every other native Bot avatar.
 * Scope is injected, so a receipt neither reads a connection store nor owns I/O. */
function CardAvatar(props: { id: string; assistant?: Readonly<Row> | null; scope?: string; current: () => boolean }) {
  const seed = computed(() => string(props.assistant?.avatarSeed) || props.id);
  const still = computed(() => 'data:image/svg+xml,' + encodeURIComponent(assistantAvatarSvg(seed())));
  const frame = signal('');
  let lease: NativeAvatarLease | undefined, key = '', alive = true;
  const release = () => { lease?.release(); lease = undefined; };
  effect(() => {
    const identity = props.id, value = seed(), scope = props.scope;
    const eligible = !!scope && props.current() && lifecycle() === 'active' && !reduceMotion() && resolveAssistantAvatar(value).animate;
    const working = props.assistant?.working === true || !!props.assistant?.activeContactTurn;
    const next = JSON.stringify([scope, identity, value]);
    untracked(() => {
      if (!eligible || key !== next) { release(); frame.set(''); }
      key = next;
      if (!eligible || !scope) return;
      if (lease) lease.working(working);
      else if (working) lease = nativeAssistantAvatarClock.subscribe(scope, identity, value, sample => {
        if (!alive || key !== next) return;
        frame.set(sample.uri);
        if (sample.settled) release();
      });
    });
  });
  cleanup(() => { alive = false; release(); });
  return <Image testID="desktop-assistant-card-avatar" accessible={false} src={frame() || still()} style={{ width: 32, height: 32 }} />;
}

function ModelLine(props: { value: string }) {
  const provider = computed(() => desktopAssistantCardProvider(props.value));
  return <View testID="desktop-assistant-card-model" class="flex-row items-center min-w-0 flex-1" style={{ gap: 6, height: 16 }} tooltip={<Text>{props.value}</Text>}>
    <If when={!!provider()} else={<Icon name="brain" size={14} color={token('muted-foreground')} />}><NativeProviderLogo providerID={provider()!} size={14} /></If>
    <Text class="text-muted-foreground flex-1 min-w-0" style={labelStyle(.75)}>{props.value}</Text>
  </View>;
}

function Cover(props: { source: NativeDesktopAssistantCardProps; label: string; children: JSX.Element }) {
  const current = () => props.source.current() && lifecycle() === 'active';
  return <Button testID={`desktop-assistant-receipt-${string(props.source.card.cardType)}`} role="button" accessibilityLabel={props.label}
    disabled={!current() || !desktopAssistantCardNavigable(props.source.card, props.source.session)}
    onPress={() => { if (current() && desktopAssistantCardNavigable(props.source.card, props.source.session)) props.source.onOpen(props.source.card); }}
    class="bg-muted min-w-0 shrink-0" hoverStyle={{ backgroundColor: alpha(nativeAppearance.current()?.webTheme?.[colorScheme()].colors.interactive.hover || token('accent'), .45) }}
    focusStyle={{ boxShadow: `0 0 0 2px ${token('ring')}` }}
    style={{ width: 304, maxWidth: '100%', height: 148, borderRadius: 21.6, paddingHorizontal: 16, paddingVertical: 10 }}>
    {props.children}
  </Button>;
}

function SessionCard(props: NativeDesktopAssistantCardProps) {
  const model = computed(() => desktopAssistantSessionCard(props.card, props.session, props.liveStatus, props.branch));
  const title = () => model().title || t('assistants.contact.card.session.untitled');
  return <Cover source={props} label={t('assistants.contact.card.session.aria', { title: title() })}>
    <View testID="desktop-assistant-card-header" class="flex-row items-center min-w-0 shrink-0" style={{ height: 32, marginBottom: 8, gap: 8 }}>
      <Icon name="chat-thread" size={16} color={token('muted-foreground')} /><Text class="text-muted-foreground min-w-0" style={labelStyle(.8)}>{t('assistants.contact.card.session.label')}</Text>
      <View class="flex-1" />
      <If when={!!model().statusKey}><View testID="desktop-assistant-card-status" class="flex-row items-center shrink-0" style={{ gap: 6 }}>
        <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor(model().status) }} />
        <Text style={{ ...labelStyle(.75), color: statusColor(model().status) }}>{t(model().statusKey!)}</Text>
      </View></If>
    </View>
    <Text testID="desktop-assistant-card-title" class="text-foreground font-medium min-w-0 shrink-0" style={{ ...labelStyle(1, 20), height: 20 }} tooltip={<Text>{title()}</Text>}>{title()}</Text>
    <View testID="desktop-assistant-card-session-details" class="min-w-0 shrink-0" style={{ height: 68, paddingVertical: 4, gap: 6 }}>
      <View testID="desktop-assistant-card-project" class="flex-row items-center min-w-0 shrink-0" style={{ height: 16, gap: 8 }}>
        <View class="flex-row items-center min-w-0" style={{ gap: 6, maxWidth: model().branch ? '45%' : '100%', flexShrink: model().branch ? 0 : 1 }} tooltip={<Text>{model().directory}</Text>}><Icon name="folder" size={14} color={token('muted-foreground')} /><Text class="text-foreground min-w-0" style={labelStyle(.8)}>{model().project}</Text></View>
        <If when={!!model().branch}><View testID="desktop-assistant-card-branch" class="flex-row items-center flex-1 min-w-0" style={{ gap: 4 }} tooltip={<Text>{model().branch}</Text>}><Icon name="git-branch" size={12} color={token('muted-foreground')} /><Text class="text-muted-foreground flex-1 min-w-0" style={labelStyle(.8)}>{model().branch}</Text></View></If>
      </View>
      <If when={!!model().changes}><View testID="desktop-assistant-card-changes" class="flex-row items-center min-w-0 shrink-0" style={{ height: 16, gap: 6 }}>
        <Icon name="code" size={14} color={token('muted-foreground')} />
        <If when={model().changes?.additions !== undefined}><Text style={{ ...labelStyle(.8), color: token('success'), fontVariant: ['tabular-nums'] }}>{`+${model().changes?.additions}`}</Text></If>
        <If when={model().changes?.deletions !== undefined}><Text style={{ ...labelStyle(.8), color: token('destructive'), fontVariant: ['tabular-nums'] }}>{`−${model().changes?.deletions}`}</Text></If>
        <If when={model().changes?.files !== undefined}><Text class="text-muted-foreground min-w-0" style={{ ...labelStyle(.8), fontVariant: ['tabular-nums'] }}>{t(model().changes?.files === 1 ? 'assistants.contact.card.session.changes.filesSingle' : 'assistants.contact.card.session.changes.filesPlural', { count: model().changes?.files ?? 0 })}</Text></If>
      </View></If>
      <View testID="desktop-assistant-card-footer" class="flex-row items-center min-w-0 shrink-0 mt-auto" style={{ height: 16, gap: 8 }}><If when={!!model().model} else={<View class="flex-1" />}><ModelLine value={model().model!} /></If><Icon name="arrow-right-s" size={16} color={token('muted-foreground')} /></View>
    </View>
  </Cover>;
}

function AssistantCard(props: NativeDesktopAssistantCardProps) {
  const title = () => string(props.card.name);
  const metadata = () => string(props.card.providerID) && string(props.card.modelID) ? `${string(props.card.providerID)}/${string(props.card.modelID)}` : '';
  return <Cover source={props} label={t('assistants.contact.card.assistant.aria', { name: title() })}>
    <View testID="desktop-assistant-card-header" class="flex-row items-center min-w-0 shrink-0" style={{ height: 32, marginBottom: 8, gap: 8 }}>
      <CardAvatar id={string(props.card.assistantID)} assistant={props.assistant} scope={props.avatarClockScope} current={props.current} />
      <Text class="text-muted-foreground min-w-0 flex-1" style={labelStyle(.8)}>{t('assistants.contact.card.assistant.label')}</Text><Icon name="arrow-right-s" size={16} color={token('muted-foreground')} />
    </View>
    <View class="justify-center min-w-0 shrink-0" style={{ height: 40 }}><Text testID="desktop-assistant-card-title" class="text-foreground font-medium min-w-0" style={labelStyle(1, 20)} tooltip={<Text>{title()}</Text>}>{title()}</Text></View>
    <View testID="desktop-assistant-card-footer" class="justify-end min-w-0 shrink-0" style={{ height: 48, paddingBottom: 4 }}><If when={!!metadata()}><View class="flex-row min-w-0" style={{ height: 16 }}><ModelLine value={metadata()} /></View></If></View>
  </Cover>;
}

function ScheduleCard(props: NativeDesktopAssistantCardProps) {
  const schedule = computed(() => desktopAssistantScheduleCard(props.card, props.task, t));
  const title = () => string(props.card.name), prompt = () => string(props.card.prompt).trim();
  return <Cover source={props} label={t('assistants.contact.card.schedule.aria', { name: title() })}>
    <View testID="desktop-assistant-card-header" class="flex-row items-center min-w-0 shrink-0" style={{ height: 32, marginBottom: 8, gap: 8 }}><Icon name="calendar" size={16} color={token('muted-foreground')} /><Text class="text-muted-foreground flex-1 min-w-0" style={labelStyle(.8)}>{t('assistants.contact.card.schedule.label')}</Text><Icon name="arrow-right-s" size={16} color={token('muted-foreground')} /></View>
    <Text testID="desktop-assistant-card-title" class="text-foreground font-medium min-w-0 shrink-0" style={{ ...labelStyle(1, 20), height: 20 }} tooltip={<Text>{title()}</Text>}>{title()}</Text>
    <View class="min-w-0 shrink-0" style={{ height: 20, paddingTop: 4 }}><If when={!!prompt()}><Text testID="desktop-assistant-card-prompt" class="text-muted-foreground min-w-0" style={labelStyle(.8)} tooltip={<Text>{prompt()}</Text>}>{prompt()}</Text></If></View>
    <View testID="desktop-assistant-card-footer" class="min-w-0 shrink-0 justify-end" style={{ height: 48 }}><View testID="desktop-assistant-card-time" class="flex-row items-baseline min-w-0" style={{ gap: 6, height: 22 }}>
      <If when={!!schedule().cadence}><Text testID="desktop-assistant-card-cadence" class="text-muted-foreground min-w-0" style={{ ...labelStyle(.75), maxWidth: '36%', flexShrink: 1 }} tooltip={<Text>{schedule().cadence}</Text>}>{schedule().cadence}</Text></If>
      <Text testID="desktop-assistant-card-clock" class="text-foreground min-w-0" style={{ ...labelStyle(schedule().clock ? 1.25 : .85, 22), flexShrink: 1, letterSpacing: schedule().clock ? -.3 : 0, fontVariant: ['tabular-nums'] }} tooltip={<Text>{schedule().value}</Text>}>{schedule().value}</Text>
    </View></View>
  </Cover>;
}

/** Pure presentation of the original three Web receipt types; no resource/navigation owner. */
export function NativeDesktopAssistantCard(props: NativeDesktopAssistantCardProps) {
  return <If when={props.card.cardType === 'session'} else={<If when={props.card.cardType === 'assistant'} else={<If when={props.card.cardType === 'schedule'}><ScheduleCard {...props} /></If>}><AssistantCard {...props} /></If>}><SessionCard {...props} /></If>;
}
