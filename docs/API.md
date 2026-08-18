# Public REST API

Notted exposes one public integration surface: the versioned REST API under `/api/v1`. The
same NestJS controllers, application services, and authorization policies serve both the
first-party web client and third-party integrations — there is no separate, parallel
"public" implementation that can drift from the product (ADR 0002).

`/api/v1/trpc` is the typed transport for Notted's own web client and is **not** part of
this contract. Its procedures may change without notice, and an API-key credential
presented there is rejected with `403 FORBIDDEN` rather than silently ignored.

Related documents: [`authorization.md`](authorization.md) for the role and policy model,
[`environment.md`](environment.md) for the server-side limits named here, and
[`standards/api.md`](standards/api.md) for the rules every endpoint is held to.

## Base URL and versioning

| Item | Value |
|---|---|
| Base URL | `https://<api-host>/api/v1` |
| Version selector | The `api/v1` path prefix only. There is no version header or query parameter. |
| Unversioned routes | `GET /health/live` and `GET /health/ready` sit outside the prefix and are operational, not part of this contract. |
| Authentication mount | Better Auth is mounted outside the versioned API at `/api/auth` (browser sessions only). |

`v1` is additive-stable: new endpoints, new optional request fields, and new response
fields may appear at any time. Removing an endpoint or field, tightening validation, or
changing an existing field's meaning is a breaking change and requires a new version path.
Clients must ignore unknown response fields and must not depend on JSON key order.

Breaking REST changes are recorded in the OpenAPI documents and in the part completion
record for the change.

## Authentication

Every `/api/v1` request must present exactly one credential.

| Credential | Header | Intended caller |
|---|---|---|
| API key | `Authorization: Bearer ntd_pk_<32 characters>` | Server-side integrations, scripts, automation |
| Session cookie | The credentialed cookie issued by Better Auth | The first-party browser client |

An unauthenticated request to an authenticated route returns `401 UNAUTHENTICATED`.

### API keys

A key is a workspace-scoped machine credential. Its wire format is the literal prefix
`ntd_pk_` followed by 32 base64url characters encoding 24 random bytes — 192 bits of
entropy.

The server stores only an HMAC-SHA256 hash of the secret and an eight-character display
prefix (`ntd_pk_` plus the first secret character). **The full secret is returned exactly
once, by the create call, and is never retrievable afterwards.** A lost key is replaced,
not recovered.

Unknown, revoked, and expired keys are indistinguishable: all three return the same
`401 UNAUTHENTICATED` with the message `The API key is invalid.` There is no response,
status, or message difference to enumerate against. A `Bearer` value that does not match
the Notted wire format is treated as somebody else's credential and causes no database
lookup at all.

`lastUsedAt` is refreshed on use, throttled to at most one write per key per minute, so it
is a coarse activity signal rather than a precise timestamp.

