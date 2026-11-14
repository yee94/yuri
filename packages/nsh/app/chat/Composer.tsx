import { Image, Text, View, keyboardFrame, signal } from 'nsh';
import { Button, Input } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { Spinner, alpha } from '../core/ui';
import { getProviderModelDisplayName } from '../../../ui/src/lib/modelDisplay';
import { Autocomplete, type Trigger } from './Autocomplete';
import { attachmentSize, mediaUri, referenceLabel } from './references';
import { attachmentsFor, pickAttachment, removeAttachment } from './attachments';
import {
  addReference,
  cancelInbox,
  compactSession,
  modelEntries,
  removeReference,
  send,
  setDraft,
  steerInbox,
  stop,
  sameModel,
  type Catalog,
  type Conversation,
} from './store';
import { openNewSession } from '../shell/nav';
import type { Row } from '../core/host';

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');
const recordOf = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

/** The `/command` or `@file` token under the caret. */
export function activeTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const slash = /(^|\s)\/([\w:-]*)$/.exec(line);
  if (slash) {
    const start = lineStart + slash.index + slash[1]!.length;
    return { kind: 'command', query: slash[2] ?? '', start, end: caret };
  }
  const mention = /(^|\s)@([^\s@]*)$/.exec(line);
  if (mention) {
    const start = lineStart + mention.index + mention[1]!.length;
    return { kind: 'file', query: mention[2] ?? '', start, end: caret };
  }
  return null;
}

/** Web `QueuedMessageChips`: the queue card sits behind the composer card and
 * keeps one compact row per message (remove, text, edit, steer). */
function QueueChips(props: { conversation: Conversation }) {
  const items = () => props.conversation.inbox().filter((row) => !textOf(row.type) || textOf(row.type) === 'user');
  const bodyOf = (row: Row) => textOf(recordOf(row.payload).text) || textOf(row.text);
  const edit = (id: string, text: string) => {
    if (!text) return;
    setDraft(props.conversation, text);
    void cancelInbox(props.conversation, id);
  };
  return (
    <If when={items().length > 0}>
      <View
        testID="chat-queue"
        style={{
          zIndex: 0,
          marginHorizontal: 6,
          marginBottom: -18,
          borderWidth: 0.5,
          borderColor: alpha(colors.border(), 0.5),
          borderRadius: 20,
          backgroundColor: alpha(colors.card(), 0.92),
          paddingHorizontal: 6,
          paddingTop: 4,
          paddingBottom: 22,
        }}
      >
        <Each of={items()} key={(item) => textOf(item.id)}>
          {(item) => {
            const id = () => textOf(item().id);
            const text = () => bodyOf(item());
            const busy = () => props.conversation.busyItem() === id();
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28 }}>
                <Button
                  onPress={() => void cancelInbox(props.conversation, id())}
                  accessibilityLabel={t('chat.queuedMessage.removeAria')}
                  activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                  style={{ width: 22, height: 28, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="delete-bin" size={12} tone="muted" />
                </Button>
                <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: colors.foreground(), numberOfLines: 1 }}>
                  {text() || t('chat.queuedMessage.empty')}
                </Text>
                <If
                  when={busy()}
                  else={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Button
                        onPress={() => edit(id(), text())}
                        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 28, paddingHorizontal: 2 }}
                      >
                        <Icon name="pencil" size={12} tone="muted" />
                        <Text style={{ fontSize: 11, fontWeight: '500', color: colors.mutedForeground() }}>
                          {t('chat.queuedMessage.edit')}
                        </Text>
                      </Button>
                      <Button
                        onPress={() => void steerInbox(props.conversation, id())}
                        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 28, paddingHorizontal: 2 }}
                      >
                        <Icon name="corner-down-left" size={12} tone="muted" />
                        <Text style={{ fontSize: 11, fontWeight: '500', color: colors.mutedForeground() }}>
                          {t('chat.queuedMessage.send')}
                        </Text>
                      </Button>
                    </View>
                  }
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 2 }}>
                    <Spinner size={11} />
                    <Text style={{ fontSize: 11, fontWeight: '500', color: colors.mutedForeground() }}>
                      {t('chat.queuedMessage.sending')}
                    </Text>
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}

