#!/bin/sh
set -eu
entry="$0"
while [ -L "$entry" ]; do
  directory="$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)"
  target="$(readlink -- "$entry")"
  case "$target" in /*) entry="$target" ;; *) entry="$directory/$target" ;; esac
done
root="$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)"
# Only OpenCode is added to the child PATH; the private Node never shadows system Node.
export PATH="$root/bin:${PATH:-/usr/bin:/bin}"
export LD_LIBRARY_PATH="$root/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$root/runtime/node" --title=yuri "$root/lib/bin/cli.js" "$@"