The hash is peppered with the server's `BETTER_AUTH_SECRET`. **Rotating that secret
invalidates every issued API key** — see
[`environment.md`](environment.md#better_auth_secret-is-also-the-api-key-pepper).

### Session cookies and mutation origin

Cookie-authenticated mutations must send an `Origin` header that matches a trusted origin,
or they are refused with `403 CSRF_ORIGIN_INVALID`. API-key requests are exempt: no browser
attaches a bearer token cross-site, and integrations send no `Origin`, so the check would
reject every legitimate integration mutation without adding protection.

## Scopes

A key carries one or more scopes. `scopes` defaults to `["read", "write"]` when the create
call omits it; the array must be non-empty, duplicate-free, and drawn from this set.

| Scope | Grants |
|---|---|
| `read` | Every `*.read` and `*.list` action, plus `export.download`. |
| `write` | Every remaining non-admin action — create, update, delete, move, restore, upload, share, tag, resolve, cancel. |
| `admin` | Every `member.*`, `settings.*`, `billing.*`, `apiKey.*`, and `webhook.*` action, plus `workspace.delete`. Implies `read` and `write`. |

The admin group is evaluated first, so an administrative listing such as `member.list` or
`apiKey.list` requires `admin` even though it is a list action. A `read`/`write` key
therefore cannot mint itself a wider key.

A scope check that fails returns `403 FORBIDDEN`.

## Effective permission: scope ∩ creator's live role

An authenticated key acts as the user who created it. Its effective permission is the
**intersection** of two independently enforced checks:

1. **Key scope** — decided by the shared authorization policy, from the scopes stored on
   the key row.
2. **The creator's current workspace role** — enforced unchanged by the same application
   services that serve session-authenticated requests, against live membership rather than
   anything captured when the key was minted.

Both must allow the action. The consequences are deliberate:

- Demoting the creator immediately narrows every key they created. Removing them from the
  workspace closes those keys entirely. Neither requires a revocation sweep.
- A key can never exceed its creator's role, however wide its scopes are. An `admin`-scoped
  key created by an editor still cannot manage members.
- Nothing about the key is cached between requests, so a revocation takes effect on the
  very next call.

Key identity is never converted into workspace membership, and the key's own workspace is
taken from its stored row, never from a header or a path the caller supplies.

## Reachable routes

**Guarantee: an API key can reach only workspace-scoped, policy-checked routes.** A
default-deny global guard inspects every API-key request; if the handler carries no
authorization specification, the request is refused with `403 FORBIDDEN` rather than
admitted. This holds for routes added in future parts without any further wiring.

Account-level and unscoped routes are consequently outside the key surface, including
Better Auth's `/api/auth/*`, the session and security routes under `/api/v1/auth/*`, the
application shell bootstrap, workspace creation and the cross-workspace workspace list,
invitation acceptance, and the health probes. Use a session for those.

A `read`-only key may use only safe HTTP methods. `POST`, `PUT`, `PATCH` and `DELETE` are
refused with `403 FORBIDDEN` for a key holding neither `write` nor `admin`, whatever the
route is — a scope check that does not depend on any individual route being labelled
correctly.

**High-risk actions are closed to API keys entirely.** `billing.update`, `workspace.delete`,
`member.update`, `member.remove`, `apiKey.create`, `apiKey.revoke`, `webhook.create`,
`webhook.update`, `webhook.delete` and `session.revoke` require *recent* authentication, and
a machine credential is never recently authenticated. They answer
`403 RECENT_AUTHENTICATION_REQUIRED` for every API key, however wide its scope, and for a
session whose sign-in is no longer fresh. The deliberate consequence: **a stolen key cannot
mint a successor key, revoke anything, change membership, or point a webhook somewhere new.**
Use an interactive session for those operations.

## Requests and responses

### Response shapes

**Successful responses return the resource payload directly** — a list endpoint answers
`{ "items": [...], "page": 1, "limit": 25, "hasMore": false }`, a create answers the created
resource, and so on, with no wrapper (ADR 0013). The request correlation id is carried by the
`X-Request-Id` response header and is the value to quote in a support request.

**Errors alone use an envelope:**

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." }, "requestId": "..." }
```

Validation failures add `error.details`, an array of `{ path, code, message }` issues.
Binary responses — attachment content, export downloads — stream the object instead and use
the envelope only for errors.

Request bodies are `application/json` and are strictly validated: unknown properties are
rejected rather than ignored. Bodies larger than `REQUEST_BODY_LIMIT_BYTES` return
`413 PAYLOAD_TOO_LARGE`.

### Pagination, filtering, and sorting

Paginated collections share one contract.

| Parameter | Type | Rule |
|---|---|---|
| `page` | integer | Minimum `1`, maximum `10000`. Defaults to `1`. |
| `limit` | integer | Minimum `1`, maximum `100`. Defaults to `25`. |
| `sortBy` | enum | An explicit per-resource allow-list. Never a free-form column name. |
| `sortDirection` | enum | `asc` or `desc`. |

Paginated responses are `{ items, page, limit, hasMore }`. There is no total count: `hasMore`
is what advances the cursor, and clients must stop on `hasMore: false` rather than probing
past the end.

Boolean query parameters are the literal strings `"true"` and `"false"`. Any other value —
including `1`, `yes`, or an empty value — is a validation error rather than a silent
`false`. Numeric query parameters accept a base-10 non-negative integer string.

Filters and sorts are explicit and allow-listed per resource. Sending an unsupported
`sortBy` is a validation error, never a silently ignored parameter.

### Idempotency

Retryable side-effecting mutations require an `Idempotency-Key` request header.

| Rule | Value |
|---|---|
| Length | 16–128 characters |
| Alphabet | `A`–`Z`, `a`–`z`, `0`–`9`, and `.` `_` `:` `-` |
| Retention | 24 hours, scoped to the acting user and the operation |
| Missing or malformed on a route that requires one | `400 IDEMPOTENCY_KEY_REQUIRED` |
| Reused with a different request payload | `409 IDEMPOTENCY_KEY_REUSED` |

Generate a fresh key per logical operation — a UUID is a good default — and reuse it
verbatim when retrying that same operation after a timeout or a `5xx`.

One deliberate exception: replaying an API-key **create** returns
`409 IDEMPOTENT_RESULT_UNAVAILABLE`. The secret exists only in the original response, so a
replay would otherwise hand back a key record whose credential the caller can never obtain.
Failing loudly is the correct answer; treat it as "the first call succeeded, go read the
key list".

### Rate limits

Four independent token buckets, each refilling continuously over a one-minute window. The
buckets are keyed disjointly, so draining one never affects another.

| Tier | Bucket key | Environment variable | Default |
|---|---|---|---|
| Unauthenticated | Client IP | `RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE` | 60 |
| Authenticated user | User ID | `RATE_LIMIT_AUTHENTICATED_PER_MINUTE` | 1000 |
| API key | Key ID | `RATE_LIMIT_API_KEY_PER_MINUTE` | 100 |
| Sensitive routes | Caller plus route tier | `RATE_LIMIT_SENSITIVE_PER_MINUTE` | 10 |

The API-key tier is per key, not per workspace or per creator: two keys in one workspace
have independent allowances, and a noisy integration cannot exhaust the interactive limit
its creator's browser session uses.

The sensitive tier is a separate bucket layered on top of the caller's general one, applied
per route to high-value mutations such as API-key creation. A caller already at their
general limit is still not granted extra sensitive capacity, and sensitive traffic does not
consume the general allowance.

Every response carries `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`
(seconds until the bucket refills). Exceeding a limit returns `429 RATE_LIMITED` with a
`Retry-After` header in seconds. Honour it; do not retry on a fixed interval.

## Errors

`error.code` is a stable, closed union — match on it rather than on `error.message`, which
is human-facing and may be reworded. Messages never contain SQL, provider detail, stack
traces, credentials, object keys, or signed URLs.

| Code | Typical status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | The request is malformed. |
| `VALIDATION_ERROR` | 400/422 | Input failed schema validation; see `error.details`. |
| `UNAUTHENTICATED` | 401 | No credential, or an invalid/revoked/expired API key. |
| `FORBIDDEN` | 403 | Authenticated, but the scope or role does not allow this action. |
| `CSRF_ORIGIN_INVALID` | 403 | A cookie-authenticated mutation carried an untrusted `Origin`. |
| `RECENT_AUTHENTICATION_REQUIRED` | 403 | A high-risk action needs a freshly authenticated session. |
| `CURRENT_SESSION_NOT_REMOTE` | 403 | A session operation targeted the caller's own current session. |
| `NOT_FOUND` | 404 | The resource does not exist, or is not visible to this caller. |
| `CONFLICT` | 409 | The request conflicts with current state. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | The route requires a valid `Idempotency-Key`. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | The key was already used for a different payload. |
| `IDEMPOTENT_RESULT_UNAVAILABLE` | 409 | The original result cannot be replayed (see above). |
| `VERSION_CONFLICT` | 409 | The resource changed since the version the request supplied. |
| `NOTE_STATE_CONFLICT` | 409 | The note is not in a state that allows this operation. |
| `NOTE_ANCESTOR_DELETED` | 409 | An ancestor of the note is deleted. |
| `NOTE_SUBTREE_ACTIVE` | 409 | The note still has active descendants. |
| `NOTE_HIERARCHY_INVALID` | 422 | The requested note parent or move is not a valid hierarchy. |
| `NOTE_SHARE_SELF_DENIED` | 422 | A note cannot be shared with its own actor. |
| `TASK_HIERARCHY_INVALID` | 422 | The requested task parent is not a valid hierarchy. |
| `TASK_RECURRENCE_INVALID` | 422 | The recurrence rule is not valid. |
| `FOLDER_HIERARCHY_INVALID` | 422 | The requested folder parent is not a valid hierarchy. |
| `FOLDER_DEPTH_EXCEEDED` | 422 | The folder tree would exceed its depth bound. |
| `TAG_NAME_TAKEN` | 409 | Another tag in the workspace already uses that name. |
| `TAG_LIMIT_REACHED` | 409 | The workspace or entity tag limit is reached. |
| `ORDER_CONFLICT` | 409 | A concurrent reorder invalidated the requested position. |
| `EXPORT_EXPIRED` | 409/422 | The export artifact has passed its retention window. |
| `EXPORT_OBJECT_UNAVAILABLE` | 409/422 | The export record exists but its object cannot be served. |
| `EXPORT_FORMAT_UNSUPPORTED` | 409/422 | The requested export format is not available for that source. |
| `WEBHOOK_URL_REJECTED` | 422 | The webhook destination is not an allowed delivery address. |
| `WEBHOOK_NOT_VERIFIED` | 409 | The webhook endpoint must pass verification before it can be enabled. |
| `WEBHOOK_VERIFICATION_FAILED` | 422 | The endpoint did not echo the verification challenge. |
| `PAYLOAD_TOO_LARGE` | 413 | The request body or upload exceeds the configured limit. |
| `UNPROCESSABLE_ENTITY` | 422 | Well-formed but semantically rejected. |
| `RATE_LIMITED` | 429 | A rate-limit bucket is empty; see `Retry-After`. |
| `REQUEST_FAILED` | 4xx/5xx | A request-level failure with no more specific code. |
| `INTERNAL_SERVER_ERROR` | 500 | An unexpected server fault. |
| `SERVICE_UNAVAILABLE` | 503 | A dependency the request needs is unavailable. |

### 404 instead of 403 across workspaces

A resource that belongs to a different workspace answers **`404 NOT_FOUND`, never `403`** —
at both the policy layer and the service layer, and identically for a resource that does not
exist at all, a random UUID, and a UUID-shaped probe.

This is a deliberate contract, not an implementation accident. `403` would confirm that an
identifier is real, turning the API into an existence oracle for tenants the caller cannot
see. `403` is reserved for the case where the caller can already see the resource but is not
allowed to perform the action on it. Do not treat a `404` as proof that an identifier is
invalid; it may simply be outside your reach.

## Machine-readable specification

| Document | Location |
|---|---|
| Committed specification | [`openapi.json`](openapi.json) |
| Live specification | `GET /api/v1/openapi.json` |

Both are produced by the same builder from the same route metadata, so the committed file
and the running server cannot describe different APIs. Generate clients from either.

## Resources

Each resource below is documented in one shape: an endpoint table, then any query or body
notes, then an example where the resource has a non-obvious call. Paths are relative to the
`/api/v1` base URL. The **Scope** column is the API-key scope required; a session-
authenticated caller needs the equivalent workspace role from
[`authorization.md`](authorization.md) instead. Every path parameter is a UUID.

<!-- Extension point: a new public resource is one more `###` subsection here, in the same
     endpoint-table → notes → example shape. Nothing above this heading needs to change. -->

### API keys

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/api-keys` | `admin` | List the workspace's keys |
| `POST` | `/workspaces/{workspaceId}/api-keys` | `admin` | Mint a key; returns the secret once |
| `DELETE` | `/workspaces/{workspaceId}/api-keys/{apiKeyId}` | `admin` | Revoke a key |

List query parameters: `page`, `limit`, `includeRevoked` (`"true"`/`"false"`, default
`false`), `sortBy` (`createdAt` | `lastUsedAt` | `name`, default `createdAt`), and
`sortDirection` (default `desc`). Revoked keys are hidden by default because the usual
administrative question is "what can reach my workspace right now".

**`POST` and `DELETE` here are unreachable with an API key** — both are high-risk actions,
so they answer `403 RECENT_AUTHENTICATION_REQUIRED` to any bearer credential. Key management
is an interactive, freshly-authenticated operation; the `GET` is available to an `admin` key.

Create body: `{ "name": string(1..100), "scopes"?: ["read"|"write"|"admin"], "expiresAt"?:
ISO-8601 }`. `expiresAt` must be in the future. `scopes` defaults to `["read", "write"]`.
The call returns `201` with `{ "apiKey": { … }, "secret": "ntd_pk_…" }` and requires an
`Idempotency-Key`; it is also on the sensitive rate-limit tier. `secret` appears in this
response and nowhere else.

Revoke returns `{ "apiKeyId": …, "revoked": true }`. Re-revoking an already-revoked key is
an idempotent success; a key that does not exist in this workspace is `404`.

No response, log line, or audit row ever contains the secret or its hash — only the
`keyPrefix` display fragment, which cannot authenticate on its own.

```bash
# List the first page of active keys.
curl -sS https://api.example.com/api/v1/workspaces/$WORKSPACE_ID/api-keys \
  -H "Authorization: Bearer ntd_pk_EXAMPLEKEYEXAMPLEKEYEXAMPLEKEY00"

# Mint a read-only key. Store `secret` from the response immediately; it is never returned again.
# NOTE: a freshly authenticated SESSION cookie, not a bearer key — see above.
curl -sS -X POST https://api.example.com/api/v1/workspaces/$WORKSPACE_ID/api-keys \
  -H "Cookie: $SESSION_COOKIE" \
  -H "Origin: https://app.example.com" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"reporting-export","scopes":["read"]}'
