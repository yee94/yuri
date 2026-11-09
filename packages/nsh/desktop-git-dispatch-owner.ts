import type { DesktopGitContextInput } from './desktop-git-dispatch';
import type { NativeNewSessionOwner } from './new-session';

/** Only the active page publishes. Retire removes exactly this owner, never its successor. */
export type DesktopGitOwnerRegistration =
  | { type: 'register'; owner: NativeNewSessionOwner; initialContext?: DesktopGitContextInput }
  | { type: 'retire'; owner: NativeNewSessionOwner };
export type DesktopGitOwnerPublisher = (registration: DesktopGitOwnerRegistration) => void;
