import type React from 'react';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { SessionIndexSession } from '@/lib/session-index-api';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { RemoteDragItem, RemoteFolderNode, RemoteSessionRow } from './remoteSessionFolders';

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

export type RemoteFolderBranchProps = {
  node: RemoteFolderNode; directory: string; depth: number; collapsed: boolean; disabled: boolean; folders: SessionFolder[]; visibleCount: number;
  children: React.ReactNode; renderRow(row: RemoteSessionRow): React.ReactNode;
  onToggle(): void; onRename(name: string): void; onRenameStart(): void; onDelete(): void; onNewSession(): void; onNewSubFolder(): void; onMove(parentId: string | null): void;
};

export type RemoteSummaryRowProps = {
  session: SessionIndexSession; active: boolean; search: string; selected: boolean; pending: boolean; pinned: boolean; unread: number;
  status?: string; reorderable?: boolean; dragItem: RemoteDragItem;
  onSelect(): void; onMultiSelect(): void; onRename(): void; onPin(): void; onUnread(): void; onArchive(): void;
  folders: Array<{ id: string; name: string }>; onFolder(id: string | null): void;
};
