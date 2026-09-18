# Part 82 — Configure reverse proxy, TLS, and network policy

**Status:** In Progress  
**Updated:** 2026-09-18

## Delivered Slice

- Replaced the production two-port web/API publication with one loopback-only
  Caddy gateway port, preserving host-only sessions by serving browser traffic
  from `APP_DOMAIN` alone.
- Added explicit routing for REST/tRPC, Better Auth, health and Socket.IO while
  preserving Next's `/api/shell/workspace` route and denying public `/metrics`
  and Bull Board access.
- Split production networking into an external-capable `edge` network and an
  internal data-service `backend` network. Only the API bridges both.
- Added a pinned derivative Caddy image that removes the unused
  `cap_net_bind_service` file capability so the gateway runs non-root with a
  read-only root filesystem, `no-new-privileges` and all runtime capabilities
  dropped.
- Added a bounded legacy `API_DOMAIN` drain path for existing deployments. New
  clients use one origin; already-loaded clients can retain their old host-only
  API session during cutover.
- Updated the production environment example and deployment runbook, including
  mandatory proxy-hop migration, version-aware rollback, internal metrics,
  custom-domain TLS gating and Cloudflare Tunnel forwarding.

## Verification

- Pinned gateway image build: passed.
- Caddy validation as UID 1000 with read-only root, tmpfs, `cap_drop: ALL` and
  `no-new-privileges`: passed.
- Hardened ephemeral routing checks: API, auth, health, WebSocket, web fallback,
  Next route ownership and legacy-host draining passed; metrics and Bull Board
  returned 404.
- Compose rendering and assertions: exactly one published port, same-origin
  public URLs, private backend network, expected network attachments, trusted
  metrics alias and proxy-hop default all passed.
- Scoped Prettier and `git diff --check`: passed.
- Independent operations/security review: no remaining critical or high finding.

## Remaining Acceptance Gates

Part 82 is not complete. A staging/production environment must still verify the
real HTTPS terminator, reputable TLS scan, browser login/cookie cutover,
long-lived WebSockets, allowed and oversized uploads, forwarded client IPs,
external port isolation, legacy rollback rehearsal and custom-domain certificate
flow if that feature is enabled. Parts 79–81 also have no completion records, so
their prerequisite acceptance cannot be inferred from existing files.
