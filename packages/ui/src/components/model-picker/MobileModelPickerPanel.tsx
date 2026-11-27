import React from 'react';
import { flushSync } from 'react-dom';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { consumeMatchingPress, markMatchingPress } from '@/components/ui/matchingPress';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { formatCompactTokensShort } from '@/lib/intlFormatters';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { buildModelSearchText, matchesModelSearch } from '@/lib/search/modelSearch';
import { liftSelectedProvider, rankModelSearchEntries } from '@/lib/search/modelPickerRanking';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

type HiddenModel = { providerID: string; modelID: string };
type PickerView = 'model' | 'variant';
type VariantTarget = { providerID: string; modelID: string; variant?: string };
type MetadataIcon = { key: string; icon: IconName; label: string };

const MAX_INLINE_VARIANT_OPTIONS = 8;
const INITIAL_ROW_BUDGET = 40;
const SEARCH_ROW_PAGE = 40;
const SEARCH_LOAD_MORE_DISTANCE = 600;
// Measured row (name + metadata line) and sticky label heights; placeholders for
// off-screen groups use them so rail jumps land where the rendered group will be.
const ESTIMATED_ROW_HEIGHT = 57;
const ESTIMATED_GROUP_LABEL_HEIGHT = 33;

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '';
    return formatCompactTokensShort(value);
};

const EMPTY_VARIANTS: readonly string[] = [];

type Translate = ReturnType<typeof useI18n>['t'];

const formatVariantLabel = (t: Translate, variant: string | undefined) => {
    if (!variant?.trim()) return t('chat.modelControls.default');
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

const getMetadataIcons = (t: Translate, metadata?: ModelMetadata): MetadataIcon[] => {
    const icons: MetadataIcon[] = [];
    if (metadata?.tool_call) icons.push({ key: 'tool_call', icon: 'tools', label: t('chat.modelControls.capability.toolCalling') });
    if (metadata?.reasoning) icons.push({ key: 'reasoning', icon: 'brain-ai-3', label: t('chat.modelControls.capability.reasoning') });
    const modalityIcons: Record<string, { icon: IconName; label: string }> = {
        text: { icon: 'text', label: t('chat.modelControls.modality.text') },
        image: { icon: 'file-image', label: t('chat.modelControls.modality.image') },
        video: { icon: 'file-video', label: t('chat.modelControls.modality.video') },
        audio: { icon: 'file-music', label: t('chat.modelControls.modality.audio') },
        pdf: { icon: 'file-pdf', label: t('chat.modelControls.modality.pdf') },
    };
    for (const modality of [...(metadata?.modalities?.input ?? []), ...(metadata?.modalities?.output ?? [])]) {
        const normalized = modality.trim().toLowerCase();
        const definition = modalityIcons[normalized];
        if (definition && !icons.some((entry) => entry.key === normalized)) icons.push({ key: normalized, ...definition });
    }
    return icons;
};

const matchingPressProps = {
    onPointerDown: markMatchingPress,
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (consumeMatchingPress(event)) return;
        event.preventDefault();
        event.stopPropagation();
    },
};

type ModelIndexEntry = { displayName: string; variants: readonly string[] };

/** Per-model display name and thinking variants, built once per provider catalog. */
const buildModelIndex = (providers: ModelPickerProvider[]) => {
    const index = new Map<string, ModelIndexEntry>();
    for (const provider of providers) {
        for (const model of provider.models ?? []) {
            const modelID = typeof model.id === 'string' ? model.id : '';
            if (!modelID) continue;
            const variants = (model as { variants?: Record<string, unknown> }).variants;
            index.set(`${provider.id}:${modelID}`, {
                displayName: getModelDisplayName(model, modelID, { maxLength: 40 }),
                variants: variants ? Object.keys(variants) : EMPTY_VARIANTS,
            });
        }
    }
    return index;
};

interface MobileModelPickerPanelProps {
    open: boolean;
    onClose: () => void;
    selectedProviderID: string;
    selectedModelID: string;
    resolveSelectedVariant: (providerID: string, modelID: string) => string | undefined;
    onSelect: (providerID: string, modelID: string, variant: string | undefined) => void;
    clearSelection?: { label: string; onSelect: () => void };
    selectionCount?: (providerID: string, modelID: string) => number;
    providers: ModelPickerProvider[];
    favoriteModels: ModelPickerEntry[];
    recentModels: ModelPickerEntry[];
    /** Most-recent-first usage order used to rank search results; defaults to `recentModels`. */
    recencyOrder?: ReadonlyArray<{ providerID: string; modelID: string }>;
    hiddenModels?: HiddenModel[];
    allowedProviderIds?: string[];
    allowedModelIdsByProvider?: Record<string, readonly string[]>;
    providerOrder?: string[];
    variantSelectionEnabled?: boolean;
    isFavorite: (providerID: string, modelID: string) => boolean;
    onToggleFavorite: (providerID: string, modelID: string) => void;
    getMetadata?: (providerID: string, modelID: string) => ModelMetadata | undefined;
    view?: PickerView;
    onViewChange?: (view: PickerView) => void;
}

