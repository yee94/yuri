#!/usr/bin/env bash
# Commit the assembled OTA channel manifests to main so the git-deployed EdgeOne
# project builds a complete static distribution. Only channels/*.json enter git;
# the EdgeOne build downloads and verifies all retained ZIPs and CHANGELOG from
# Vercel before activation. Runs from a detached worktree; checkout is untouched.
# After synchronization, explicitly invoke the production deployment hook; a
# successful push alone does not establish that EdgeOne received a Git callback.
#
# Usage: commit-edgeone-manifests.sh <snapshot-dir> <commit-message-subject>
set -euo pipefail
node scripts/mobile-ota/trigger-edgeone-deploy.mjs --check

SNAPSHOT_DIR="${1:?snapshot dir required}"
SUBJECT="${2:?commit subject required}"
CHANNELS_SRC="$SNAPSHOT_DIR/ota/channels"
DEST_REL="deploy/update-service/ota/channels"

for ch in beta stable; do
  test -s "$CHANNELS_SRC/$ch.json" || { echo "Missing $CHANNELS_SRC/$ch.json" >&2; exit 1; }
done

WORKTREE="$(mktemp -d)"
trap 'git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true' EXIT

for attempt in 1 2 3 4 5; do
  git fetch --quiet origin main
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  git worktree add --quiet --detach "$WORKTREE" origin/main

  mkdir -p "$WORKTREE/$DEST_REL"
  cp "$CHANNELS_SRC/beta.json" "$CHANNELS_SRC/stable.json" "$WORKTREE/$DEST_REL/"

  if git -C "$WORKTREE" diff --quiet -- "$DEST_REL" && [[ "${EDGEONE_FORCE_DEPLOY:-}" != "1" ]]; then
    echo "EdgeOne channel manifests already up to date on main."
    node scripts/mobile-ota/trigger-edgeone-deploy.mjs
    exit 0
  fi

  git -C "$WORKTREE" add "$DEST_REL"
  git -C "$WORKTREE" \
    -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet --allow-empty -m "$SUBJECT [skip ci]"

  if git -C "$WORKTREE" push --quiet origin HEAD:main; then
    echo "Committed EdgeOne channel manifests to main."
    node scripts/mobile-ota/trigger-edgeone-deploy.mjs
    exit 0
  fi
  echo "Push to main raced with another update (attempt $attempt/5); retrying." >&2
  sleep $((attempt * 3))
done

echo "::error::Could not push EdgeOne channel manifests to main; EdgeOne would keep serving stale manifests." >&2
exit 1
