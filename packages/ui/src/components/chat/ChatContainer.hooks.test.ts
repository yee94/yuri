import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('ChatContainer source contracts', () => {
    const source = readFileSync(join(here, 'ChatContainer.tsx'), 'utf8');
    // The follow/timeline/swap wiring and the transcript paint are shared with
    // RemoteChatContainer, so they live outside the container source.
    const shellSource = readFileSync(join(here, 'useChatSessionShell.ts'), 'utf8');
    const viewportSource = readFileSync(join(here, 'ChatViewport.tsx'), 'utf8');
    const frameSource = readFileSync(join(here, 'ChatSessionFrame.tsx'), 'utf8');

    test('handlers use useEvent; no React.useCallback', () => {
        expect(source).toContain("from '@reactuses/core'");
        expect(source).toContain('useEvent');
        expect(source).not.toContain('React.useCallback');
        // Comments may mention useCallback as a ban; ban the call form only.
        expect(source).not.toMatch(/(?<![\w.])useCallback\s*\(/);
    });

    test('DOM and browser listeners use @reactuses/core hooks', () => {
        expect(source).toContain('useEventListener');
        expect(source).toContain('useIsomorphicLayoutEffect');
        expect(source).toContain('useMount');
        expect(source).toContain('useUnmount');
        // The viewport-size observer moved into the shared shell with its listeners.
        expect(shellSource).toContain('useEventListener');
        expect(shellSource).toContain('useResizeObserver');
        expect(shellSource).toContain('useIsomorphicLayoutEffect');
        expect(shellSource).toContain('useUnmount');
        for (const owner of [source, shellSource]) {
            expect(owner).not.toContain('React.useLayoutEffect');
            expect(owner).not.toContain('addEventListener(');
            expect(owner).not.toContain('new ResizeObserver');
        }
    });

    test('timeline bridge publishes via render-phase refs, not effect rebinding', () => {
        expect(shellSource).toContain('activeTurnChangeRef.current = timeline.handleActiveTurnChange');
        expect(shellSource).toContain('historyUpwardIntentRef.current = timeline.handleHistoryUpwardIntent');
        expect(shellSource).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*activeTurnChangeRef\.current\s*=/,
        );
        expect(shellSource).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*historyUpwardIntentRef\.current\s*=/,
        );
    });

    test('native mobile load-older visibility uses the mounted mobile surface state', () => {
        // Capacitor launches MobileApp directly and does not set the hosted-page
        // __YURI_SURFACE__ global. Width/pointer probing can vary while
        // the WebView viewport changes, whereas isMobile is set before mount.
        expect(shellSource).toContain('const showLoadOlderButton = resolveMobileLoadOlderVisibility({');
        expect(shellSource).toContain('isMobile,');
        expect(shellSource).not.toContain('const showLoadOlderButton = isMobileSurfaceRuntime()');
        // Controller auto-fill uses the same mounted flag as the status slot.
        const timelineCallStart = shellSource.indexOf('const timeline = useChatTimelineController({');
        const timelineCallEnd = shellSource.indexOf('});', timelineCallStart);
        expect(timelineCallStart).toBeGreaterThan(-1);
        const timelineCall = shellSource.slice(timelineCallStart, timelineCallEnd);
        expect(timelineCall).toContain('isMobile,');
        // Comment may mention the probe; the option value must not call it.
        expect(timelineCall).not.toMatch(/isMobile:\s*isMobileSurfaceRuntime\s*\(/);
    });

    test('load-error retry reloads the transcript and enters the hydrating skeleton', () => {
        expect(source).toContain('retryTranscriptInitial');
        expect(source).toContain('userRetrying: isRetryingSessionHistory');
        expect(source).toContain('onClick={retrySessionHistory}');
        expect(source).not.toContain('sync.syncSession(currentSessionId, true)');
    });

    test('uses repository P0 as the transcript and composer reveal gate', () => {
        expect(source).toContain('useSessionTranscriptHydration');
        expect(source).toContain('p0Satisfied: transcriptHydration.p0Satisfied');
        expect(source).toContain('hasBusyShell: sessionIsWorking && hasTranscriptShell');
        expect(source).toContain('hasImmediateShell: pendingUserMessages.length > 0 || historyPrefix.length > 0');
        expect(source).toContain("if (sessionTranscriptGate === 'pass' && renderedViewportMessages.length > 0)");
    });

    test('history pagination facts come only from the transcript repository projection', () => {
        // Ticket 02: ChatContainer reads pagination via useSessionTranscriptPagination
        // (repository getPagination) and never stitches facts from prefetch.
        expect(source).toContain('useSessionTranscriptPagination');
        expect(source).toContain('transcriptPagination.boundary');
        expect(source).toContain('boundary: historyBoundary');
        expect(source).toContain('limit: historyBoundary.loadedTurns');
        expect(source).not.toContain('state.session_history_boundary?.[');
        expect(source).not.toContain('sessionPrefetchInfo?.cursor');
        expect(source).not.toContain('sessionPrefetchInfo?.complete');
        expect(source).not.toContain('sessionPrefetchInfo?.limit');
        expect(source).not.toContain('prefetchHasMore');
    });

    test('historyMeta.loading is sync/assistant only — never stuck prefetch loading', () => {
        // Timeline wait gate (historyLoading) must not OR prefetch status.
        // Stuck sessionPrefetch status==='loading' blocked mobile load-more for
        // wait window with toast and zero fetch; cold transcript gate still uses prefetch.
        expect(source).toContain('resolveChatHistoryPaginationLoading');
        expect(source).toContain('syncHistoryLoading');
        expect(source).toContain('syncLoading: syncHistoryLoading');
        expect(source).toContain('assistantLoading:');
        expect(source).not.toContain("sessionPrefetchInfo?.status === 'loading'");
        // Prefetch remains on the cold transcript gate path.
        expect(source).toContain('prefetchStatus: sessionPrefetchInfo?.status');
    });

    test('mobile history status is authoritative-only and has no manual load button', () => {
        // No speculative placeholder: unresolved history boundary (unknown)
        // must not paint the status slot or a spinner.
        expect(source).not.toContain('isHistoryAvailabilityPending');
        // Visibility = mounted mobile surface && (canLoadEarlier || real
        // user-initiated loadEarlier mutation in flight).
        expect(shellSource).toContain('const showLoadOlderButton = resolveMobileLoadOlderVisibility({');
        expect(shellSource).toContain('canLoadEarlier: timeline.historySignals.canLoadEarlier');
        expect(shellSource).toContain('isLoadingOlder: timeline.isLoadingOlder');
        // Busy is mutation-owned only — background prefetch/SWR
        // loading never drives the status.
        expect(viewportSource).toContain('const loadOlderBusy = resolveMobileLoadOlderBusy({ isLoadingOlder });');
        expect(viewportSource).toContain('aria-busy={loadOlderBusy}');
        expect(viewportSource).not.toContain('data-chat-load-older="true"');
        expect(viewportSource).toContain("{t('chat.history.loadingMore')}");
        // Desktop scroll/auto-fill keeps a glass disc (icon only) while the
        // flight is unresolved. The label is the accessible name, not painted text.
        expect(viewportSource).toContain('resolveDesktopLoadOlderStatusVisibility');
        expect(viewportSource).toContain("aria-label={t('chat.history.loadingMore')}");
        expect(viewportSource).toContain('yuri-mobile-glass-control');
        expect(viewportSource).not.toContain("typography-meta text-[var(--surface-mutedForeground)]\">{t('chat.history.loadingMore')}");
        expect(viewportSource).toContain('showDesktopLoadOlderStatus');
    });

    test('explicit history navigation releases the initial entry-stick pin', () => {
        const autoFollowSource = readFileSync(join(here, '../../hooks/useChatAutoFollow.ts'), 'utf8');
        const releaseStart = autoFollowSource.indexOf('const releaseAutoFollow = useEvent');
        const releaseEnd = autoFollowSource.indexOf('const onUpwardUserIntentRef', releaseStart);

        expect(releaseStart).toBeGreaterThan(-1);
        expect(releaseEnd).toBeGreaterThan(releaseStart);
        expect(autoFollowSource.slice(releaseStart, releaseEnd)).toContain('endEntryStick();');
    });

    test('explicit history pagination holds auto-follow released through viewport restoration', () => {
        const autoFollowSource = readFileSync(join(here, '../../hooks/useChatAutoFollow.ts'), 'utf8');
        const timelineSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');

        expect(autoFollowSource).toContain('historyViewportPreservationRef');
        expect(autoFollowSource).toContain('if (historyViewportPreservationRef.current) {');
        expect(timelineSource).toContain('beginHistoryViewportPreservation();');
        expect(timelineSource).toContain('endHistoryViewportPreservation();');
    });

    // Legend production entry is disabled; retain its dedicated bridge contract.
    test.skip('legend path releases end pinning before an explicit older-history fetch', () => {
        // A prepend is a data change, and maintainScrollAtEnd fires on
        // dataChange: with follow still armed the list reads the content
        // growth as an end correction and throws the viewport to the live
        // edge. Mobile only reaches history through this button, so the
        // gesture-driven release never covers it.
        const clickStart = source.indexOf('const handleLoadOlderClick = useEvent');
        const clickEnd = source.indexOf('});', clickStart);

        expect(clickStart).toBeGreaterThan(-1);
        const clickBody = source.slice(clickStart, clickEnd);
        expect(clickBody).toContain('setLegendFollowReleased(true);');
        // Unconditional. Gating this on being away from the live edge trusted
        // the at-end signal, and a stale-true reading skipped the release
        // silently — which is how the prepend could still reach the live edge.
        expect(clickBody).not.toContain('if (!legendIsAtEnd)');
        // Release must precede the fetch that commits the prepend.
        expect(clickBody.indexOf('setLegendFollowReleased(true);'))
            .toBeLessThan(clickBody.indexOf('timelineLoadEarlier('));
        // Released state reaches the list as suspended follow.
        expect(source).toContain('timelineFollowSuspended={legendFollowReleased}');
        expect(source).toContain('timelineFollowEnabled={!pendingRevealWork && !timelineFollowSuspended}');
    });

    /**
     * Releasing follow is not enough on its own: the list decides what to do
     * with a prepend inside the commit that delivers it, so the read position
     * has to be captured — and end maintenance stood down — while the
     * transcript is still untouched. Every load path funnels through the
     * controller's `loadEarlier`, so the arm hangs off that rather than off the
     * button, which is the only path mobile uses but not the only one there is.
     */
    test('an older-history fetch arms the timeline anchor before it goes out', () => {
        const controllerSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');

        expect(controllerSource).toContain('onWillLoadEarlier?: () => void;');
        expect(controllerSource).toContain('onWillLoadEarlier?.();');
        // Only for user-initiated loads: automatic backfill has no read
        // position to protect and must leave end maintenance alone.
        const armIndex = controllerSource.indexOf('onWillLoadEarlier?.();');
        expect(controllerSource.slice(0, armIndex)).toContain('if (options?.userInitiated) {');
        // Armed before the fetch, not after it resolves.
        expect(armIndex).toBeLessThan(controllerSource.indexOf('loadEarlierMutation.mutateAsync('));

        expect(shellSource).toContain('onWillLoadEarlier: armTimelineHistoryAnchor,');
        expect(shellSource).toContain('setTimelineHistoryAnchorToken((token) => token + 1);');
        expect(frameSource).toContain('timelineHistoryAnchorToken={shell.timelineHistoryAnchorToken}');
    });

    /**
     * Auto-follow owns follow policy while its controller delegates scroll
     * writes to the active list. The visible control must re-arm both owners.
     */
    test('resume-to-latest resumes follow through the active list controller', () => {
        const resumeStart = shellSource.indexOf('const resumeToLatestInstant = useEvent');
        expect(resumeStart).toBeGreaterThan(-1);
        const resumeBody = shellSource.slice(resumeStart, shellSource.indexOf('});', resumeStart));
        expect(resumeBody).toContain("goToBottom('instant')");
        expect(resumeBody).toContain('expandMobileComposer()');
        expect(shellSource).toContain('const expandMobileComposer = useMobileComposerSwap(');
        const autoFollowSource = readFileSync(join(here, '../../hooks/useChatAutoFollow.ts'), 'utf8');
        expect(shellSource).toContain('scrollControllerRef: messageListRef');
        expect(autoFollowSource).toContain("scrollControllerRef?.current?.scrollToBottom({ behavior: mode === 'smooth' ? 'smooth' : 'auto', ...options })");
        // The visible control goes through turn navigation and auto-follow.
        expect(shellSource).toContain('resumeToBottom: resumeToLatestInstant,');
        expect(shellSource).not.toContain('resumeToBottom: timeline.resumeToBottomInstant,');
    });

    test('default viewport keeps composer inset and the shell-gated live status slot', () => {
        expect(viewportSource).toContain('style={{ height: isMobile ? CHAT_TAIL_SPACER_MOBILE_HEIGHT : CHAT_TAIL_SPACER_DESKTOP_HEIGHT }}');
        expect(viewportSource).toContain('<StatusRowContainer />');
        // Classic path: shell-gated status mounts through MessageList.liveStatusSlot
        // (inside the pin-reveal root), not as a sibling after MessageList.
        expect(viewportSource).toContain('liveStatusSlot={');
        const statusGate = viewportSource.indexOf('liveStatusSlot={');
        const liveStatusSlot = viewportSource.slice(statusGate, viewportSource.indexOf('/>', statusGate + 80) + 2);
        expect(liveStatusSlot).toContain('renderedMessages.length > 0');
        expect(liveStatusSlot).toContain('<StatusRowContainer />');
        expect(viewportSource).not.toMatch(/<\/MessageList>\s*\{\/\* No transcript shell/);
    });

    test('composer send invokes the default on-send follow policy', () => {
        expect(shellSource).toContain('const scrollViewportOnSend = useEvent');
        const sendStart = shellSource.indexOf('const scrollViewportOnSend = useEvent');
        const sendBody = shellSource.slice(sendStart, shellSource.indexOf('});', sendStart));
        expect(sendBody).toContain('scrollToBottomOnSend()');
        expect(source).toContain('scrollToBottom={shell.scrollViewportOnSend}');
        expect(source).not.toContain('scrollToBottom={shell.follow.scrollToBottomOnSend}');
    });

    test('latches confirmed subagent footer identity through temporary session identity gaps', () => {
        // session.updated hides subagents from the live directory list, so
        // parentSessionTarget can go null while the child is still on screen.
        // The banner must keep the last-known parent + agent/model instead of
        // flashing to the metadata-less "cannot send to child" foot.
        expect(source).toContain('resolveSubagentReadOnlyBannerLatch');
        expect(source).toContain('const nextSubagentBannerLatch = resolveSubagentReadOnlyBannerLatch(');
        expect(source).toContain('const resolvedParentSessionTarget = parentSessionTarget ?? nextSubagentBannerLatch?.parentTarget ?? null');
        expect(source).toContain('const bannerExecution = nextSubagentBannerLatch?.execution ?? sessionExecution');
        expect(source).toContain('agentName={bannerExecution.agentName}');
        expect(source).toContain('modelId={bannerExecution.modelId}');
        expect(source).not.toContain('const readOnlyPromptBanner = parentSessionTarget ? (');
    });

    test('desktop composer keeps a page-background fade above each transcript-style input', () => {
        const foot = readFileSync(join(here, 'ComposerFoot.tsx'), 'utf8');
        expect(foot).toContain('const DesktopComposerEdgeFade');
        expect(foot).toContain('bg-gradient-to-t from-[var(--surface-background)] to-transparent');
        // ComposerFoot owns the fade; shells opt in through its default overlay.
        expect(source).not.toContain('<DesktopComposerEdgeFade');
        const establishingDraftShell = source.slice(
            source.indexOf('if ((draftSubmitting || draftEstablishing) && draftPendingMessage)'),
            source.indexOf('if (draftSubmitting || draftEstablishing)'),
        );
        const hydratingShell = source.slice(
            source.indexOf('if (isSessionHydrating)', source.indexOf('if (draftSubmitting || draftEstablishing)')),
            source.indexOf('if (renderedViewportMessages.length === 0 && !sessionIsWorking)'),
        );
        const transcriptShell = source.slice(
            source.lastIndexOf('<ChatSessionFrame shell={shell}>'),
            source.indexOf('const MemoizedChatContainerContent'),
        );
        // ChatSessionFoot forwards its `overlay` straight to ComposerFoot.
        expect(frameSource).toContain('<ComposerFoot isMobile={isMobile} expanded={expanded} overlay={overlay} className={className}>');
        for (const shell of [establishingDraftShell, hydratingShell]) {
            expect(shell).toContain('<ChatSessionFoot key="composer-foot" isMobile={isMobile} expanded={isDesktopExpandedInput}>');
        }
        expect(transcriptShell).toContain('<ChatSessionFoot');
        expect(transcriptShell).toContain('key="composer-foot"');
        expect(transcriptShell).not.toContain('overlay={false}');
        expect(foot).toContain('!isMobile && !expanded && overlay');
    });

    test('draft handoff commits a local identity in layout and scopes immediate reveal to its retained row', () => {
        const handoffStart = source.indexOf('const committedDraftPendingRef');
        const handoffEnd = source.indexOf('const selectedSessionView', handoffStart);
        const handoffSource = source.slice(handoffStart, handoffEnd);
        expect(handoffStart).toBeGreaterThan(-1);
        expect(handoffSource).toContain('useIsomorphicLayoutEffect(() => {');
        expect(handoffSource).toContain('committedDraftPendingRef.current = {');
        expect(handoffSource).toContain('identity: draftPendingIdentity');
        expect(handoffSource).toContain('messageId: selectedSession.draftPendingMessageId');
        expect(handoffSource).toContain('selectedRetainedPendingMessages.some(');
        expect(handoffSource).not.toContain('requestAnimationFrame');
    });

    test('establishing draft paints the pending row without the markdown pin-reveal hide', () => {
        const establishingDraftShell = source.slice(
            source.indexOf('if ((draftSubmitting || draftEstablishing) && draftPendingMessage)'),
            source.indexOf('if (draftSubmitting || draftEstablishing)'),
        );
        expect(establishingDraftShell).toContain('initialPinRevealComplete');
        const revealStart = source.indexOf('const initialPinRevealComplete = Boolean(');
        expect(revealStart).toBeGreaterThan(-1);
        const revealBody = source.slice(revealStart, source.indexOf(');', revealStart) + 2);
        expect(revealBody).toContain('committedDraftHandoffMessageId');
        expect(revealBody).toContain('retainedPendingUserMessages.length > 0');
    });

    // Legend production entry is disabled; default ScrollShadow remains tested.
    test.skip('legend scroller dataset restores the transcript scroll-shadow mask', () => {
        expect(source).toContain("scrollShadow: 'true'");
        expect(source).toContain("orientation: 'vertical'");
    });

    test('timeline does not publish viewport metrics for automatic backfill', () => {
        // Trace-20260805: messages-keyed layout effect + fresh setState object
        // forced a second ChatContainer render on every shell-tool part commit.
        const timelineSource = readFileSync(join(here, 'hooks/useChatTimelineController.ts'), 'utf8');
        expect(timelineSource).not.toContain('setViewportMetrics');
        expect(timelineSource).not.toContain('chatTimelineAutoFillQueryKey');
        expect(timelineSource).not.toContain('[messages, sessionId, isLoadingOlder, scrollRef]');
    });

    test('inactive surfaces freeze message records and gate the stall watchdog', () => {
        // Phone predecessor keeps DOM/snapshot but must not poll or stream-subscribe.
        expect(source).toContain('enabled: active,');
        expect(source).toContain('shouldArmTranscriptStallWatchdog');
        expect(source).toContain('resetTranscriptStallStateForInactive');
        const stallEffect = source.slice(
            source.indexOf('shouldArmTranscriptStallWatchdog({'),
            source.indexOf('TRANSCRIPT_STALL_POLL_MS);') + 'TRANSCRIPT_STALL_POLL_MS);'.length,
        );
        expect(stallEffect).toContain('active,');
        expect(stallEffect).toContain('sessionIsWorking');
    });
});
