import { Scroll, Text, View, effect, signal } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { Spinner, alpha } from '../core/ui';
import { getComposerLocalCommandMetadata } from '../../../ui/src/lib/composer-local-commands-core';
import { searchFiles, type Catalog, type Conversation } from './store';
import type { Row } from '../core/host';

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

export type Trigger = { kind: 'command' | 'file'; query: string; start: number; end: number };

export type AutocompleteChoice = { kind: 'file' | 'command' | 'agent' | 'skill'; value: string };

type CommandRow = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  isYuri: boolean;
  scope: string;
};

const localCommands = (hasSession: boolean, hasMessages: boolean): CommandRow[] => {
  return getComposerLocalCommandMetadata(
    { hasSession, hasMessages, canStartSessionCommand: hasSession, reloadEnabled: false },
    t,
  ).map((command) => ({
    id: command.id,
    name: command.name,
    description: command.description,
    isBuiltIn: command.isBuiltIn === true,
    isYuri: command.isYuri === true,
    scope: '',
  }));
};

const isSubsequence = (query: string, value: string): boolean => {
  let index = 0;
  for (const char of value) {
    if (char === query[index]) index += 1;
    if (index >= query.length) return true;
  }
  return false;
};

function commandScore(command: CommandRow, query: string): number | null {
  if (!query) return 0;
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (command.description.toLowerCase().includes(query)) return 3;
  if (isSubsequence(query, name)) return 4;
  return null;
}

const COMMAND_ICONS: Record<string, IconName> = {
  new: 'add',
  init: 'file',
  undo: 'arrow-go-back',
  redo: 'arrow-go-forward',
  timeline: 'time',
  compact: 'scissors',
  reload: 'refresh',
  model: 'command',
  summary: 'flashlight',
  'workspace-review': 'search-eye',
  'craft-goal': 'target',
  'catch-up': 'refresh',
  debug: 'tools',
  weigh: 'target',
  explore: 'global',
  btw: 'chat-thread',
};

const commandIcon = (command: CommandRow): IconName =>
  COMMAND_ICONS[command.name] ?? (command.isBuiltIn || command.isYuri ? 'flashlight' : 'command');

const fileIcon = (row: Row): IconName => {
  if (textOf(row.type) === 'directory') return 'folder';
  const path = textOf(row.relativePath) || textOf(row.path);
  const extension = path.includes('.') ? path.split('.').pop()?.toLowerCase() ?? '' : '';
  if (['ts', 'tsx', 'js', 'jsx', 'json'].includes(extension)) return 'code';
  if (['md', 'mdx', 'txt'].includes(extension)) return 'file';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(extension)) return 'file-image';
  return 'file-text';
};

