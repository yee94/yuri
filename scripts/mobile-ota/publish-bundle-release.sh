#!/usr/bin/env bash
# Upload every snapshot OTA ZIP to the GitHub release bundle store BEFORE the
# snapshot's manifests go live, so clients never see a manifest whose bundle is
# missing. ZIPs are content-addressed: an existing asset with the same name and
# size is already correct and is skipped. Unreferenced assets older than the
# retention window are pruned to stay under GitHub's per-release asset limit.
#
# Usage: scripts/mobile-ota/publish-bundle-release.sh <snapshot-dir>
# Requires GH_TOKEN with contents:write and GITHUB_REPOSITORY.
set -euo pipefail

SNAPSHOT_DIR="${1:?snapshot directory is required}"
BUNDLES_DIR="$SNAPSHOT_DIR/ota/bundles"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
RETENTION_DAYS="${OTA_BUNDLE_RETENTION_DAYS:-30}"
TAG="$(node --input-type=module -e '
  import { OTA_BUNDLE_RELEASE_TAG } from "./deploy/update-service/lib/ota-bundle-release.js";
  process.stdout.write(OTA_BUNDLE_RELEASE_TAG);
')"

shopt -s nullglob
ZIPS=("$BUNDLES_DIR"/*.zip)
if [[ ${#ZIPS[@]} -eq 0 ]]; then
  echo "No OTA bundles to upload."
  exit 0
fi

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  # Prerelease so it never becomes GitHub Latest or enters stable update feeds.
  gh release create "$TAG" --repo "$REPO" --prerelease --target "${GITHUB_SHA:-main}" \
    --title "OTA bundle store" \
    --notes "Content-addressed OTA bundles served to update clients. Managed by CI; do not edit."
fi

RELEASE_ID="$(gh api "repos/$REPO/releases/tags/$TAG" --jq '.id')"
EXISTING="$(gh api --paginate "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" \
  --jq '.[] | "\(.name) \(.size)"')"

for zip in "${ZIPS[@]}"; do
  name="$(basename "$zip")"
  size="$(stat -c %s "$zip")"
  if grep -qxF "$name $size" <<<"$EXISTING"; then
    echo "OTA bundle $name already published"
    continue
  fi
  gh release upload "$TAG" "$zip" --repo "$REPO" --clobber
  echo "OTA bundle $name uploaded ($size bytes)"
done

REFERENCED="$(for zip in "${ZIPS[@]}"; do basename "$zip"; done)"
CUTOFF="$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
gh api --paginate "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" \
  --jq '.[] | "\(.id) \(.name) \(.created_at)"' |
  while read -r id name created; do
    if grep -qxF "$name" <<<"$REFERENCED" || [[ "$created" > "$CUTOFF" ]]; then continue; fi
    gh api -X DELETE "repos/$REPO/releases/assets/$id" >/dev/null
    echo "Pruned unreferenced OTA bundle $name ($created)"
  done
