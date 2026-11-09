export type ResourceHtmlMode = 'source' | 'preview';
export type ResourceHtmlPresentation = 'inline' | 'fullScreen';
export type ResourceHtmlGui = 'preparing' | 'matched' | 'failed' | 'unmatched' | 'bypassed';
export type ResourceHtmlInput = Readonly<{
  /** Captured Host/authorization + directory/path identity; never stat/content lease. */
  identity: string;
  active: boolean;
  htmlFile: boolean;
  targetLine?: number;
  gui: ResourceHtmlGui;
}>;
export type ResourceHtmlMount = Readonly<{ owner: string; identity: string; presentation: ResourceHtmlPresentation }>;
export type ResourceHtmlDialog = Readonly<{ generation: number; identity: string; open: boolean; opened: boolean; closeAttempt: number }>;
export type ResourceHtmlState = Readonly<{
  mode: ResourceHtmlMode;
  eligible: boolean;
  transitioning: boolean;
  mount: ResourceHtmlMount | null;
  dialog: ResourceHtmlDialog | null;
  error: string;
}>;

const eligible = (value: ResourceHtmlInput) => value.htmlFile && value.targetLine === undefined
  && (value.gui === 'unmatched' || value.gui === 'bypassed');

/** One Files display owner. Native close is an exact retirement ACK, not an
 * unmount hint: rejection retains the old ticket and blocks every fresh mount. */
