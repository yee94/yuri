import { cleanup, effect, signal, untracked, type JSX } from 'nsh';
import { createDesktopChatWriter } from './desktop-chat-writer';
import type { VerifiedDesktopWriterGrant } from './desktop-writer-core';

type Admission = { grant(): VerifiedDesktopWriterGrant | null; markUnknown(cause?: unknown): void };
export type NativeDesktopChatWriterOwner = ReturnType<typeof createDesktopChatWriter<Admission>>;
type Options = Parameters<typeof createDesktopChatWriter<Admission>>[0];

/** Keeps the actual Chat construction in NSH's mounted child owner, never an async continuation. */
export function NativeDesktopChatWriter(props: Omit<Options, 'renderChild' | 'changed'> & {
  onOwner?(owner: NativeDesktopChatWriterOwner): void | (() => void);
  children(grant: Admission['grant'], markUnknown: Admission['markUnknown'], owner: NativeDesktopChatWriterOwner): JSX.Element;
  waiting(status: ReturnType<NativeDesktopChatWriterOwner['status']>): JSX.Element;
}) {
  const admitted = signal(false), revision = signal(0);
  const owner = createDesktopChatWriter({ ...props, changed() {
    revision.set(untracked(revision) + 1);
    if (owner.child()) admitted.set(true);
  }, renderChild: (grant, markUnknown) => ({ grant: () => { revision(); return grant(); }, markUnknown }) });
  const unregister = props.onOwner?.(owner);
  if (unregister) cleanup(unregister);
  cleanup(owner.retire);
  effect(() => {
    props.client(); props.capabilitiesReady(); props.committedRuntimeScope(); props.stableAuthorityIdentity(); props.current();
    untracked(() => { void owner.reconcile(); });
  });
  function Ready() {
    const admission = owner.child()!;
    return props.children(admission.grant, admission.markUnknown, owner);
  }
  function Waiting() { return <>{() => { revision(); return props.waiting(owner.status()); }}</>; }
  return <If when={admitted()} else={<Waiting />}><Ready /></If>;
}