```

### Workspaces

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{id}` | `read` | Read one workspace |
| `PATCH` | `/workspaces/{id}` | `admin` | Update workspace settings |
| `DELETE` | `/workspaces/{id}` | `admin` | Delete the workspace |

Creating a workspace and listing the workspaces a user belongs to are account-level
operations with no workspace to scope to, so they are session-only and unreachable by an API
key. Workspace deletion also requires recent authentication for session callers.

### Members and invitations

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/members` | `admin` | List members |
| `PATCH` | `/workspaces/{workspaceId}/members/{memberId}` | `admin` | Change a member's role |
| `DELETE` | `/workspaces/{workspaceId}/members/{memberId}` | `admin` | Remove a member |
| `POST` | `/workspaces/{workspaceId}/members/leave` | `admin` | Leave the workspace |
| `GET` | `/workspaces/{workspaceId}/invitations` | `admin` | List pending invitations |
| `POST` | `/workspaces/{workspaceId}/invitations` | `admin` | Invite a member |
| `POST` | `/workspaces/{workspaceId}/invitations/{invitationId}/resend` | `admin` | Resend an invitation |
| `DELETE` | `/workspaces/{workspaceId}/invitations/{invitationId}` | `admin` | Revoke an invitation |

Accepting an invitation is an account-level route with no prior workspace membership, so it
is session-only. An admin cannot modify or remove an owner; only an owner can.

### Projects

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/projects` | `read` | List projects |
| `POST` | `/workspaces/{workspaceId}/projects` | `write` | Create a project |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}` | `read` | Read one project |
| `PATCH` | `/workspaces/{workspaceId}/projects/{projectId}` | `write` | Update a project |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/archive` | `write` | Archive |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/complete` | `write` | Mark complete |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/restore` | `write` | Restore |
| `DELETE` | `/workspaces/{workspaceId}/projects/{projectId}` | `write` | Delete |

