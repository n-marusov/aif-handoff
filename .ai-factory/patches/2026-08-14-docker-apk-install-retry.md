# Docker web stage: apk install fails on transient Alpine CDN error

**Date:** 2026-08-14
**Files:** `.docker/Dockerfile`, `.docker/apk-install.sh`
**Severity:** medium

## Problem

`docker compose -f docker-compose.production.yml build` failed in the `web`
stage with:

```
WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.22/main: temporary error (try again later)
ERROR: unable to select packages:
  gettext (no such package):
    required by: world[gettext]
```

The error was misleading: `gettext` exists in Alpine 3.22 `main` (verified by
running `apk add --no-cache gettext` inside the image successfully). The build
had no way to retry, so a transient CDN failure aborted the whole production
build.

## Root Cause

The `web` stage used a bare `RUN apk add --no-cache gettext` with **no retry
logic**, while every other Docker stage used the resilient `apt-install`
wrapper that retries transient mirror/CDN failures (see the "Hash Sum
mismatch" incident documented in `apt-install.sh`). When `dl-cdn.alpinelinux.org`
intermittently refuses an index fetch, apk loads no index for the repo that
contains the requested package and reports "no such package" — a classic
transient-failure-masquerading-as-config-error.

Second finding: a NEW `RUN` failure surfaced during verification —
`/bin/sh: apk-install: not found` (exit 127) even though the file was copied to
`/usr/local/bin` and that dir is in `PATH`. Root cause: the script was written
with **CRLF line endings**. The shebang became `#!/bin/sh\r`, so the kernel
tried to exec `/bin/sh\r` (nonexistent) and reported "not found". The repo's
`.gitattributes` enforces `eol=lf`, so the committed version would have been LF
eventually, but Docker builds from the working-tree file, which was CRLF.

## Solution

1. Created `.docker/apk-install.sh` — a resilient `apk` wrapper mirroring the
   existing `apt-install.sh` pattern: up to 3 attempts with `sleep (attempt*5)`
   backoff, `--no-cache` so no stale index persists between attempts, and
   `rm -rf /var/cache/apk/*` before retrying.
2. Updated the `web` stage: `COPY .docker/apk-install.sh /usr/local/bin/apk-install`
   + `RUN chmod +x /usr/local/bin/apk-install && apk-install gettext`.
3. Converted the new script to **LF** line endings (`sed -i 's/\r$//'`) after
   writing it, because CRLF corrupts the shebang.

## Prevention

- **Any new shell script added for Docker builds must use LF line endings.**
  On Windows, verify with `od -c <file> | head` — the first line must end with
  `\n`, not `\r\n`. `.gitattributes` normalizes on commit, but the working tree
  is what Docker COPYs.
- **Never add bare `apk add` / `apt-get install` to a Dockerfile.** Use the
  wrappers (`apk-install` / `apt-install`) so transient CDN failures retry
  instead of aborting the build.
- **Verify with a real build after any Dockerfile change** (`docker compose -f
  docker-compose.production.yml build`), not just `docker build --check`.
  A failing RUN surfaces only when the layer actually executes.
- If the build fails with `parent snapshot ... does not exist: not found`
  during image export, it is BuildKit cache corruption — run
  `docker builder prune -af` and rebuild. Not a Dockerfile bug.

## Tags

`#docker` `#alpine` `#apk` `#line-endings` `#crlf` `#buildkit` `#transient-cdn` `#retry`
