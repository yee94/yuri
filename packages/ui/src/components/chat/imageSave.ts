import { Capacitor, registerPlugin } from '@capacitor/core';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { readFileResourceUrl, readRuntimeFileBlob } from '@/lib/runtime-file-resource';
import { downloadRuntimeFile } from '@/lib/runtime-file-download';
import { readRelayImageDisplayBlob } from '@/lib/relay/relay-image-stream';
import { type DownloadProgress } from '@/lib/download-progress';

import {
  needsRuntimeImageStream,
  resolveImageSource,
} from './imageSource';

export type ImageSaveTarget = {
  kind?: 'image' | 'video' | 'audio';
  /** Browser-consumable URL currently shown (blob / yuri-asset / http / data). */
  displayUrl?: string;
  /** Original message source (file://, absolute path, http, data, …). */
  sourceUrl: string;
  filename?: string;
  mimeType?: string;
  effectiveDirectory?: string;
  /**
   * Bytes already available in the UI (e.g. captured from the fullscreen
   * preview img). When set, save never re-fetches network/runtime paths.
   */
  prefetchedBlob?: Blob;
};

export type ImageSaveResult = 'downloaded' | 'saved';

const DEFAULT_MIME = 'image/png';

type YuriMediaPlugin = {
  saveFile: (options: { dataBase64: string; mimeType: string; filename: string }) => Promise<{ cancelled?: boolean }>;
  stageFile: (options: { id: string; dataBase64: string; append: boolean }) => Promise<void>;
  saveStagedFile: (options: { id: string; filename: string }) => Promise<{ cancelled?: boolean }>;
  discardStagedFile: (options: { id: string }) => Promise<void>;
  saveImage: (options: {
    dataBase64: string;
    mimeType?: string;
    filename?: string;
  }) => Promise<void>;
};

const YuriMedia = registerPlugin<YuriMediaPlugin>('YuriMedia');

const extensionForMime = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() || DEFAULT_MIME;
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'video/quicktime') return 'mov';
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3';
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a';
  const subtype = normalized.split('/')[1];
  return subtype && /^[a-z0-9.+-]+$/i.test(subtype) ? subtype : 'png';
};

const sanitizeFilename = (value: string | undefined, mimeType: string): string => {
  const fallback = `${mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image'}.${extensionForMime(mimeType)}`;
  const raw = (value || '').trim() || fallback;
  const base = raw.split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, '_').replace(/^\.+/, '');
  if (!cleaned) return fallback;
  if (!/\.[a-z0-9]{1,8}$/i.test(cleaned)) {
    return `${cleaned}.${extensionForMime(mimeType)}`;
  }
  return cleaned;
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
      return;
    }
    reject(new Error('Failed to encode image'));
  };
  reader.onerror = () => reject(reader.error ?? new Error('Failed to encode image'));
  reader.readAsDataURL(blob);
});

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const dataUrl = await blobToDataUrl(blob);
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

const fetchBlobFromUrl = async (url: string, signal?: AbortSignal, onProgress?: DownloadProgress): Promise<Blob> => {
  if (url.startsWith('yuri-asset:')) {
    const original = await readRelayImageDisplayBlob(url, signal, onProgress);
    if (original) return original;
    if (isCapacitorApp()) throw new Error('Image display stream is no longer available');
  }
  return readFileResourceUrl(url, signal, onProgress);
};

const materializeFromRuntimePath = async (
  path: string,
  signal?: AbortSignal,
  onProgress?: DownloadProgress,
): Promise<Blob> => {
  return readRuntimeFileBlob({ path, signal }, onProgress);
};

