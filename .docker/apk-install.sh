#!/bin/sh
# Resilient apk install wrapper for Docker builds.
#
# Handles transient Alpine mirror / CDN failures observed during build:
#   - `WARNING: fetching <repo>: temporary error (try again later)` on
#     dl-cdn.alpinelinux.org. When the index for the repo that contains the
#     requested package fails to load, apk reports a misleading
#     "unable to select packages: <pkg> (no such package)" even though the
#     package exists. A retry loop re-fetches the index on the next attempt.
#
# Runs with --no-cache so no index/cache is persisted between attempts, and
# the layer stays small. The built-in backoff avoids hammering the CDN.
set -eu

MAX_ATTEMPTS=3

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if apk add --no-cache "$@"; then
        exit 0
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
        echo "apk-install: failed after $MAX_ATTEMPTS attempts" >&2
        exit 1
    fi
    echo "apk-install: attempt $attempt/$MAX_ATTEMPTS failed; clearing index cache and retrying..." >&2
    rm -rf /var/cache/apk/*
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
done
