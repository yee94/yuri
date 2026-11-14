import { Scroll, Text, View, effect, signal, untracked, windowSize } from 'nsh';
import { Button, Input } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, statusColor } from '../core/theme';
import { Icon } from '../core/Icon';
import { alpha, NativeSheet, Spinner } from '../core/ui';
import { getProviderModelDisplayName } from '../../../ui/src/lib/modelDisplay';
import { readUsage, type UsageSnapshot } from './usage';
import {
  chooseAgent,
  chooseModel,
  contextUsage,
  modelEntries,
  modelRefs,
  sameModel,
  toggleFavoriteModel,
  variantsOf,
  type Catalog,
  type Conversation,
  type ModelRef,
  type PickerModel,
} from './store';
import type { Row } from '../core/host';

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

const sheetPopup = {
  backgroundColor: colors.background(),
  borderTopLeftRadius: 26,
  borderTopRightRadius: 26,
} as const;

const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

const field = {
  minHeight: 38,
  borderRadius: 10,
  paddingHorizontal: 10,
  fontSize: 14,
  color: colors.foreground(),
  backgroundColor: alpha(colors.muted(), 0.65),
  placeholderColor: colors.mutedForeground(),
} as const;

function Tabs(props: { value: () => 'model' | 'agent'; onChange: (tab: 'model' | 'agent') => void }) {
  const item = (id: 'model' | 'agent', label: string) => (
    <Button
      onPress={() => props.onChange(id)}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 6,
        borderRadius: 9,
        backgroundColor: props.value() === id ? alpha(colors.foreground(), 0.1) : undefined,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: props.value() === id ? '600' : '400',
          color: props.value() === id ? colors.foreground() : colors.mutedForeground(),
        }}
      >
        {label}
      </Text>
    </Button>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 4, padding: 3, borderRadius: 12, backgroundColor: alpha(colors.muted(), 0.6) }}>
      {item('model', t('chat.modelControls.model'))}
      {item('agent', t('chat.modelControls.selectAgent'))}
    </View>
  );
}

