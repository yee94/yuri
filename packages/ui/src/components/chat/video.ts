export const isVideoSource = (source: string, mimeType?: string): boolean => (
  Boolean(mimeType?.toLowerCase().startsWith('video/'))
  || /^data:video\//i.test(source)
  || /\.(?:mp4|m4v|webm|mov|ogv|ogg)(?:[?#]|$)/i.test(source)
);

export const isAudioSource = (source: string, mimeType?: string): boolean => (
  Boolean(mimeType?.toLowerCase().startsWith('audio/'))
  || /^data:audio\//i.test(source)
  || /\.(?:mp3|m4a|aac|wav|flac|opus|oga)(?:[?#]|$)/i.test(source)
);

/** Audio and video share one playback/download preview. */
export const isMediaSource = (source: string, mimeType?: string): boolean => (
  isVideoSource(source, mimeType) || isAudioSource(source, mimeType)
);
