# Root notification catalog receipt

`app.notificationCatalog()` is read-only current authority state: `{ scope, refreshGeneration, complete, domains, error, sessionIssues? }`. Optional `sessionIssues` contains normalized failed/pending directory identities for local display, not a second writer or notification authority. Its scope captures Host id, JS generation, real optional `authorizationID` and Native runtime lease. Domains are projects/sessions/bots/tasks, each `unknown | pending | complete | failed`. Only the existing root `refresh()` writer can publish their successful receipt. Neither `online`, `loading`, prior non-empty arrays nor a caught refresh promise grants completeness.

`awaitNotificationCatalogReady(scope, current): Promise<void>` accepts the notification root's `{hostID,generation}` scope (or null). It verifies the actual captured lease/authorization, joins the existing refresh flight, or makes **one** attempt through the same root `refresh()` if no successful current receipt exists. It does not own an HTTP reader, timer, polling lane or hidden retry loop. After awaiting, it verifies caller/current scope, refresh generation, all four domains, current authoritative array references, and absence of dirty catalog tips. It rejects `notification_catalog_stale`, `notification_catalog_unsupported` or `notification_catalog_incomplete`; it never returns a false-shaped success. An explicit subsequent call retries through the same root writer after failure.

Successful empty arrays are valid. Malformed/partial projects, pending/failed session-index synchronization, malformed/partial assistants, and schedule failed-project IDs cannot yield a complete receipt. Sessions adopt display data per directory via `session-catalog`: confirmed complete directories may replace or clear; failed/pending/unproven directories preserve prior rows, with failed-index saved rows usable only as cold display seeds. Global incomplete flags or an unexplained completed/total deficit cannot authorize empty replacement. This partial display returns without throwing a whole-root loading error, but the sessions domain stays failed/unknown and the complete receipt remains false. Schedules retain the existing per-project partial adoption: successful projects may update while failed projects retain prior rows, and the whole tasks domain stays failed. Other failed domains keep their prior data. Any catalog tip immediately invalidates its domain; a tip arriving during refresh fences that read from restoring complete. Old Host/authorization/lease/refresh generations cannot publish a new receipt. A different page writing any catalog array cannot borrow the root's old receipt: reference mismatch exposes `complete:false` until root authority confirms it again.

At least one fulfilled domain can establish reachability (`online`), not catalog completeness. Projects exposes a local notice and explicit retry through the existing root and page readers. Notification recovery classifies only the exact `notification_catalog_incomplete` failure as `waitingReady`, keeping a successful settings read ready; other read failures remain errors. No peek/claim precedes readiness. The existing live admission pending map retains events without misreporting a settings failure; explicit root recovery retries that map before launch recovery, preserving deduplication and Host/authorization/generation fences.

Session-index data remains the endpoint's bounded root summaries; `complete` does not mean all historic sessions/transcripts were fetched. Root notification resolution already uses one exact metadata read for a missing child/session and rejects duplicate identities. No extra history/index pagination was added. Bot and global schedule catalogs are whole snapshot collections; duplicate task IDs across projects remain in the collection for the resolver to reject before project validation.

`Connection.authorizationID` now retains the actual optional Native snapshot field. Same-Host foreground preserves connection/UI identity only when that authorization is unchanged. A real authorization change is a new authority even if Host id or a malformed fixture's lease happens to repeat. Nothing derives authorization from epoch, lease, editor version or id.

## Minimal main application props

Use the existing notification root and existing parsed runtime observer. Add these props (existing resolve/open remain unchanged):

```ts
captureRequest: captureHostRequest,
authorizationID: nativeNotificationAuthorization,
catalogReady: current =>
  awaitNotificationCatalogReady(nativeNotificationScope(), current),
catalog: (_target, current) => {
  if (!current() || !app.notificationCatalog().complete)
    throw new Error('notification_catalog_incomplete');
  return [
    ...app.bots().map(bot => ({
      target: { kind: 'assistant' as const, id: text(bot.id) },
    })),
    ...app.tasks().map(item => ({
      target: { kind: 'schedule' as const, id: text(record(item.task).id) },
      projectID: text(item.projectId),
    })),
  ];
},
```

Remove the legacy `settingsRead` prop. Do not prefilter catalog entries by source project. In the existing root authority/lifecycle effect, observe the published receipt and invoke `notifications.recover()` when complete authority publishes; do not create another runtime observer or stream. The root already retries settings/Basic/reconnect and receipt recovery, while the await seam deduplicates catalog access through root refresh. The page operation-recovery contract is separate: same-Host foreground must not remount Chat or persistent Settings/Tab UI just to obtain a new sender.

## Evidence boundary

`notification-catalog-state.test.ts` exercises the actual root refresh writer with a strict Native fixture, including successful empty, concurrent awaits, each domain failure, partial schedules, malformed snapshots, tip-during-read, retry, page/Host/authorization/lease/refresh fences and array-writer ownership. It performs no engine/Host/network/device operation. Application props, Native notification/authorization handling and Voice engine lifecycle are owned elsewhere and need their owners' integration evidence.