export const materializeImageBlob = async (
  target: ImageSaveTarget,
  signal?: AbortSignal,
  onProgress?: DownloadProgress,
): Promise<{ blob: Blob; filename: string; mimeType: string }> => {
  const effectiveDirectory = target.effectiveDirectory ?? '';
  let blob: Blob | null = null;

  if (target.prefetchedBlob && target.prefetchedBlob.size > 0) {
    blob = target.prefetchedBlob;
  }

  // Prefer the URL already driving the visible <img> (blob / virtual asset).
  // This is a local/memory read, not a second host download when the preview
  // is already resolved.
  const displayUrl = target.displayUrl?.trim();
  if (!blob && displayUrl && (!/^https?:/i.test(displayUrl) || !needsRuntimeImageStream(resolveImageSource(target.sourceUrl, effectiveDirectory)))) {
    try {
      blob = await fetchBlobFromUrl(displayUrl, signal, onProgress);
    } catch {
      signal?.throwIfAborted();
      blob = null;
      onProgress?.(0);
    }
  }

  if (!blob) {
    const source = target.sourceUrl.trim();
    if (!source) {
      throw new Error('Image source is empty');
    }

    if (/^(?:data|blob):/i.test(source) || /^https?:/i.test(source) || /^\/api(?=\/|[?#]|$)/.test(source)) {
      blob = await fetchBlobFromUrl(source, signal, onProgress);
    } else {
      const resolved = resolveImageSource(source, effectiveDirectory);
      if (needsRuntimeImageStream(resolved)) {
        blob = await materializeFromRuntimePath(resolved.path, signal, onProgress);
      } else {
        blob = await fetchBlobFromUrl(resolved.source, signal, onProgress);
      }
    }
  }

  if (!blob || blob.size <= 0) {
    throw new Error('Image is empty');
  }
  onProgress?.(100);

  const mimeType = (
    target.mimeType
    || (blob.type && /^(image|video|audio)\//.test(blob.type) ? blob.type : '')
    || (target.kind === 'video' ? 'video/mp4' : target.kind === 'audio' ? 'audio/mpeg' : '')
    || DEFAULT_MIME
  ).split(';')[0].trim() || DEFAULT_MIME;

  return {
    blob,
    filename: sanitizeFilename(target.filename, mimeType),
    mimeType,
  };
};

// Multiple of 3 so every chunk's base64 decodes independently on the native side.
const STAGE_CHUNK_BYTES = 3 * 1024 * 1024;

const isUnimplemented = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'UNIMPLEMENTED'
);

/**
 * Stream bytes to a native cache file in bounded chunks, then open the save
 * picker. Returns null when the installed native shell predates staging.
 */
const saveFileByStaging = async (
  blob: Blob,
  filename: string,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<{ cancelled?: boolean } | null> => {
  if (typeof YuriMedia.stageFile !== 'function') return null;
  const id = crypto.randomUUID();
  let staged = false;
  try {
    for (let offset = 0; offset < blob.size; offset += STAGE_CHUNK_BYTES) {
      signal?.throwIfAborted();
      const dataBase64 = await blobToBase64(blob.slice(offset, offset + STAGE_CHUNK_BYTES));
      try {
        await YuriMedia.stageFile({ id, dataBase64, append: offset > 0 });
      } catch (error) {
        if (offset === 0 && isUnimplemented(error)) return null;
        throw error;
      }
      staged = true;
      onProgress?.(Math.min(1, (offset + STAGE_CHUNK_BYTES) / blob.size));
    }
    signal?.throwIfAborted();
    staged = false;
    return await YuriMedia.saveStagedFile({ id, filename });
  } finally {
    if (staged) void YuriMedia.discardStagedFile({ id }).catch(() => {});
  }
};

const isMediaFileKind = (target: ImageSaveTarget): boolean => target.kind === 'video' || target.kind === 'audio';

const isNativeMediaAvailable = (): boolean => {
  if (!isCapacitorApp() || typeof Capacitor === 'undefined') return false;
  return Capacitor.isPluginAvailable('YuriMedia');
};

/**
 * Save an image via the best available surface:
 * - Capacitor: native gallery write (YuriMedia)
 * - VS Code: native save dialog
 * - desktop/web: browser download (share is not used for "save to photos")
 */
export const saveImageToDevice = async (
  target: ImageSaveTarget,
  signal?: AbortSignal,
  onProgress?: DownloadProgress,
): Promise<ImageSaveResult> => {
  const resolved = resolveImageSource(target.sourceUrl, target.effectiveDirectory ?? '');
  if (isVSCodeRuntime() && isMediaFileKind(target) && !isNativeMediaAvailable()) {
    const files = getRegisteredRuntimeAPIs()?.files;
    if (needsRuntimeImageStream(resolved) && files?.downloadFile) {
      signal?.throwIfAborted();
      await files.downloadFile(resolved.path);
      return 'saved';
    }
    throw new Error('Video download is unavailable for this source in VS Code');
  }
  if (needsRuntimeImageStream(resolved) && !target.prefetchedBlob && !/^(?:blob|data|yuri-asset):/i.test(target.displayUrl ?? '')
    && !isNativeMediaAvailable() && !isVSCodeRuntime()) {
    await downloadRuntimeFile({ path: resolved.path, filename: target.filename, signal }, onProgress);
    return 'downloaded';
  }
  const stagesNativeFile = isMediaFileKind(target) && isNativeMediaAvailable();
  // Native file saves also write to device storage; keep the tail of the
  // progress ring for that phase so the ring never sits at 100% while waiting.
  const downloadProgress: DownloadProgress | undefined = stagesNativeFile && onProgress
    ? (percent) => onProgress(percent === null ? null : Math.floor(percent * 0.9))
    : onProgress;
  const { blob, filename, mimeType } = await materializeImageBlob(target, signal, downloadProgress);
  signal?.throwIfAborted();

  if (isNativeMediaAvailable()) {
    if (stagesNativeFile) {
      const result = await saveFileByStaging(blob, filename, signal,
        (fraction) => onProgress?.(90 + Math.floor(fraction * 9)))
        ?? await YuriMedia.saveFile({ dataBase64: await blobToBase64(blob), mimeType, filename });
      if (result?.cancelled) throw new DOMException('Save cancelled', 'AbortError');
      return 'saved';
    }
    const dataBase64 = await blobToBase64(blob);
    signal?.throwIfAborted();
    await YuriMedia.saveImage({ dataBase64, mimeType, filename });
    return 'saved';
  }

  if (isVSCodeRuntime()) {
    const vscode = getRegisteredRuntimeAPIs()?.vscode;
    if (vscode?.saveImage) {
      const dataUrl = await blobToDataUrl(blob);
      await vscode.saveImage({ fileName: filename, dataUrl });
      return 'saved';
    }
  }

  downloadBlob(blob, filename);
  return 'downloaded';
};
