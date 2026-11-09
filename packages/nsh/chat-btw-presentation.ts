import type { BtwCloseTicket, BtwOwner, BtwState } from './chat-btw-model';

export type BtwPresentation = {
  readonly id: number;
  readonly owner: BtwOwner;
  readonly closeTicket: BtwCloseTicket;
  state: BtwState;
  open: boolean;
  closing: boolean;
};

/** One actual Sheet at a time. Closing roots keep immutable owner/ticket callbacks. */
export function createBtwPresentation(notify: () => void) {
  let presented: BtwPresentation | null = null, serial = 0, disposed = false;
  let desired: { owner: BtwOwner; active: boolean } | null = null;
  function start() {
    if (disposed || presented || !desired?.active) return;
    const state = desired.owner.snapshot();
    if (!state.open) return;
    presented = { id: ++serial, owner: desired.owner, closeTicket: desired.owner.capturePresentation(), state, open: true, closing: false };
    notify();
  }
  return {
    current: () => presented,
    sync(owner: BtwOwner, state: BtwState, active: boolean) {
      if (disposed) return;
      desired = { owner, active };
      if (!presented) { start(); return; }
      const same = presented.owner === owner && presented.closeTicket.generation === state.presentationGeneration;
      if (!presented.closing && same && state.open && active) {
        if (presented.state !== state) { presented.state = state; notify(); }
      } else if (!presented.closing) {
        presented.closing = true; presented.open = false; notify();
      }
    },
    change(ticket: BtwPresentation, event: { open: boolean }) {
      if (disposed || presented !== ticket || event.open) return;
      // NativeSheet may deliver this after a newer intent or owner was adopted.
      // Never resolve props.owner here and never use the ordinary edit revision.
      ticket.closing = true; ticket.open = false;
      ticket.owner.closePresentation(ticket.closeTicket);
      notify();
    },
    closed(ticket: BtwPresentation) {
      if (disposed || presented !== ticket) return;
      presented = null;
      notify(); start();
    },
    dispose() { disposed = true; desired = null; presented = null; },
  };
}
