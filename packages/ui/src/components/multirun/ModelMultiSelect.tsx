import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { DesktopModelPickerContent } from '@/components/model-picker/DesktopModelPickerContent';
import { MobileModelPickerPanel } from '@/components/model-picker/MobileModelPickerPanel';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';

/** Chip height class - shared between chips and add button */
const CHIP_HEIGHT_CLASS = 'h-7';
const noSelectedVariant = () => undefined;

/** UI-only type with instanceId for React keys and duplicate tracking */
export interface ModelSelectionWithId {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: string;
  instanceId: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- Utility is tightly coupled with ModelMultiSelect
export const generateInstanceId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * Model selection chip with remove button.
 * Shows instance index (e.g., "(2)") when same model is selected multiple times.
 */
const ModelChip: React.FC<{
  model: ModelSelectionWithId;
  instanceIndex: number;
  totalSameModel: number;
  onRemove: () => void;
}> = ({ model, instanceIndex, totalSameModel, onRemove }) => {
  const displayName = model.displayName || `${model.providerID}/${model.modelID}`;
  const label = totalSameModel > 1 ? `${displayName} (${instanceIndex})` : displayName;

  return (
    <div className={cn('flex items-center gap-1.5 px-2 rounded-md bg-interactive-selection/20 border border-border/30', CHIP_HEIGHT_CLASS)}>
      <ModelLogo modelId={model.modelID} providerId={model.providerID} className="h-3.5 w-3.5" />
      <span className="typography-meta font-medium truncate max-w-[140px]">
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground ml-0.5"
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export interface ModelMultiSelectProps {
  selectedModels: ModelSelectionWithId[];
  onAdd: (model: ModelSelectionWithId) => void;
  onRemove: (index: number) => void;
  onUpdate?: (index: number, model: ModelSelectionWithId) => void;
  /** Minimum models required (shows validation hint) */
  minModels?: number;
  /** Label for the add button */
  addButtonLabel?: string;
  /** Whether to show the selected chips */
  showChips?: boolean;
  /** Maximum models allowed */
  maxModels?: number;
  /** Optional className for add model trigger button */
  addButtonClassName?: string;
  /** Direction for the model picker popup. Multi-run launcher opens upward near the footer. */
  dropdownSide?: 'top' | 'bottom';
  /** Optional className for the picker popup. */
  dropdownClassName?: string;
  /** Optional className for the trigger/dropdown positioning container. */
  containerClassName?: string;
  /** Optional trigger icon override. */
  triggerIcon?: React.ReactNode;
}

/**
 * Model selector for multi-run (allows selecting same model multiple times).
 */
export const ModelMultiSelect: React.FC<ModelMultiSelectProps> = ({
  selectedModels,
  onAdd,
  onRemove,
  onUpdate,
  minModels,
  addButtonLabel,
  showChips = true,
  maxModels,
  addButtonClassName,
  dropdownSide = 'top',
  dropdownClassName,
  containerClassName,
  triggerIcon,
}) => {
  const { t } = useI18n();
  const { isMobile: deviceIsMobile } = useDeviceInfo();
  const isMobileLayout = useUIStore((state) => state.isMobile);
  const isMobile = isMobileLayout || deviceIsMobile;
  const providers = useConfigStore((state) => state.providers) as ModelPickerProvider[];
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
  const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
  const { favoriteModelsList, recentModelsList } = useModelLists();
  const recentModelUsage = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const providerOrder = useUIStore((state) => state.providerOrder);
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const isSingleSelect = maxModels === 1;
  const canAddModel = maxModels === undefined || selectedModels.length < maxModels || isSingleSelect;
  const selectedModel = isSingleSelect ? selectedModels[0] : undefined;

  // Count occurrences of each model for display purposes
  const modelCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of selectedModels) {
      const key = `${m.providerID}:${m.modelID}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [selectedModels]);

  // Get instance index for a specific model selection
  const getInstanceIndex = (model: ModelSelectionWithId): number => {
    const sameModels = selectedModels.filter(
      m => m.providerID === model.providerID && m.modelID === model.modelID
    );
    return sameModels.findIndex(m => m.instanceId === model.instanceId) + 1;
  };

  const handleOpenChange = useEvent((open: boolean) => {
    setIsOpen(open);
    if (!open) setSearchQuery('');
  });
  const closePicker = useEvent(() => handleOpenChange(false));

  React.useEffect(() => {
    if (!canAddModel && isOpen) closePicker();
  }, [canAddModel, closePicker, isOpen]);

  const handleSelectModel = useEvent((providerID: string, modelID: string, model?: ModelPickerEntry['model']) => {
    if (!canAddModel) return;
    const nextModel = {
      providerID,
      modelID,
      displayName: getModelDisplayName(model, modelID) || modelID,
      instanceId: generateInstanceId(),
    };
    if (isSingleSelect && selectedModels.length > 0 && onUpdate) {
      onUpdate(0, nextModel);
    } else {
      onAdd(nextModel);
    }
    if (isSingleSelect) closePicker();
  });
  const selectDesktopModel = useEvent((entry: ModelPickerEntry) => handleSelectModel(entry.providerID, entry.modelID, entry.model));
  const selectMobileModel = useEvent((providerID: string, modelID: string) => {
    const model = providers.find((provider) => provider.id === providerID)?.models?.find((model) => model.id === modelID);
    handleSelectModel(providerID, modelID, model);
  });
  const getSelectionCount = (providerID: string, modelID: string) => modelCounts.get(`${providerID}:${modelID}`) ?? 0;

  const labels = React.useMemo(() => ({
    searchPlaceholder: t('multirun.modelMultiSelect.search.placeholder'),
    noResults: t('multirun.modelMultiSelect.search.noResults'),
    favorites: t('multirun.modelMultiSelect.sections.favorites'),
    recent: t('multirun.modelMultiSelect.sections.recent'),
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
  }), [t]);

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        CHIP_HEIGHT_CLASS,
        '!border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70',
        addButtonClassName,
      )}
      disabled={!canAddModel}
      onClick={isMobile ? () => handleOpenChange(true) : undefined}
    >
      {triggerIcon ?? <Icon name="add" className="h-3.5 w-3.5 mr-1" />}
      {addButtonLabel ?? t('multirun.modelMultiSelect.actions.addModel')}
    </Button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 items-center">
        {/* Add model button (dropdown trigger) */}
        <div className={cn('relative', containerClassName)}>
          {isMobile ? (
            <>
              {trigger}
              <MobileModelPickerPanel
                open={isOpen}
                onClose={closePicker}
                selectedProviderID={selectedModel?.providerID ?? ''}
                selectedModelID={selectedModel?.modelID ?? ''}
                resolveSelectedVariant={noSelectedVariant}
                onSelect={selectMobileModel}
                providers={providers}
                favoriteModels={favoriteModelsList}
                recentModels={recentModelsList}
                recencyOrder={recentModelUsage}
                providerOrder={providerOrder}
                getMetadata={getModelMetadata}
                hiddenModels={hiddenModels}
                selectionCount={getSelectionCount}
                variantSelectionEnabled={false}
                isFavorite={isFavoriteModel}
                onToggleFavorite={toggleFavoriteModel}
              />
            </>
          ) : (
            <DropdownMenu modal={false} open={isOpen} onOpenChange={handleOpenChange}>
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
              <DesktopModelPickerContent side={dropdownSide} align="start" className={dropdownClassName}>
                <ModelPickerList
                  providers={providers}
                  providerOrder={providerOrder}
                  favoriteModels={favoriteModelsList}
                  recentModels={recentModelsList}
                  recencyOrder={recentModelUsage}
                  getMetadata={getModelMetadata}
                  hiddenModels={hiddenModels}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  onSelect={selectDesktopModel}
                  labels={labels}
                  selectedModel={selectedModel}
                  selectionCount={(entry) => getSelectionCount(entry.providerID, entry.modelID)}
                  disabled={!canAddModel}
                  tooltipsEnabled={isOpen}
                  isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                  onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                  onEscape={closePicker}
                />
              </DesktopModelPickerContent>
            </DropdownMenu>
          )}
        </div>

        {/* Selected models */}
        {showChips && selectedModels.length > 0 && (
          <div className="flex flex-col gap-2 w-full">
            {selectedModels.map((model, index) => {
              const key = `${model.providerID}:${model.modelID}`;
              const totalSameModel = modelCounts.get(key) || 1;
              const instanceIndex = getInstanceIndex(model);

              const provider = providers.find((p) => p.id === model.providerID);
              const providerModel = provider?.models?.find((m: Record<string, unknown>) => (m as { id?: string }).id === model.modelID) as
                | { variants?: Record<string, unknown> }
                | undefined;
              const variantKeys = providerModel?.variants ? Object.keys(providerModel.variants) : [];
              const hasVariants = variantKeys.length > 0;

              const DEFAULT_VARIANT_VALUE = '__default__';
              const variantValue = model.variant ?? DEFAULT_VARIANT_VALUE;

              return (
                <div key={model.instanceId} className="flex items-center gap-2 min-w-0">
                  <ModelChip
                    model={model}
                    instanceIndex={instanceIndex}
                    totalSameModel={totalSameModel}
                    onRemove={() => onRemove(index)}
                  />

                  {hasVariants && (
                    <Select
                      value={variantValue}
                      onValueChange={(value) => {
                        if (!onUpdate) return;
                        const nextVariant = value === DEFAULT_VARIANT_VALUE ? undefined : value;
                        onUpdate(index, { ...model, variant: nextVariant });
                      }}
                    >
                      <SelectTrigger
                        size="chip"
                        className="px-2 gap-1.5 rounded-md !border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70 typography-meta font-medium text-foreground"
                      >
                        <Icon name="brain-ai-3"
                          className={cn(
                            'h-3.5 w-3.5 flex-shrink-0',
                            variantValue === DEFAULT_VARIANT_VALUE ? 'text-muted-foreground' : 'text-[color:var(--status-info)]'
                          )}
                        />
                        <SelectValue placeholder={t('multirun.modelMultiSelect.variant.placeholder')}>
                          {(value) => value === DEFAULT_VARIANT_VALUE
                            ? t('multirun.modelMultiSelect.variant.default')
                            : value}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent fitContent>
                        <SelectItem value={DEFAULT_VARIANT_VALUE} className="pr-2 [&>span:first-child]:hidden">
                          {t('multirun.modelMultiSelect.variant.default')}
                        </SelectItem>
                        {variantKeys.map((variant) => (
                          <SelectItem key={variant} value={variant} className="pr-2 [&>span:first-child]:hidden">
                            {variant}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Validation hint */}
      {minModels !== undefined && selectedModels.length < minModels && (
        <p className="typography-micro text-muted-foreground">
          {maxModels !== undefined
            ? t('multirun.modelMultiSelect.validation.minToMax', { min: minModels, max: maxModels })
            : t('multirun.modelMultiSelect.validation.minOnly', { min: minModels })}
        </p>
      )}
    </div>
  );
};
