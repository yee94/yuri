import { Image, Scroll, Text, View, effect, signal, type Signal } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, statusColor } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { Spinner, alpha, fontSize } from '../core/ui';
import { Markdown } from './Markdown';
import { openMessageMenu } from './actions';
import { mediaUri } from './references';
import {
  activityCounts,
  messageDuration,
  messageTps,
  toolName,
  toolSettled,
  toolState,
  teamTool,
  type RowGroup,
} from './model';
import type { Conversation, MessageEntry, PartEntry } from './store';
import { retryMessage } from './store';

const expansions = new Map<string, Signal<boolean>>();

function expansionFor(key: string, initial: boolean): Signal<boolean> {
  const existing = expansions.get(key);
  if (existing) return existing;
  const created = signal(initial);
  expansions.set(key, created);
  return created;
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

const TOOL_ICONS: Record<string, IconName> = {
  read: 'file-text',
  write: 'file-edit',
  edit: 'pencil-ai',
  multiedit: 'pencil-ai',
  bash: 'terminal-box',
  shell: 'terminal-box',
  glob: 'folder-open',
  grep: 'search',
  list: 'list-unordered',
  webfetch: 'global',
  fetch: 'global',
  task: 'ai-agent',
  skill: 'sparkling',
  question: 'question',
  todo: 'list-check-2',
};

const toolIcon = (name: string): IconName => TOOL_ICONS[name.toLowerCase()] ?? 'tools';

const inputOf = (part: Record<string, unknown>): Record<string, unknown> => {
  const state = toolState(part);
  const raw = state.input;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { command: raw };
    }
    return { value: raw };
  }
  return {};
};

const pick = (input: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
};

export function toolSummary(part: Record<string, unknown>): string {
  const input = inputOf(part);
  return (
    pick(input, ['description', 'command', 'filePath', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) ||
    pick(input, ['filename', 'name'])
  );
}

const pretty = (value: unknown): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

function MetaLine(props: { entry: () => MessageEntry; show: boolean }) {
  const info = () => props.entry().info();
  const model = () => textOf(info().modelName) || textOf(info().modelID);
  const duration = () => messageDuration(info());
  const tps = () => messageTps(info());
  return (
    <If when={props.show && (!!model() || duration() > 0)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <If when={!!model()}>
          <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{model()}</Text>
        </If>
        <If when={duration() > 0}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="hourglass" size={11} tone="muted" />
            <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>
              {duration() < 1000 ? `${Math.round(duration())}ms` : `${(duration() / 1000).toFixed(1)}s`}
            </Text>
          </View>
        </If>
        <If when={!!tps()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="pulse" size={11} tone="muted" />
            <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{tps()}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

function Reasoning(props: { part: () => Record<string, unknown>; live: () => boolean }) {
  const text = () => textOf(props.part().text);
  const key = () => `reason:${textOf(props.part().id) || text().slice(0, 12)}`;
  const expanded = expansionFor(key(), false);
  const summary = () => {
    const line = text().trim().split('\n')[0] ?? '';
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  };
  return (
    <View style={{ gap: 6 }}>
      <Button
        onPress={() => expanded.set(!expanded())}
        accessibilityLabel={expanded() ? t('chat.reasoningTrace.collapseAria') : t('chat.reasoningTrace.expandAria')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}
      >
        <Icon name="brain-ai-3" size={13} tone="muted" />
        <Text style={{ fontSize: 13, color: colors.mutedForeground(), fontWeight: '500' }}>
          {t('chat.reasoningTrace.thinking')}
        </Text>
        <If when={!expanded() && !!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 12, color: alpha(colors.mutedForeground(), 0.8), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={12} tone="muted" />
      </Button>
      <If when={expanded()}>
        <View style={{ borderLeftWidth: 2, borderLeftColor: alpha(colors.border(), 0.9), paddingLeft: 10 }}>
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.mutedForeground() }}>{text()}</Text>
        </View>
      </If>
    </View>
  );
}

function ToolDetail(props: { part: () => Record<string, unknown> }) {
  const state = () => toolState(props.part());
  const input = () => pretty(state().input);
  const output = () => textOf(state().output);
  const error = () => textOf(state().error);
  return (
    <View
      style={{
        gap: 6,
        marginTop: 6,
        padding: 8,
        borderRadius: 10,
        backgroundColor: alpha(colors.muted(), 0.45),
      }}
    >
      <If when={!!input()}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground() }}>
          {t('chat.permissionCard.details')}
        </Text>
        <Scroll style={{ maxHeight: 200 }} scrollbar={false}>
          <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.foreground() }}>{input()}</Text>
        </Scroll>
      </If>
      <If when={!!error()}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.destructive() }}>
          {t('chat.permissionCard.details')}
        </Text>
        <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.destructive() }}>{error()}</Text>
      </If>
      <If when={!!output()}>
        <Scroll style={{ maxHeight: 260 }} scrollbar={false}>
          <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.foreground() }}>{output()}</Text>
        </Scroll>
      </If>
    </View>
  );
}

