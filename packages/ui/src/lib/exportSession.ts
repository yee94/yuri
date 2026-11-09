import type { Message, Part } from '@/lib/opencode/v2-types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { isVSCodeRuntime, openDesktopPath, revealDesktopPath, saveDesktopMarkdownFile } from '@/lib/desktop';
import { getRevealLabelKey } from '@/lib/utils';
import { formatSessionAsMarkdown as formatCore, type ChildSessionExport } from './export-session-core';
export { buildExportFilename } from './export-session-core';
export type { ChildSessionExport } from './export-session-core';

export function formatSessionAsMarkdown(messages: Array<{ info: Message; parts: Part[] }>, title?: string | null, children?: ChildSessionExport[]): string {
  return formatCore(messages, title, children, getCurrentIntlLocale());
}
export function downloadAsMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
export async function saveAsMarkdownDesktop(content: string, filename: string): Promise<string | null> {
  const desktopPath = await saveDesktopMarkdownFile(filename, content);
  if (desktopPath) return desktopPath;
  if (!isVSCodeRuntime()) return null;
  try {
    const payload = await getRegisteredRuntimeAPIs()?.vscode?.saveMarkdown?.({ fileName: filename, content }) as { saved?: boolean; path?: string } | undefined;
    if (!payload || payload.saved !== true) return null;
    const savedPath = typeof payload.path === 'string' ? payload.path.trim() : '';
    return savedPath.length > 0 ? savedPath : null;
  } catch { return null; }
}
export async function revealExportedMarkdown(path: string): Promise<boolean> {
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
  if (runtimeFiles?.revealPath) {
    try { const result = await runtimeFiles.revealPath(path); return Boolean(result?.success); }
    catch { return false; }
  }
  if (await revealDesktopPath(path)) return true;
  return openDesktopPath(path);
}
export function getExportRevealLabelKey() { return getRevealLabelKey(); }