export function createResourceHtmlViewer(input: {
  identifyMount(): string;
  closePreview(owner: string): Promise<void>;
  changed(value: ResourceHtmlState): void;
  back(): void;
}) {
  let current: ResourceHtmlInput | undefined, mode: ResourceHtmlMode = 'preview', wantedMode: ResourceHtmlMode = mode;
  let fullscreen = false, mount: ResourceHtmlMount | null = null, dialog: ResourceHtmlDialog | null = null;
  let generation = 0, disposed = false, error = '', flight: Promise<void> | undefined;
  let presentationPending = false, failedOwner: string | undefined;
  let disposal: Promise<void> | undefined, finishDisposal: (() => void) | undefined;
  let rejectDisposal: ((cause: Error) => void) | undefined;
  const retiredWaiters: Array<{ resolve(): void; reject(cause: Error): void }> = [];
  let displayChanged: typeof input.changed | undefined = input.changed;
  const state = (): ResourceHtmlState => Object.freeze({ mode, eligible: !!current && eligible(current), transitioning: presentationPending || !!flight || !!dialog && !dialog.open,
    mount, dialog, error });
  const publish = () => {
    displayChanged?.(state());
    if (error && rejectDisposal) {
      rejectDisposal(new Error(error)); rejectDisposal = undefined; finishDisposal = undefined;
    }
    if (error || !mount && !dialog) for (const waiter of retiredWaiters.splice(0)) {
      if (error) waiter.reject(new Error(error)); else waiter.resolve();
    }
  };
  const presentation = (): ResourceHtmlPresentation => fullscreen ? 'fullScreen' : 'inline';
  const wantsPreview = () => !disposed && !!current?.active && eligible(current) && wantedMode === 'preview';
  function reconcile(): Promise<void> {
    if (flight) return flight;
    if (error) return Promise.resolve();
    const work = async () => {
      if (presentationPending && current?.active && !disposed) return;
      if (mount && (failedOwner === mount.owner || !wantsPreview() || mount.identity !== current?.identity || mount.presentation !== presentation())) {
        const old = mount;
        try { await input.closePreview(old.owner); }
        catch (cause) { error = String(cause); return; }
        mount = null; failedOwner = undefined;
      }
      if (dialog && (disposed || !current?.active || !eligible(current) || !fullscreen || dialog.identity !== current.identity)) {
        if (presentationPending) return;
        if (dialog.open) dialog = Object.freeze({ ...dialog, open: false, closeAttempt: dialog.closeAttempt + 1 });
        return;
      }
      if (dialog && !dialog.open) return;
      if (disposed || !current?.active) return;
      mode = wantedMode;
      if (fullscreen && eligible(current) && !dialog) {
        dialog = Object.freeze({ generation: ++generation, identity: current.identity, open: true, opened: false, closeAttempt: 0 });
        return;
      }
      if (wantsPreview() && !mount && (!dialog || dialog.opened)) {
        mount = Object.freeze({ owner: input.identifyMount(), identity: current.identity, presentation: presentation() });
      }
    };
    // Reserve the single gate synchronously, before calling asynchronous native close.
    flight = Promise.resolve().then(work).finally(() => {
      flight = undefined; publish();
      if (disposed && !mount && !dialog) { finishDisposal?.(); finishDisposal = undefined; rejectDisposal = undefined; }
    });
    publish(); return flight;
  }
  return {
    state,
    detachDisplay() { displayChanged = undefined; },
    update(next: ResourceHtmlInput) {
      if (disposed) return flight ?? Promise.resolve();
      const previous = current;
      if (previous && previous.identity === next.identity && previous.active === next.active && previous.htmlFile === next.htmlFile
        && previous.targetLine === next.targetLine && previous.gui === next.gui) return flight ?? Promise.resolve();
      if (!previous || previous.identity !== next.identity) { wantedMode = next.targetLine === undefined ? 'preview' : 'source'; fullscreen = false; }
      else if (next.targetLine !== undefined) wantedMode = 'source';
      if (!next.active || !eligible(next)) fullscreen = false;
      current = Object.freeze({ ...next });
      return reconcile();
    },
    toggleMode() {
      if (disposed || presentationPending || !current?.active || !eligible(current) || flight || error) return flight ?? Promise.resolve();
      wantedMode = mode === 'preview' ? 'source' : 'preview'; return reconcile();
    },
    setFullscreen(value: boolean) {
      if (disposed || presentationPending || !current?.active || !eligible(current) || error) return flight ?? Promise.resolve();
      fullscreen = value; return reconcile();
    },
    back(ticket?: number) {
      if (disposed || presentationPending || ticket !== undefined && dialog?.generation !== ticket) return Promise.resolve();
      if (dialog || fullscreen) { fullscreen = false; return reconcile(); }
      input.back(); return Promise.resolve();
    },
    dialogOpened(ticket: number) {
      if (!dialog || dialog.generation !== ticket || !dialog.open || dialog.opened) return Promise.resolve();
      dialog = Object.freeze({ ...dialog, opened: true }); return reconcile();
    },
    dialogClosed(ticket: number) {
      if (!dialog || dialog.generation !== ticket || dialog.open) return Promise.resolve();
      dialog = null; return reconcile();
    },
    dialogFailed(ticket: number, attempt: number) {
      if (!dialog || dialog.generation !== ticket || dialog.open || dialog.closeAttempt !== attempt) return;
      error = 'resource_html_dialog_close_failed'; publish();
    },
    retry() {
      if (error && dialog && !dialog.open) dialog = Object.freeze({ ...dialog, closeAttempt: dialog.closeAttempt + 1 });
      error = ''; return reconcile();
    },
    waitRetired(): Promise<void> {
      if (error) return Promise.reject(new Error(error));
      if (!mount && !dialog) return flight ?? Promise.resolve();
      return new Promise<void>((resolve, reject) => retiredWaiters.push({ resolve, reject }));
    },
    previewFailed(owner: string) {
      if (disposed || mount?.owner !== owner) return;
      failedOwner = owner; error = 'resource_html_preview_failed'; publish();
    },
    setPresentationPending(value: boolean) {
      presentationPending = value; publish();
      if (!value) return reconcile();
      return Promise.resolve();
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      if (error && dialog && !dialog.open) dialog = Object.freeze({ ...dialog, closeAttempt: dialog.closeAttempt + 1 });
      disposed = true; fullscreen = false; error = '';
      disposal = reconcile().then(() => {
        if (error) throw new Error(error);
        if (!mount && !dialog) return;
        return new Promise<void>((resolve, reject) => { finishDisposal = resolve; rejectDisposal = reject; });
      }).catch(cause => { disposal = undefined; throw cause; });
      return disposal;
    },
  };
}

export type ResourceHtmlViewerController = ReturnType<typeof createResourceHtmlViewer>;