A project with any explicit access grant is restricted: it is visible only to owners,
admins, and holders of a grant. Restricted projects that the caller cannot reach answer
`404`.

### Notes

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/notes` | `read` | List notes |
| `POST` | `/workspaces/{workspaceId}/notes` | `write` | Create a note |
| `GET` | `/workspaces/{workspaceId}/notes/navigation` | `read` | Navigation tree |
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}` | `read` | Read one note |
| `PATCH` | `/workspaces/{workspaceId}/notes/{noteId}` | `write` | Update a note |
| `DELETE` | `/workspaces/{workspaceId}/notes/{noteId}` | `write` | Soft-delete a note |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/move` | `write` | Move within the tree |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/copy` | `read` | Copy a note |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/restore` | `write` | Restore from trash |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/permanent-delete` | `write` | Delete permanently |
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}/versions` | `read` | List versions |
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}` | `read` | Read one version |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}/restore` | `write` | Restore a version |

Note content is TipTap JSON. Hierarchy operations reject cycles and over-deep trees with
`NOTE_HIERARCHY_INVALID`, and operate against server-held ancestry rather than any parent
chain the client supplies.

### Note shares

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}/shares` | `write` | List a note's shares |
| `PUT` | `/workspaces/{workspaceId}/notes/{noteId}/shares/{userId}` | `write` | Grant or update a share |
| `DELETE` | `/workspaces/{workspaceId}/notes/{noteId}/shares/{userId}` | `write` | Remove a share |