function ToolRow(props: { part: () => Record<string, unknown>; nested?: boolean }) {
  const name = () => toolName(props.part());
  const settled = () => toolSettled(props.part());
  const failed = () => textOf(toolState(props.part()).status) === 'error';
  const key = () => `tool:${textOf(props.part().id)}`;
  const expanded = expansionFor(key(), false);
  const summary = () => toolSummary(props.part());
  return (
    <View>
      <Button
        onPress={() => expanded.set(!expanded())}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          paddingVertical: 4,
          paddingHorizontal: props.nested ? 2 : 0,
        }}
      >
        <Icon name={toolIcon(name())} size={14} tone="muted" />
        <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
          {name()}
        </Text>
        <If when={!!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <If when={!settled()}>
          <Spinner size={11} />
        </If>
        <If when={settled() && failed()}>
          <Icon name="error-warning" size={13} color={() => statusColor('error')} />
        </If>
        <Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={12} tone="muted" />
      </Button>
      <If when={expanded()}>
        <ToolDetail part={props.part} />
      </If>
    </View>
  );
}

function Activity(props: { parts: () => PartEntry[]; key: () => string; live: () => boolean; last: () => boolean }) {
  const names = () => props.parts().map((part) => toolName(part.sig()));
  const active = () => props.parts().some((part) => !toolSettled(part.sig()));
  const initial = props.last() && props.live();
  const expanded = expansionFor(props.key(), initial);
  const counts = () => activityCounts(names());
  const summary = () => {
    const value = counts();
    const out: string[] = [];
    const add = (count: number, single: string, plural: string) => {
      if (count > 0) out.push(t(count === 1 ? (single as never) : (plural as never), { count }));
    };
    add(value.search ?? 0, 'chat.contextGroup.searchSingle', 'chat.contextGroup.searchPlural');
    add(value.read ?? 0, 'chat.contextGroup.readSingle', 'chat.contextGroup.readPlural');
    add(value.list ?? 0, 'chat.contextGroup.listSingle', 'chat.contextGroup.listPlural');
    add(value.edit ?? 0, 'chat.usedGroup.editSingle', 'chat.usedGroup.editPlural');
    add(value.command ?? 0, 'chat.usedGroup.commandSingle', 'chat.usedGroup.commandPlural');
    add(value.other ?? 0, 'chat.usedGroup.otherSingle', 'chat.usedGroup.otherPlural');
    return out.join(', ');
  };
  return (
    <View>
      <Button
        onPress={() => expanded.set(!expanded())}
        accessibilityLabel={expanded() ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 5, borderRadius: 8 }}
      >
        <If when={active()} else={<Icon name="check-double" size={13} tone="muted" />}>
          <Spinner size={12} />
        </If>
        <Text style={{ fontSize: 13, fontWeight: '500', color: colors.mutedForeground() }}>
          {active() ? t('chat.activity.active') : t('chat.usedGroup.used')}
        </Text>
        <If when={!!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 12, color: alpha(colors.mutedForeground(), 0.85), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={12} tone="muted" />
      </Button>
      <If when={expanded()}>
        <View style={{ gap: 4, marginTop: 2, paddingLeft: 6 }}>
          <Each of={props.parts()} key={(part) => part.key}>
            {(part) => <ToolRow part={() => part().sig()} nested />}
          </Each>
        </View>
      </If>
    </View>
  );
}

