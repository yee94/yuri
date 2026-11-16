import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function buildRemotePortableInstallScript(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Invalid portable Yuri release version');
  }
  const installer = fs.readFileSync(require.resolve('@yuriai/web/bin/install-portable.sh'), 'utf8');
  return `set -e
bash -s -- --version '${version}' --install-dir "$HOME/.local/share/yuri" --no-link <<'YURI_PORTABLE_INSTALLER'
${installer}
YURI_PORTABLE_INSTALLER
runtime_dir="$HOME/.config/yuri"
mkdir -p "$runtime_dir"
(umask 077; printf '%s\\n' 'YURI_SSH_PORTABLE="$HOME/.local/share/yuri"' > "$runtime_dir/ssh-runtime.sh.tmp")
mv "$runtime_dir/ssh-runtime.sh.tmp" "$runtime_dir/ssh-runtime.sh"
"$HOME/.local/share/yuri/current/yuri" --version
`;
}

export function buildRemotePortableVerificationScript() {
  return `set -e
[ -n "$YURI_SSH_PORTABLE" ] || { echo "Portable Yuri runtime is not registered" >&2; exit 1; }
root="$YURI_SSH_PORTABLE/current"
LD_LIBRARY_PATH="$root/runtime/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$root/runtime/node" "$root/verify.mjs"
`;
}
