# Self-contained Linux CLI

This distribution retains the existing Node server architecture. `yuri` is a
symlink-aware shell launcher; it executes `runtime/node` directly without putting
that private Node on PATH. Child servers, IPC workers and session skill helpers
inherit `process.execPath`. `bin/opencode` is a native OpenCode executable.
The launcher and its daemon retain the explicit `yuri` process title, so the
existing PID-identity check does not depend on the extraction directory's name.
systemd startup uses the installer-owned `current/yuri` launcher when available,
including its private-library setup; manual extractions use their own launcher.

`build.mjs` copies the installed production dependency graph, preserving nested
versions, peers, optional native packages and runtime assets with internal relative
symlinks. It never resolves new versions or modifies the source installation.
Build dependencies/native compilation belong to CI, not installation. The package
contains Node's license, dependency licenses, GCC runtime libraries/copyright and
the prebuilt front end/LLM bridge. Speech model downloads remain on demand.

Build natively for x64 or arm64 through `Dockerfile` (Node 24 on Debian 12):

```sh
docker build -f packages/web/scripts/portable/Dockerfile \
  --target artifacts --output type=local,dest=packages/web/portable-dist .
```

`bun run pack:portable` only assembles an already-built checkout on compatible
Linux, with matching Node native bindings and GCC runtime files. The Docker path
is the reproducible build/verification boundary. No dependencies are added to the
repository. glibc 2.36+ and a supported Linux kernel are required; Alpine/musl is
explicitly unsupported. Other OS/CPU combinations retain npm installation.

Artifacts are `yuri-<version>-linux-{x64,arm64}.tar.gz` and per-file SHA-256 sums.
The final build stage runs in a slim Linux image without system Node, npm,
Python or a compiler: SQLite read, real PTY execution, speech addon loading,
CLI/OpenCode versions, assets, daemon start/status/stop, HTTP health, browser
entrypoint and upstream OpenCode readiness must pass before export.

`bin/install-portable.sh` downloads and verifies the exact release, runs its
preflight, then atomically switches `<install-dir>/current`. Old version
directories are retained. Download/checksum/preflight failure leaves `current`
untouched. A directory lock rejects concurrent installs; an interrupted install
may require operator recovery of `.install-lock`. Existing unrelated `yuri`
commands are never overwritten. The installer does not edit shell profiles or
install system packages. Downloads require HTTPS, curl or wget, tar, and a
SHA-256 utility; no Node/npm/Python/compiler is used on the target.

SSH `download_release` uses this same packaged installer and keeps the executable
binding in `ssh-runtime.sh`. New UI- and session-skill-created SSH entries select it; stored npm/bun
choices retain their old behavior. SSH version alignment drains managed daemons
before replacing the selected release. Portable native failures are errors,
never automatic target-side rebuilds. SSH bundle upload is not implemented.

Portable installations are not npm-owned. `yuri update` fails before stopping
anything and points to the bundled installer. HTTP Host self-update is supported
only for installer-managed layouts (`versions/<release>` plus `current`): the
host-update helper runs this same `install.sh --no-link` for the exact planned
release (archive checksum bound at plan time), then restarts through
`current/yuri`. Manual extractions report unsupported; stop the Host and run the
installer, or reconnect from the updated desktop to align the SSH Host. There is
no second download protocol and no automatic rollback of database/state changes.
Existing global npm updates are unchanged.