/** Picked uploads and confirmed `@file` / `/command` / quote chips, each removable. */
function ComposerChips(props: { conversation: Conversation }) {
  const attachments = attachmentsFor(props.conversation);
  const references = () => props.conversation.references();
  return (
    <If when={attachments.items().length > 0 || references().length > 0}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 6 }}>
        <Each of={attachments.items()} key={(item) => item.requestId}>
          {(item) => {
            const image = () => item().mime.startsWith('image/') && !!mediaUri(item().uri);
            return (
              <View
                testID={`attachment-chip-${item().name}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: 240,
                  paddingHorizontal: 6,
                  paddingVertical: 4,
                  borderRadius: 10,
                  backgroundColor: alpha(colors.muted(), 0.6),
                }}
              >
                <If when={image()} else={<Icon name="file-text" size={12} tone="muted" />}>
                  <Image src={item().uri} style={{ width: 22, height: 22, borderRadius: 5, objectFit: 'cover', backgroundColor: colors.muted() }} />
                </If>
                <View style={{ flexShrink: 1, gap: 0 }}>
                  <Text style={{ fontSize: 11, color: colors.foreground(), numberOfLines: 1 }}>{item().name}</Text>
                  <If when={!!attachmentSize(item().size)}>
                    <Text style={{ fontSize: 9, color: colors.mutedForeground(), numberOfLines: 1 }}>{attachmentSize(item().size)}</Text>
                  </If>
                </View>
                <Button
                  testID={`attachment-remove-${item().name}`}
                  accessibilityLabel={t('chat.fileAttachment.actions.removeNamed', { name: item().name })}
                  onPress={() => void removeAttachment(props.conversation, item().requestId)}
                  style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="close" size={10} tone="muted" />
                </Button>
              </View>
            );
          }}
        </Each>
        <Each of={references()} key={(reference) => reference.id}>
          {(reference) => (
            <View
              testID={`reference-chip-${reference().id}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                maxWidth: 240,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 10,
                backgroundColor: alpha(colors.muted(), 0.6),
              }}
            >
              <Icon
                name={() => (reference().kind === 'command' ? 'slash-commands-2' : reference().kind === 'quote' ? 'chat-thread' : 'file-text')}
                size={11}
                tone="muted"
              />
              <Text style={{ flexShrink: 1, fontSize: 11, color: colors.foreground(), numberOfLines: 1 }}>
                {referenceLabel(reference())}
              </Text>
              <Button
                testID={`reference-remove-${reference().id}`}
                accessibilityLabel={t('chat.fileAttachment.actions.removeNamed', { name: referenceLabel(reference()) })}
                onPress={() => removeReference(props.conversation, reference().id)}
                style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="close" size={10} tone="muted" />
              </Button>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

function modelLabel(catalog: Catalog, conversation: Conversation): string {
  const selection = conversation.selection();
  const entry = modelEntries(catalog).find((candidate) => sameModel(candidate, selection));
  if (!entry) return selection.modelID || t('chat.modelControls.selectModel');
  return getProviderModelDisplayName(entry.provider, entry.modelID, { fallbackLabel: entry.modelID });
}

/** Liquid Glass composer card: draft, chips, queue, model/agent, attach, send or stop. */
export function Composer(props: {
  conversation: Conversation;
  catalog: () => Catalog;
  onOpenPicker: (tab: 'model' | 'agent') => void;
  /** Web composer swap: 0 full card, 1 compact pill. */
  progress: () => number;
  /** The compact pill asks the transcript to come back to the live edge. */
  onExpand: () => void;
}) {
  const caret = signal(0);
  const attachments = attachmentsFor(props.conversation);
  const draft = () => props.conversation.draft();
  const busy = () => props.conversation.busy();
  const canSend = () => (!!draft().trim() || attachments.items().length > 0) && !props.conversation.sending();
  const trigger = () => activeTrigger(draft(), caret());
  const pick = (choice: { kind: 'file' | 'command' | 'agent' | 'skill'; value: string }) => {
    const token = trigger();
    if (!token) return;
    // Web local commands run here; the server owns every other command name.
    if (choice.kind === 'command') {
      const name = choice.value.trim().toLowerCase();
      if (name === 'model') {
        setDraft(props.conversation, '');
        props.onOpenPicker('model');
        return;
      }
      if (name === 'compact') {
        setDraft(props.conversation, '');
        void compactSession(props.conversation);
        return;
      }
      if (name === 'new') {
        setDraft(props.conversation, '');
        openNewSession(props.conversation.directory(), props.conversation.remote ?? undefined);
        return;
      }
    }
    const text = draft();
    const marker = choice.kind === 'command' ? '/' : '@';
    const value = `${marker}${choice.value} `;
    setDraft(props.conversation, `${text.slice(0, token.start)}${value}${text.slice(token.end)}`);
    caret.set(token.start + value.length);
    if (choice.kind === 'file' || choice.kind === 'command') {
      addReference(props.conversation, { kind: choice.kind, value: choice.value });
    }
  };
  const primary = () => {
    if (busy() && !draft().trim()) {
      void stop(props.conversation);
      return;
    }
    void send(props.conversation);
  };
  const selection = () => props.conversation.selection();
  const failure = () => attachments.error() || props.conversation.error();
  const sendLabel = () =>
    busy() && !draft().trim()
      ? t('chat.chatInput.actions.stopGeneratingAria')
      : t('chat.chatInput.actions.sendMessageAria');
  const sendBackground = () =>
    busy() && !draft().trim()
      ? alpha(colors.foreground(), 0.9)
      : canSend()
        ? colors.foreground()
        : alpha(colors.muted(), 0.9);
  const compact = () => props.progress() > 0.5;
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: keyboardFrame().height > 0 ? 'env(keyboard-inset-height)' : 'calc(env(safe-area-inset-bottom) + 8px)',
      }}
    >
      <View style={{ position: 'relative' }}>
        <View
          style={{
            transform: props.progress() > 0.001 ? `translateY(${props.progress() * 110}%)` : 'none',
            opacity: 1 - Math.min(1, props.progress() * 2),
          }}
        >
          <QueueChips conversation={props.conversation} />
          <View
            focusWithinStyle={{ backgroundColor: alpha(colors.card(), 0.92) }}
            style={{
              position: 'relative',
              borderRadius: radius.surface,
              backgroundColor: alpha(colors.card(), 0.82),
              backdropFilter: 'blur(22px) saturate(1.35)',
              glassEffect: 'regular',
              boxShadow: '0 0 0 0.5px rgba(0,0,0,0.05), 0 10px 30px -16px rgba(0,0,0,0.3)',
              paddingHorizontal: 10,
              paddingTop: 8,
              paddingBottom: 6,
              gap: 2,
            }}
          >
            <Autocomplete conversation={props.conversation} catalog={props.catalog} trigger={trigger} onPick={pick} />
            <ComposerChips conversation={props.conversation} />
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
              <Input
                testID="chat-input"
                value={draft()}
                onChange={(event) => setDraft(props.conversation, event.value)}
                onSelectionChange={(event) => caret.set(event.end)}
                placeholder={t('chat.chatInput.placeholder.chatCompact')}
                multiline
                autoCapitalize="sentences"
                activeStyle={{ opacity: 0.9 }}
                style={{
                  flex: 1,
                  minHeight: 38,
                  maxHeight: 160,
                  paddingHorizontal: 4,
                  paddingVertical: 6,
                  fontSize: 15,
                  lineHeight: 20,
                  color: colors.foreground(),
                  placeholderColor: colors.mutedForeground(),
                  backgroundColor: 'transparent',
                }}
              />
              <Button
                testID="chat-send"
                accessibilityLabel={sendLabel()}
                onPress={primary}
                disabled={!(busy() && !draft().trim()) && !canSend()}
                activeStyle={{ transform: 'scale(0.9)', opacity: 0.85 }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: sendBackground(),
                }}
              >
                <If
                  when={busy() && !draft().trim()}
                  else={
                    <Icon
                      name="arrow-up"
                      size={16}
                      color={() => (canSend() ? colors.background() : colors.mutedForeground())}
                    />
                  }
                >
                  <View style={{ width: 11, height: 11, borderRadius: 2.5, backgroundColor: colors.background() }} />
                </If>
              </Button>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 26 }}>
              <Button
                testID="chat-attach"
                onPress={() => void pickAttachment(props.conversation, 'files')}
                disabled={attachments.busy()}
                accessibilityLabel={t('chat.chatInput.actions.attachFiles')}
                activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
                style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}
              >
                <If when={attachments.busy()} else={<Icon name="attachment-2" size={15} tone="muted" />}>
                  <Spinner size={12} />
                </If>
              </Button>
              <Button
                testID="chat-agent"
                onPress={() => props.onOpenPicker('agent')}
                accessibilityLabel={t('chat.chatInput.actions.modelAgentSettings')}
                activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, height: 26, borderRadius: 8 }}
              >
                <Icon name="ai-agent" size={14} tone="muted" />
                <Text style={{ fontSize: 11, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
                  {textOf(selection().agent) || t('chat.chatInput.actions.modelAgentSettings')}
                </Text>
              </Button>
              <View style={{ flex: 1 }} />
              <Button
                testID="chat-model"
                onPress={() => props.onOpenPicker('model')}
                accessibilityLabel={t('chat.modelControls.selectModel')}
                activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, height: 26, borderRadius: 8, maxWidth: 190 }}
              >
                <Text style={{ flexShrink: 1, fontSize: 11, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
                  {modelLabel(props.catalog(), props.conversation)}
                </Text>
                <If when={!!selection().variant}>
                  <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>{selection().variant}</Text>
                </If>
                <Icon name="arrow-up-s" size={11} tone="muted" />
              </Button>
            </View>
          </View>
        </View>
        <If when={compact()}>
          <View
            testID="chat-composer-compact"
            style={{
              position: 'absolute',
              zIndex: 30,
              left: '10%',
              right: '10%',
              bottom: 0,
              height: 44,
              borderRadius: 24,
              borderWidth: 1,
              borderColor: alpha(colors.border(), 0.5),
              backgroundColor: alpha(colors.card(), 0.96),
              boxShadow: '0 2px 6px -3px rgba(0,0,0,0.06)',
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 8,
              gap: 4,
            }}
          >
            <Button
              testID="chat-compact-attach"
              onPress={() => void pickAttachment(props.conversation, 'files')}
              disabled={attachments.busy()}
              activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
              style={{ width: 28, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <If when={attachments.busy()} else={<Icon name="attachment-2" size={15} tone="muted" />}>
                <Spinner size={12} />
              </If>
            </Button>
            <Button
              testID="chat-compact-expand"
              onPress={props.onExpand}
              activeStyle={{ opacity: 0.85 }}
              style={{ flex: 1, height: 44, justifyContent: 'center' }}
            >
              <Text
                style={{
                  fontSize: 14,
                  color: draft().trim() ? colors.foreground() : colors.mutedForeground(),
                  numberOfLines: 1,
                }}
              >
                {draft().trim() || t('chat.chatInput.placeholder.chatCompact')}
              </Text>
            </Button>
            <Button
              testID="chat-compact-send"
              accessibilityLabel={sendLabel()}
              onPress={primary}
              disabled={!(busy() && !draft().trim()) && !canSend()}
              activeStyle={{ transform: 'scale(0.9)', opacity: 0.85 }}
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: sendBackground(),
              }}
            >
              <If
                when={busy() && !draft().trim()}
                else={<Icon name="arrow-up" size={13} color={() => (canSend() ? colors.background() : colors.mutedForeground())} />}
              >
                <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors.background() }} />
              </If>
            </Button>
          </View>
        </If>
      </View>
      <If when={!!failure()}>
        <Text style={{ paddingHorizontal: 6, paddingTop: 6, fontSize: 12, color: colors.destructive(), numberOfLines: 3 }}>
          {failure()}
        </Text>
      </If>
    </View>
  );
}
