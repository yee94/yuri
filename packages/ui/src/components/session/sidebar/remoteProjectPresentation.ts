import type React from 'react';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { SessionIndexSession } from '@/lib/session-index-api';
import type { TopSectionSecondaryMeta } from './pinnedSessions';

/** Presentation contracts describe remote data and intent, never a desktop component's props or transport calls. */
export type RemoteProjectShellProps = {
  project: RemoteProject;
  registry: HostRuntimeRegistry;
  label: string;
  sessionCount: number;
  collapsed: boolean;
  active: boolean;
  loading: boolean;
  isRepo: boolean;
  reorderEnabled: boolean;
  iconSlot?: React.ReactNode;
  children: React.ReactNode;
  actions: {
    disabled: boolean;
    toggle(): void;
    newSession(): void;
    newWorktree(): void;
    newFolder(): void;
    sync(): void;
    edit(): void;
    close(): void;
  };
};

export type RemoteSummaryRowProps = {
  secondaryMeta?: TopSectionSecondaryMeta | null;
  worktreeLabel?: string | null;
  subtitleSuffix?: React.ReactNode;
  /** Desktop top section: icon-only marker before the title instead of a subtitle line. */
  leading?: React.ReactNode;
  /** Task-view card layout: `badge` is the project mark, `leading` then sits in front of it. */
  card?: { badge: React.ReactNode; hostLabel: string; folderId?: string };
  pinDisabled?: boolean;
  session: SessionIndexSession; active: boolean; search: string; selected: boolean; pending: boolean; pinned: boolean; unread: number;
  status?: string; reorderable?: boolean; depth?: number; dragItem: { directory: string; id: string };
  onSelect(): void; onMultiSelect(): void; onRename(): void; onPin(): void; onUnread(): void; onArchive(): void; onDelete(): void;
  folders: Array<{ id: string; name: string }>; onFolder(id: string | null): void;
};
