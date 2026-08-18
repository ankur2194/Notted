# ADR 0013 — Successful REST responses return the bare resource payload

## Status

Accepted (2026-08-19, Part 65/66 review round 2).

## Context

`Notted.md` (API design conventions, "Consistent response format:
`{ success: boolean, data?: T, error?: string }`") reads as mandating one envelope
for every `/api/v1` response. What the codebase has actually shipped since the
first REST controllers is asymmetric:

- **Errors** are enveloped by the global `ApiExceptionFilter`:
  `{ "success": false, "error": { "code", "message", "details?" }, "requestId" }`.
- **Successes** return the resource payload directly — `{ items, page, limit, hasMore }`
  for lists, the resource object for reads and creates. Every REST controller, the
  entire `apps/web` client (`request-json.ts` and all `lib/*/requests.ts` parsers),
  the shared `*PageSchema`/`*ResultSchema` validators, and the generated
  `docs/openapi.json` all encode this bare shape. The lone exception is the
  hand-written `GET /api/v1` root route.

Part 65's public-API documentation initially restated the `Notted.md` envelope,
and six new e2e assertions followed the documentation instead of the runtime —
the round-2 review caught the divergence as a blocking finding.

## Decision

Successful `/api/v1` responses return the **bare resource payload**. Only errors
carry the `{success:false, error, requestId}` envelope. The request correlation id
travels in the `X-Request-Id` response header, which is present on every response.

`Notted.md`'s envelope line is interpreted as satisfied by this asymmetric contract:
responses are consistent (one shape per outcome class), the discriminator is the
HTTP status code, and `success: true` plus a `data` wrapper add no information a
client uses.

## Consequences

- Retrofitting the success envelope would touch every REST controller (or add a
  global interceptor), the OpenAPI generator, and every first-party web request
  parser, for no functional gain — rejected.
- `docs/API.md` documents the bare success shape and the error envelope
  explicitly; `docs/openapi.json` already matched the runtime and is unchanged.
- Integration/e2e tests assert `response.body` directly for successes and
  `response.body.error.code` for failures.
- The `GET /api/v1` root route keeps its historical hand-built envelope; it is a
  liveness/identity probe, not a resource endpoint.
