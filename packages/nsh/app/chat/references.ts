import { normalizePath } from '../core/store';
import type { DraftReference } from './store';

/** Web `composerQuotes`: one header, one `>` block per quote, then the message. */
export const CONVERSATION_QUOTE_HEADER = 'Quoted from the conversation:';

const quoteBlock = (quote: string): string => quote.split('\n').map((line) => `> ${line}`).join('\n');

export function messageWithComposerQuotes(quotes: readonly string[], message: string): string {
  if (quotes.length === 0 || message.trimStart().startsWith('/')) return message;
  const quoted = [CONVERSATION_QUOTE_HEADER, ...quotes.map(quoteBlock)].join('\n\n');
  return message ? `${quoted}\n\n${message}` : quoted;
}

/** Absolute `file://` URL of one workspace reference (Web `fileUri`). */
export function fileUri(path: string, directory: string): string {
  const normalized = path.replace(/\\/g, '/');
  const root = normalizePath(directory);
  const absolute = /^(?:\/|[a-zA-Z]:\/)/.test(normalized) ? normalized : `${root}/${normalized.replace(/^\.\//, '')}`;
  const head = absolute.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of absolute.slice(head.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const encoded = head + parts.map((part) => (/^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part))).join('/');
  return `file://${/^[a-zA-Z]:/.test(encoded) ? '/' : ''}${encoded}`;
}

/** The `@file` chips as the prompt's `files` (`uri` + `name`). */
export function referenceFiles(references: readonly DraftReference[], directory: string): { uri: string; name: string }[] {
  const files: { uri: string; name: string }[] = [];
  for (const reference of references) {
    if (reference.kind !== 'file') continue;
    const uri = fileUri(reference.value, directory);
    if (files.some((file) => file.uri === uri)) continue;
    files.push({ uri, name: reference.value.split('/').pop() || reference.value });
  }
  return files;
}

export const referenceToken = (reference: DraftReference): string =>
  reference.kind === 'file' ? `@${reference.value}` : reference.kind === 'command' ? `/${reference.value}` : '';

/** The label the chips row shows. */
export const referenceLabel = (reference: DraftReference): string => {
  if (reference.kind === 'quote') {
    const line = reference.value.trim().split('\n')[0] ?? '';
    return line.length > 60 ? `${line.slice(0, 60)}…` : line;
  }
  return referenceToken(reference);
};

/** The URL an `Image` may load; a bare `file:` path is not granted to media loads. */
export const mediaUri = (uri: string): string => {
  if (!uri) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  return /^(?:https?|asset|data|blob):/i.test(uri) ? uri : '';
};

export const attachmentSize = (bytes?: number): string => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
};
