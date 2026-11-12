import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TimelineDialog } from './TimelineDialog';

const counters = vi.hoisted(() => ({
  isMobile: false,
  navigationSucceeds: true,
  navigatedIDs: [] as string[],
  turnOffsets: [] as number[],
  latestCalls: 0,
  canLoadEarlier: false,
  loadEarlierCalls: 0,
  messageRecordsReads: 0,
  previewCalls: 0,
  fullTextCalls: 0,
  forkCalls: 0,
  revertCalls: 0,
  messages: [] as Array<{
    info: { id: string; role: string; time: { created: number } };
    parts: Array<{ type: string; text?: string }>;
  }>,
  forkDeferred: null as { resolve: () => void; promise: Promise<void> } | null,
  revertDeferred: null as { resolve: () => void; promise: Promise<void> } | null,
  bumpMessages: () => {
    counters.messages = [
      ...counters.messages,
      {
        info: {
          id: `user-${counters.messages.length + 1}`,
          role: 'user',
          time: { created: Date.UTC(2024, 0, 1, 12, counters.messages.length) },
        },
        parts: [{ type: 'text', text: `message ${counters.messages.length + 1}` }],
      },
    ];
  },
  createDeferred: () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { resolve, promise };
  },
}));

vi.mock('@/sync/sync-context', () => ({
  useSyncDirectory: () => '/repo',
  useSessionMessageRecords: () => {
    counters.messageRecordsReads += 1;
    return counters.messages;
  },
}));

vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: {
    revertToMessage: () => Promise<void>;
    forkFromMessage: () => Promise<void>;
  }) => unknown) => selector({
    revertToMessage: async () => {
      counters.revertCalls += 1;
      if (counters.revertDeferred) await counters.revertDeferred.promise;
    },
    forkFromMessage: async () => {
      counters.forkCalls += 1;
      if (counters.forkDeferred) await counters.forkDeferred.promise;
    },
  }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
}));

vi.mock('@/lib/device', () => ({
  useDeviceInfo: () => ({ isMobile: counters.isMobile, isTablet: false }),
}));

vi.mock('./SessionSurfaceContext', () => ({
  useSessionSurface: () => ({
    capabilities: { forkSession: true, mutateSession: true },
  }),
}));

