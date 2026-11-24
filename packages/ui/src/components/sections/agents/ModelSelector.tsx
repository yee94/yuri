import React from 'react';
import { useEvent } from '@reactuses/core';
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Icon } from '@/components/icon/Icon';
import { useModelLists, type ModelListProvider } from '@/hooks/useModelLists';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { DesktopModelPickerContent, DesktopModelVariantPicker } from '@/components/model-picker/DesktopModelPickerContent';
import { ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { MobileModelPickerPanel } from '@/components/model-picker/MobileModelPickerPanel';

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    variant?: string;
    onChange: (providerId: string, modelId: string, variant?: string) => void;
    className?: string;
    allowedProviderIds?: string[];
    allowedModelIdsByProvider?: Record<string, readonly string[]>;
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
    showIcon?: boolean;
    providers?: ModelListProvider[];
}

function getVariantOptions(entry: ModelPickerEntry): string[] {
    const variants = (entry.model as { variants?: Record<string, unknown> }).variants;
    return variants ? Object.keys(variants) : [];
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    variant,
    onChange,
    className,
    allowedProviderIds,
    allowedModelIdsByProvider,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
    showIcon = true,
    providers: catalogProviders,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const storedProviders = useConfigStore((state) => state.providers);
    const providers = catalogProviders ?? storedProviders;
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const isMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const recentModelUsage = useUIStore((state) => state.recentModels);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists({
        currentProviderID: providerId,
        currentModelID: modelId,
        providers: catalogProviders,
    });
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [variantTarget, setVariantTarget] = React.useState<ModelPickerEntry | null>(null);
    const variantSelectionEnabled = variant !== undefined;

    const closePicker = useEvent(() => {
        setIsMobilePanelOpen(false);
        setIsDropdownOpen(false);
        setSearchQuery('');
        setVariantTarget(null);
    });
    const openMobilePanel = useEvent(() => {
        setIsMobilePanelOpen(true);
        void useConfigStore.getState().refreshCatalogsOnPickerOpen({ source: 'modelSelector:mobilePanel' });
    });
    const handleDropdownOpenChange = useEvent((open: boolean) => {
        if (!open) return closePicker();
        setIsDropdownOpen(true);
        void useConfigStore.getState().refreshCatalogsOnPickerOpen({ source: 'modelSelector:desktopMenu' });
    });

    const handleSelect = useEvent((entry: ModelPickerEntry) => {
        const variantOptions = getVariantOptions(entry);
        const sameModel = entry.providerID === providerId && entry.modelID === modelId;
        const rememberedVariant = entry.variant !== undefined && variantOptions.includes(entry.variant)
            ? entry.variant
            : undefined;
        const nextVariant = sameModel
            && variant
            && variantOptions.includes(variant)
            ? variant
            : (rememberedVariant ?? '');
        onChange(entry.providerID, entry.modelID, variantSelectionEnabled ? nextVariant : undefined);
        addRecentModel(
            entry.providerID,
            entry.modelID,
            variantSelectionEnabled ? (nextVariant || undefined) : undefined,
        );
        closePicker();
    });

    const handleSelectNone = useEvent(() => {
        onChange('', '', variantSelectionEnabled ? '' : undefined);
        closePicker();
    });

    const handleVariantSelect = useEvent((nextVariant: string | undefined) => {
        if (!variantTarget) return;
        onChange(variantTarget.providerID, variantTarget.modelID, nextVariant ?? '');
        addRecentModel(variantTarget.providerID, variantTarget.modelID, nextVariant);
        closePicker();
    });

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        provider: t('chat.modelControls.provider'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        modalityImage: t('chat.modelControls.modality.image'),
        modalityVideo: t('chat.modelControls.modality.video'),
        modalityAudio: t('chat.modelControls.modality.audio'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
        costInput: t('chat.modelControls.costInput'),
        costOutput: t('chat.modelControls.costOutput'),
    }), [placeholder, t]);

    const selectedModel = React.useMemo(() => providerId && modelId ? { providerID: providerId, modelID: modelId } : null, [providerId, modelId]);
    const triggerLabel = providerId && modelId ? `${providerId}/${modelId}` : (placeholder || t('settings.agents.modelSelector.notSelected'));
    const variantLabel = variantSelectionEnabled ? (variant || t('chat.modelControls.default')) : null;
    const resolveMobileVariant = React.useMemo(() => (entryProviderId: string, entryModelId: string) => (
        entryProviderId === providerId && entryModelId === modelId ? variant || undefined : undefined
    ), [modelId, providerId, variant]);
    const handleMobileSelect = useEvent((nextProviderId: string, nextModelId: string, nextVariant: string | undefined) => {
        onChange(nextProviderId, nextModelId, variantSelectionEnabled ? (nextVariant ?? '') : undefined);
        addRecentModel(
            nextProviderId,
            nextModelId,
            variantSelectionEnabled ? (nextVariant || undefined) : undefined,
        );
        closePicker();
    });

    const renderVariantControl = (entry: ModelPickerEntry, state: { isSelected: boolean }) => {
        if (!variantSelectionEnabled) return null;
        const variantOptions = getVariantOptions(entry);
        if (variantOptions.length === 0) return null;
        const rememberedVariant = entry.variant !== undefined && variantOptions.includes(entry.variant)
            ? entry.variant
            : undefined;
        const selectedVariant = state.isSelected ? variant : (rememberedVariant ?? '');
        return (
            <button
                type="button"
                className="model-picker-thinking flex shrink-0 items-center rounded-md px-1.5 py-0.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setVariantTarget(entry);
                }}
                aria-label={t('chat.modelControls.showThinkingModes')}
            >
                <span className="max-w-24 truncate">{selectedVariant || t('chat.modelControls.default')}</span>
                <Icon name="arrow-right-s" className="size-3.5" />
            </button>
        );
    };

    const modelPicker = (
        <ModelPickerList
            providers={providers}
            providerOrder={providerOrder}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            recencyOrder={recentModelUsage}
            getMetadata={getModelMetadata}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={handleSelect}
            labels={labels}
            selectedModel={selectedModel}
            hiddenModels={hiddenModels}
            allowedProviderIds={allowedProviderIds}
            allowedModelIdsByProvider={allowedModelIdsByProvider}
            includeNotSelected
            onSelectNone={handleSelectNone}
            onEscape={closePicker}
            tooltipsEnabled={tooltipsEnabled && isDropdownOpen}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            onToggleFavorite={(entry) => toggleFavoriteModel(
                entry.providerID,
                entry.modelID,
                entry.providerID === providerId && entry.modelID === modelId
                    ? (variant || undefined)
                    : entry.variant,
            )}
            renderRowEnd={renderVariantControl}
        />
    );

    const variantTargetOptions = variantTarget ? getVariantOptions(variantTarget) : [];
    const variantTargetHighlighted = (() => {
        if (!variantTarget) return '';
        const isCurrentModel = variantTarget.providerID === providerId
            && variantTarget.modelID === modelId;
        if (isCurrentModel) return variant || '';
        return variantTarget.variant !== undefined && variantTargetOptions.includes(variantTarget.variant)
            ? variantTarget.variant
            : '';
    })();
    const variantPicker = variantTarget ? (
        <DesktopModelVariantPicker
            entry={variantTarget}
            variants={variantTargetOptions}
            selectedVariant={variantTargetHighlighted}
            formatLabel={(option) => option || t('chat.modelControls.default')}
            onSelect={handleVariantSelect}
            onBack={() => setVariantTarget(null)}
        />
    ) : null;
    const picker = variantPicker || modelPicker;

    if (isActuallyMobile) {
        return (
            <>
                <button
                    type="button"
                    onClick={isReady ? openMobilePanel : undefined}
                    disabled={!isReady}
                    className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-[var(--surface-elevated)] px-2 py-1.5 text-left',
                        !isReady && 'opacity-60 cursor-not-allowed',
                        className,
                    )}
                >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : showIcon && (providerId || modelId) ? (
                            <ModelLogo modelId={modelId} providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : showIcon ? (
                            <Icon name="pencil-ai" className="h-3 w-3 text-muted-foreground" />
                        ) : null}
                        {isReady ? <span className="typography-meta font-medium text-foreground truncate">{triggerLabel}</span> : null}
                        {isReady && variantLabel ? <span className="shrink-0 typography-micro text-muted-foreground">{variantLabel}</span> : null}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </button>
                <MobileModelPickerPanel
                    open={isMobilePanelOpen}
                    onClose={closePicker}
                    selectedProviderID={providerId}
                    selectedModelID={modelId}
                    resolveSelectedVariant={resolveMobileVariant}
                    onSelect={handleMobileSelect}
                    providers={providers}
                    favoriteModels={favoriteModelsList}
                    recentModels={recentModelsList}
                    recencyOrder={recentModelUsage}
                    clearSelection={{ label: labels.notSelected, onSelect: handleSelectNone }}
                    getMetadata={getModelMetadata}
                    hiddenModels={hiddenModels}
                    allowedProviderIds={allowedProviderIds}
                    allowedModelIdsByProvider={allowedModelIdsByProvider}
                    providerOrder={providerOrder}
                    variantSelectionEnabled={variantSelectionEnabled}
                    isFavorite={isFavoriteModel}
                    onToggleFavorite={(nextProviderId, nextModelId) => toggleFavoriteModel(
                        nextProviderId,
                        nextModelId,
                        nextProviderId === providerId && nextModelId === modelId
                            ? (variant || undefined)
                            : favoriteModelsList.find((entry) => entry.providerID === nextProviderId && entry.modelID === nextModelId)?.variant
                                ?? recentModelsList.find((entry) => entry.providerID === nextProviderId && entry.modelID === nextModelId)?.variant,
                    )}
                />
            </>
        );
    }

    return (
        <DropdownMenu open={isReady && isDropdownOpen} onOpenChange={isReady ? handleDropdownOpenChange : undefined}>
            <DropdownMenuTrigger asChild>
                <div className={cn(
                    'border-input data-[placeholder]:text-muted-foreground flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover data-[popup-open]:bg-interactive-active h-6 w-fit',
                    !isReady && 'opacity-60 cursor-not-allowed',
                    className,
                )}>
                    {!isReady ? (
                        <>
                            <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                            <span className="typography-ui-label font-normal whitespace-nowrap text-muted-foreground">
                                {isUnavailable ? t('common.unavailable') : t('common.loading')}
                            </span>
                        </>
                    ) : (
                        <>
                            {showIcon
                                ? (providerId || modelId
                                    ? <ModelLogo modelId={modelId} providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" />
                                    : <Icon name="pencil-ai" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />)
                                : null}
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-left font-normal text-foreground">{triggerLabel}</span>
                            {variantLabel ? <span className="shrink-0 typography-micro text-muted-foreground">{variantLabel}</span> : null}
                        </>
                    )}
                    <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                </div>
            </DropdownMenuTrigger>
            <DesktopModelPickerContent align="start" portalToBody={dropdownPortalToBody}>
                {picker}
            </DesktopModelPickerContent>
        </DropdownMenu>
    );
};
