export type DesktopWindowCloseRequest = Readonly<{ ticket: string; windowID: string; generation: number; reason: 'close' | 'quit' }>;

function closeRequest(value: unknown): DesktopWindowCloseRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ticket !== 'string' || !row.ticket || row.ticket.length > 1024
    || typeof row.windowID !== 'string' || !row.windowID || row.windowID.length > 256
    || !Number.isSafeInteger(row.generation) || (row.generation as number) < 1
    || row.reason !== 'close' && row.reason !== 'quit') return null;
  return { ticket: row.ticket, windowID: row.windowID, generation: row.generation as number, reason: row.reason };
}

/** Approval never disposes a document/window owner. Native validates ticket expiry
 * and performs the actual close; a rejected decision leaves the window usable. */
export function createDesktopWindowCloseOwner(options: {
  scope: () => unknown;
  requestFiles: () => Promise<boolean>;
  requestSettings: () => Promise<boolean>;
  canCloseFiles: () => boolean;
  decide: (decision: { ticket: string; approved: boolean }) => Promise<unknown>;
  onCommitting: (locked: boolean) => void;
  onError: (error: unknown) => void;
}) {
  let alive = true, windowID: string | undefined, generation = 0, revision = 0;
  let flight: { ticket: string; promise: Promise<boolean> } | undefined;
  let committingTicket: string | undefined;
  function unlock(ticket: string) {
    if (committingTicket !== ticket) return;
    committingTicket = undefined; options.onCommitting(false);
  }
  async function decide(ticket: string, approved: boolean) {
    try {
      if (await options.decide({ ticket, approved }) !== true) throw new Error('desktop_close_decision_unconfirmed');
      return approved;
    } catch (error) { if (alive) { unlock(ticket); options.onError(error); } return false; }
  }
  return {
    request(value: unknown): Promise<boolean> {
      const request = closeRequest(value);
      if (!alive || !request || windowID !== undefined && request.windowID !== windowID) return Promise.resolve(false);
      if (flight?.ticket === request.ticket) return flight.promise;
      if (committingTicket) return Promise.resolve(false);
      if (request.generation <= generation) return Promise.resolve(false);
      windowID = request.windowID; generation = request.generation;
      const captured = ++revision, scope = options.scope();
      if (flight) return decide(request.ticket, false);
      const current = () => alive && captured === revision && Object.is(scope, options.scope());
      const promise = (async () => {
        let approved = false;
        try {
          approved = current() && await options.requestFiles() && current()
            && await options.requestSettings() && current();
          if (approved) {
            committingTicket = request.ticket; options.onCommitting(true);
            approved = current() && options.canCloseFiles();
            if (!approved) unlock(request.ticket);
          }
        } catch (error) { approved = false; unlock(request.ticket); if (current()) options.onError(error); }
        if (!alive || captured !== revision) return false;
        return decide(request.ticket, approved);
      })().finally(() => { if (flight?.ticket === request.ticket) flight = undefined; });
      flight = { ticket: request.ticket, promise };
      return promise;
    },
    dispose() { alive = false; revision++; },
  };
}
