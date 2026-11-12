import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import {
  getRelativeFilePath,
  isFilePathWithinDirectory,
  normalizeFilePath,
  toAbsoluteFilePath,
} from '@/lib/path-utils';
import { useUIStore, type ContextPanelFileNotice } from '@/stores/useUIStore';

export type TurnChangedFileOpenTarget =
  | { kind: 'diff'; path: string }
  | { kind: 'file'; path: string; notice: ContextPanelFileNotice };

export const resolveTurnChangedFileOpenTarget = (
  directory: string,
  filePath: string,
): TurnChangedFileOpenTarget => {
  const absolutePath = toAbsoluteFilePath(directory, filePath) || normalizeFilePath(filePath);
  if (!absolutePath) {
    return { kind: 'diff', path: filePath };
  }

  if (!isFilePathWithinDirectory(absolutePath, directory)) {
    return {
      kind: 'file',
      path: absolutePath,
      notice: 'turn-diff-outside-workspace',
    };
  }

  const relativePath = getRelativeFilePath(absolutePath, directory);
  return {
    kind: 'diff',
    path: relativePath || filePath,
  };
};

export const openTurnChangedFilePreview = (args: {
  scope?: HostRuntimeEntry;
  directory: string;
  filePath: string;
  turnMessageId?: string | null;
  sessionId?: string | null;
  mobile?: boolean;
}): void => {
  const store = useUIStore.getState();
  args.scope?.sdk();
  const stateKey = args.scope?.key ?? args.directory;
  const target = resolveTurnChangedFileOpenTarget(args.directory, args.filePath);

  if (target.kind === 'file') {
    const open = () => {
      store.openContextFile(stateKey, target.path, { fileNotice: target.notice });
      if (args.mobile) {
        store.setRightSidebarOpen(false);
      }
    };
    if (args.scope) open();
    else void ensureOutsideFileGrantForDesktop(target.path, args.directory).then(open);
    return;
  }

  if (args.mobile) {
    store.navigateToDiff(target.path, false, 'turn');
    store.setRightSidebarOpen(false);
    return;
  }

  store.openContextDiff(
    stateKey,
    target.path,
    false,
    'turn',
    undefined,
    args.turnMessageId,
    args.sessionId,
  );
};