/**
 * Stable shell: keeps cross-open UI state and MobileResizableSheet chrome.
 * Expensive provider/model list build + row metadata formatting live in
 * MobileModelPickerPanelBody under MobileWindowMotion presence (exit-safe).
 */
export const MobileModelPickerPanel: React.FC<MobileModelPickerPanelProps> = ({
    open,
    onClose,
    selectedProviderID,
    selectedModelID,
    resolveSelectedVariant,
    onSelect,
    clearSelection,
    selectionCount,
    providers,
    favoriteModels,
    recentModels,
    recencyOrder,
    hiddenModels = [],
    allowedProviderIds,
    allowedModelIdsByProvider,
    providerOrder,
    variantSelectionEnabled = true,
    isFavorite,
    onToggleFavorite,
    getMetadata,
    view,
    onViewChange,
}) => {
    const { t } = useI18n();
    const mobileSheetId = React.useId();
    const [query, setQuery] = React.useState('');
    const [expandedModelKey, setExpandedModelKey] = React.useState<string | null>(null);
    const [internalView, setInternalView] = React.useState<PickerView>('model');
    const [variantTarget, setVariantTarget] = React.useState<VariantTarget | null>(null);
    const activeView = view ?? internalView;

    React.useEffect(() => {
        if (!open) {
            setQuery('');
            setExpandedModelKey(null);
            setInternalView('model');
            setVariantTarget(null);
        }
    }, [open]);

    const setView = (nextView: PickerView) => {
        setInternalView(nextView);
        onViewChange?.(nextView);
    };

    const isVariantView = activeView === 'variant' && Boolean(
        variantTarget ?? (selectedProviderID && selectedModelID),
    );

    return (
        <MobileResizableSheet
            id={`mobile-model-picker-sheet-${mobileSheetId}`}
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) onClose();
            }}
            leading={isVariantView ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setView('model')}
                    aria-label={t('onboarding.common.actions.back')}
                >
                    <Icon name="arrow-left" className="size-5" />
                </Button>
            ) : undefined}
            ariaLabel={isVariantView ? t('chat.modelControls.thinking') : t('chat.modelControls.selectModel')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            bodyClassName="px-2"
            keyboardInset={false}
        >
            <MobileModelPickerPanelBody
                query={query}
                onQueryChange={setQuery}
                expandedModelKey={expandedModelKey}
                onExpandedModelKeyChange={setExpandedModelKey}
                activeView={activeView}
                setView={setView}
                variantTarget={variantTarget}
                onVariantTargetChange={setVariantTarget}
                selectedProviderID={selectedProviderID}
                selectedModelID={selectedModelID}
                resolveSelectedVariant={resolveSelectedVariant}
                onSelect={onSelect}
                clearSelection={clearSelection}
                selectionCount={selectionCount}
                providers={providers}
                favoriteModels={favoriteModels}
                recentModels={recentModels}
                recencyOrder={recencyOrder}
                hiddenModels={hiddenModels}
                allowedProviderIds={allowedProviderIds}
                allowedModelIdsByProvider={allowedModelIdsByProvider}
                providerOrder={providerOrder}
                variantSelectionEnabled={variantSelectionEnabled}
                isFavorite={isFavorite}
                onToggleFavorite={onToggleFavorite}
                getMetadata={getMetadata}
            />
        </MobileResizableSheet>
    );
};

type MobileModelRowProps = {
    model: ModelPickerEntry['model'];
    providerID: string;
    modelID: string;
    displayName: string;
    /** Shown above the name in favorites, recents and search results. */
    providerName?: string;
    selected: boolean;
    selectionCount?: number;
    expanded: boolean;
    favorite: boolean;
    variants: readonly string[];
    displayVariant?: string;
    clickVariant?: string;
    getMetadata?: (providerID: string, modelID: string) => ModelMetadata | undefined;
    onSelect: (providerID: string, modelID: string, variant: string | undefined) => void;
    onToggleExpanded: (rowKey: string) => void;
    onToggleFavorite: (providerID: string, modelID: string) => void;
    onOpenVariantOverflow: (providerID: string, modelID: string, variant?: string) => void;
};