vi.mock('./lib/messagePreview', () => ({
  getMessagePreview: (...args: unknown[]) => {
    counters.previewCalls += 1;
    return String((args[0] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '');
  },
  getFullText: (...args: unknown[]) => {
    counters.fullTextCalls += 1;
    return String((args[0] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '');
  },
}));

vi.mock('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

/**
 * Presence mock mirroring Base UI Dialog portal: mount on open, keep children
 * during exit, unmount only after explicit exit complete (no guessed delay).
 */
vi.mock('@/components/ui/dialog', () => {
  const PresenceContext = React.createContext<{
    open: boolean;
    mounted: boolean;
    completeExit: () => void;
  }>({ open: false, mounted: false, completeExit: () => undefined });

  const Dialog = ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) => {
    const [mounted, setMounted] = React.useState(open);
    React.useEffect(() => {
      if (open) setMounted(true);
    }, [open]);
    const completeExit = () => {
      if (!open) setMounted(false);
    };
    return (
      <PresenceContext.Provider value={{ open, mounted, completeExit }}>
        <div data-testid="timeline-dialog-root" data-open={String(open)} data-mounted={String(mounted)}>
          {mounted ? children : null}
        </div>
      </PresenceContext.Provider>
    );
  };

  const DialogContent = ({ children, className, presentation }: { children: React.ReactNode; className?: string; presentation?: string }) => {
    const presence = React.useContext(PresenceContext);
    return (
      <div data-testid="timeline-dialog-content" data-open={String(presence.open)} data-presentation={presentation} className={className}>
        {children}
        {!presence.open && presence.mounted ? (
          <button type="button" data-testid="complete-exit" onClick={presence.completeExit}>
            complete-exit
          </button>
        ) : null}
      </div>
    );
  };

  return {
    Dialog,
    DialogContent,
    DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props}>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock('@/components/ui/MobileResizableSheet', async () => {
  const { Dialog, DialogContent } = await import('@/components/ui/dialog');
  return { MobileResizableSheet: ({ open, onOpenChange, children, title }: {
    open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode; title?: React.ReactNode;
  }) => <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <div data-testid="timeline-mobile-sheet">{title}{children}</div>
  </DialogContent></Dialog> };
});

describe.each([false, true])('TimelineDialog closed-work gate (mobile=%s)', (isMobile) => {
  let container: HTMLElement;
  let root: Root;
  let open: boolean;
  let setOpen: (next: boolean) => void;
  let parentTick: number;
  let setParentTick: (next: number) => void;

  const Host = () => {
    const [isOpen, setIsOpen] = React.useState(open);
    const [tick, setTick] = React.useState(parentTick);
    open = isOpen;
    setOpen = setIsOpen;
    parentTick = tick;
    setParentTick = setTick;
    return (
      <div data-parent-tick={tick}>
        <TimelineDialog
          open={isOpen}
          onOpenChange={setIsOpen}
            sessionID="session-1"
            directory="/tmp/project"
            onScrollToMessage={async (id) => { counters.navigatedIDs.push(id); return counters.navigationSucceeds; }}
            onScrollByTurnOffset={(offset) => { counters.turnOffsets.push(offset); }}
            onResumeToLatest={() => { counters.latestCalls += 1; }}
            canLoadEarlier={counters.canLoadEarlier}
            onLoadEarlier={() => { counters.loadEarlierCalls += 1; }}
        />
      </div>
    );
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    counters.isMobile = isMobile;
    counters.navigationSucceeds = true;
    counters.navigatedIDs = [];
    counters.turnOffsets = [];
    counters.latestCalls = 0;
    counters.canLoadEarlier = false;
    counters.loadEarlierCalls = 0;
    counters.messageRecordsReads = 0;
    counters.previewCalls = 0;
    counters.fullTextCalls = 0;
    counters.forkCalls = 0;
    counters.revertCalls = 0;
    counters.forkDeferred = null;
    counters.revertDeferred = null;
    counters.messages = [{
      info: { id: 'user-1', role: 'user', time: { created: Date.UTC(2024, 0, 1, 12, 0) } },
      parts: [{ type: 'text', text: 'hello timeline' }],
    }];
    open = false;
    parentTick = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const renderHost = async () => {
    await act(async () => {
      root.render(<Host />);
    });
  };

  const completeExit = async () => {
    const exitButton = container.querySelector<HTMLButtonElement>('[data-testid="complete-exit"]');
    await act(async () => {
      exitButton?.click();
    });
  };

  const forkButtons = () => Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).filter((button) => button.querySelector('[data-icon="git-branch"], [data-icon="loader-4"]')
    && button.getAttribute('aria-busy') !== null);

  const clickFork = async () => {
    const buttons = forkButtons();
    const target = buttons.find((button) => !button.disabled) ?? buttons[0];
    await act(async () => {
      target?.click();
    });
  };

  test('closed shell performs no message subscription or preview work under parent rerenders', async () => {
    await renderHost();
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).toBeNull();
    expect(counters.messageRecordsReads).toBe(0);
    expect(counters.previewCalls).toBe(0);

    for (let i = 1; i <= 50; i++) {
      counters.bumpMessages();
      await act(async () => { setParentTick(i); });
    }

    expect(counters.messageRecordsReads).toBe(0);
    expect(counters.previewCalls).toBe(0);
    expect(counters.fullTextCalls).toBe(0);
  });

  test('uses a compact search/list surface with no description or help block', async () => {
    for (let i = 0; i < 8; i++) counters.bumpMessages();
    counters.messages[2].parts = [{ type: 'text', text: '这是一条用于检查长消息省略和操作按钮对齐的示例，不会访问真实会话。'.repeat(3) }];
    await renderHost();
    await act(async () => { setOpen(true); });
    expect(Boolean(container.querySelector('[data-testid="timeline-mobile-sheet"]'))).toBe(isMobile);
    if (!isMobile) expect(container.querySelector('[data-testid="timeline-dialog-content"]')?.getAttribute('data-presentation')).toBe('picker');
    expect(container.querySelector('input')?.getAttribute('aria-label')).toBe('chat.timeline.searchPlaceholder');
    expect(container.querySelector('.yuri-timeline-list')).not.toBeNull();
    expect(container.textContent).not.toContain('chat.timeline.description');
    expect(container.textContent).not.toContain('chat.timeline.help.');
    expect(container.textContent).not.toContain('chat.timeline.actions.title');
    expect(container.querySelector('button[aria-label="chat.timeline.actions.revertFromHere"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="chat.timeline.actions.forkFromHere"]')).not.toBeNull();
    if (process.env.YURI_TEST_EVIDENCE_DIR) {
      mkdirSync(process.env.YURI_TEST_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.YURI_TEST_EVIDENCE_DIR, `timeline-${isMobile ? 'mobile' : 'desktop'}.html`), container.innerHTML);
    }
  });

  test('message navigation keeps the timeline open on a failed jump and closes on success', async () => {
    await renderHost();
    await act(async () => { setOpen(true); });
    counters.navigationSucceeds = false;
    await act(async () => { container.querySelector<HTMLButtonElement>('.yuri-timeline-message')!.click(); });
    expect(counters.navigatedIDs).toEqual(['user-1']);
    expect(open).toBe(true);
    counters.navigationSucceeds = true;
    await act(async () => { container.querySelector<HTMLButtonElement>('.yuri-timeline-message')!.click(); });
    expect(open).toBe(false);
  });

  test('retains compact previous-turn and latest navigation actions', async () => {
    await renderHost();
    await act(async () => { setOpen(true); });
    const action = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('.yuri-timeline-toolbar button')].find(button => button.textContent === text)!;
    await act(async () => { action('chat.timeline.actions.previousTurn').click(); });
    expect(counters.turnOffsets).toEqual([-1]);
    expect(open).toBe(false);
    await act(async () => { setOpen(true); });
    await act(async () => { action('chat.timeline.actions.latest').click(); });
    expect(counters.latestCalls).toBe(1);
    expect(open).toBe(false);
  });

  test('search keeps full-text filtering, looping arrows and Enter navigation', async () => {
    counters.messages = [
      { info: { id: 'needle-1', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'needle first' }] },
      { info: { id: 'needle-2', role: 'user', time: { created: 2000 } }, parts: [{ type: 'text', text: `${'prefix '.repeat(20)}needle second` }] },
      { info: { id: 'assistant', role: 'assistant', time: { created: 3000 } }, parts: [{ type: 'text', text: 'needle assistant' }] },
    ];
    await renderHost();
    await act(async () => { setOpen(true); });
    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-timeline-message-id]')).toHaveLength(2);
    expect(container.textContent).not.toContain('needle assistant');
    const selected = () => container.querySelector('[data-timeline-message-id][data-selected="true"]')?.getAttribute('data-timeline-message-id');
    expect(selected()).toBe('needle-1');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(selected()).toBe('needle-2');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(selected()).toBe('needle-1');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(counters.navigatedIDs).toEqual(['needle-1']);
    expect(open).toBe(false);
  });

  test('revert remains separate from message navigation', async () => {
    await renderHost();
    await act(async () => { setOpen(true); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="chat.timeline.actions.revertFromHere"]')!.click(); });
    expect(counters.revertCalls).toBe(1);
    expect(counters.navigatedIDs).toEqual([]);
    expect(open).toBe(false);
  });

  test('load-earlier preserves the existing row anchor through the shared scroll container', async () => {
    counters.canLoadEarlier = true;
    for (let i = 0; i < 19; i++) counters.bumpMessages();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('yuri-timeline-list')) return new DOMRect(0, 0, 600, 200);
      if (this.dataset.timelineMessageId) {
        const list = container.querySelector<HTMLElement>('.yuri-timeline-list')!;
        const rows = [...list.querySelectorAll('[data-timeline-message-id]')];
        return new DOMRect(0, rows.indexOf(this) * 38 - list.scrollTop, 600, 36);
      }
      return originalRect.call(this);
    });
    try {
      await renderHost();
      await act(async () => { setOpen(true); });
      const list = container.querySelector<HTMLElement>('.yuri-timeline-list')!;
      list.scrollTop = 200;
      await act(async () => { container.querySelector<HTMLButtonElement>('.yuri-timeline-history button')!.click(); });
      expect(counters.loadEarlierCalls).toBe(1);
      counters.messages = [
        ...Array.from({ length: 5 }, (_, i) => ({
          info: { id: `earlier-${i}`, role: 'user', time: { created: Date.UTC(2024, 0, 1, 11, i) } },
          parts: [{ type: 'text', text: `earlier ${i}` }],
        })),
        ...counters.messages,
      ];
      await act(async () => { setParentTick(parentTick + 1); });
      expect(list.scrollTop).toBe(390);
      expect(container.querySelector('[data-timeline-message-id="user-6"]')?.getBoundingClientRect().top).toBe(-10);
    } finally {
      rectSpy.mockRestore();
    }
  });

  test('open → exit retain → fully exit → reopen uses presence lifecycle without closed work', async () => {
    await renderHost();

    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).not.toBeNull();
    expect(counters.messageRecordsReads).toBeGreaterThan(0);
    expect(counters.previewCalls).toBeGreaterThan(0);
    expect(container.textContent).toContain('hello timeline');

    const readsWhileOpen = counters.messageRecordsReads;
    const previewsWhileOpen = counters.previewCalls;

    await act(async () => {
      setOpen(false);
    });
    // Exit animation window: content retained, still present.
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="complete-exit"]')).not.toBeNull();
    expect(container.textContent).toContain('hello timeline');

    await completeExit();
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).toBeNull();

    const readsAfterExit = counters.messageRecordsReads;
    const previewsAfterExit = counters.previewCalls;
    counters.bumpMessages();
    await act(async () => {
      setParentTick(parentTick + 1);
    });
    await act(async () => {
      setParentTick(parentTick + 1);
    });
    expect(counters.messageRecordsReads).toBe(readsAfterExit);
    expect(counters.previewCalls).toBe(previewsAfterExit);

    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).not.toBeNull();
    expect(counters.messageRecordsReads).toBeGreaterThan(readsWhileOpen);
    expect(counters.previewCalls).toBeGreaterThan(previewsWhileOpen);
    expect(container.textContent).toContain(`message ${counters.messages.length}`);
  });

  test('deferred fork: close → exit → reopen keeps single in-flight action until settle unlocks', async () => {
    counters.forkDeferred = counters.createDeferred();
    await renderHost();

    await act(async () => {
      setOpen(true);
    });

    await clickFork();
    expect(counters.forkCalls).toBe(1);
    expect(container.querySelector('button[aria-busy="true"]')).not.toBeNull();

    // Close while still pending (external dismiss); body may retain then unmount.
    await act(async () => {
      setOpen(false);
    });
    expect(container.querySelector('[data-testid="complete-exit"]')).not.toBeNull();
    await completeExit();
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).toBeNull();
    expect(counters.forkCalls).toBe(1);

    await act(async () => {
      setOpen(true);
    });
    // Shell gate still locked: buttons disabled, repeated click must not start a second fork.
    const busyOrDisabled = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.disabled || button.getAttribute('aria-busy') === 'true');
    expect(busyOrDisabled.length).toBeGreaterThan(0);

    await clickFork();
    await clickFork();
    expect(counters.forkCalls).toBe(1);

    await act(async () => {
      counters.forkDeferred?.resolve();
      await counters.forkDeferred?.promise;
    });
    // After settle, dialog auto-closes from successful action.
    await act(async () => {
      // flush microtasks from finally + onOpenChange
      await Promise.resolve();
    });

    await completeExit();
    await act(async () => {
      setOpen(true);
    });

    // Gate unlocked for a new scope action.
    counters.forkDeferred = null;
    await clickFork();
    expect(counters.forkCalls).toBe(2);
  });

  test('pending shell state survives body remount; settle unlocks a fresh scope without residual busy', async () => {
    counters.forkDeferred = counters.createDeferred();
    await renderHost();

    await act(async () => {
      setOpen(true);
    });
    await clickFork();
    expect(counters.forkCalls).toBe(1);
    expect(container.querySelector('button[aria-busy="true"]')).not.toBeNull();

    // Exit retain: body still mounted, pending UI remains.
    await act(async () => {
      setOpen(false);
    });
    expect(container.querySelector('button[aria-busy="true"]')).not.toBeNull();
    expect(counters.forkCalls).toBe(1);

    // Full exit unmounts body; shell still owns the gate.
    await completeExit();
    expect(container.querySelector('[data-testid="timeline-dialog-content"]')).toBeNull();

    // Reopen remounts body under the same shell pending generation.
    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('button[aria-busy="true"]')).not.toBeNull();
    await clickFork();
    expect(counters.forkCalls).toBe(1);

    await act(async () => {
      counters.forkDeferred?.resolve();
      await counters.forkDeferred?.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Successful settle closes; after exit + reopen, UI is clean for a new action.
    await completeExit();
    counters.forkDeferred = null;
    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('button[aria-busy="true"]')).toBeNull();
    await clickFork();
    expect(counters.forkCalls).toBe(2);
  });
});

describe('TimelineDialog shell/body source contract', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'TimelineDialog.tsx'),
    'utf-8',
  );

  test('body is hosted by desktop/mobile presence; pending gate is owned by the shell until settle', () => {
    expect(source).toMatch(/<MobileResizableSheet[\s\S]*?\{body\}[\s\S]*?<\/MobileResizableSheet>/);
    expect(source).toMatch(/<DialogContent[\s\S]*?\{body\}[\s\S]*?<\/DialogContent>/);
    expect(source).toContain('pendingActionGateRef');
    expect(source).toContain('pendingActionGenerationRef');
    expect(source).toContain('runPendingMessageAction');
    // Body must not own a local reentry ref that resets on remount.
    expect(source).not.toMatch(/const TimelineDialogBody[\s\S]*pendingActionRef\s*=\s*React\.useRef/);
  });
});
