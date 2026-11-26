/**
 * Content-addressed OTA ZIPs are published as assets of one GitHub prerelease,
 * so the Vercel origin serves only manifests and update decisions, never bundle
 * bytes. EdgeOne still materializes local copies for domestic clients.
 */
export const OTA_BUNDLE_RELEASE_TAG = 'ota-bundles';
export const OTA_BUNDLE_RELEASE_BASE_URL = `https://github.com/yee94/yuri/releases/download/${OTA_BUNDLE_RELEASE_TAG}/`;

const BUNDLE_PATH_PATTERN = /^\/ota\/bundles\/([0-9a-f]{16})\.zip$/;

export function otaBundleReleaseUrl(bundleId, baseUrl = OTA_BUNDLE_RELEASE_BASE_URL) {
  return new URL(`${bundleId}.zip`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

/** Map a canonical `/ota/bundles/<id>.zip` path to its release asset, or null. */
export function otaBundleReleaseUrlForPath(pathname, baseUrl = OTA_BUNDLE_RELEASE_BASE_URL) {
  const bundleId = BUNDLE_PATH_PATTERN.exec(pathname)?.[1];
  return bundleId ? otaBundleReleaseUrl(bundleId, baseUrl) : null;
}
