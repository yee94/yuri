#!/usr/bin/env bash
set -euo pipefail

version=""
install_dir="${YURI_INSTALL_DIR:-$HOME/.local/share/yuri}"
bin_dir="${YURI_BIN_DIR:-$HOME/.local/bin}"
link_bin=true
release_base="${YURI_RELEASE_BASE_URL:-https://github.com/yee94/yuri/releases}"
release_api="${YURI_RELEASE_API_URL:-https://api.github.com/repos/yee94/yuri/releases}"

fail() { echo "Yuri: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--install-dir|--bin-dir)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in --version) version="$2" ;; --install-dir) install_dir="$2" ;; --bin-dir) bin_dir="$2" ;; esac
      shift 2 ;;
    --no-link) link_bin=false; shift ;;
    --help) echo "Usage: install.sh [--version X.Y.Z[-beta.N]] [--install-dir DIR] [--bin-dir DIR] [--no-link]"; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ "$(uname -s)" = Linux ] || fail "Portable installation currently supports Linux only"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "Unsupported Linux architecture" ;; esac
if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null && ldd --version 2>&1 | grep -qi musl; }; then
  fail "Portable packages require glibc Linux; musl/Alpine is not supported"
fi
libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
if [[ "$libc" =~ ^glibc[[:space:]]([0-9]+)\.([0-9]+)$ ]]; then
  [ "${BASH_REMATCH[1]}" -gt 2 ] || { [ "${BASH_REMATCH[1]}" -eq 2 ] && [ "${BASH_REMATCH[2]}" -ge 36 ]; } \
    || fail "Portable packages require glibc 2.36+"
fi
case "$install_dir" in /*) ;; *) fail "--install-dir must be an absolute path" ;; esac
case "$bin_dir" in /*) ;; *) fail "--bin-dir must be an absolute path" ;; esac
case "$release_base" in https://*) ;; *) fail "Release downloads require HTTPS" ;; esac
case "$release_api" in https://*) ;; *) fail "Release discovery requires HTTPS" ;; esac
command -v tar >/dev/null || fail "tar is required to extract the package"
if command -v curl >/dev/null; then
  download() { curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --max-time 600 "$1" -o "$2"; }
elif command -v wget >/dev/null; then
  download() { wget -q --https-only --timeout=600 "$1" -O "$2"; }
else fail "curl or wget is required to download the package"
fi
if command -v sha256sum >/dev/null; then
  checksum() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null; then
  checksum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail "sha256sum or shasum is required to verify the download"
fi
mkdir -p "$install_dir"
lock="$install_dir/.install-lock"
mkdir "$lock" 2>/dev/null || fail "Another installation is active, or .install-lock needs operator recovery"
temporary=""
cleanup() {
  [ -z "$temporary" ] || rm -rf -- "$temporary"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
temporary="$(mktemp -d "$install_dir/.install.XXXXXX")"
if [ -z "$version" ]; then
  download "$release_api/latest" "$temporary/latest.json"
  version="$(sed -n 's/.*"tag_name":[[:space:]]*"v\([^"]*\)".*/\1/p' "$temporary/latest.json")"
  [[ "$version" != *-* ]] || fail "Stable discovery returned a prerelease"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] || fail "Invalid release version"
name="yuri-$version-linux-$arch.tar.gz"
target="$install_dir/versions/$version-linux-$arch"
if $link_bin && { [ -e "$bin_dir/yuri" ] || [ -L "$bin_dir/yuri" ]; }; then
  [ -L "$bin_dir/yuri" ] && [ "$(readlink "$bin_dir/yuri")" = "$install_dir/current/yuri" ] \
    || fail "$bin_dir/yuri already belongs to another installation; choose --bin-dir or use --no-link"
fi
if [ ! -e "$target" ]; then
  download "$release_base/download/v$version/$name" "$temporary/$name"
  download "$release_base/download/v$version/$name.sha256" "$temporary/checksum"
  expected="$(cut -d ' ' -f 1 < "$temporary/checksum")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid release checksum"
  [ "$(checksum "$temporary/$name")" = "$expected" ] || fail "Release checksum mismatch"
  tar -xzf "$temporary/$name" -C "$temporary"
  LD_LIBRARY_PATH="$temporary/yuri/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$temporary/yuri/runtime/node" "$temporary/yuri/verify.mjs" "$version"
  mkdir -p "$install_dir/versions"
  mv "$temporary/yuri" "$target"
else
  LD_LIBRARY_PATH="$target/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$target/runtime/node" "$target/verify.mjs" "$version"
fi
if $link_bin; then
  mkdir -p "$bin_dir"
  ln -s "$install_dir/current/yuri" "$temporary/yuri-link"
  mv -Tf "$temporary/yuri-link" "$bin_dir/yuri"
fi
# The previous release remains intact. Only this symlink switches after verification.
ln -s "versions/$version-linux-$arch" "$temporary/current"
mv -Tf "$temporary/current" "$install_dir/current"
if $link_bin; then
  echo "Installed Yuri $version: $bin_dir/yuri"
  case ":${PATH:-}:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to PATH to run yuri from any directory." ;; esac
else
  echo "Installed Yuri $version: $install_dir/current/yuri"
fi