The share target must be a current member of the same workspace, and a share can never
grant more access than the note's project already permits.

### Folders

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/folders` | `read` | List folders |
| `POST` | `/workspaces/{workspaceId}/folders` | `write` | Create a folder |
| `PATCH` | `/workspaces/{workspaceId}/folders/{folderId}` | `write` | Rename or move |
| `DELETE` | `/workspaces/{workspaceId}/folders/{folderId}` | `write` | Delete a folder |

Invalid parents return `FOLDER_HIERARCHY_INVALID`; exceeding the depth bound returns
`FOLDER_DEPTH_EXCEEDED`.

### Tasks

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/tasks` | `read` | List tasks |
| `POST` | `/workspaces/{workspaceId}/tasks` | `write` | Create a task |
| `POST` | `/workspaces/{workspaceId}/tasks/bulk` | `read` | Bulk read |
| `GET` | `/workspaces/{workspaceId}/tasks/{taskId}` | `read` | Read one task |
| `PATCH` | `/workspaces/{workspaceId}/tasks/{taskId}` | `write` | Update a task |
| `POST` | `/workspaces/{workspaceId}/tasks/{taskId}/reorder` | `write` | Reposition a task |
| `DELETE` | `/workspaces/{workspaceId}/tasks/{taskId}` | `write` | Delete a task |

Reordering is optimistic: a concurrent reorder returns `ORDER_CONFLICT`, and the client
should re-read the list rather than retry blindly. Invalid recurrence rules return
`TASK_RECURRENCE_INVALID`.

### Task statuses

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/task-statuses` | `read` | List statuses |
| `POST` | `/workspaces/{workspaceId}/task-statuses` | `admin` | Create a status |
| `PATCH` | `/workspaces/{workspaceId}/task-statuses/{statusId}` | `admin` | Update a status |
| `DELETE` | `/workspaces/{workspaceId}/task-statuses/{statusId}` | `admin` | Delete a status |

The status set is workspace configuration, so changing it is a `settings.update` action and
requires the `admin` scope even though the rows look like ordinary content.

### Tags

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/tags` | `read` | List tags |
| `POST` | `/workspaces/{workspaceId}/tags` | `write` | Create a tag |
| `PATCH` | `/workspaces/{workspaceId}/tags/{tagId}` | `write` | Rename or recolour |
| `DELETE` | `/workspaces/{workspaceId}/tags/{tagId}` | `write` | Delete a tag |

Tag names are unique per workspace (`TAG_NAME_TAKEN`). A single note or task accepts at most
50 unique tag identifiers; workspace and entity limits return `TAG_LIMIT_REACHED`.

### Comments

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}/comments` | `read` | List a note's comments |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/comments` | `write` | Create a comment |
| `PATCH` | `/workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}` | `write` | Edit a comment |
| `DELETE` | `/workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}` | `write` | Delete a comment |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}/resolution` | `write` | Resolve or reopen |

Comments are loaded through their note, so a comment identifier from another note or another
workspace answers `404`.

### Attachments

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/notes/{noteId}/attachments` | `read` | List a note's attachments |
| `POST` | `/workspaces/{workspaceId}/notes/{noteId}/attachments` | `write` | Upload an attachment |
| `GET` | `/workspaces/{workspaceId}/attachments/{attachmentId}/content` | `read` | Download content |
| `DELETE` | `/workspaces/{workspaceId}/attachments/{attachmentId}` | `write` | Delete an attachment |

Object storage is private: content is always served through this authorized route, never
from a public bucket URL. Object keys are never authority on their own — the database lookup
decides. Oversized uploads return `413 PAYLOAD_TOO_LARGE`.