function ModelRow(props: {
  conversation: Conversation;
  catalog: Catalog;
  entry: PickerModel;
  favorites: () => ModelRef[];
  expanded: () => string;
  setExpanded: (key: string) => void;
  close: () => void;
}) {
  const selected = () => sameModel(props.conversation.selection(), props.entry);
  const key = () => `${props.entry.providerID}/${props.entry.modelID}`;
  const variants = () => variantsOf(props.entry.model);
  const label = () =>
    getProviderModelDisplayName(props.entry.provider, props.entry.modelID, { fallbackLabel: props.entry.modelID });
  const favorite = () => props.favorites().some((ref) => sameModel(ref, props.entry));
  const pick = async (variant?: string) => {
    try {
      await chooseModel(props.conversation, props.catalog, {
        providerID: props.entry.providerID,
        modelID: props.entry.modelID,
        ...(variant ? { variant } : {}),
      });
      props.close();
    } catch {
      // The sheet stays open; the composer keeps its previous selection.
    }
  };
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Button
          onPress={() => (variants().length ? props.setExpanded(props.expanded() === key() ? '' : key()) : void pick())}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
          style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 1, paddingHorizontal: 8, paddingVertical: 8 }}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: selected() ? '600' : '400',
              color: colors.foreground(),
              numberOfLines: 1,
            }}
          >
            {label()}
          </Text>
          <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {textOf(props.entry.provider.name) || props.entry.providerID}
          </Text>
        </Button>
        <If when={selected()}>
          <Icon name="check" size={14} />
        </If>
        <Button
          onPress={() => void toggleFavoriteModel(props.catalog, props.entry)}
          accessibilityLabel={favorite() ? t('chat.modelControls.unfavoriteAria') : t('chat.modelControls.addToFavorites')}
          style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={favorite() ? 'star-fill' : 'star'} size={14} tone="muted" />
        </Button>
      </View>
      <If when={props.expanded() === key()}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 8, paddingBottom: 8 }}>
          <Each of={['', ...variants()]} key="index">
            {(variant) => (
              <Button
                onPress={() => void pick(variant() || undefined)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 11,
                  backgroundColor:
                    (props.conversation.selection().variant ?? '') === variant()
                      ? alpha(colors.foreground(), 0.14)
                      : alpha(colors.muted(), 0.6),
                }}
              >
                <Text style={{ fontSize: 12, color: colors.foreground() }}>
                  {variant() || t('sessions.scheduledTasks.editor.thinkingLevel.default')}
                </Text>
              </Button>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

function ModelSection(props: {
  title: string;
  conversation: Conversation;
  catalog: Catalog;
  rows: () => PickerModel[];
  favorites: () => ModelRef[];
  expanded: () => string;
  setExpanded: (key: string) => void;
  close: () => void;
}) {
  return (
    <If when={props.rows().length > 0}>
      <View style={{ paddingTop: 6 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground(), paddingHorizontal: 8, paddingBottom: 2 }}>
          {props.title}
        </Text>
        <Each of={props.rows()} key={(entry) => `${entry.providerID}/${entry.modelID}`}>
          {(entry) => (
            <ModelRow
              conversation={props.conversation}
              catalog={props.catalog}
              entry={entry()}
              favorites={props.favorites}
              expanded={props.expanded}
              setExpanded={props.setExpanded}
              close={props.close}
            />
          )}
        </Each>
      </View>
    </If>
  );
}

/** Model and agent picker in one system sheet (variants, recent and favorites). */
export function PickerSheet(props: {
  conversation: Conversation;
  catalog: () => Catalog;
  open: () => boolean;
  close: () => void;
  tab: () => 'model' | 'agent';
  setTab: (tab: 'model' | 'agent') => void;
}) {
  const query = signal('');
  const expanded = signal('');
  const height = () => Math.max(360, windowSize().height * 0.72);
  const favorites = () => modelRefs(props.catalog().preferences().favoriteModels);
  const resolve = (ref: ModelRef) => modelEntries(props.catalog()).find((entry) => sameModel(entry, ref));
  const recentModels = () => modelRefs(props.catalog().preferences().recentModels).map(resolve).filter((entry): entry is PickerModel => !!entry);
  const favoriteModels = () => favorites().map(resolve).filter((entry): entry is PickerModel => !!entry);
  const matches = (entry: PickerModel) => {
    const value = query().trim().toLowerCase();
    if (!value) return true;
    return `${entry.providerID} ${entry.modelID} ${textOf(entry.provider.name)}`.toLowerCase().includes(value);
  };
  const models = () => modelEntries(props.catalog()).filter(matches);
  const grouped = () => {
    const groups: { providerID: string; name: string; entries: PickerModel[] }[] = [];
    for (const entry of models()) {
      const last = groups[groups.length - 1];
      if (last && last.providerID === entry.providerID) last.entries.push(entry);
      else groups.push({ providerID: entry.providerID, name: textOf(entry.provider.name) || entry.providerID, entries: [entry] });
    }
    return groups;
  };
  const agents = () => {
    const value = query().trim().toLowerCase();
    return props.catalog().agents().filter((agent) => !value || `${textOf(agent.name)} ${textOf(agent.description)}`.toLowerCase().includes(value));
  };
  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.close();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={{ height: height(), paddingHorizontal: 14, paddingTop: 10, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8 }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '600', color: colors.foreground() }}>
            {t('chat.chatInput.actions.modelAgentSettings')}
          </Text>
          <Button onPress={props.close} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} tone="muted" />
          </Button>
        </View>
        <Tabs value={props.tab} onChange={props.setTab} />
        <View style={{ marginTop: 8 }}>
          <Input
            testID={props.tab() === 'model' ? 'model-search' : 'agent-search'}
            value={query()}
            onChange={(event) => query.set(event.value)}
            placeholder={
              props.tab() === 'model'
                ? t('chat.modelControls.searchProvidersOrModels')
                : t('chat.modelControls.selectAgent')
            }
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
        </View>
        <Scroll class="flex-1" style={{ marginTop: 8 }} contentStyle={{ paddingBottom: 12 }}>
          <If when={props.catalog().loading() && models().length === 0 && agents().length === 0}>
            <View style={{ paddingVertical: 24, alignItems: 'center', gap: 8 }}>
              <Spinner size={16} />
            </View>
          </If>
          <If when={!!props.catalog().error()}>
            <Text style={{ fontSize: 12, color: colors.destructive(), paddingVertical: 8 }}>{props.catalog().error()}</Text>
          </If>
          <If when={props.tab() === 'model'}>
            <If when={!query().trim()}>
              <ModelSection
                title={t('chat.modelControls.recent')}
                conversation={props.conversation}
                catalog={props.catalog()}
                rows={recentModels}
                favorites={favorites}
                expanded={expanded}
                setExpanded={(key) => expanded.set(key)}
                close={props.close}
              />
              <ModelSection
                title={t('chat.modelControls.favorites')}
                conversation={props.conversation}
                catalog={props.catalog()}
                rows={favoriteModels}
                favorites={favorites}
                expanded={expanded}
                setExpanded={(key) => expanded.set(key)}
                close={props.close}
              />
            </If>
            <Each of={grouped()} key={(group) => group.providerID}>
              {(group) => (
                <View style={{ paddingTop: 6 }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground(), paddingHorizontal: 8, paddingBottom: 2 }}>
                    {group().name}
                  </Text>
                  <Each of={group().entries} key={(entry) => `${entry.providerID}/${entry.modelID}`}>
                    {(entry) => (
                      <ModelRow
                        conversation={props.conversation}
                        catalog={props.catalog()}
                        entry={entry()}
                        favorites={favorites}
                        expanded={expanded}
                        setExpanded={(key) => expanded.set(key)}
                        close={props.close}
                      />
                    )}
                  </Each>
                </View>
              )}
            </Each>
          </If>
          <If when={props.tab() === 'agent'}>
            <Each of={agents()} key={(agent) => textOf(agent.name)}>
              {(agent) => (
                <Button
                  onPress={() => {
                    void chooseAgent(props.conversation, textOf(agent().name)).catch(() => undefined);
                    props.close();
                  }}
                  activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 9 }}
                >
                  <Icon name="ai-agent" size={15} tone="muted" />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 14, color: colors.foreground(), numberOfLines: 1 }}>{textOf(agent().name)}</Text>
                    <If when={!!textOf(agent().description)}>
                      <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 2 }}>
                        {textOf(agent().description)}
                      </Text>
                    </If>
                  </View>
                  <If when={props.conversation.selection().agent === textOf(agent().name)}>
                    <Icon name="check" size={14} />
                  </If>
                </Button>
              )}
            </Each>
          </If>
        </Scroll>
      </View>
    </NativeSheet>
  );
}

