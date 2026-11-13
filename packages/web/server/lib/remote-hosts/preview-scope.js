export const REMOTE_PREVIEW_TOKEN_MARKER = '__YURI_HUB_URL_AUTH__';
export const remotePreviewPrefix = (req) => {
  const prefix = req.headers?.['x-yuri-preview-hub-prefix'];
  return typeof prefix === 'string' && /^\/api\/hosts\/[A-Za-z0-9._~%-]{1,256}$/.test(prefix) ? prefix : '';
};

// Retain only a possible partial marker, not the response body.
export async function* replacePreviewToken(body, token) {
  const decoder = new TextDecoder();
  let tail = '';
  for await (const chunk of body) {
    const text = (tail + decoder.decode(chunk, { stream: true })).replaceAll(REMOTE_PREVIEW_TOKEN_MARKER, token);
    let suffix = 0;
    for (let length = 1; length < REMOTE_PREVIEW_TOKEN_MARKER.length; length++) {
      if (text.endsWith(REMOTE_PREVIEW_TOKEN_MARKER.slice(0, length))) suffix = length;
    }
    tail = suffix ? text.slice(-suffix) : '';
    const output = suffix ? text.slice(0, -suffix) : text;
    if (output) yield Buffer.from(output);
  }
  const output = (tail + decoder.decode()).replaceAll(REMOTE_PREVIEW_TOKEN_MARKER, token);
  if (output) yield Buffer.from(output);
}
