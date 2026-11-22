import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useQuotaStore } from '@/stores/useQuotaStore';

type Sortable = ReturnType<typeof useSortable>;

interface ListBinding {
  ids: string[];
  move: (id: string, delta: number) => void;
}

interface HandleBinding {
  id: string;
  move: (id: string, delta: number) => void;
  setActivatorNodeRef: Sortable['setActivatorNodeRef'];
  attributes: Sortable['attributes'];
  listeners: Sortable['listeners'];
}

const ListContext = React.createContext<ListBinding | null>(null);
const HandleContext = React.createContext<HandleBinding | null>(null);

interface SortableUsageListProps {
  /** The providers on screen, in the order they are drawn. */
  ids: string[];
  /** Called with the new order after a drag or Alt+arrow move; defaults to saving it as the user's usage order. */
  onReorder?: (ids: string[]) => void;
  /** A view that can't save an order (a remote host's popover) draws plain cards. */
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * Magpie lets its usage cards be dragged by their logo (or moved with Alt+arrows). This wraps the
 * cards of one usage view the same way; each card sits in a SortableUsageItem and shows its logo as
 * a UsageProviderLogo handle.
 */
export const SortableUsageList: React.FC<SortableUsageListProps> = ({ ids, onReorder, disabled = false, children }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const commit = useEvent((next: string[]) => {
    (onReorder ?? useQuotaStore.getState().reorderProviders)(next);
  });
  const onDragEnd = useEvent(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    commit(arrayMove(ids, from, to));
  });
  const move = useEvent((id: string, delta: number) => {
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from < 0 || to === from) return;
    commit(arrayMove(ids, from, to));
  });
  const binding = React.useMemo(() => ({ ids, move }), [ids, move]);

  if (disabled || ids.length < 2) return <>{children}</>;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ListContext.Provider value={binding}>{children}</ListContext.Provider>
      </SortableContext>
    </DndContext>
  );
};

const SortableItemInner: React.FC<{ id: string; list: ListBinding; className?: string; children: React.ReactNode }> = ({
  id,
  list,
  className,
  children,
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = React.useMemo(
    () => ({ id, move: list.move, setActivatorNodeRef, attributes, listeners }),
    [id, list.move, setActivatorNodeRef, attributes, listeners],
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={cn('group/usage relative', isDragging && 'opacity-70', className)}
    >
      <HandleContext.Provider value={handle}>{children}</HandleContext.Provider>
    </div>
  );
};

export const SortableUsageItem: React.FC<{ id: string; className?: string; children: React.ReactNode }> = ({ id, className, children }) => {
  const list = React.useContext(ListContext);
  if (!list) return <div className={className}>{children}</div>;
  return <SortableItemInner id={id} list={list} className={className}>{children}</SortableItemInner>;
};

/** A card's provider logo; inside a SortableUsageList it is also the card's drag handle. */
export const UsageProviderLogo: React.FC<{ providerId: string; name: string; className?: string }> = ({ providerId, name, className }) => {
  const { t } = useI18n();
  const handle = React.useContext(HandleContext);
  const logo = <ProviderLogo providerId={providerId} className={className} />;
  if (!handle) return logo;
  const label = t('header.services.arrangeProvider', { name });
  const step = (key: string): number => (key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : key === 'ArrowDown' || key === 'ArrowRight' ? 1 : 0);
  return (
    <button
      type="button"
      data-usage-drag-handle="true"
      data-mobile-press-feedback="none"
      {...handle.attributes}
      {...handle.listeners}
      ref={handle.setActivatorNodeRef}
      aria-label={label}
      title={label}
      onKeyDown={(event) => {
        const delta = event.altKey ? step(event.key) : 0;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        handle.move(handle.id, delta);
        // the cards are redrawn in their new places: keep the keyboard on this one
        requestAnimationFrame(() => button.focus({ preventScroll: true }));
      }}
      className="relative -m-1 inline-flex shrink-0 !cursor-grab touch-none select-none items-center justify-center rounded-sm p-1 outline-none hover:bg-[var(--interactive-hover)] focus-visible:ring-2 focus-visible:ring-primary active:!cursor-grabbing"
    >
      <span className="pointer-events-none inline-flex">{logo}</span>
      <Icon
        name="drag-move-2"
        className="pointer-events-none absolute right-[calc(100%-3px)] top-1/2 size-2.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/usage:opacity-100 group-focus-within/usage:opacity-100"
      />
    </button>
  );
};