// Every group is expanded, so rows must only re-render when their own props change
// (not on rail highlight, scroll sync, or an unrelated row's expansion).
const MobileModelRow = React.memo<MobileModelRowProps>(({
    model,
    providerID,
    modelID,
    displayName,
    providerName,
    selected,
    selectionCount = 0,
    expanded,
    favorite,
    variants,
    displayVariant,
    clickVariant,
    getMetadata,
    onSelect,
    onToggleExpanded,
    onToggleFavorite,
    onOpenVariantOverflow,
}) => {
    const { t } = useI18n();
    const rowKey = `${providerID}:${modelID}`;
    const metadata = mergeModelMetadataWithLiveModel(providerID, model, getMetadata?.(providerID, modelID));
    const inlineVariants = [undefined, ...variants].slice(0, MAX_INLINE_VARIANT_OPTIONS);
    const metadataIcons = getMetadataIcons(t, metadata);
    const contextText = metadata?.limit?.context ? `${formatTokens(metadata.limit.context)} ctx` : null;

    return (
        <div className={cn('border-b border-border/30 last:border-b-0', selected && 'bg-interactive-selection/15 text-interactive-selection-foreground')}>
            <div className="flex items-center gap-2 px-2 py-1.5">
                <button type="button" {...matchingPressProps} onClick={() => onSelect(providerID, modelID, clickVariant)} className="flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-primary">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {providerName !== undefined ? (
                            <span className="truncate text-[10px] leading-none text-muted-foreground/60">{providerName}</span>
                        ) : null}
                        <div className="flex min-w-0 items-center gap-1.5">
                            <ModelLogo modelId={modelID} providerId={providerID} className="size-3.5 flex-shrink-0" />
                            <span className="truncate typography-meta font-medium text-foreground">{displayName}</span>
                            {selected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                        </div>
                        {contextText || metadataIcons.length > 0 ? (
                            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
                                {contextText ? <span className="flex-shrink-0 whitespace-nowrap">{contextText}</span> : null}
                                {contextText && metadataIcons.length > 0 ? <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-border/50" /> : null}
                                <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0.5">
                                    {metadataIcons.map(({ key, icon, label }) => (
                                        <span key={`${rowKey}-${key}`} className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground" title={label} aria-label={label}>
                                            <Icon name={icon} className="size-3" />
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </button>
                {selectionCount > 0 ? <span className="shrink-0 typography-micro text-muted-foreground">x{selectionCount}</span> : null}
                {variants.length > 0 ? (
                    <button type="button" {...matchingPressProps} onClick={() => onToggleExpanded(rowKey)} className="flex flex-shrink-0 items-center gap-0.5 typography-micro font-medium text-muted-foreground hover:text-foreground" aria-expanded={expanded} aria-label={expanded ? t('chat.modelControls.hideThinkingModes') : t('chat.modelControls.showThinkingModes')}>
                        <span className="whitespace-nowrap">{formatVariantLabel(t, displayVariant)}</span>
                        <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                    </button>
                ) : null}
                <button type="button" {...matchingPressProps} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFavorite(providerID, modelID); }} className={cn('model-favorite-button flex size-5 flex-shrink-0 items-center justify-center hover:text-primary/80', favorite ? 'text-primary' : 'text-muted-foreground')} aria-label={favorite ? t('chat.modelControls.unfavoriteAria') : t('chat.modelControls.favoriteAria')} title={favorite ? t('chat.modelControls.removeFromFavorites') : t('chat.modelControls.addToFavorites')}>
                    <Icon name={favorite ? 'star-fill' : 'star'} className="size-4" />
                </button>
            </div>
            {expanded && variants.length > 0 ? (
                <div className="border-t border-border/30 p-2">
                    <div className="flex flex-wrap gap-2">
                        {inlineVariants.map((variant) => {
                            const variantSelected = variant === displayVariant || (!variant && !displayVariant);
                            return <button key={`${rowKey}-${variant ?? 'default'}`} type="button" {...matchingPressProps} onClick={() => onSelect(providerID, modelID, variant)} className={cn('inline-flex items-center rounded-full border px-2.5 py-1 typography-meta font-medium', variantSelected ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border/40 text-muted-foreground hover:bg-interactive-hover/50')} aria-pressed={variantSelected}>{formatVariantLabel(t, variant)}</button>;
                        })}
                        {inlineVariants.length < variants.length + 1 ? <button type="button" {...matchingPressProps} onClick={() => onOpenVariantOverflow(providerID, modelID, displayVariant)} className="inline-flex items-center rounded-full border border-border/40 px-2.5 py-1 typography-meta font-medium text-muted-foreground hover:bg-interactive-hover/50" aria-label={t('chat.modelControls.moreThinkingModes')}>{t('inlineComment.actions.showMore')}</button> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
});
MobileModelRow.displayName = 'MobileModelRow';

type MobileModelPickerPanelBodyProps = {
    query: string;
    onQueryChange: (value: string) => void;
    expandedModelKey: string | null;
    onExpandedModelKeyChange: (value: string | null | ((current: string | null) => string | null)) => void;
    activeView: PickerView;
    setView: (view: PickerView) => void;
    variantTarget: VariantTarget | null;
    onVariantTargetChange: (value: VariantTarget | null) => void;
    selectedProviderID: string;
    selectedModelID: string;
    resolveSelectedVariant: (providerID: string, modelID: string) => string | undefined;
    onSelect: (providerID: string, modelID: string, variant: string | undefined) => void;
    clearSelection?: MobileModelPickerPanelProps['clearSelection'];
    selectionCount?: MobileModelPickerPanelProps['selectionCount'];
    providers: ModelPickerProvider[];
    favoriteModels: ModelPickerEntry[];
    recentModels: ModelPickerEntry[];
    recencyOrder?: ReadonlyArray<{ providerID: string; modelID: string }>;
    hiddenModels: HiddenModel[];
    allowedProviderIds?: string[];
    allowedModelIdsByProvider?: Record<string, readonly string[]>;
    providerOrder?: string[];
    variantSelectionEnabled: boolean;
    isFavorite: (providerID: string, modelID: string) => boolean;
    onToggleFavorite: (providerID: string, modelID: string) => void;
    getMetadata?: (providerID: string, modelID: string) => ModelMetadata | undefined;
};

const MobileModelPickerPanelBody: React.FC<MobileModelPickerPanelBodyProps> = ({
    query: liveQuery,
    onQueryChange,
    expandedModelKey,
    onExpandedModelKeyChange,
    activeView,
    setView,
    variantTarget,
    onVariantTargetChange,
    selectedProviderID,
    selectedModelID,
    resolveSelectedVariant,
    onSelect,
    clearSelection,
    selectionCount,
    providers,
    favoriteModels,
    recentModels,
    recencyOrder,
    hiddenModels,
    allowedProviderIds,
    allowedModelIdsByProvider,
    providerOrder,
    variantSelectionEnabled,
    isFavorite,
    onToggleFavorite,
    getMetadata,
}) => {
    const { t } = useI18n();
    // The input stays on the live query; the full-catalog filter and ranking follow
    // the deferred value so typing never waits for the list to re-render.
    const query = React.useDeferredValue(liveQuery);
    const modelIndex = React.useMemo(() => buildModelIndex(providers), [providers]);
    const getDisplayName = (entry: { model: ModelPickerEntry['model']; providerID: string; modelID: string }) => (
        modelIndex.get(`${entry.providerID}:${entry.modelID}`)?.displayName
        ?? getModelDisplayName(entry.model, entry.modelID, { maxLength: 40 })
    );
    const getVariants = (providerID: string, modelID: string) => (
        modelIndex.get(`${providerID}:${modelID}`)?.variants ?? EMPTY_VARIANTS
    );

    const allowedProviderSet = React.useMemo(
        () => allowedProviderIds && allowedProviderIds.length > 0 ? new Set(allowedProviderIds) : null,
        [allowedProviderIds],
    );
    const allowedModelsByProvider = React.useMemo(() => allowedModelIdsByProvider
        ? new Map(Object.entries(allowedModelIdsByProvider).map(([providerID, modelIDs]) => [providerID, new Set(modelIDs)]))
        : null, [allowedModelIdsByProvider]);
    const hiddenModelKeys = React.useMemo(
        () => new Set(hiddenModels.map((entry) => `${entry.providerID}:${entry.modelID}`)),
        [hiddenModels],
    );
    const providerByID = React.useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
    const orderedProviders = React.useMemo(() => {
        let ordered = providers;
        if (providerOrder?.length) {
            const rank = new Map(providerOrder.map((providerID, index) => [providerID, index]));
            ordered = [...providers].sort((left, right) => {
                const leftRank = rank.get(left.id);
                const rightRank = rank.get(right.id);
                if (leftRank === undefined && rightRank === undefined) return 0;
                if (leftRank === undefined) return 1;
                if (rightRank === undefined) return -1;
                return leftRank - rightRank;
            });
        }
        // The selected model's provider becomes the first group and rail slot.
        return liftSelectedProvider(ordered, selectedProviderID || undefined);
    }, [providerOrder, providers, selectedProviderID]);

    // Render-phase predicates via useMemo (stable identity + real deps; not useEvent).
    const isAllowed = React.useMemo(
        () => (providerID: string, modelID: string) => {
            if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
            if (allowedModelsByProvider && allowedModelsByProvider.get(providerID)?.has(modelID) !== true) return false;
            return !hiddenModelKeys.has(`${providerID}:${modelID}`);
        },
        [allowedModelsByProvider, allowedProviderSet, hiddenModelKeys],
    );

    const matchesQuery = React.useMemo(
        () => (entry: ModelPickerEntry) => {
            const normalizedQuery = query.trim();
            if (!normalizedQuery) return true;
            const provider = providerByID.get(entry.providerID);
            const providerName = provider?.name || entry.providerID;
            const modelName = modelIndex.get(`${entry.providerID}:${entry.modelID}`)?.displayName
                ?? getModelDisplayName(entry.model, entry.modelID, { maxLength: 40 });
            return matchesModelSearch(buildModelSearchText({
                providerName,
                providerID: entry.providerID,
                modelName,
                modelID: entry.modelID,
            }), normalizedQuery);
        },
        [modelIndex, providerByID, query],
    );

    const filteredFavorites = React.useMemo(
        () => favoriteModels.filter((entry) => isAllowed(entry.providerID, entry.modelID) && matchesQuery(entry)),
        [favoriteModels, isAllowed, matchesQuery],
    );
    const filteredRecents = React.useMemo(
        () => recentModels.filter((entry) => isAllowed(entry.providerID, entry.modelID) && matchesQuery(entry)),
        [isAllowed, matchesQuery, recentModels],
    );
    const filteredProviders = React.useMemo(() => {
        const normalizedQuery = query.trim();
        return orderedProviders
            .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
            .map((provider) => {
                const providerMatches = normalizedQuery.length > 0
                    && (matchesModelSearch(provider.name || provider.id, normalizedQuery)
                        || matchesModelSearch(provider.id, normalizedQuery));
                const models = (provider.models ?? []).filter((model) => {
                    const modelID = typeof model.id === 'string' ? model.id : '';
                    if (!modelID || !isAllowed(provider.id, modelID)) return false;
                    if (providerMatches || !normalizedQuery) return true;
                    return matchesModelSearch(buildModelSearchText({
                        providerName: provider.name || provider.id,
                        providerID: provider.id,
                        modelName: modelIndex.get(`${provider.id}:${modelID}`)?.displayName ?? modelID,
                        modelID,
                    }), normalizedQuery);
                });
                return { provider, models };
            })
            .filter((entry) => entry.models.length > 0);
    }, [allowedProviderSet, isAllowed, modelIndex, orderedProviders, query]);

    const hasQuery = query.trim().length > 0;
    // Search is one flat list ranked by match + recent usage + selection, so the
    // most relevant model is the first row regardless of its provider group.
    const searchResults = React.useMemo(() => {
        if (!hasQuery) return null;
        return rankModelSearchEntries<ModelPickerEntry>({
            candidates: filteredProviders.flatMap(({ provider, models }) => models.map((model) => ({
                entry: { model, providerID: provider.id, modelID: model.id as string },
                providerName: provider.name || provider.id,
                modelName: modelIndex.get(`${provider.id}:${model.id as string}`)?.displayName ?? (model.id as string),
            }))),
            query: query.trim(),
            recencyOrder: recencyOrder ?? recentModels,
            recentModels,
            favoriteModels,
            selectedModel: selectedProviderID && selectedModelID
                ? { providerID: selectedProviderID, modelID: selectedModelID }
                : null,
        });
    }, [favoriteModels, filteredProviders, hasQuery, modelIndex, query, recencyOrder, recentModels, selectedModelID, selectedProviderID]);

    // The rail lists every selectable provider regardless of the query so it does not reshuffle while typing.
    const railProviders = React.useMemo(() => orderedProviders.filter((provider) => (
        (!allowedProviderSet || allowedProviderSet.has(provider.id))
        && (provider.models ?? []).some((model) => typeof model.id === 'string' && isAllowed(provider.id, model.id))
    )), [allowedProviderSet, isAllowed, orderedProviders]);

    // The first commit mounts only about one screen of rows; the rest of the catalog
    // follows in an interruptible transition so opening the sheet is not blocked.
    const [mountAllRows, setMountAllRows] = React.useState(false);
    React.useEffect(() => {
        if (!mountAllRows) React.startTransition(() => setMountAllRows(true));
    }, [mountAllRows]);
    // Short queries match hundreds of models; mount one page of ranked rows and
    // grow it near the bottom. The limit belongs to its query, so a new query
    // starts from the first page without an effect.
    const [searchRowLimit, setSearchRowLimit] = React.useState({ query: '', limit: SEARCH_ROW_PAGE });
    const searchLimit = searchRowLimit.query === query ? searchRowLimit.limit : SEARCH_ROW_PAGE;
    const visibleSearchResults = searchResults ? searchResults.slice(0, searchLimit) : null;
    const hasMoreSearchRows = searchResults !== null && searchResults.length > searchLimit;
    const visibleProviders = (() => {
        if (mountAllRows) return filteredProviders;
        let budget = INITIAL_ROW_BUDGET - filteredFavorites.length - filteredRecents.length;
        const visible: typeof filteredProviders = [];
        for (const group of filteredProviders) {
            if (budget <= 0) break;
            visible.push(group.models.length > budget ? { ...group, models: group.models.slice(0, budget) } : group);
            budget -= group.models.length;
        }
        return visible;
    })();

    const [railActiveId, setRailActiveId] = React.useState('all');
    const scrollRef = React.useRef<HTMLElement | null>(null);
    const railRef = React.useRef<HTMLElement | null>(null);
    // A tapped rail entry stays active until the list scrolls away from its target,
    // so short trailing groups that can never reach the top remain selectable.
    const railPinRef = React.useRef<{ id: string; offset: number } | null>(null);

    const getRailSections = () => Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-rail-section]') ?? []);

    const syncRailActive = () => {
        const container = scrollRef.current;
        if (!container) return;
        const pin = railPinRef.current;
        if (pin) {
            if (Math.abs(container.scrollTop - pin.offset) < 2) return;
            railPinRef.current = null;
        }
        const containerTop = container.getBoundingClientRect().top;
        let active = 'all';
        for (const section of getRailSections()) {
            if (section.getBoundingClientRect().top - containerTop > 8) break;
            active = section.dataset.railSection ?? active;
        }
        setRailActiveId(active);
    };

    // Scroll events can fire several times per frame; measure section rects at most once per frame.
    const railSyncFrameRef = React.useRef<number | null>(null);
    const scheduleRailSync = () => {
        if (railSyncFrameRef.current !== null) return;
        railSyncFrameRef.current = requestAnimationFrame(() => {
            railSyncFrameRef.current = null;
            syncRailActive();
        });
    };
    // Search results are one flat list with a disabled rail: scrolling only pages more rows in.
    const handleScroll = () => {
        if (!searchResults) {
            scheduleRailSync();
            return;
        }
        if (!hasMoreSearchRows) return;
        const container = scrollRef.current;
        if (!container || container.scrollHeight - container.scrollTop - container.clientHeight > SEARCH_LOAD_MORE_DISTANCE) return;
        setSearchRowLimit({ query, limit: searchLimit + SEARCH_ROW_PAGE });
    };
    React.useEffect(() => () => {
        if (railSyncFrameRef.current !== null) cancelAnimationFrame(railSyncFrameRef.current);
    }, []);

    const scrollToRailSection = (id: string) => {
        const container = scrollRef.current;
        if (!container) return;
        // A tap can arrive before the deferred rows mount; mount them now so the target section exists.
        if (!mountAllRows) flushSync(() => setMountAllRows(true));
        let target = 0;
        if (id !== 'all') {
            const section = getRailSections().find((element) => element.dataset.railSection === id);
            if (!section) return;
            target = section.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        }
        target = Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight));
        container.scrollTop = target;
        railPinRef.current = { id, offset: target };
        setRailActiveId(id);
    };

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.scrollTop = 0;
        railPinRef.current = null;
        syncRailActive();
        // Only the query switches between the sectioned list and flat results.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasQuery]);

    // Keep the active rail entry visible when the rail itself overflows.
    React.useEffect(() => {
        const rail = railRef.current;
        const active = rail?.querySelector<HTMLElement>('[aria-current="true"]');
        if (!rail || !active) return;
        const railRect = rail.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        if (activeRect.top < railRect.top) rail.scrollTop += activeRect.top - railRect.top - 4;
        else if (activeRect.bottom > railRect.bottom) rail.scrollTop += activeRect.bottom - railRect.bottom + 4;
    }, [railActiveId]);

    // Stable identities so memoized rows skip re-rendering; these only run on user events.
    const handleSelect = useEvent((providerID: string, modelID: string, variant: string | undefined) => onSelect(providerID, modelID, variant));
    const handleToggleExpanded = useEvent((rowKey: string) => onExpandedModelKeyChange((current) => current === rowKey ? null : rowKey));
    const handleToggleFavorite = useEvent((providerID: string, modelID: string) => onToggleFavorite(providerID, modelID));
    const handleOpenVariantOverflow = useEvent((providerID: string, modelID: string, variant?: string) => {
        onVariantTargetChange(variant === undefined ? { providerID, modelID } : { providerID, modelID, variant });
        setView('variant');
    });

    const renderModelRow = (entry: ModelPickerEntry, options: { showProvider?: boolean; preferRememberedVariant?: boolean } = {}) => {
        const { model, providerID, modelID } = entry;
        const rowKey = `${providerID}:${modelID}`;
        const selected = providerID === selectedProviderID && modelID === selectedModelID;
        const variants = variantSelectionEnabled ? getVariants(providerID, modelID) : EMPTY_VARIANTS;
        const selectedVariant = resolveSelectedVariant(providerID, modelID);
        const rememberedVariant = options.preferRememberedVariant
            && entry.variant !== undefined
            && variants.includes(entry.variant)
            ? entry.variant
            : undefined;
        // Favorites/recents apply a still-valid remembered variant; expired values fall back.
        // Selected rows keep live resolveSelectedVariant for display; clicks still prefer remembered.
        const clickVariant = rememberedVariant !== undefined ? rememberedVariant : selectedVariant;
        const displayVariant = selected
            ? selectedVariant
            : (rememberedVariant !== undefined ? rememberedVariant : selectedVariant);
        return (
            <MobileModelRow
                key={`mobile-model-${rowKey}`}
                model={model}
                providerID={providerID}
                modelID={modelID}
                displayName={getDisplayName(entry)}
                providerName={options.showProvider ? (providerByID.get(providerID)?.name || providerID) : undefined}
                selected={selected}
                selectionCount={selectionCount?.(providerID, modelID)}
                expanded={expandedModelKey === rowKey}
                favorite={isFavorite(providerID, modelID)}
                variants={variants}
                displayVariant={displayVariant}
                clickVariant={clickVariant}
                getMetadata={getMetadata}
                onSelect={handleSelect}
                onToggleExpanded={handleToggleExpanded}
                onToggleFavorite={handleToggleFavorite}
                onOpenVariantOverflow={handleOpenVariantOverflow}
            />
        );
    };

    const activeVariantTarget = variantTarget ?? (activeView === 'variant' && selectedProviderID && selectedModelID
        ? { providerID: selectedProviderID, modelID: selectedModelID }
        : null);
    const targetVariants = activeVariantTarget ? getVariants(activeVariantTarget.providerID, activeVariantTarget.modelID) : EMPTY_VARIANTS;
    const targetSelectedVariant = (() => {
        if (!activeVariantTarget) return undefined;
        const isCurrentModel = activeVariantTarget.providerID === selectedProviderID
            && activeVariantTarget.modelID === selectedModelID;
        if (isCurrentModel) {
            return resolveSelectedVariant(activeVariantTarget.providerID, activeVariantTarget.modelID);
        }
        const remembered = activeVariantTarget.variant !== undefined
            && targetVariants.includes(activeVariantTarget.variant)
            ? activeVariantTarget.variant
            : undefined;
        return remembered ?? resolveSelectedVariant(activeVariantTarget.providerID, activeVariantTarget.modelID);
    })();
    const hasResults = searchResults
        ? searchResults.length > 0
        : filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;
    const renderGroupLabel = (label: string) => (
        <div className="sticky top-0 z-10 bg-[var(--surface-elevated)] px-2 py-1.5 typography-micro font-semibold text-muted-foreground">{label}</div>
    );
    const isVariantView = activeView === 'variant' && Boolean(activeVariantTarget);

    return (
        // Match Sessions sheet: pin search outside the scroll region, and use
        // ScrollableOverlay so the list gets a bounded height + the default
        // dismiss-gesture scroll container class (`.overlay-scrollbar-container`).
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            {!isVariantView ? (
                <div
                    className="relative z-10 shrink-0"
                    data-mobile-sheet-no-dismiss=""
                    data-mobile-sheet-search=""
                >
                    <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        type="text"
                        value={liveQuery}
                        onChange={(event) => {
                            onQueryChange(event.target.value);
                            onExpandedModelKeyChange(null);
                        }}
                        placeholder={t('chat.modelControls.searchProvidersOrModels')}
                        className="h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] pl-7 typography-meta"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        enterKeyHint="search"
                        inputMode="search"
                    />
                    {liveQuery ? (
                        <button
                            type="button"
                            onClick={() => {
                                onQueryChange('');
                                onExpandedModelKeyChange(null);
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            aria-label={t('chat.modelControls.clearSearch')}
                        >
                            <Icon name="close-circle" className="size-4" />
                        </button>
                    ) : null}
                </div>
            ) : null}
            {!isVariantView && clearSelection ? (
                <Button type="button" variant="ghost" size="sm" {...matchingPressProps} onClick={clearSelection.onSelect} className="shrink-0 justify-start text-muted-foreground">
                    <Icon name="close" className="size-3.5" />
                    <span className="min-w-0 truncate">{clearSelection.label}</span>
                    {!selectedProviderID || !selectedModelID ? <Icon name="check" className="ml-auto size-4 shrink-0 text-primary" /> : null}
                </Button>
            ) : null}
            <div className="flex min-h-0 flex-1 gap-1">
            {!isVariantView ? (
                <nav
                    ref={railRef}
                    aria-label={t('chat.modelControls.provider')}
                    aria-disabled={hasQuery || undefined}
                    data-mobile-sheet-no-dismiss=""
                    className={cn('model-picker-rail flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto py-1 scrollbar-hidden', hasQuery && 'pointer-events-none opacity-40')}
                >
                    {[{ id: 'all', name: t('chat.modelControls.modeValue.all') }, ...railProviders.map((provider) => ({ id: provider.id, name: provider.name || provider.id }))].map((item) => {
                        const active = !hasQuery && railActiveId === item.id;
                        return (
                            <Button
                                key={item.id}
                                type="button"
                                variant="ghost"
                                size="icon"
                                {...matchingPressProps}
                                tabIndex={hasQuery ? -1 : undefined}
                                aria-label={item.name}
                                aria-current={active ? 'true' : undefined}
                                onClick={() => scrollToRailSection(item.id)}
                                className={cn('size-9 shrink-0', active && 'bg-interactive-selection')}
                            >
                                {item.id === 'all'
                                    ? <Icon name="list-unordered" className="size-4" />
                                    : <ProviderLogo providerId={item.id} className="size-4 flex-shrink-0" />}
                            </Button>
                        );
                    })}
                </nav>
            ) : null}
            <ScrollableOverlay
                ref={scrollRef}
                onScroll={handleScroll}
                disableHorizontal
                preventOverscroll
                outerClassName="min-h-0 flex-1"
                className="overscroll-contain"
            >
                <div className="flex flex-col gap-2">
                    {isVariantView && activeVariantTarget ? (
                        <div className="flex flex-col gap-1.5">
                            {[undefined, ...targetVariants].map((variant) => {
                                const selected = variant === targetSelectedVariant || (!variant && !targetSelectedVariant);
                                return (
                                    <button
                                        key={variant ?? 'default'}
                                        type="button"
                                        className={cn(
                                            'flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                                            selected ? 'border-primary/30 bg-primary/10' : 'border-border/40',
                                        )}
                                        {...matchingPressProps}
                                        onClick={() => onSelect(activeVariantTarget.providerID, activeVariantTarget.modelID, variant)}
                                    >
                                        <span className="typography-meta font-medium text-foreground">{formatVariantLabel(t, variant)}</span>
                                        {selected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <>
                            {!hasResults ? (
                                <div className="px-3 py-8 text-center typography-meta text-muted-foreground">
                                    {t('chat.modelControls.noProvidersOrModelsFound')}
                                </div>
                            ) : null}
                            {hasResults ? (
                                <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)]">
                                    {searchResults ? (
                                        <div className="flex flex-col">{visibleSearchResults?.map((entry) => renderModelRow(entry, { showProvider: true, preferRememberedVariant: true }))}</div>
                                    ) : (
                                        <>
                                            <div data-rail-section="all">
                                                {filteredFavorites.length > 0 ? (
                                                    <div>
                                                        {renderGroupLabel(t('chat.modelControls.favorites'))}
                                                        <div className="flex flex-col">{filteredFavorites.map((entry) => renderModelRow(entry, { showProvider: true, preferRememberedVariant: true }))}</div>
                                                    </div>
                                                ) : null}
                                                {filteredRecents.length > 0 ? (
                                                    <div>
                                                        {renderGroupLabel(t('chat.modelControls.recent'))}
                                                        <div className="flex flex-col">{filteredRecents.map((entry) => renderModelRow(entry, { showProvider: true, preferRememberedVariant: true }))}</div>
                                                    </div>
                                                ) : null}
                                            </div>
                                            {visibleProviders.map(({ provider, models }) => (
                                                <div
                                                    key={provider.id}
                                                    data-rail-section={provider.id}
                                                    // Off-screen groups skip layout and paint; `auto` keeps the last measured height.
                                                    style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${models.length * ESTIMATED_ROW_HEIGHT + ESTIMATED_GROUP_LABEL_HEIGHT}px` }}
                                                >
                                                    {renderGroupLabel(provider.name || provider.id)}
                                                    <div className="flex flex-col">
                                                        {models.map((model) => renderModelRow({ model, providerID: provider.id, modelID: model.id as string }))}
                                                    </div>
                                                </div>
                                            ))}
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            </ScrollableOverlay>
            </div>
        </div>
    );
};