function Badge(props: { label: string; tone?: 'neutral' | 'accent' }) {
  return (
    <View
      style={{
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: props.tone === 'accent' ? alpha(colors.ring(), 0.14) : alpha(colors.muted(), 0.7),
      }}
    >
      <Text
        style={{
          fontSize: 9,
          fontWeight: '700',
          color: props.tone === 'accent' ? colors.ring() : colors.mutedForeground(),
          textTransform: 'uppercase',
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

type MentionRow =
  | { type: 'header'; key: string; label: string }
  | {
      type: 'item';
      key: string;
      group: 'skill' | 'agent' | 'file';
      value: string;
      title: string;
      subtitle: string;
      badge: string;
      icon: IconName;
    };

/** The `/` command and `@` mention candidates, floating above the composer. */
export function Autocomplete(props: {
  conversation: Conversation;
  catalog: () => Catalog;
  trigger: () => Trigger | null;
  onPick: (choice: AutocompleteChoice) => void;
}) {
  const files = signal<Row[]>([]);
  const loading = signal(false);
  const failure = signal('');

  const commands = (): CommandRow[] => {
    const token = props.trigger();
    if (!token || token.kind !== 'command') return [];
    const query = token.query.trim().toLowerCase();
    const local = localCommands(
      !!props.conversation.sessionID(),
      props.conversation.messages().length > 0,
    );
    const seen = new Set(local.map((command) => command.name));
    const server = props.catalog()
      .commands()
      .filter((row) => {
        const name = textOf(row.name);
        if (!name || seen.has(name) || textOf(row.source) === 'skill') return false;
        seen.add(name);
        return true;
      })
      .map((row) => ({
        id: `server:${textOf(row.name)}`,
        name: textOf(row.name),
        description: textOf(row.description),
        isBuiltIn: row.isBuiltIn === true,
        isYuri: false,
        scope: textOf(row.scope),
      }));
    return [...local, ...server]
      .flatMap((command) => {
        const score = commandScore(command, query);
        return score === null ? [] : [{ command, score }];
      })
      .sort(
        (left, right) =>
          left.score - right.score ||
          Number(right.command.isBuiltIn || right.command.isYuri) - Number(left.command.isBuiltIn || left.command.isYuri) ||
          left.command.name.localeCompare(right.command.name),
      )
      .slice(0, 20)
      .map((entry) => entry.command);
  };

  const mentionRows = (): MentionRow[] => {
    const token = props.trigger();
    if (!token || token.kind !== 'file') return [];
    const query = token.query.trim().toLowerCase();
    const score = (title: string, subtitle: string) => {
      if (!query) return 0;
      const value = title.replace(/^@/, '').toLowerCase();
      if (value === query) return 0;
      if (value.startsWith(query)) return 1;
      if (value.includes(query)) return 2;
      if (subtitle.toLowerCase().includes(query)) return 3;
      return isSubsequence(query, value) ? 4 : null;
    };
    const groups: MentionRow[] = [];
    const pushGroup = (
      group: 'skill' | 'agent' | 'file',
      label: string,
      rows: { key: string; title: string; subtitle: string; badge: string; icon: IconName; value: string }[],
    ) => {
      const ranked = rows
        .flatMap((row) => {
          const value = score(row.title, row.subtitle);
          return value === null ? [] : [{ row, value }];
        })
        .sort((left, right) => left.value - right.value || left.row.title.localeCompare(right.row.title))
        .slice(0, 12)
        .map((entry) => entry.row);
      if (!ranked.length) return;
      groups.push({ type: 'header', key: `header:${group}`, label });
      for (const row of ranked) {
        groups.push({
          type: 'item',
          key: `${group}:${row.key}`,
          group,
          value: row.value,
          title: row.title,
          subtitle: row.subtitle,
          badge: row.badge,
          icon: row.icon,
        });
      }
    };

    const skills = props
      .catalog()
      .skills()
      .map((row) => ({
        key: `${textOf(row.name)}-${textOf(row.scope)}`,
        title: `@${textOf(row.name)}`,
        subtitle: textOf(row.description),
        badge: textOf(row.scope),
        icon: 'book-open' as IconName,
        value: textOf(row.name),
      }))
      .filter((row) => row.value);
    pushGroup('skill', t('chat.fileMentionAutocomplete.groups.skills'), skills);

    const agents = props
      .catalog()
      .agents()
      .map((row) => ({
        key: textOf(row.name),
        title: `@${textOf(row.name)}`,
        subtitle: textOf(row.description),
        badge: '',
        icon: 'ai-agent' as IconName,
        value: textOf(row.name),
      }))
      .filter((row) => row.value);
    pushGroup('agent', t('chat.fileMentionAutocomplete.groups.agents'), agents);

    const fileRows = files()
      .map((row) => ({
        key: textOf(row.path),
        title: textOf(row.relativePath) || textOf(row.path),
        subtitle: '',
        badge: '',
        icon: fileIcon(row),
        value: textOf(row.relativePath) || textOf(row.path),
      }))
      .filter((row) => row.value);
    pushGroup('file', t('chat.fileMentionAutocomplete.groups.files'), fileRows);
    return groups;
  };

  const visible = () => {
    const token = props.trigger();
    if (!token) return false;
    if (token.kind === 'command') return !token.query.includes(' ');
    return true;
  };

  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const token = props.trigger();
    if (!token || token.kind !== 'file') {
      files.set([]);
      failure.set('');
      loading.set(false);
      return;
    }
    const id = ++serial;
    const query = token.query;
    loading.set(true);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        try {
          const rows = await searchFiles(props.conversation.directory(), query, props.conversation.hostId);
          if (id !== serial) return;
          files.set(rows);
          failure.set('');
        } catch (error) {
          if (id !== serial) return;
          files.set([]);
          failure.set(error instanceof Error ? error.message : String(error));
        } finally {
          if (id === serial) loading.set(false);
        }
      })();
    }, 180);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  return (
    <If when={visible()}>
      <View
        style={{
          position: 'absolute',
          left: 6,
          right: 6,
          bottom: '100%',
          marginBottom: 6,
          maxHeight: 280,
          borderRadius: radius.inset,
          overflow: 'hidden',
          backgroundColor: alpha(colors.background(), 0.96),
          backdropFilter: 'blur(20px) saturate(1.3)',
          boxShadow: '0 0 0 0.5px rgba(0,0,0,0.06), 0 12px 30px -12px rgba(0,0,0,0.32)',
        }}
      >
        <Scroll style={{ maxHeight: 280 }} scrollbar={false} keyboardShouldPersistTaps="always">
          <If when={props.trigger()?.kind === 'command'}>
            <View style={{ paddingVertical: 6 }}>
              <Each of={commands()} key={(row) => row.id}>
                {(row) => (
                  <Button
                    onPress={() => props.onPick({ kind: 'command', value: row().name })}
                    activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 }}
                  >
                    <Icon name={commandIcon(row())} size={14} tone="muted" />
                    <Text style={{ flexShrink: 0, fontSize: 14, fontWeight: '500', color: colors.foreground() }}>
                      /{row().name}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Badge label={t('chat.commandAutocomplete.badge.command')} tone="accent" />
                      <If when={row().isYuri}>
                        <Badge label="Yuri" />
                      </If>
                      <If when={!row().isYuri && (row().isBuiltIn || !!row().scope)}>
                        <Badge label={row().isBuiltIn ? t('chat.commandAutocomplete.badge.system') : row().scope} />
                      </If>
                    </View>
                  </Button>
                )}
              </Each>
              <If when={commands().length === 0}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.commandAutocomplete.empty')}</Text>
                </View>
              </If>
            </View>
          </If>
          <If when={props.trigger()?.kind === 'file'}>
            <View style={{ paddingVertical: 6 }}>
              <If when={loading() && files().length === 0}>
                <View style={{ padding: 12, alignItems: 'center' }}>
                  <Spinner size={13} />
                </View>
              </If>
              <If when={!!failure()}>
                <Text style={{ fontSize: 12, color: colors.destructive(), padding: 12 }}>{failure()}</Text>
              </If>
              <Each of={mentionRows()} key={(row) => row.key}>
                {(row) => (
                  <If
                    when={row().type === 'header'}
                    else={
                      <Button
                        onPress={() =>
                          props.onPick({
                            kind:
                              (row() as { group: 'skill' | 'agent' | 'file' }).group === 'skill'
                                ? 'skill'
                                : (row() as { group: 'skill' | 'agent' | 'file' }).group === 'agent'
                                  ? 'agent'
                                  : 'file',
                            value: (row() as { value: string }).value,
                          })
                        }
                        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 }}
                      >
                        <Icon name={(row() as { icon: IconName }).icon} size={14} tone="muted" />
                        <Text style={{ flexShrink: 1, fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>
                          {(row() as { title: string }).title}
                        </Text>
                        <If when={!!(row() as { badge: string }).badge}>
                          <Badge label={(row() as { badge: string }).badge} />
                        </If>
                        <View style={{ flex: 1 }} />
                        <If when={!!(row() as { subtitle: string }).subtitle}>
                          <Text style={{ flexShrink: 1, fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
                            {(row() as { subtitle: string }).subtitle}
                          </Text>
                        </If>
                      </Button>
                    }
                  >
                    <Text
                      style={{
                        paddingHorizontal: 10,
                        paddingTop: 6,
                        paddingBottom: 2,
                        fontSize: 11,
                        fontWeight: '600',
                        color: colors.mutedForeground(),
                      }}
                    >
                      {(row() as { label: string }).label}
                    </Text>
                  </If>
                )}
              </Each>
              <If when={!loading() && mentionRows().length === 0 && !failure()}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>
                    {t('chat.fileMentionAutocomplete.empty')}
                  </Text>
                </View>
              </If>
            </View>
          </If>
        </Scroll>
      </View>
    </If>
  );
}
