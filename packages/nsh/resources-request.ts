import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { attachmentFrom, contactDescriptor } from './attachments';
import type { Attachment } from './model';
import { resourcePath, resourceStatFrom } from './resources-model';

/** Uses the existing bound runtime request, retaining the owner's constructor receipt. */
export function bindResourceStat(scope: RuntimeScope | null, request: (path: string) => Promise<unknown>) {
  const expectedHost = runtimeScopeFrom(scope);
  return async (path: string) => {
    if (!expectedHost) throw new Error('scope_required');
    return resourceStatFrom(await request(`/api/fs/stat?path=${encodeURIComponent(resourcePath(path))}`));
  };
}

/** Bind at resource owner construction, never at a later click/retry. A copied,
 * immutable receipt also prevents mutation of an external props object. */
export function bindResourceRead(scope: RuntimeScope | null, call: (name: string, body: Record<string, unknown>) => Promise<unknown>) {
  const expectedHost = runtimeScopeFrom(scope);
  return async (path: string, requestId: string): Promise<unknown> => {
    if (!expectedHost) throw new Error('scope_required');
    return await call('resources.read', { path, requestId, expectedHost });
  };
}

/** Contact descriptors remain a distinct source; opaque IDs never become fs paths. */
export function bindContactAttachmentRead(scope: RuntimeScope | null, call: (name: string, body: Record<string, unknown>) => Promise<unknown>) {
  const expectedHost = runtimeScopeFrom(scope);
  return async (file: Attachment, requestId: string): Promise<unknown> => {
    if (!expectedHost) throw new Error('scope_required');
    if (file.kind !== 'contact') throw new Error('invalid_contact_attachment');
    const verified = attachmentFrom(file, { hostID: expectedHost.hostID, target: { kind: 'assistant', id: file.assistantID } });
    if (verified.kind !== 'contact') throw new Error('invalid_contact_attachment');
    return call('resources.read', { source: { kind: 'contact', assistantID: verified.assistantID, descriptor: contactDescriptor(verified) }, requestId, expectedHost });
  };
}
