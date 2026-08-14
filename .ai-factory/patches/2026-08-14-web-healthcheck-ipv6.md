# Web container unhealthy: healthcheck hits IPv6 ::1 and HTTPS redirect

**Date:** 2026-08-14
**Files:** `docker-compose.production.yml`
**Severity:** medium

## Problem

After deploying with `docker compose -f docker-compose.production.yml up`,
the `web` (Angie) container reported `unhealthy`. `curl http://localhost/health`
returned `301 Moved Permanently` (expected), but the healthcheck kept failing
with `wget: can't connect to remote host: Connection refused`.

## Root Cause

Two compounding issues in the old healthcheck
(`wget --spider -q http://localhost:80/health`):

1. **IPv6-first resolution.** BusyBox wget resolved `localhost` to `::1`
   (IPv6) first, but Angie listens on IPv4 only (`listen 80` / `0.0.0.0:80`).
   Connection to `[::1]:80` was refused, and busybox wget does not fall back
   to `127.0.0.1`. Same trap exists for any container process using
   `localhost` — inside a container `localhost` is not guaranteed to prefer
   IPv4.
2. **Redirect following.** Port 80 by design returns
   `301 https://$host$request_uri` (production forces HTTPS). wget followed the
   redirect to `https://localhost/health`, but the ACME client cannot obtain a
   Let's Encrypt certificate for `localhost` ("Domain name needs at least one
   dot"), so the 443 TLS handshake failed (curl exit 35).

The 301 itself was **not** the bug — it is the intended production behavior.

## Solution

Replaced the healthcheck with a netcat probe against IPv4 that accepts the
expected 301 as the healthy signal:

```yaml
healthcheck:
  test: ["CMD-SHELL", "printf 'GET /health HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | nc -w 2 127.0.0.1 80 | grep -q 'HTTP/1.1 301' || exit 1"]
```

- `127.0.0.1` avoids IPv6-first resolution.
- Checking for the `301` status line verifies Angie is alive AND serving the
  production (HTTPS-redirect) config — not just that a TCP port is open.
- `nc` is present in the angie Alpine image (`/usr/bin/nc`, busybox).
- BusyBox ash in this image does **not** support `/dev/tcp` — do not use it in
  healthchecks here.

## Prevention

- **Never use `localhost` in container healthchecks.** Use `127.0.0.1` — the
  process may resolve to IPv6 `::1` first and nothing listens there.
- **Never follow redirects in healthchecks.** In production configs, an
  expected redirect (301→HTTPS) is proof the server works. Probe and assert
  the expected status line instead of relying on `wget --spider` following
  the chain into TLS (which can fail for self-signed/ACME-less certs).
- When running the production compose locally with the default
  `DOMAIN=localhost`, HTTPS cannot have a real certificate (Let's Encrypt
  requires a dot) — that is expected; use a real domain for TLS deployments.
- After changing a healthcheck, verify with `docker compose ... up -d` and
  `docker inspect <container> --format "{{.State.Health}}"`.

## Tags

`#docker` `#healthcheck` `#ipv6` `#netcat` `#angie` `#reverse-proxy` `#tls` `#acme`
