import { Scroll, Text, View, effect, signal } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { Spinner, alpha } from '../core/ui';
import { searchFiles, type Catalog, type Conversation } from './store';
import type { Row } from '../core/host';

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

export type Trigger = { kind: 'command' | 'file'; query: string; start: number; end: number };

/** The `/` command and `@` file candidates, floating above the composer. */
export function Autocomplete(props: {
  conversation: Conversation;
  catalog: () => Catalog;
  trigger: () => Trigger | null;
  onPick: (choice: { kind: 'file' | 'command'; value: string }) => void;
}) {
  const files = signal<Row[]>([]);
  const loading = signal(false);
  const failure = signal('');
  const commands = () => {
    const token = props.trigger();
    if (!token || token.kind !== 'command') return [];
    const value = token.query.toLowerCase();
    return props.catalog()
      .commands()
      .filter((row) => !value || textOf(row.name).toLowerCase().startsWith(value))
      .slice(0, 20);
  };
  const fileRows = () => {
    const token = props.trigger();
    if (!token || token.kind !== 'file') return [];
    return files().slice(0, 20);
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
          const rows = await searchFiles(props.conversation.directory(), query);
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
          maxHeight: 260,
          borderRadius: radius.inset,
          overflow: 'hidden',
          backgroundColor: alpha(colors.background(), 0.96),
          backdropFilter: 'blur(20px) saturate(1.3)',
          boxShadow: '0 0 0 0.5px rgba(0,0,0,0.06), 0 12px 30px -12px rgba(0,0,0,0.32)',
        }}
      >
        <Scroll style={{ maxHeight: 260 }} scrollbar={false} keyboardShouldPersistTaps="always">
          <If when={props.trigger()?.kind === 'command'}>
            <Each of={commands()} key={(row) => textOf(row.name)}>
              {(row) => (
                <Button
                  onPress={() => props.onPick({ kind: 'command', value: textOf(row().name) })}
                  activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9 }}
                >
                  <Icon name="slash-commands-2" size={14} tone="muted" />
                  <Text style={{ flex: 1, fontSize: 14, color: colors.foreground(), numberOfLines: 1 }}>
                    /{textOf(row().name)}
                  </Text>
                  <If when={!!textOf(row().description)}>
                    <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
                      {textOf(row().description)}
                    </Text>
                  </If>
                </Button>
              )}
            </Each>
            <If when={commands().length === 0}>
              <View style={{ padding: 14, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('sessions.sidebar.empty.noMatches.title')}</Text>
              </View>
            </If>
          </If>
          <If when={props.trigger()?.kind === 'file'}>
            <If when={loading()}>
              <View style={{ padding: 12, alignItems: 'center' }}>
                <Spinner size={13} />
              </View>
            </If>
            <If when={!!failure()}>
              <Text style={{ fontSize: 12, color: colors.destructive(), padding: 12 }}>{failure()}</Text>
            </If>
            <Each of={fileRows()} key={(row) => textOf(row.path)}>
              {(row) => (
                <Button
                  onPress={() =>
                    props.onPick({ kind: 'file', value: textOf(row().relativePath) || textOf(row().path) })
                  }
                  activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9 }}
                >
                  <Icon name={textOf(row().type) === 'directory' ? 'folder' : 'file-text'} size={14} tone="muted" />
                  <Text style={{ flex: 1, fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>
                    {textOf(row().relativePath) || textOf(row().path)}
                  </Text>
                </Button>
              )}
            </Each>
            <If when={!loading() && fileRows().length === 0 && !failure()}>
              <View style={{ padding: 14, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('sessions.sidebar.empty.noMatches.title')}</Text>
              </View>
            </If>
          </If>
        </Scroll>
      </View>
    </If>
  );
}