function MetaRow(props: { icon: 'git-branch' | 'donut-chart'; label: string; value: () => string; detail?: () => string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 10 }}>
      <Icon name={props.icon} size={17} tone="muted" />
      <Text style={{ fontSize: 13, color: colors.mutedForeground() }}>{props.label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end', gap: 1 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>{props.value()}</Text>
        <If when={!!props.detail?.()}>
          <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>{props.detail?.()}</Text>
        </If>
      </View>
    </View>
  );
}

/** The header's context ring panel: branch, real context usage and provider quotas. */
export function ContextSheet(props: {
  conversation: Conversation;
  open: () => boolean;
  close: () => void;
  branch: () => string;
  limit: () => number;
}) {
  const usage = signal<UsageSnapshot | null>(null);
  const usageLoading = signal(false);
  const usageError = signal('');
  const tokens = () => contextUsage(props.conversation);
  const percentage = () => {
    const total = tokens().tokens;
    const limit = props.limit();
    if (total === null || !limit) return 0;
    return Math.min((total / limit) * 100, 999);
  };
  const format = (value: number) =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  const contextValue = () => {
    if (tokens().pending || tokens().tokens === null) return t('contextUsage.pending');
    return `${percentage().toFixed(1)}%`;
  };
  const contextDetail = () => {
    const total = tokens().tokens;
    if (total === null || !props.limit()) return '—';
    return `${format(total)}/${format(props.limit())}`;
  };
  const percentColor = (value: number | null) => {
    if (value === null) return colors.foreground();
    if (value >= 80) return statusColor('error');
    if (value >= 50) return statusColor('warning');
    return colors.foreground();
  };

  effect(() => {
    if (!props.open()) return;
    untracked(() => {
      usageLoading.set(true);
      usageError.set('');
      void readUsage(props.conversation.directory(), props.conversation.hostId)
        .then((value) => usage.set(value))
        .catch((error) => usageError.set(error instanceof Error ? error.message : String(error)))
        .finally(() => usageLoading.set(false));
    });
  });

  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.close();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={{ maxHeight: windowSize().height * 0.72, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 'env(safe-area-inset-bottom)', gap: 4 }}>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground(), paddingHorizontal: 10, paddingBottom: 6 }}>
          {t('mobile.header.openMetadataAria')}
        </Text>
        <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.3) }}>
          <MetaRow icon="git-branch" label={t('mobile.header.metadata.branch')} value={() => props.branch() || t('common.unavailable')} />
          <View style={{ height: 0.5, backgroundColor: alpha(colors.border(), 0.6), marginLeft: 10 }} />
          <MetaRow
            icon="donut-chart"
            label={t('mobile.header.metadata.context')}
            value={contextValue}
            detail={contextDetail}
          />
        </View>
        <Scroll style={{ maxHeight: windowSize().height * 0.4 }} scrollbar={false} contentStyle={{ paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 4 }}>
            <Icon name="timer" size={15} tone="muted" />
            <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('mobile.header.metadata.usage')}</Text>
            <View style={{ flex: 1 }} />
            <If when={usageLoading()}>
              <Spinner size={11} />
            </If>
            <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>
              {(usage()?.displayMode ?? 'usage') === 'remaining' ? t('header.services.remaining') : t('header.services.used')}
            </Text>
          </View>
          <If when={!!usageError()}>
            <Text style={{ fontSize: 12, color: colors.destructive(), paddingHorizontal: 10, paddingVertical: 4 }}>{usageError()}</Text>
          </If>
          <Each of={usage()?.groups ?? []} key={(group) => group.providerId}>
            {(group) => (
              <View
                style={{
                  marginTop: 6,
                  padding: 10,
                  gap: 6,
                  borderRadius: radius.action,
                  backgroundColor: alpha(colors.muted(), 0.35),
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
                  {group().name}
                </Text>
                <Each of={group().rows} key={(row) => row.key}>
                  {(row) => (
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <Text style={{ flexShrink: 1, fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>
                        {row().label}
                      </Text>
                      <If when={!!row().reset}>
                        <Text style={{ fontSize: 10, color: colors.mutedForeground(), numberOfLines: 1 }}>{row().reset}</Text>
                      </If>
                      <View style={{ flex: 1 }} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: percentColor(row().percent) }}>
                        {row().percent === null ? '' : `${row().percent}%`}
                      </Text>
                    </View>
                  )}
                </Each>
                <If when={!!group().status}>
                  <Text style={{ fontSize: 10, color: colors.mutedForeground(), numberOfLines: 2 }}>{group().status}</Text>
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </NativeSheet>
  );
}

export const pickerSheetStyle = sheetPopup;

export const providerName = (provider: Row) => textOf(provider.name) || textOf(provider.id);
