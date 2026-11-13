import React from 'react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { UndoCountdownRing } from '@/components/ui/UndoCountdownRing';
import { SESSION_DELETE_UNDO_MS } from '@/lib/sessionMutationUndo';
import type { RemoteMobileStatusOwner } from './remoteMobileStatusCatalog';

/** Explicit user-requested deletion owns its timer; no Hub staging/queue is used. */
export function deleteRemoteMobileSessions(options: {
  rows: Array<{ key: string; remote: RemoteMobileStatusOwner }>;
  message: string; undoLabel: string; errorMessage: string;
  hide(keys: string[]): void; restore(keys: string[]): void;
  refresh(remote: RemoteMobileStatusOwner): Promise<unknown>;
}) {
  const keys = options.rows.map((row) => row.key);
  options.hide(keys);
  let cancelled = false;
  const timer = window.setTimeout(() => {
    void (async () => {
      if (cancelled) return;
      const failed: string[] = [];
      // Delete descendants before parents; success in one Location never erases a failed sibling.
      for (const row of [...options.rows].reverse()) {
        try {
          const deleted = await row.remote.entry.service().deleteSession(row.remote.sessionId, row.remote.directory);
          if (!deleted) throw new Error('Remote session deletion failed');
        } catch { failed.push(row.key); }
      }
      if (failed.length) { options.restore(failed); toast.error(options.errorMessage); }
      await Promise.allSettled(options.rows.map((row) => options.refresh(row.remote)));
    })();
  }, SESSION_DELETE_UNDO_MS);
  toast.custom((id) => <div className="flex w-full min-w-0 items-center gap-2.5 text-foreground">
    <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{options.message}</span>
    <Button variant="ghost" size="sm" className="session-mutation-undo-action shrink-0 gap-1" onClick={() => {
      cancelled = true; window.clearTimeout(timer); options.restore(keys); toast.dismiss(id);
    }}>{options.undoLabel}<UndoCountdownRing durationMs={SESSION_DELETE_UNDO_MS} /></Button>
  </div>, { duration: SESSION_DELETE_UNDO_MS, className: 'session-mutation-undo-toast !max-w-[calc(100vw-2rem)]' });
}