type Node =
  | { kind: 'text'; key: string; part: PartEntry }
  | { kind: 'reasoning'; key: string; part: PartEntry }
  | { kind: 'tool'; key: string; part: PartEntry }
  | { kind: 'files'; key: string; files: Record<string, unknown>[] }
  | { kind: 'activity'; key: string; parts: PartEntry[] };

function layout(entry: MessageEntry): Node[] {
  const nodes: Node[] = [];
  let group: PartEntry[] = [];
  const flush = () => {
    if (!group.length) return;
    nodes.push({ kind: 'activity', key: `activity:${entry.id}:${group[0]!.key}`, parts: group });
    group = [];
  };
  for (const part of entry.parts()) {
    const raw = part.sig();
    const type = textOf(raw.type);
    if (type === 'text') {
      if (!textOf(raw.text).trim()) continue;
      flush();
      nodes.push({ kind: 'text', key: part.key, part });
      continue;
    }
    if (type === 'reasoning') {
      if (!textOf(raw.text).trim()) continue;
      flush();
      nodes.push({ kind: 'reasoning', key: part.key, part });
      continue;
    }
    if (type === 'tool') {
      if (teamTool(toolName(raw))) {
        group.push(part);
        continue;
      }
      flush();
      nodes.push({ kind: 'tool', key: part.key, part });
      continue;
    }
    if (type === 'file') {
      flush();
      nodes.push({ kind: 'files', key: part.key, files: [raw] });
      continue;
    }
  }
  flush();
  return nodes;
}

function Attachment(props: { file: () => Record<string, unknown> }) {
  const url = () => textOf(props.file().url) || textOf(props.file().uri);
  const mime = () => textOf(props.file().mime);
  const name = () => textOf(props.file().filename) || textOf(props.file().name) || url().split('/').pop() || '';
  return (
    <If
      when={mime().startsWith('image/') && !!mediaUri(url())}
      else={
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 8,
            backgroundColor: alpha(colors.muted(), 0.6),
          }}
        >
          <Icon name="file-text" size={13} tone="muted" />
          <Text style={{ fontSize: 12, color: colors.foreground(), numberOfLines: 1 }}>{name()}</Text>
        </View>
      }
    >
      <Image
        src={url()}
        style={{ width: 180, height: 180, borderRadius: 12, objectFit: 'cover', backgroundColor: colors.muted() }}
      />
    </If>
  );
}

function UserMessage(props: { entry: () => MessageEntry; onRetry: () => void; onMenu: () => void }) {
  const error = () => textOf(props.entry().info().error);
  const files = () => props.entry().attachments();
  const showError = () => {
    void AlertDialog.show({
      title: t('assistants.contact.sendError.title'),
      description: error() || t('assistants.contact.sendFailed'),
      actions: [
        { id: 'close', label: t('gitView.common.close'), role: 'cancel' },
        { id: 'retry', label: t('chat.history.retry') },
      ],
    }).then((answer) => {
      if (answer.action === 'retry') props.onRetry();
    });
  };
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, maxWidth: '100%' }}>
        <If when={!!error()}>
          <Button
            testID={`message-error-${props.entry().id}`}
            accessibilityLabel={t('assistants.contact.sendError.viewDetails')}
            onPress={showError}
            style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="exclamation-fill" size={18} color={() => statusColor('error')} />
          </Button>
        </If>
        <View
          testID={`message-${props.entry().id}`}
          onLongPress={() => props.onMenu()}
          style={{
            maxWidth: '86%',
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: radius.inset,
            borderBottomRightRadius: 4,
            backgroundColor: alpha(colors.muted(), 0.75),
          }}
        >
          <Markdown text={() => props.entry().text()} />
          <If when={files().length > 0}>
            <View style={{ gap: 6, marginTop: 6 }}>
              <Each of={files()} key="index">
                {(file) => <Attachment file={file} />}
              </Each>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

/** Web `BusyDots`: three dots stepping in order while the reply streams. */
function TypingDots() {
  const step = signal(0);
  effect(() => {
    const timer = setInterval(() => step.set((step() + 1) % 3), 320);
    return () => clearInterval(timer);
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 14 }}>
      <Each of={[0, 1, 2]} key="index">
        {(index) => (
          <View
            style={{
              width: 3,
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.mutedForeground(),
              opacity: step() === index() ? 1 : 0.35,
            }}
          />
        )}
      </Each>
    </View>
  );
}

