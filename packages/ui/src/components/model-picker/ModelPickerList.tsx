import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  MouseSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { toast } from '@/components/ui/toast';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { formatCompactNumber, formatUsdCurrency } from '@/lib/intlFormatters';
import { copyTextToClipboard } from '@/lib/clipboard';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { buildModelSearchText, matchesModelSearch } from '@/lib/search/modelSearch';
import { liftSelectedProvider, rankModelSearchEntries } from '@/lib/search/modelPickerRanking';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';

type CapabilityIcon = {
  key: string;
  icon: IconName;
  label: string;
};

/** Multimodal capabilities shown under 能力 — text/PDF are omitted as baseline/non-multimodal. */
const MULTIMODAL_ICON_MAP: Record<string, { icon: IconName; labelKey: 'modalityImage' | 'modalityVideo' | 'modalityAudio' }> = {
  image: { icon: 'file-image', labelKey: 'modalityImage' },
  video: { icon: 'file-video', labelKey: 'modalityVideo' },
  audio: { icon: 'file-music', labelKey: 'modalityAudio' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

const CapabilityIconBadge: React.FC<{ iconName: IconName; label: string }> = ({ iconName, label }) => (
  <span
    className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground"
    title={label}
    aria-label={label}
    role="img"
  >
    <Icon name={iconName} className="size-3.5" />
  </span>
);

const getCapabilityIcons = (
  metadata: ModelMetadata | undefined,
  labels: ModelPickerListProps['labels'],
): CapabilityIcon[] => {
  const icons: CapabilityIcon[] = [];
  if (metadata?.tool_call && labels.capabilityToolCalling) {
    icons.push({ key: 'tool_call', icon: 'tools', label: labels.capabilityToolCalling });
  }
  if (metadata?.reasoning && labels.capabilityReasoning) {
    icons.push({ key: 'reasoning', icon: 'brain-ai-3', label: labels.capabilityReasoning });
  }

  const modalityValues = [
    ...(metadata?.modalities?.input ?? []),
    ...(metadata?.modalities?.output ?? []),
  ];
  const uniqueModalities = Array.from(new Set(modalityValues.map(normalizeModality).filter(Boolean)));
  for (const modality of uniqueModalities) {
    const definition = MULTIMODAL_ICON_MAP[modality];
    if (!definition) continue;
    const label = labels[definition.labelKey];
    if (!label) continue;
    icons.push({ key: `modality-${modality}`, icon: definition.icon, label });
  }
  return icons;
};

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

export type ModelPickerProvider = {
  id: string;
  name?: string;
  models?: ProviderModel[];
};

export type ModelPickerEntry = {
  model: ProviderModel;
  providerID: string;
  modelID: string;
  /** Remembered thinking variant from favorites/recents; omitted when never recorded. */
  variant?: string;
};

type ModelPickerFavoriteEntry = ModelPickerEntry;

type HiddenModel = { providerID: string; modelID: string };

type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

const getModelDisplayName = (model: Record<string, unknown>) => {
  return getSharedModelDisplayName(model, undefined, { maxLength: 40 });
};

const formatModelContextTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatUsdCurrency(value);
};

const hasTooltipMetadata = (metadata?: ModelMetadata, providerName?: string) => {
  if (providerName) return true;
  if (!metadata) return false;
  return Boolean(
    metadata.tool_call ||
    metadata.reasoning ||
    metadata.cost?.input !== undefined ||
    metadata.cost?.output !== undefined ||
    (metadata.modalities?.input?.length ?? 0) > 0 ||
    (metadata.modalities?.output?.length ?? 0) > 0,
  );
};

const ModelPickerRowTooltip: React.FC<{
  metadata?: ModelMetadata;
  providerName?: string;
  providerID: string;
  modelID: string;
  active: boolean;
  anchor: () => HTMLElement | null;
  labels: ModelPickerListProps['labels'];
  children: React.ReactElement;
}> = ({ metadata, providerName, providerID, modelID, active, anchor, labels, children }) => {
  const { t } = useI18n();
  const [delayedActive, setDelayedActive] = React.useState(false);
  const modelIdentifier = `${providerID}/${modelID}`;

  React.useEffect(() => {
    if (!active) {
      setDelayedActive(false);
      return;
    }
    const timeout = window.setTimeout(() => setDelayedActive(true), 450);
    return () => window.clearTimeout(timeout);
  }, [active]);

  const showTooltip = active && delayedActive && hasTooltipMetadata(metadata, providerName);
  const capabilityIcons = showTooltip ? getCapabilityIcons(metadata, labels) : [];
  const hasCost = metadata?.cost?.input !== undefined || metadata?.cost?.output !== undefined;

  return (
    <>
      {children}
      {showTooltip ? (
        <Tooltip open onOpenChange={() => {}}>
          <TooltipContent anchor={anchor} side="right" sideOffset={8} className="min-w-52 max-w-xs text-left transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100">
            <div className="flex flex-col gap-2 text-left text-xs">
              {providerName && labels.provider ? (
                <div className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span className="typography-meta font-medium">{labels.provider}</span>
                  <span className="typography-meta text-foreground">{providerName}</span>
                </div>
              ) : null}
              {capabilityIcons.length > 0 ? (
                <div className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span className="typography-meta font-medium shrink-0">{labels.capabilities}</span>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {capabilityIcons.map(({ key, icon, label }) => (
                      <CapabilityIconBadge key={key} iconName={icon} label={label} />
                    ))}
                  </div>
                </div>
              ) : null}
              {hasCost ? (
                <div className="flex items-start justify-between gap-3 text-muted-foreground">
                  {labels.costPerMillion ? (
                    <span className="typography-meta font-medium shrink-0">{labels.costPerMillion}</span>
                  ) : null}
                  <div className="flex flex-col items-end gap-0.5 min-w-0">
                    <div className="flex items-center justify-end gap-1.5 min-w-0">
                      {labels.costInput ? <span className="typography-meta shrink-0">{labels.costInput}</span> : null}
                      <span className="typography-meta text-foreground tabular-nums">{formatCost(metadata?.cost?.input)}</span>
                    </div>
                    <div className="flex items-center justify-end gap-1.5 min-w-0">
                      {labels.costOutput ? <span className="typography-meta shrink-0">{labels.costOutput}</span> : null}
                      <span className="typography-meta text-foreground tabular-nums">{formatCost(metadata?.cost?.output)}</span>
                    </div>
                  </div>
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="xs"
                className="h-auto min-h-0 w-full min-w-0 justify-end gap-0 rounded-none p-0 text-right cursor-copy font-normal text-muted-foreground hover:bg-transparent active:bg-transparent"
                aria-label={t('onboarding.common.copyToClipboard')}
                title={modelIdentifier}
                onClick={async (event) => {
                  event.stopPropagation();
                  try {
                    const result = await copyTextToClipboard(modelIdentifier);
                    if (result.ok) toast.success(t('contextSidebar.actions.copied'));
                    else toast.error(t('filesView.toast.copyFailed'));
                  } catch {
                    toast.error(t('filesView.toast.copyFailed'));
                  }
                }}
              >
                <span className="block w-full min-w-0 truncate text-right text-[10px] leading-tight">{modelIdentifier}</span>
              </Button>
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
};

const createIndexSelectionStore = (): IndexSelectionStore => {
  let value = 0;
  const listeners = new Set<() => void>();
  const listenersByIndex = new Map<number, Set<() => void>>();
  const notify = (index: number) => {
    const listeners = listenersByIndex.get(index);
    if (!listeners) return;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeIndex: (index, listener) => {
      let listeners = listenersByIndex.get(index);
      if (!listeners) {
        listeners = new Set();
        listenersByIndex.set(index, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByIndex.delete(index);
      };
    },
    set: (nextValue) => {
      if (value === nextValue) return;
      const previousValue = value;
      value = nextValue;
      notify(previousValue);
      notify(nextValue);
      for (const listener of listeners) listener();
    },
  };
};

const ModelPickerRowHighlight: React.FC<{
  store: IndexSelectionStore;
  index: number;
  renderVersion?: number;
  children: (isHighlighted: boolean) => React.ReactNode;
}> = React.memo(({ store, index, children }) => {
  const [isHighlighted, setIsHighlighted] = React.useState(() => store.getSnapshot() === index);

  React.useEffect(() => {
    const sync = () => setIsHighlighted(store.getSnapshot() === index);
    sync();
    return store.subscribeIndex(index, sync);
  }, [index, store]);

  return <>{children(isHighlighted)}</>;
});

const ModelPickerFooter: React.FC<{
  store: IndexSelectionStore;
  flatModelList: ModelPickerEntry[];
  footerContent: ModelPickerListProps['footerContent'];
  fallback: React.ReactNode;
}> = ({ store, flatModelList, footerContent, fallback }) => {
  const [selectedIndex, setSelectedIndex] = React.useState(() => store.getSnapshot());

  React.useEffect(() => store.subscribe(() => setSelectedIndex(store.getSnapshot())), [store]);

  const activeEntry = flatModelList[selectedIndex];
  return <>{typeof footerContent === 'function' ? footerContent(activeEntry) : (footerContent ?? fallback)}</>;
};

type SortableFavoriteHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
  isDragging: boolean;
};

const SortableFavoriteModelRow: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableFavoriteHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </div>
  );
};

const SortableProviderSection: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableFavoriteHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Translate.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </div>
  );
};

const STICKY_HEADER_OFFSET = 32;

const scrollIntoView = (container: HTMLElement | null, node: HTMLElement | null) => {
  if (!node) return;
  if (!container) {
    node.scrollIntoView({ block: 'nearest' });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const top = nodeRect.top - containerRect.top + container.scrollTop;
  const bottom = top + nodeRect.height;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + container.clientHeight;
  const viewTopWithHeader = viewTop + STICKY_HEADER_OFFSET;
  const target = top < viewTopWithHeader
    ? top - STICKY_HEADER_OFFSET
    : bottom > viewBottom
      ? bottom - container.clientHeight
      : viewTop;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.max(0, Math.min(target, max));
};

interface ModelPickerListProps {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerFavoriteEntry[];
  recentModels: ModelPickerFavoriteEntry[];
  getMetadata?: (providerID: string, modelID: string) => ModelMetadata | undefined;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: {
    searchPlaceholder: string;
    noResults: string;
    favorites: string;
    recent: string;
    keyboardHint?: string;
    /** Label of the first provider-rail entry in the `stairs` layout. */
    all?: string;
    notSelected?: string;
    favorite?: string;
    unfavorite?: string;
    provider?: string;
    capabilities?: string;
    capabilityToolCalling?: string;
    capabilityReasoning?: string;
    modalityImage?: string;
    modalityVideo?: string;
    modalityAudio?: string;
    costPerMillion?: string;
    costInput?: string;
    costOutput?: string;
  };
  selectedModel?: { providerID: string; modelID: string } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  allowedModelIdsByProvider?: Record<string, readonly string[]>;
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  selectionCount?: (entry: ModelPickerEntry) => number;
  disabled?: boolean;
  maxHeightClassName?: string;
  maxHeightStyle?: React.CSSProperties;
  sectionHeaderClassName?: string;
  rowClassName?: string;
  stickyHeaders?: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  renderRowEnd?: (entry: ModelPickerEntry, state: { isHighlighted: boolean; isSelected: boolean }) => React.ReactNode;
  onActiveKeyDown?: (event: React.KeyboardEvent, entry: ModelPickerEntry | undefined) => void;
  onActiveEntryChange?: (entry: ModelPickerEntry | undefined) => void;
  onVariantKey?: (event: React.KeyboardEvent, entry: ModelPickerEntry) => boolean;
  onReorderFavorite?: (active: ModelPickerEntry, over: ModelPickerEntry) => void;
  reorderFavoriteAriaLabel?: string;
  reorderFavoriteTitle?: string;
  providerOrder?: string[];
  onReorderProvider?: (orderedProviderIDs: string[]) => void;
  reorderProviderTitle?: string;
  footerContent?: React.ReactNode | ((activeEntry: ModelPickerEntry | undefined) => React.ReactNode);
  renderVersion?: number;
  tooltipsEnabled?: boolean;
  /** Most-recent-first usage order used to rank search results; defaults to `recentModels`. */
  recencyOrder?: ReadonlyArray<{ providerID: string; modelID: string }>;
}

export const ModelPickerList: React.FC<ModelPickerListProps> = ({
  providers,
  favoriteModels,
  recentModels,
  getMetadata,
  searchQuery,
  onSearchQueryChange,
  onSelect,
  labels,
  selectedModel,
  hiddenModels = [],
  allowedProviderIds,
  allowedModelIdsByProvider,
  includeNotSelected = false,
  onSelectNone,
  selectionCount,
  disabled = false,
  maxHeightClassName = 'max-h-[min(400px,calc(100dvh-12rem))] flex-1',
  maxHeightStyle,
  sectionHeaderClassName,
  rowClassName,
  stickyHeaders = true,
  autoFocus = true,
  onEscape,
  isFavorite,
  onToggleFavorite,
  renderRowEnd,
  onActiveKeyDown,
  onActiveEntryChange,
  onVariantKey,
  onReorderFavorite,
  reorderFavoriteAriaLabel,
  reorderFavoriteTitle,
  providerOrder,
  onReorderProvider,
  reorderProviderTitle,
  footerContent,
  renderVersion,
  tooltipsEnabled = true,
  recencyOrder,
}) => {
  const { t } = useI18n();
  const selectionStoreRef = React.useRef<IndexSelectionStore | null>(null);
  if (!selectionStoreRef.current) selectionStoreRef.current = createIndexSelectionStore();
  const selectionStore = selectionStoreRef.current;
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const keyboardOwnsSelectionRef = React.useRef(false);
  const lastMousePositionRef = React.useRef<{ x: number; y: number } | null>(null);
  const hasSearchQuery = searchQuery.trim().length > 0;
  const favoriteRowSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  // Desktop-only provider reordering: a MouseSensor (no TouchSensor) keeps the
  // section headers tappable/scrollable on touch devices while enabling
  // click-and-drag with a mouse.
  const providerSectionSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
  );

  const allowedProviderSet = React.useMemo(() => {
    if (!allowedProviderIds || allowedProviderIds.length === 0) return null;
    return new Set(allowedProviderIds);
  }, [allowedProviderIds]);

  const allowedModelSetByProvider = React.useMemo(() => {
    if (!allowedModelIdsByProvider) return null;
    return new Map(
      Object.entries(allowedModelIdsByProvider).map(([providerID, modelIDs]) => [providerID, new Set(modelIDs)]),
    );
  }, [allowedModelIdsByProvider]);

  const isAllowedModel = React.useCallback((providerID: string, modelID: string) => {
    if (!allowedModelSetByProvider) return true;
    return allowedModelSetByProvider.get(providerID)?.has(modelID) === true;
  }, [allowedModelSetByProvider]);

  const providerById = React.useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((hidden) => hidden.providerID === providerID && hidden.modelID === modelID);
  }, [hiddenModels]);

  const matchesQuery = React.useCallback((modelName: string, providerName: string, providerID: string, modelID: string) => {
    const query = searchQuery.trim();
    if (!query) return true;
    // Separator-tolerant: "GLM 5.2" should still hit "GLM-5.2"; provider/model IDs are searchable too.
    return matchesModelSearch(buildModelSearchText({ providerName, providerID, modelName, modelID }), query);
  }, [searchQuery]);

  const filterBookmarkedModels = React.useMemo(() => (entries: ModelPickerEntry[]) => entries.filter(({ providerID, modelID }) => (
    providerById.has(providerID)
    && (!allowedProviderSet || allowedProviderSet.has(providerID))
    && isAllowedModel(providerID, modelID)
    && !isHidden(providerID, modelID)
  )), [allowedProviderSet, isAllowedModel, isHidden, providerById]);
  const filteredFavorites = React.useMemo(() => filterBookmarkedModels(favoriteModels), [favoriteModels, filterBookmarkedModels]);
  const filteredRecents = React.useMemo(() => filterBookmarkedModels(recentModels), [filterBookmarkedModels, recentModels]);

  const selectedProviderID = selectedModel?.providerID;
  const orderedProviders = React.useMemo(() => {
    let ordered = providers;
    if (providerOrder && providerOrder.length > 0) {
      const rank = new Map(providerOrder.map((id, index) => [id, index] as const));
      const ranked = providers
        .filter((provider) => rank.has(provider.id))
        .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      const unranked = providers.filter((provider) => !rank.has(provider.id));
      ordered = [...ranked, ...unranked];
    }
    // Stairs lifts the selected model's provider to the first group (and rail slot).
    return liftSelectedProvider(ordered, selectedProviderID);
  }, [providerOrder, providers, selectedProviderID]);

  const filteredProviders = React.useMemo(() => orderedProviders
    .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
    .map((provider) => {
      const models = Array.isArray(provider.models) ? provider.models : [];
      const filteredModels = models.filter((model) => {
        const modelID = typeof model.id === 'string' ? model.id : '';
        if (!modelID || isHidden(provider.id, modelID)) return false;
        if (!isAllowedModel(provider.id, modelID)) return false;
        return matchesQuery(getModelDisplayName(model), provider.name || provider.id, provider.id, modelID);
      });
      return { ...provider, models: filteredModels };
    })
    .filter((provider) => provider.models.length > 0), [allowedProviderSet, isAllowedModel, isHidden, matchesQuery, orderedProviders]);

  // Stairs search is one flat list ranked by match + recent usage instead of
  // per-section filtering, so the most relevant model is always the first row.
  const searchResults = React.useMemo(() => {
    if (!hasSearchQuery) return null;
    return rankModelSearchEntries<ModelPickerEntry>({
      candidates: filteredProviders.flatMap((provider) => provider.models.map((model) => ({
        entry: { model, providerID: provider.id, modelID: model.id as string },
        providerName: provider.name || provider.id,
        modelName: getModelDisplayName(model),
      }))),
      query: searchQuery.trim(),
      recencyOrder: recencyOrder ?? recentModels,
      recentModels,
      favoriteModels,
      selectedModel,
    });
  }, [favoriteModels, filteredProviders, hasSearchQuery, recencyOrder, recentModels, searchQuery, selectedModel]);

  // The rail lists every selectable provider regardless of the search query so
  // it does not reshuffle while typing.
  const railProviders = React.useMemo(() => orderedProviders
    .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
    .filter((provider) => (Array.isArray(provider.models) ? provider.models : []).some((model) => {
      const modelID = typeof model.id === 'string' ? model.id : '';
      return Boolean(modelID) && !isHidden(provider.id, modelID) && isAllowedModel(provider.id, modelID);
    })), [allowedProviderSet, isAllowedModel, isHidden, orderedProviders]);

  const { flatModelList, modelRowIndices } = React.useMemo(() => {
    const items: ModelPickerEntry[] = [];
    const modelRowIndices = new Map<string, number>();
    const append = (entry: ModelPickerEntry, section: string) => {
      modelRowIndices.set(`${section}:${entry.providerID}:${entry.modelID}`, items.length);
      items.push(entry);
    };
    if (searchResults) {
      searchResults.forEach((entry) => append(entry, 'search'));
      return { flatModelList: items, modelRowIndices };
    }
    filteredFavorites.forEach((entry) => append(entry, 'fav'));
    filteredRecents.forEach((entry) => append(entry, 'recent'));
    filteredProviders.forEach((provider) => {
      provider.models.forEach((model) => append({ model, providerID: provider.id, modelID: model.id as string }, 'provider'));
    });
    return { flatModelList: items, modelRowIndices };
  }, [filteredFavorites, filteredProviders, filteredRecents, searchResults]);

  const [rootFontSize, setRootFontSize] = React.useState(16);
  React.useLayoutEffect(() => {
    setRootFontSize(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }, []);
  const virtualLayout = React.useMemo(() => {
    const slots: Array<{ key: string; height: number; modelIndex: number }> = [];
    let modelIndex = 0;
    const addSection = (key: string, entries: ModelPickerEntry[], rowHeight: number, separated: boolean) => {
      slots.push({ key, height: (1.5 + (separated ? 0.625 : 0)) * rootFontSize, modelIndex: -1 });
      for (const entry of entries) slots.push({ key: `${key}:${entry.providerID}:${entry.modelID}`, height: rowHeight * rootFontSize, modelIndex: modelIndex++ });
    };
    if (searchResults) {
      for (const entry of searchResults) slots.push({ key: `search:${entry.providerID}:${entry.modelID}`, height: 2.5 * rootFontSize, modelIndex: modelIndex++ });
      return slots;
    }
    if (filteredFavorites.length) addSection('favorites', filteredFavorites, 2.5, false);
    if (filteredRecents.length) addSection('recent', filteredRecents, 2.5, filteredFavorites.length > 0);
    filteredProviders.forEach((provider, index) => addSection(
      `provider:${provider.id}`,
      provider.models.map((model) => ({ model, providerID: provider.id, modelID: model.id as string })),
      2,
      index > 0 || filteredFavorites.length > 0 || filteredRecents.length > 0,
    ));
    return slots;
  }, [filteredFavorites, filteredProviders, filteredRecents, rootFontSize, searchResults]);

  // Scroll offsets at which each provider's label reaches the top of the list.
  const providerSectionTops = React.useMemo(() => {
    if (searchResults) return [];
    const labelHeight = 1.5 * rootFontSize;
    const tops: Array<{ id: string; top: number }> = [];
    let offset = 0.375 * rootFontSize;
    for (const slot of virtualLayout) {
      if (slot.modelIndex === -1 && slot.key.startsWith('provider:')) {
        tops.push({ id: slot.key.slice('provider:'.length), top: offset + slot.height - labelHeight });
      }
      offset += slot.height;
    }
    return tops;
  }, [rootFontSize, searchResults, virtualLayout]);
  const railRef = React.useRef<HTMLElement | null>(null);
  const [railPin, setRailPin] = React.useState<{ id: string; offset: number } | null>(null);
  const virtualMeasurements = React.useMemo(() => ({
    estimateSize: (index: number) => virtualLayout[index].height,
    getItemKey: (index: number) => virtualLayout[index].key,
  }), [virtualLayout]);
  const rowVirtualizer = useVirtualizer({
    count: virtualLayout.length,
    getScrollElement: () => scrollRef.current,
    ...virtualMeasurements,
    paddingStart: 0.375 * rootFontSize,
    paddingEnd: 0.375 * rootFontSize,
    overscan: 6,
    initialRect: { width: 400, height: 400 },
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const visibleModelIndices = new Set(virtualItems.map((item) => virtualLayout[item.index].modelIndex));

  const stairsScrollOffset = rowVirtualizer.scrollOffset ?? 0;
  const railActiveId = (() => {
    if (railPin && Math.abs(stairsScrollOffset - railPin.offset) < 2) return railPin.id;
    let active = 'all';
    for (const section of providerSectionTops) {
      if (section.top <= stairsScrollOffset + 4) active = section.id;
    }
    return active;
  })();
  // Keep the active rail entry visible when the rail itself overflows.
  React.useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!rail || !active) return;
    const railRect = rail.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < railRect.top) rail.scrollTop += activeRect.top - railRect.top - 4;
    else if (activeRect.bottom > railRect.bottom) rail.scrollTop += activeRect.bottom - railRect.bottom + 4;
  }, [railActiveId, hasSearchQuery]);
  const scrollToRailSection = (id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const sectionTop = id === 'all' ? 0 : providerSectionTops.find((section) => section.id === id)?.top;
    if (sectionTop === undefined) return;
    const target = Math.max(0, Math.min(sectionTop, container.scrollHeight - container.clientHeight));
    container.scrollTop = target;
    setRailPin({ id, offset: target });
  };

  const hasResults = flatModelList.length > 0;
  const favoriteSortingEnabled = Boolean(onReorderFavorite) && searchQuery.trim().length === 0 && filteredFavorites.length > 1;
  const providerSortingEnabled = Boolean(onReorderProvider) && searchQuery.trim().length === 0 && !allowedProviderSet && filteredProviders.length > 1;
  const favoriteLookup: Map<string, ModelPickerEntry> = React.useMemo(() => new Map(
    filteredFavorites.map((entry) => [`${entry.providerID}:${entry.modelID}`, entry] as const),
  ), [filteredFavorites]);

  React.useEffect(() => {
    selectionStore.set(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setRailPin(null);
  }, [searchQuery, selectionStore]);

  const selectIndex = React.useCallback((index: number) => {
    selectionStore.set(index);
    onActiveEntryChange?.(flatModelList[index]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const moveSelection = React.useCallback((direction: 1 | -1) => {
    const total = flatModelList.length;
    if (total === 0) return;
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    const currentIndex = selectionStore.getSnapshot();
    const nextIndex = (currentIndex + direction + total) % total;
    selectionStore.set(nextIndex);
    onActiveEntryChange?.(flatModelList[nextIndex]);
    requestAnimationFrame(() => scrollIntoView(scrollRef.current, itemRefs.current[nextIndex]));
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  React.useEffect(() => {
    onActiveEntryChange?.(flatModelList[selectionStore.getSnapshot()]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    event.stopPropagation();
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && onVariantKey?.(event, selected)) return;
    }
    onActiveKeyDown?.(event, flatModelList[selectionStore.getSnapshot()]);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && !disabled) onSelect(selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    }
  }, [disabled, flatModelList, moveSelection, onActiveKeyDown, onEscape, onSelect, onVariantKey, selectionStore]);

  const headerClassName = cn(
    'model-picker-section-header typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 px-2 py-1.5',
    stickyHeaders && 'sticky top-0 z-10 [background:linear-gradient(var(--surface-elevated),var(--surface-elevated)),linear-gradient(var(--surface-background),var(--surface-background))]',
    sectionHeaderClassName,
  );

  const renderRow = (entry: ModelPickerEntry, keyPrefix: string, showProviderLogo: boolean, dragHandleProps?: SortableFavoriteHandleProps | null) => {
    const rowIndex = modelRowIndices.get(`${keyPrefix}:${entry.providerID}:${entry.modelID}`);
    if (rowIndex === undefined) return null;
    if (!dragHandleProps?.isDragging && !(virtualItems.length ? visibleModelIndices.has(rowIndex) : rowIndex < 12)) {
      return <div key={`${keyPrefix}-${entry.providerID}-${entry.modelID}`} ref={(element) => { itemRefs.current[rowIndex] = element; }} className="model-picker-row-placeholder" data-model-section={keyPrefix} aria-hidden="true" />;
    }
    const metadata = mergeModelMetadataWithLiveModel(entry.providerID, entry.model, getMetadata?.(entry.providerID, entry.modelID));
    const providerName = providerById.get(entry.providerID)?.name || entry.providerID;
    const contextTokens = formatModelContextTokens(metadata?.limit?.context);
    const count = selectionCount?.(entry) ?? 0;
    const isSelected = selectedModel?.providerID === entry.providerID && selectedModel.modelID === entry.modelID;
    const favorite = isFavorite?.(entry) ?? false;

    const handleMouseActivity = (event: React.MouseEvent) => {
      const nextPosition = { x: event.clientX, y: event.clientY };
      const previousPosition = lastMousePositionRef.current;
      const pointerMoved = !previousPosition || previousPosition.x !== nextPosition.x || previousPosition.y !== nextPosition.y;
      lastMousePositionRef.current = nextPosition;

      if (keyboardOwnsSelectionRef.current && !previousPosition) return;
      if (keyboardOwnsSelectionRef.current && !pointerMoved) return;
      if (keyboardOwnsSelectionRef.current && pointerMoved) keyboardOwnsSelectionRef.current = false;
      selectIndex(rowIndex);
    };

    return (
      <ModelPickerRowHighlight key={`${keyPrefix}-${entry.providerID}-${entry.modelID}`} store={selectionStore} index={rowIndex} renderVersion={renderVersion}>
        {(isHighlighted) => {
          const rowElement = (
            <div
              ref={(el) => { itemRefs.current[rowIndex] = el; }}
              role="option"
              data-model-section={keyPrefix}
              aria-selected={isSelected}
               aria-setsize={flatModelList.length}
               aria-posinset={rowIndex + 1}
              aria-disabled={disabled || undefined}
              tabIndex={-1}
              onClick={() => { if (!disabled) onSelect(entry); }}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(entry);
                }
              }}
              onMouseEnter={handleMouseActivity}
              onMouseMove={handleMouseActivity}
              className={cn(
                'model-picker-row w-full text-left px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer',
                !disabled && (isHighlighted ? 'bg-interactive-selection' : 'hover:bg-interactive-hover/50'),
                disabled && 'cursor-not-allowed opacity-60',
                rowClassName,
              )}
            >
              <div className="model-picker-row-main flex items-center gap-1.5 flex-1 min-w-0">
                {dragHandleProps ? (
                  <button type="button" ref={dragHandleProps.setActivatorNodeRef} {...dragHandleProps.attributes} {...dragHandleProps.listeners} disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} className="model-favorite-drag-handle flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none" aria-label={reorderFavoriteAriaLabel} title={reorderFavoriteTitle}>
                    <Icon name="draggable" className="size-3.5" />
                  </button>
                ) : null}
                {showProviderLogo ? <ModelLogo modelId={entry.modelID} providerId={entry.providerID} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <span className="model-picker-row-labels contents">
                  <span className="model-picker-row-name font-medium truncate">{getModelDisplayName(entry.model)}</span>
                  <span className="model-picker-row-meta contents">
                    {keyPrefix !== 'provider' ? <span className="model-picker-row-provider hidden truncate">{providerName}</span> : null}
                    {contextTokens ? <span className="model-picker-row-context typography-micro text-muted-foreground flex-shrink-0">{contextTokens}</span> : null}
                  </span>
                </span>
              </div>
              {count > 0 ? <span className="typography-micro text-muted-foreground flex-shrink-0">x{count}</span> : null}
              {renderRowEnd?.(entry, { isHighlighted, isSelected })}
              <span className={cn('model-picker-row-selection size-4 shrink-0', !isSelected && 'hidden')}>
                {isSelected ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
              </span>
              {onToggleFavorite ? (
                <button type="button" disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFavorite(entry); }} className={cn('model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80 flex-shrink-0 disabled:pointer-events-none', favorite ? 'text-primary' : 'text-muted-foreground')} aria-label={favorite ? labels.unfavorite : labels.favorite} title={favorite ? labels.unfavorite : labels.favorite}>
                  <Icon name={favorite ? 'star-fill' : 'star'} className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );

          return <ModelPickerRowTooltip metadata={metadata} providerName={providerName} providerID={entry.providerID} modelID={entry.modelID} active={tooltipsEnabled && isHighlighted} anchor={() => itemRefs.current[rowIndex]} labels={labels}>{rowElement}</ModelPickerRowTooltip>;
        }}
      </ModelPickerRowHighlight>
    );
  };

  const handleFavoriteDragEnd = (event: DragEndEvent) => {
    if (!onReorderFavorite) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeFavorite = favoriteLookup.get(String(active.id));
    const overFavorite = favoriteLookup.get(String(over.id));
    if (!activeFavorite || !overFavorite) return;

    onReorderFavorite(activeFavorite, overFavorite);
  };

  const handleProviderDragEnd = (event: DragEndEvent) => {
    if (!onReorderProvider) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const ids = orderedProviders.map((provider) => provider.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;

    onReorderProvider(arrayMove(ids, from, to));
  };

  const renderSectionHeader = (label: string, headerDragProps?: SortableFavoriteHandleProps) => (
    // Stairs labels are plain text: no icon, no collapse. Reorderable provider
    // labels still act as the drag activator.
    <div
      ref={headerDragProps?.setActivatorNodeRef}
      {...headerDragProps?.attributes}
      {...headerDragProps?.listeners}
      title={headerDragProps ? reorderProviderTitle : undefined}
      className={cn(headerClassName, headerDragProps && 'cursor-grab select-none active:cursor-grabbing')}
    >
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );

  const renderProviderSection = (
    provider: (typeof filteredProviders)[number],
    providerIndex: number,
    headerDragProps?: SortableFavoriteHandleProps,
  ) => (
    <>
      {providerIndex > 0 ? <div className="model-picker-section-divider h-px bg-border/40 my-1" /> : null}
      {renderSectionHeader(provider.name || provider.id, headerDragProps)}
      {provider.models.map((model) => renderRow({ model, providerID: provider.id, modelID: model.id as string }, 'provider', true))}
    </>
  );

  const scrollArea = (
      <ScrollableOverlay ref={scrollRef} outerClassName="min-w-0 flex-1" className="overlay-scrollbar-target--no-gutter" disableHorizontal>
        <div className="model-picker-list px-1">
          {!hasResults ? (
            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">{labels.noResults}</div>
          ) : null}

          {searchResults ? searchResults.map((entry) => renderRow(entry, 'search', true)) : (
          <>
          {filteredFavorites.length > 0 ? (
            <div className="model-picker-section">
              {renderSectionHeader(labels.favorites)}
              {favoriteSortingEnabled ? (
                <DndContext sensors={favoriteRowSensors} collisionDetection={closestCenter} onDragEnd={handleFavoriteDragEnd}>
                  <SortableContext items={filteredFavorites.map((entry) => `${entry.providerID}:${entry.modelID}`)} strategy={verticalListSortingStrategy}>
                    {filteredFavorites.map((entry) => {
                      return (
                        <SortableFavoriteModelRow key={`fav-sortable-${entry.providerID}-${entry.modelID}`} id={`${entry.providerID}:${entry.modelID}`} disabled={disabled}>
                          {(dragHandleProps) => renderRow(entry, 'fav', true, dragHandleProps)}
                        </SortableFavoriteModelRow>
                      );
                    })}
                  </SortableContext>
                </DndContext>
              ) : filteredFavorites.map((entry) => renderRow(entry, 'fav', true))}
            </div>
          ) : null}

          {filteredRecents.length > 0 ? (
            <div className="model-picker-section">
              {filteredFavorites.length > 0 ? <div className="model-picker-section-divider h-px bg-border/40 my-1" /> : null}
              {renderSectionHeader(labels.recent)}
              {filteredRecents.map((entry) => renderRow(entry, 'recent', true))}
            </div>
          ) : null}

          {(filteredFavorites.length > 0 || filteredRecents.length > 0) && filteredProviders.length > 0 ? <div className="model-picker-section-divider h-px bg-border/40 my-1" /> : null}

          {providerSortingEnabled ? (
            <DndContext sensors={providerSectionSensors} collisionDetection={closestCenter} onDragEnd={handleProviderDragEnd}>
              <SortableContext items={filteredProviders.map((provider) => provider.id)} strategy={verticalListSortingStrategy}>
                {filteredProviders.map((provider, providerIndex) => (
                  <SortableProviderSection key={provider.id} id={provider.id} disabled={disabled}>
                    {(dragHandleProps) => renderProviderSection(provider, providerIndex, dragHandleProps)}
                  </SortableProviderSection>
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            filteredProviders.map((provider, providerIndex) => (
              <div key={provider.id}>
                {renderProviderSection(provider, providerIndex)}
              </div>
            ))
          )}
          </>
          )}
        </div>
      </ScrollableOverlay>
  );

  const stairsRail = (
    <nav ref={railRef} className={cn('model-picker-rail', hasSearchQuery && 'pointer-events-none opacity-40')} aria-label={labels.provider ?? t('chat.modelControls.provider')} aria-disabled={hasSearchQuery || undefined}>
      {[{ id: 'all', name: labels.all ?? t('chat.modelControls.modeValue.all') }, ...railProviders.map((provider) => ({ id: provider.id, name: provider.name || provider.id }))].map((item) => (
        <Tooltip key={item.id}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              tabIndex={hasSearchQuery ? -1 : undefined}
              aria-label={item.name}
              aria-current={!hasSearchQuery && railActiveId === item.id ? 'true' : undefined}
              onClick={() => scrollToRailSection(item.id)}
              className={cn('model-picker-rail-item size-8', !hasSearchQuery && railActiveId === item.id && 'bg-interactive-selection')}
            >
              {item.id === 'all'
                ? <Icon name="list-unordered" className="size-4" />
                : <ProviderLogo providerId={item.id} className="size-4 flex-shrink-0" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>{item.name}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );

  return (
    <>
      <div className="model-picker-search-area p-1.5 pb-1">
        <div className="relative">
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={labels.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className="model-picker-search h-8 pl-8 typography-meta"
            autoFocus={autoFocus}
          />
        </div>
      </div>

      {includeNotSelected ? (
        <div className="model-picker-clear-action shrink-0 px-1.5 py-1">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={onSelectNone} disabled={disabled}>
            <Icon name="close" className="size-3.5" />
            <span className="min-w-0 truncate">{labels.notSelected}</span>
            {!selectedModel ? <Icon name="check" className="ml-auto size-4 shrink-0 text-primary" /> : null}
          </Button>
        </div>
      ) : null}
      <div className={cn('model-picker-stairs flex min-h-0', maxHeightClassName)} style={maxHeightStyle}>
        {stairsRail}
        {scrollArea}
      </div>

      <div className="model-picker-footer px-3 pt-1 pb-1.5 border-t border-border/40 typography-micro text-muted-foreground">
        <ModelPickerFooter store={selectionStore} flatModelList={flatModelList} footerContent={footerContent} fallback={labels.keyboardHint ?? (
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint"><Icon name="arrow-up" className="size-2.5" /><Icon name="arrow-down" className="size-2.5" /></Kbd>
            {t('directoryExplorerDialog.footer.navigate')}
            <Kbd variant="hint"><Icon name="corner-down-left" className="size-2.5" /></Kbd>
            {t('directoryExplorerDialog.footer.select')}
          </span>
        )} />
      </div>
    </>
  );
};