### Search

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/search` | `read` | Full-text, semantic, or hybrid search |
| `GET` | `/workspaces/{workspaceId}/search/suggestions` | `read` | Query suggestions |

Results are filtered by the caller's own read permission before they are returned, so search
never reveals a note the caller could not open directly.

### Exports

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/workspaces/{workspaceId}/exports` | `write` | Request an export |
| `GET` | `/workspaces/{workspaceId}/exports` | `read` | List export records |
| `GET` | `/workspaces/{workspaceId}/exports/{exportId}` | `read` | Read one export record |
| `POST` | `/workspaces/{workspaceId}/exports/{exportId}/cancel` | `write` | Cancel a running export |
| `GET` | `/workspaces/{workspaceId}/exports/{exportId}/download` | `read` | Download the artifact |

Exports are asynchronous: create returns a record, then poll it until the state is terminal
before downloading. `export.download` is deliberately a `read`-scope action, so a read-only
integration can retrieve an artifact an operator produced. Artifacts expire
(`EXPORT_EXPIRED`); an unsupported source/format pair returns `EXPORT_FORMAT_UNSUPPORTED`.

### Notifications

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/notifications` | `read` | List notifications |
| `PATCH` | `/workspaces/{workspaceId}/notifications/{notificationId}` | `read` | Mark one read/unread |
| `POST` | `/workspaces/{workspaceId}/notifications/read-all` | `read` | Mark all read |
| `GET` | `/workspaces/{workspaceId}/notifications/email-preference` | `read` | Read email preference |
| `POST` | `/workspaces/{workspaceId}/notifications/email-preference` | `read` | Update email preference |

Notifications belong to a user, not a workspace at large. Under an API key they resolve to
the key's creator, so a key reads and mutates only that user's notifications.

### Storage

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/storage` | `read` | Read storage usage and quota |
| `POST` | `/workspaces/{workspaceId}/storage/maintenance` | `admin` | Run storage maintenance |

Maintenance is a `settings.update` action: it reclaims orphaned objects and is administrative
rather than a content operation.

### Webhooks

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/workspaces/{workspaceId}/webhooks` | `admin` | List endpoints |
| `POST` | `/workspaces/{workspaceId}/webhooks` | `admin` | Register an endpoint; returns the secret once |
| `PATCH` | `/workspaces/{workspaceId}/webhooks/{webhookId}` | `admin` | Update URL, events, or enablement |
| `DELETE` | `/workspaces/{workspaceId}/webhooks/{webhookId}` | `admin` | Delete an endpoint |
| `POST` | `/workspaces/{workspaceId}/webhooks/{webhookId}/rotate-secret` | `admin` | Rotate the signing secret; returns it once |
| `POST` | `/workspaces/{workspaceId}/webhooks/{webhookId}/verify` | `admin` | Send the verification challenge |
| `GET` | `/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries` | `admin` | List delivery attempts |
| `POST` | `/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries/{deliveryId}/retry` | `admin` | Replay a recorded delivery |

Every `webhook.*` action is administrative: it requires the `admin` scope and an owner or
admin role. Create, update, delete, rotate-secret and verify are additionally high-risk, so
they need a freshly authenticated session and are **unreachable with an API key** — only the
endpoint list, the delivery list and the delivery replay are available to an `admin` key.
Editors and viewers are denied outright. Create and verify are on the
sensitive rate-limit tier — each one makes the server dial an address the caller chose.

List query parameters are `page` and `limit`. The delivery list adds `status`
(`pending` | `success` | `failed` | `retrying`) and is ordered newest attempt first.

#### Event catalog

Five events can be subscribed to. An endpoint's `events` array must be non-empty and
duplicate-free.

| Event | Fires when |
|---|---|
| `note.created` | A note is created |
| `note.updated` | A note is updated |
| `note.deleted` | A note is soft-deleted |
| `project.created` | A project is created |
| `member.joined` | A member joins the workspace |

`webhook.verification` is **not** a subscribable event. It is sent only by the verify route,
to one endpoint, on demand; it can never be fanned out and cannot appear in an `events`
array.

#### Payload

Every delivery is a `POST` with an `application/json` body in one shape:

```json
{
  "id": "<eventId>",
  "event": "note.created",
  "occurredAt": "2026-08-18T09:41:07.412Z",
  "workspaceId": "…",
  "actorId": "…|null",
  "data": { }
}
```

`actorId` is `null` when the change had no acting user. **The key order above is part of the
signed bytes** — verify the signature against the body exactly as received (see below)
rather than against anything you re-serialize.

`data` is a fixed object per event:

| Event | `data` fields |
|---|---|
| `note.created`, `note.updated`, `note.deleted` | `id`, `title`, `projectId`, `folderId`, `parentId`, `isArchived`, `isDeleted`, `updatedAt` |
| `project.created` | `id`, `name`, `status`, `isArchived`, `updatedAt` |
| `member.joined` | `membershipId`, `userId`, `role`, `joinedAt` |
| `webhook.verification` | `challenge` |

**Payloads carry identifiers and cheap metadata only — never note content, never an email
address, never a person's name.** A note's `title` and a project's `name` are the one
human-readable field each, because without them a delivery is illegible; the note body is
never sent, and `member.joined` carries identifiers and a role, nothing else. An integrator
who needs more must call this REST API with the identifiers, on its own credential and
under its own permissions.

Payload fields are re-read from the database at delivery time and the endpoint creator's
live permission on the resource is re-checked, so an endpoint whose creator has lost access
to a restricted project stops receiving that project's notes with no other action.

#### Headers

| Header | Purpose |
|---|---|
| `content-type` | Always `application/json` |
| `user-agent` | Always `Notted-Webhook/1`, so our traffic can be filtered |
| `x-notted-event` | The event name, matching `event` in the body |
| `x-notted-event-id` | **The idempotency key.** Stable across every retry *and* across a manual replay — deduplicate on this |
| `x-notted-delivery-id` | Unique per attempt; matches the delivery-log row id |
| `x-notted-timestamp` | Unix **seconds** at signing time, the same value signed into the signature |
| `x-notted-signature` | `t=<unix seconds>,v1=<lowercase hex>` |

#### Verifying the signature

The canonical signed string is exactly `` `${timestamp}.${rawBody}` `` — the timestamp in
unix **seconds**, and `rawBody` the exact bytes received. The MAC is HMAC-SHA256 under the
endpoint's signing secret, encoded as lowercase hex in the header's `v1=` field.

Verify **before** parsing. Parsing and re-serializing JSON changes whitespace and key order,
which changes the bytes, which changes the MAC.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

// `rawBody` must be the unparsed request body — a Buffer or the exact string.
export function verifyNottedWebhook(secret, header, rawBody) {
  const match = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/.exec(String(header).trim());
  if (match === null) return false;

  const timestamp = Number(match[1]);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest();
  const presented = Buffer.from(match[2], "hex");
  // `timingSafeEqual` throws on a length mismatch, so lengths are checked first,
  // and a plain `===` would leak how much of a candidate signature is correct.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
```

