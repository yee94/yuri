import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon } from '../core/Icon';
import { EmptyState, Spinner, alpha } from '../core/ui';
import { request, record, textOf } from '../core/host';
import type { Conversation } from './store';

type McpServer = { name: string; status: string; error: string };

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const statusLabel = (status: string): string => {
  if (status === 'connected') return t('settings.mcp.page.status.label.connected');
  if (status === 'failed' || status === 'error') return t('settings.mcp.page.status.label.failed');
  if (status === 'needs-auth' || status === 'needs_auth') return t('settings.mcp.page.status.label.needsAuth');
  if (status === 'needs-client-registration') return t('settings.mcp.page.status.label.needsRegistration');
  return t('settings.mcp.page.status.description.default');
};

/** Header menu «MCP»: server names with their live runtime status (Web's `chat-mcp`). */
export function McpSheet(props: { conversation: Conversation; open: () => boolean; close: () => void }) {
  const loading = signal(false);
  const error = signal('');
  const servers = signal<McpServer[]>([]);
  const busy = signal<string[]>([]);

  const location = () => `location%5Bdirectory%5D=${encodeURIComponent(props.conversation.directory())}`;

  const refresh = async () => {
    if (loading()) return;
    loading.set(true);
    error.set('');
    const failures: string[] = [];
    let names: string[] = [];
    const statuses = new Map<string, McpServer>();
    try {
      const config = await request(`/api/config/mcp?${location()}`);
      if (Array.isArray(config)) names = config.map((entry) => textOf(record(entry).name)).filter(Boolean);
      else throw new Error('Invalid MCP configs response');
    } catch (failure) {
      failures.push(errorText(failure));
    }
    try {
      const body = record(await request(`/api/mcp?${location()}`));
      if (!Array.isArray(body.data)) throw new Error('Invalid MCP list response');
      for (const entry of body.data) {
        const row = record(entry);
        const name = textOf(row.name);
        const state = record(row.status);
        if (!name || !textOf(state.status)) continue;
        statuses.set(name, { name, status: textOf(state.status), error: textOf(state.error) });
      }
    } catch (failure) {
      failures.push(errorText(failure));
    }
    const merged = [...new Set([...names, ...statuses.keys()])].sort((left, right) => left.localeCompare(right));
    servers.set(merged.map((name) => statuses.get(name) ?? { name, status: '', error: '' }));
    error.set(failures[0] ?? '');
    loading.set(false);
  };

  const toggle = async (server: McpServer) => {
    if (busy().includes(server.name)) return;
    const connected = server.status === 'connected';
    busy.set([...busy(), server.name]);
    try {
      await request(`/api/experimental/mcp/${encodeURIComponent(server.name)}/${connected ? 'disconnect' : 'connect'}?${location()}`, 'POST');
      await refresh();
    } catch (failure) {
      error.set(errorText(failure));
    } finally {
      busy.set(busy().filter((name) => name !== server.name));
    }
  };

  effect(() => {
    if (!props.open()) return;
    untracked(() => void refresh());
  });

  return (
    <Sheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.close();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={{ height: 460, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground() }}>{t('mobile.menu.mcp')}</Text>
          <If when={loading()}>
            <Spinner size={14} />
          </If>
          <Button testID="mcp-refresh" onPress={() => void refresh()} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="refresh" size={15} tone="muted" />
          </Button>
          <Button onPress={props.close} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} tone="muted" />
          </Button>
        </View>
        <If when={!!error()}>
          <Text style={{ fontSize: 12, color: colors.destructive(), paddingHorizontal: 10, paddingBottom: 6 }}>{error()}</Text>
        </If>
        <If
          when={servers().length > 0}
          else={
            <If when={!loading()}>
              <EmptyState icon="tools" title={t('mobile.menu.mcp')} description={t('settings.mcp.page.status.description.default')} />
            </If>
          }
        >
          <Scroll class="flex-1" scrollbar={false} contentStyle={{ paddingBottom: 10 }}>
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.25) }}>
              <Each of={servers()} key={(server) => server.name}>
                {(server) => {
                  const connected = () => server().status === 'connected';
                  return (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}>
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: connected() ? colors.success() : alpha(colors.mutedForeground(), 0.6),
                        }}
                      />
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={{ fontSize: 14, color: colors.foreground(), numberOfLines: 1 }}>{server().name}</Text>
                        <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
                          {server().error || statusLabel(server().status)}
                        </Text>
                      </View>
                      <If when={busy().includes(server().name)}>
                        <Spinner size={12} />
                      </If>
                      <If when={!busy().includes(server().name)}>
                        <Button
                          testID={`mcp-toggle-${server().name}`}
                          onPress={() => void toggle(server())}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            borderRadius: 10,
                            backgroundColor: alpha(colors.muted(), 0.7),
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '500', color: colors.foreground() }}>
                            {connected() ? t('settings.mcp.page.actions.disconnect') : t('settings.mcp.page.actions.connect')}
                          </Text>
                        </Button>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          </Scroll>
        </If>
      </View>
    </Sheet>
  );
}
