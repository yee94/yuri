import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';

const ROW_WIDTHS = ['62%', '78%', '54%', '70%', '48%'] as const;

const Bone: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <Skeleton className={`rounded bg-muted-foreground/10 ${className ?? ''}`} style={style} />
);

/** Placeholder rows for the first load, shaped like real plugin rows. */
export const PluginListSkeleton: React.FC = () => (
  <div role="status" aria-busy="true" data-plugin-skeleton="list">
    {ROW_WIDTHS.map((width, index) => (
      <div key={index} className="flex h-[37px] items-center gap-2 px-3" data-plugin-skeleton-row>
        <Bone className="size-5 shrink-0 rounded-[4px]" />
        <Bone className="h-2" style={{ width }} />
      </div>
    ))}
  </div>
);

/** Placeholder detail for the first load: title, one field and the options editor. */
export const PluginDetailSkeleton: React.FC = () => (
  <SettingsPageLayout className="yuri-plugin-detail sm:pt-6">
    <div role="status" aria-busy="true" data-plugin-skeleton="detail">
      <div className="flex items-center gap-2.5 py-3">
        <Bone className="size-7 shrink-0 rounded-md" />
        <div className="space-y-1.5">
          <Bone className="h-2.5 w-44" />
          <Bone className="h-2 w-12" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Bone className="h-2 w-14" />
        <Bone className="h-9 w-full rounded-md" />
      </div>
      <div className="mt-5 space-y-2">
        <Bone className="h-2 w-16" />
        <Bone className="h-20 w-full rounded-md" />
      </div>
    </div>
  </SettingsPageLayout>
);