**Timestamp tolerance is the receiver's responsibility.** Notted signs the timestamp and
recommends a 300-second window, but does not enforce one on outbound deliveries: a queued
retry is legitimately minutes old, and refusing to send it would turn a backlog into dropped
events. Choose your own window and reject anything outside it.

#### Retry and backoff

Delivery is asynchronous and gets **exactly 5 attempts** per (endpoint × event) — the first
send plus four retries — on bounded exponential backoff with jitter (roughly 1s, 2s, 4s, 8s,
each ± jitter and capped by the runtime's maximum). **Each endpoint carries its own
independent budget**, so one dead receiver never delays or consumes another's.

| Outcome | Treatment |
|---|---|
| `2xx` | Success |
| `5xx`, `408`, `429` | Retried |
| Timeout, connection failure, DNS failure, TLS or certificate failure | Retried |
| Any other `4xx` | Permanent failure, never retried |
| Any `3xx` | Permanent failure. **Redirects are never followed** — a `3xx` is data, not a second request |
| A URL the destination guard refuses | Permanent failure |
| A disabled, unverified, or deleted endpoint | Permanent failure |
| A resource that is gone, or a creator who has lost access to it | Permanent failure |

A response body larger than the read cap is *not* a failure: a `2xx` is a successful
delivery however chatty the receiver is.

**Delivery is at-least-once, so a receiver must be idempotent.** The attempt row is written
after the HTTP call returns, so a crash between your `200` and that write re-delivers the
same `x-notted-event-id`. Deduplicate on it and answer `2xx` quickly — accept and enqueue
rather than doing the work on the request path; the outbound request has a wall-clock ceiling
(`WEBHOOK_REQUEST_TIMEOUT_MS`, 10 seconds by default).

#### Endpoint lifecycle

An endpoint is created **disabled and unverified**, so a typo'd or hostile URL never receives
a single real event.

`POST /verify` sends one signed `webhook.verification` request synchronously, with its own
5-second budget and no retry, and records a delivery attempt either way — a failed
verification is visible in the delivery log where an admin will look for it. To pass, the
receiver must answer `2xx` with the `data.challenge` value echoed in the body, either as the
raw body or as JSON such as `{"challenge":"…"}`. Two limits apply, because the check runs
against the same bounded snippet the delivery log stores:

- The response must carry a **textual content type** — `text/*` or anything containing
  `json`. A challenge echoed as `application/octet-stream` fails.
- Only the first **500 characters** of the response are examined, and at most 8 KB is read
  off the wire. A challenge buried past that cap fails. Echo it as the whole body, or as a
  small JSON object.

Enabling an unverified endpoint returns `409 WEBHOOK_NOT_VERIFIED`. Changing the URL resets
both `isVerified` and `isEnabled`: verification proved that *that* host holds the secret and
proves nothing about the next one. A workspace may hold at most **10 endpoints**.

#### Destination restrictions

A destination must be a public **HTTPS** URL with no embedded credentials and no more than
2048 characters. Private ranges, loopback, link-local (including the cloud-metadata address
`169.254.169.254`), carrier-grade NAT, multicast and reserved ranges, `localhost` and
`.localhost` / `.local` / `.internal` names, and Notted's own hostnames are all refused with
`422 WEBHOOK_URL_REJECTED`. IPv4-mapped IPv6 forms are unmapped and re-checked, so a v6
costume does not bypass a v4 rule.

The refusal message is deliberately non-specific: naming the layer that refused, or the
address a name resolved to, would be a private-network oracle. The address filter runs again
at socket-connect time on every delivery, so a DNS record that answers publicly for
validation and privately for the connection lands on nothing.

#### Secrets

The signing secret is `whsec_` followed by 43 base64url characters (32 random bytes). It is
returned **exactly once** — by create and by rotate-secret — and never afterwards: only its
encrypted form is stored, and no list response, log line, or audit row contains it. A lost
secret is rotated, not recovered.

A rotation takes effect immediately, and **in-flight retries are signed with the new
secret**. A receiver that must not drop those should accept either secret for a short window
during a rotation, then remove the old one.

#### Delivery logs

Each attempt writes one immutable row: its time, the event and event id, the attempt number,
the status, the receiver's HTTP status, the duration, and `payloadHash` — a SHA-256 of the
exact bytes sent. The request body, the request headers, and the signature are never stored.

`responseBodySnippet` is the receiver's response body, captured only for a textual content
type (`text/*` or anything containing `json`), read to at most 8 KB and stored to at most 500
characters, with control characters and ANSI escapes stripped. A binary response stores
`null` rather than mojibake, and a declared `content-length` above the read cap is not read
at all.

`errorMessage` is drawn from a closed code set — never the underlying network error text,
which quotes the endpoint URL and would leak any credential the admin put in its path or
query.

| `errorMessage` | Meaning |
|---|---|
| `timeout` | The receiver did not answer within the request budget |
| `connection_failed` | DNS, TCP, or socket failure |
| `dns_blocked` | The host resolved to a blocked address |
| `url_rejected` | The destination guard refused the URL |
| `tls_failed` | TLS handshake or certificate validation failed |
| `http_error` | A non-`2xx` response |
| `response_too_large` | Reserved in the vocabulary; the sender never emits it, because an oversized body is still a delivery |
| `resource_unavailable` | The endpoint or the event's resource is gone, disabled, or unverified |
| `resource_forbidden` | The endpoint's creator can no longer read the resource |
| `secret_unavailable` | The stored secret could not be decrypted — an operator problem |

`status` is `success`, `failed`, or `retrying`; `pending` exists in the enum but is never
written, because a row is only inserted once the attempt has settled.

Replay is `POST .../deliveries/{deliveryId}/retry`, which returns `202` with
`{ webhookId, eventId, scheduled }`. It replays the **same event with the same event id**
under a fresh attempt budget, rebuilding the payload from the original recorded intent rather
than from the log row — so a receiver deduplicating on `x-notted-event-id` correctly sees a
repeat rather than a new event. Once the original intent has been pruned, the delivery can no
longer be replayed and the call answers `409 CONFLICT`.

#### Webhook error codes

| Code | Status | Remedy |
|---|---|---|
| `WEBHOOK_URL_REJECTED` | 422 | Point the endpoint at a public HTTPS address that is not private, loopback, link-local, or Notted itself. |
| `WEBHOOK_NOT_VERIFIED` | 409 | Call `POST /verify` and pass the challenge, then enable the endpoint. A URL change resets verification. |
| `WEBHOOK_VERIFICATION_FAILED` | 422 | Answer the challenge with `2xx`, a textual content type, and the `challenge` value inside the first 500 characters. Read the recorded attempt in the delivery log for the reason. |
| `CONFLICT` | 409 | Either the workspace already holds 10 endpoints — delete one before creating another — or the delivery being replayed is too old to reconstruct. |

```bash
# Register an endpoint. Store `secret` from the response immediately; it is never returned again.
curl -sS -X POST https://api.example.com/api/v1/workspaces/$WORKSPACE_ID/webhooks \
  -H "Authorization: Bearer ntd_pk_EXAMPLEKEYEXAMPLEKEYEXAMPLEKEY00" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/notted","events":["note.created","note.updated"]}'

# Prove control of the endpoint, then enable it.
curl -sS -X POST https://api.example.com/api/v1/workspaces/$WORKSPACE_ID/webhooks/$WEBHOOK_ID/verify \
  -H "Authorization: Bearer ntd_pk_EXAMPLEKEYEXAMPLEKEYEXAMPLEKEY00"

curl -sS -X PATCH https://api.example.com/api/v1/workspaces/$WORKSPACE_ID/webhooks/$WEBHOOK_ID \
  -H "Authorization: Bearer ntd_pk_EXAMPLEKEYEXAMPLEKEYEXAMPLEKEY00" \
  -H "Content-Type: application/json" \
  -d '{"isEnabled":true}'
```