function AssistantMessage(props: {
  entry: () => MessageEntry;
  live: () => boolean;
  last: () => boolean;
  showMeta: boolean;
  onMenu: () => void;
}) {
  const nodes = () => layout(props.entry());
  const error = () => textOf(props.entry().info().error);
  const streaming = () => !!props.entry().info().streaming;
  const hasText = () => props.entry().parts().some((part) => part.sig().type === 'text' && !!textOf(part.sig().text).trim());
  const showError = () => {
    void AlertDialog.show({
      title: t('assistants.contact.sendError.title'),
      description: error(),
      actions: [{ id: 'close', label: t('gitView.common.close'), role: 'cancel' }],
    });
  };
  return (
    <View testID={`message-${props.entry().id}`} onLongPress={() => props.onMenu()} style={{ gap: 10 }}>
      <Each of={nodes()} key={(node) => node.key}>
        {(node) => (
          <If
            when={node().kind === 'text'}
            else={
              <If
                when={node().kind === 'reasoning'}
                else={
                  <If
                    when={node().kind === 'activity'}
                    else={
                      <If
                        when={node().kind === 'files'}
                        else={<ToolRow part={() => (node() as { part: PartEntry }).part.sig()} />}
                      >
                        <View style={{ gap: 6 }}>
                          <Each of={(node() as { files: Record<string, unknown>[] }).files} key="index">
                            {(file) => <Attachment file={file} />}
                          </Each>
                        </View>
                      </If>
                    }
                  >
                    <Activity
                      parts={() => (node() as { parts: PartEntry[] }).parts}
                      key={() => node().key}
                      live={props.live}
                      last={props.last}
                    />
                  </If>
                }
              >
                <Reasoning part={() => (node() as { part: PartEntry }).part.sig()} live={props.live} />
              </If>
            }
          >
            <Markdown text={() => textOf((node() as { part: PartEntry }).part.sig().text)} />
          </If>
        )}
      </Each>
      <If when={!!error()}>
        <Button
          testID={`assistant-error-${props.entry().id}`}
          onPress={showError}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
        >
          <Icon name="exclamation-fill" size={14} color={() => statusColor('error')} />
          <Text style={{ flexShrink: 1, fontSize: 12, color: colors.destructive(), numberOfLines: 3 }}>{error()}</Text>
        </Button>
      </If>
      <If when={streaming() && !hasText()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Spinner size={11} />
          <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.assistantStatus.thinking')}</Text>
        </View>
      </If>
      <If when={streaming() && hasText()}>
        <TypingDots />
      </If>
      <MetaLine entry={props.entry} show={props.showMeta} />
    </View>
  );
}

function CompactionCard(props: { entry: () => MessageEntry }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: alpha(colors.muted(), 0.5),
      }}
    >
      <Icon name="fold-vertical" size={14} tone="muted" />
      <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 2 }}>
        {textOf(props.entry().info().summary) || t('chat.activity.compactionCompleted')}
      </Text>
    </View>
  );
}

/** One transcript row: a user turn or one assistant run. */
export function MessageRow(props: {
  conversation: Conversation;
  row: () => RowGroup;
}) {
  const entries = () => props.row().ids.map((id) => props.conversation.entries.get(id)).filter((entry) => !!entry);
  return (
    <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 6 }}>
      <Each of={entries()} key={(entry) => entry.id}>
        {(entry) => (
          <If
            when={entry().role === 'user'}
            else={
              <If
                when={entry().role === 'compaction'}
                else={
                  <AssistantMessage
                    entry={entry}
                    live={() => props.row().live}
                    last={() => props.row().last}
                    showMeta={true}
                    onMenu={() => void openMessageMenu(props.conversation, entry())}
                  />
                }
              >
                <CompactionCard entry={entry} />
              </If>
            }
          >
            <UserMessage
              entry={entry}
              onRetry={() => void retryMessage(props.conversation, entry())}
              onMenu={() => void openMessageMenu(props.conversation, entry())}
            />
          </If>
        )}
      </Each>
    </View>
  );
}

export const messageText = (entry: MessageEntry) => entry.text();

export const messageFontSize = fontSize.body;
