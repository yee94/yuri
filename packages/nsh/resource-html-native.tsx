import { nativeComponent } from 'nsh';
import type { RuntimeScope } from './runtime-scope';

export const ResourceHTMLView = nativeComponent<{
  config: Readonly<{ owner: string; expectedHost: RuntimeScope | null; directory: string; path: string; lease: string; presentationOwner?: string }>;
}, { failed: { owner: string } }>('yuri.resource.html', { props: ['config'], events: ['failed'] });

export const ResourceHTMLPresentationAnchor = nativeComponent<{
  config: Readonly<{ owner: string; expectedHost: RuntimeScope | null }>;
  closing: boolean;
  closeAttempt: number;
}, { ready: { owner: string }; failed: { owner: string }; opened: { owner: string }; closed: { owner: string }; closeFailed: { owner: string; attempt: number; code: string } }>('yuri.resource.presentation', { props: ['config', 'closing', 'closeAttempt'], events: ['ready', 'failed', 'opened', 'closed', 'closeFailed'] });
