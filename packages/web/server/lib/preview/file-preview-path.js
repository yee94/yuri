import { REMOTE_PREVIEW_TOKEN_MARKER } from '../remote-hosts/preview-scope.js';

const URL_TOKEN = /^yuri_url_[A-Za-z0-9_-]{32}$/;
const TOKEN_SEGMENT = /^(?:yuri_url_[A-Za-z0-9_-]{32}|-|__YURI_HUB_URL_AUTH__)$/;

/** Only the file-preview envelope may carry URL auth in a path, never other APIs. */
export const parseFilePreviewPath = (pathname) => {
  if (typeof pathname !== 'string' || /[\\?#\u0000-\u0020]/.test(pathname)) return null;
  const match = /^(\/api\/hosts\/[A-Za-z0-9._~%-]{1,256})?\/api\/preview\/proxy\/([a-f0-9]{16,64})\/_file\/([a-f0-9]{32})\/([^/]+)(\/.*)$/i.exec(pathname);
  if (!match || !TOKEN_SEGMENT.test(match[4])) return null;
  try {
    for (const segment of pathname.split('/').slice(1)) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) return null;
    }
  } catch { return null; }
  const resourcePath = match[5];
  const basePath = pathname.slice(0, -resourcePath.length);
  return { hostPrefix: match[1] || '', id: match[2], previewToken: match[3], urlAuthToken: match[4], resourcePath, basePath };
};

export const readFilePreviewUrlAuthToken = (pathname) => {
  const parsed = parseFilePreviewPath(pathname);
  return parsed && URL_TOKEN.test(parsed.urlAuthToken) ? parsed.urlAuthToken : '';
};

/** Hub must strip its credential before the existing authenticated Host transport. */
export const replaceFilePreviewUrlAuthToken = (pathname, replacement = '-') => {
  const parsed = parseFilePreviewPath(pathname);
  if (!parsed || !TOKEN_SEGMENT.test(replacement)) return null;
  return `${parsed.basePath.slice(0, -parsed.urlAuthToken.length)}${replacement}${parsed.resourcePath}`;
};

export const filePreviewResponseBase = (parsed, hostPrefix) => {
  const token = hostPrefix ? REMOTE_PREVIEW_TOKEN_MARKER : parsed.urlAuthToken;
  return `${hostPrefix}/api/preview/proxy/${parsed.id}/_file/${parsed.previewToken}/${token}`;
};
