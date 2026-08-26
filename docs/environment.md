# Environment contracts

Notted separates configuration by consumer. Real environment files are ignored by Git;
only examples are committed.

| Owner | Local file | Required? | Allowed contents |
|---|---|---|---|
| Docker Compose | root `.env` | No — every value defaults in `compose.yaml` | Published-port overrides, service administration credentials, bucket names |
| NestJS API | `apps/api/.env` | Host-side tooling only | Server URLs and secrets, dependency clients, limits, and feature flags |
| Next.js web | `apps/web/.env.local` | Host-side tooling only | Only `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_WS_URL` |

The development stack configures the API and web containers entirely from
[`compose.yaml`](../compose.yaml), so `docker compose up` needs no file from this table.
`apps/api/.env` and `apps/web/.env.local` exist for commands run on the host —
`pnpm db:studio`, `pnpm db:generate`, `pnpm test:ci`, Playwright. Run `pnpm env:init` to
copy missing examples without overwriting local values, then `pnpm env:check`.

Never put a database URL, auth secret, provider credential, or encryption key in a
`NEXT_PUBLIC_*` variable. Next.js embeds public variables into browser bundles at build
time. Changing one requires rebuilding the web application; the Turborepo build cache
also hashes all three.

The authentication browser client uses `NEXT_PUBLIC_API_URL` plus the Part 21
`/api/auth` base path and includes cookies. Server-rendered route protection forwards the
current request cookies to that API origin without logging them. Production routing must
therefore preserve the documented cookie/session topology (normally one public host or an
explicitly reviewed shared cookie domain); unrelated cross-site API and web hosts are not a
supported implicit fallback.

## Production requirements

- `APP_URL`, `API_URL`, `BETTER_AUTH_URL`, and every trusted auth origin use HTTPS;
  `WS_URL` uses WSS. Public URLs are credential-free origins without paths, queries, or
  fragments.
- `DATABASE_URL` includes a non-placeholder application user and strong password.
- `BETTER_AUTH_SECRET` is at least 32 bytes and is not a documented/example value. It is also
  the API-key hashing pepper, so rotating it invalidates every issued API key — see
  [BETTER_AUTH_SECRET is also the API-key pepper](#better_auth_secret-is-also-the-api-key-pepper).
- `BETTER_AUTH_TRUSTED_ORIGINS` must include the exact `APP_URL` origin. Authentication
  requires `FEATURE_REDIS_ENABLED=true`; Redis loss fails closed and can require
  reauthentication (ADR 0010).
- Each OAuth provider is disabled by omission unless its complete server-only tuple is
  present: Google and GitHub require client ID plus client secret; Microsoft requires client
  ID, client secret, and tenant ID. A partial tuple fails startup. Never place any member of
  these tuples in `NEXT_PUBLIC_*`, browser mocks, screenshots, logs, or documentation.
- `AUTH_PASSKEY_RP_ID` is the relying-party host (not a URL). Every comma-separated
  `AUTH_PASSKEY_ORIGINS` entry must be an exact trusted origin whose host equals or is a
  subdomain of that RP ID. Production requires HTTPS. Development permits only
  `http://localhost`; other insecure origins fail startup.
- `DATA_ENCRYPTION_KEYS` is a comma-separated ordered keyring such as
  `3:<base64>,2:<base64>`. Versions are unique positive integers, each value decodes to
  exactly 32 bytes, and the first version is active.
- Enabled Redis, MinIO, Meilisearch, SMTP, and AI providers require their application
  credentials. Compose-only root/master credentials belong to the Compose file or its
  root `.env`; application credentials belong in the API environment.
- Production SMTP uses implicit TLS or requires STARTTLS. SMTP user and password are
  either both present or both absent.
- AI remains disabled unless `FEATURE_AI_ENABLED=true`. Chat credentials are stored per
  workspace (Part 67), so no deployment-level provider key is required; `AI_REQUEST_TIMEOUT_MS`
  (default 120000, 1000–600000) bounds every outbound chat call.
- Custom domains remain disabled unless `CUSTOM_DOMAINS_ENABLED=true`, and enabling them
  requires a reverse proxy that can obtain certificates for tenant hostnames on demand.
  `CUSTOM_DOMAIN_CNAME_TARGET` must be a public hostname in production — `localhost`,
  `*.localhost`, and IPv4 literals fail startup — and `TRUST_PROXY_HOPS` must match the
  number of proxies in front of the API. See
  [Custom-domain values](#custom-domain-values).

Validation errors name variables and safe requirement categories but never echo supplied
values. Do not paste real environment files into issue reports, logs, or test artifacts.

## Cross-file development consistency

Inside the Docker stack there is nothing to keep in sync: `compose.yaml` derives
`DATABASE_URL` from the same `POSTGRES_*` values it gives PostgreSQL, hands the MinIO root
credentials to the API as its access key pair, reuses `MEILI_MASTER_KEY` as the API search
key, and derives `APP_URL`, `API_URL`, `WS_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, and the
three `NEXT_PUBLIC_*` origins from `NOTTED_WEB_PORT` and `NOTTED_API_PORT`. These are
documented local defaults only, not production credential-sharing guidance.

The host-side files can still drift from each other, so `pnpm env:check` verifies that
`apps/web/.env.local`'s `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and
`NEXT_PUBLIC_WS_URL` match `apps/api/.env`'s `APP_URL`, `API_URL`, and `WS_URL`, then
invokes both typed application validators. It succeeds and says so when the files are
absent, because the Docker stack does not need them.

`apps/api/.env` points its `DATABASE_URL`, `MINIO_ENDPOINT`, `MEILISEARCH_HOST`, and
`EMAIL_SMTP_HOST` at `127.0.0.1`. Those are reachable only while
`docker/compose.debug-ports.yml` is layered in (`pnpm infra:up:ports`); the default stack
keeps the data services off the host.

## BETTER_AUTH_SECRET is also the API-key pepper

`BETTER_AUTH_SECRET` has a second consumer. Part 65 stores no raw API key: a key row holds
only an HMAC-SHA256 hash of the secret, peppered with `BETTER_AUTH_SECRET`, plus an
eight-character display prefix. The pepper lives only in the process environment and never in
the database, so a database-only compromise can neither verify a stolen key nor forge a new
row.

**Rotating `BETTER_AUTH_SECRET` invalidates every issued API key.** Each stored hash was
computed under the old pepper and can no longer be reproduced, so every key begins returning
the same `401 UNAUTHENTICATED` as an unknown key — silently, from the integration's point of
view, because the failure is deliberately indistinguishable from revocation.

Treat a rotation as a planned key-reissue event, not a routine secret change:

- Announce it to every workspace that owns integrations; the keys cannot be migrated, only
  reissued.
- Rotate the secret and mint replacement keys in the same maintenance window. There is no
  dual-pepper period: the hash construction is versioned (`notted:api-key:v1:`) so a future
  scheme can coexist with `v1` rows, but a pepper change is not such a scheme.
- The secret is Better Auth's signing secret as well, so plan for signed-in users to be
  affected in the same window.

This coupling does not apply to `DATA_ENCRYPTION_KEYS`, which is a versioned keyring designed
for overlapping rotation.

## Portable secret generation

These commands generate new values locally. Run each independently and store its output
in a secret manager; do not commit it.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
node -e "console.log('1:'+require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The first is suitable for `BETTER_AUTH_SECRET`, the second for an initial
`DATA_ENCRYPTION_KEYS` entry, and the third for provider/application credentials that
accept hexadecimal values. Rotate encryption by prepending a new, higher unique version;
retain old versions until all encrypted records have been re-encrypted and verified.

## Authentication and email queue values

`AUTH_VERIFICATION_TOKEN_TTL_SECONDS`, `AUTH_MAGIC_LINK_TOKEN_TTL_SECONDS`, and
`AUTH_PASSWORD_RESET_TOKEN_TTL_SECONDS` bound credential-link validity.
`SESSION_SHORT_LIVED_HOURS` must be exactly `24` for Better Auth 1.6.24. A non-remembered
session receives a one-day server expiry and a browser-session cookie; explicit remember-me
uses `SESSION_REMEMBER_ME_DAYS` for both the durable expiry and cookie maximum age. TOTP
confirmation/disable session rotations preserve the existing one-day versus remembered choice;
they never silently promote a browser-session login to a remembered session.
`AUTH_RECENT_AUTH_SECONDS` configures Better Auth `session.freshAge` and the matching internal
principal freshness projection. `AUTH_TWO_FACTOR_CHALLENGE_SECONDS`,
`AUTH_TWO_FACTOR_LOCKOUT_ATTEMPTS`, and `AUTH_TWO_FACTOR_LOCKOUT_SECONDS` bound challenge and
account-level brute-force behavior for an already-identified account's second factor.
`AUTH_LOCKOUT_ATTEMPTS` (default `10`, 3–100) and `AUTH_LOCKOUT_SECONDS` (default `900`,
60–86400) instead bound credential-stuffing against the sign-in identifier itself, before any
second factor is reached: `AUTH_LOCKOUT_SECONDS` is both the window in which failures accrue
and the resulting lock duration, one knob for both. State lives in Redis rather than in the
in-memory rate-limit buckets, so a lockout holds across every API replica instead of resetting
whichever instance the next attempt happens to land on. The identifier is never stored or
logged in the clear, only as its SHA-256 hash, and a locked response (`423`, `Retry-After`) uses
the same refusal message as an unrecognized identifier, so the lockout itself cannot be used to
enumerate which accounts exist. Authentication and invitation email intents use the shared
BullMQ runtime's `QUEUE_*` dispatch, attempt, backoff, timeout, concurrency, and idempotency
limits; there is no standalone auth-email queue configuration. These are operational limits,
never payload or secret inputs. `DATA_ENCRYPTION_KEYS` protects tokenized auth-email context at
rest.

Playwright-only overrides are `PLAYWRIGHT_APP_URL`, `PLAYWRIGHT_API_URL`, and
`PLAYWRIGHT_MAILPIT_URL`. They are test-runner process values, not browser bundle values or
application secrets. Defaults use the documented loopback ports.

OAuth provider callback URLs use Better Auth's server route under the configured base URL:
`<BETTER_AUTH_URL><BETTER_AUTH_BASE_PATH>/callback/google`, `/callback/github`, and
`/callback/microsoft`. Register only the enabled provider callbacks. Browser return targets
remain exact application-local paths validated by the web client and Better Auth trusted
origins; external or protocol-relative targets are rejected.
Provider failures return to a generic local `/login` error state; provider error descriptions
and credential material are never rendered.

## Observability values

| Variable | Default | Range | Notes |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` | Pino level for the structured logger. `compose.yaml` now sets it explicitly (`LOG_LEVEL: ${LOG_LEVEL:-info}`) so there is a knob to turn without editing the file. `debug` and `trace` do **not** relax redaction, but they do raise log volume against a bounded 10 MB × 5 rotation. |
| `METRICS_TOKEN` | unset | any string; **≥ 32 characters in production** | Bearer token for `GET /metrics`. **Unset means the endpoint answers `404`, not `401`**, so a deployment is never accidentally exporting its internals and the route's existence is not discoverable without the token. A value shorter than 32 characters **fails startup in production** rather than silently disabling the endpoint — a deployment that meant to enable metrics must hear about a weak token instead of wondering why Prometheus gets 404s. Generate with `openssl rand -hex 32` and give the scraper the same value through Prometheus's `credentials_file`, never inline in a scrape config. The endpoint is **not** exempt from the trusted-host check, so with `CUSTOM_DOMAINS_ENABLED=true` a scraper dialling a raw IP receives `421`; see [`docs/runbooks/observability.md`](runbooks/observability.md). |

## Rate-limit values

Five independent token buckets guard the API. Each value is requests per minute for one
bucket; the buckets are keyed disjointly (client IP, user ID, API-key ID, a per-route
sensitive bucket, and the authentication bucket below), so draining one never consumes
another's allowance. All five are optional API environment values with the defaults below.

| Variable | Default | Accepted range | Bucket |
|---|---|---|---|
| `RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE` | `60` | 1–100000 | Per client IP, before any credential is validated |
| `RATE_LIMIT_AUTHENTICATED_PER_MINUTE` | `1000` | 1–1000000 | Per authenticated user |
| `RATE_LIMIT_API_KEY_PER_MINUTE` | `100` | 1–1000000 | Per API key, not per workspace or per creator |
| `RATE_LIMIT_SENSITIVE_PER_MINUTE` | `10` | 1–10000 | Per caller, per route opted into the sensitive tier |
| `RATE_LIMIT_AUTH_PER_MINUTE` | `5` | 1–10000 | Per client IP and per attempted identifier on authentication endpoints |

A value outside its range fails startup rather than being clamped. The tier is selected only
from the trusted principal an authentication adapter installed after validating a credential;
request headers never influence it, and rate-limit identity never grants a role or a resource
permission.

`RATE_LIMIT_AUTH_PER_MINUTE` is Part 74's authentication tier and is deliberately tighter than
`RATE_LIMIT_SENSITIVE_PER_MINUTE`. It is keyed disjointly from the sensitive bucket, so
exhausting one never consumes the other's allowance, and it is spent twice on every sign-in
attempt: once as a per-IP bucket in the Express middleware in front of Better Auth, and once
as a per-identifier budget in `AuthLockoutService` once the credential body is parsed. The
per-IP half is what a single attacker's own address exhausts; the per-identifier half is the
axis a distributed attacker spreading requests across many source IPs cannot rotate, because
it counts against the email being guessed rather than the address guessing it.

The sensitive tier is layered on top of the caller's general bucket rather than replacing it,
so a handful of sign-in-grade or credential-minting requests cannot consume a caller's whole
general allowance, and a caller already at their general limit gains no extra capacity.

The development stack raises the unauthenticated, authenticated, and sensitive values to
effectively unlimited numbers in [`compose.yaml`](../compose.yaml) so that seeding, hot
reload, and Playwright runs are never throttled. `RATE_LIMIT_API_KEY_PER_MINUTE` is not
overridden there and keeps its default. Those are local values only; production uses the
defaults above or lower.

Callers see `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` on every response
and `Retry-After` on `429 RATE_LIMITED`. See [`API.md`](API.md) for the client-facing
contract.

## Outbound webhook values

Both variables belong to the API environment and both are optional.

| Variable | Default | Accepted range | Notes |
|---|---|---|---|
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `10000` | 1000–30000 | Wall-clock ceiling on one outbound delivery request. A receiver is expected to accept and enqueue, not to do the work on the request path. Out of range fails startup rather than being clamped. |
| `WEBHOOK_ALLOW_INSECURE_URLS` | `false` | `true` / `false` | **Forced to `false` whenever `NODE_ENV=production`, regardless of what the environment says** — the variable is not read there at all. Outside production it unblocks the `http:` scheme and loopback IP literals (`127.0.0.0/8`, `::1`) **only**. Note it does NOT unblock the *hostname* `localhost`: that name, along with `*.localhost`, `*.local`, `*.internal` and `metadata.google.internal`, is refused by the hostname deny-list whatever this flag says, so a local receiver must be addressed as `http://127.0.0.1:<port>/…`. |

`WEBHOOK_ALLOW_INSECURE_URLS` never relaxes anything beyond those two. `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (including the cloud metadata address),
and every other private or reserved range stay blocked with the flag on, as do destinations
that resolve back to the deployment's own hosts. That narrowness is deliberate: an
integration test can point an endpoint at an in-process receiver on `127.0.0.1` while, in the
same run, the "private and link-local destinations are rejected" assertions still hold. The
flag is not an SSRF switch and cannot be used as one.

[`compose.yaml`](../compose.yaml) sets it to `true` for the development and disposable e2e
API containers, which enumerate their own environment; override it through root `.env` if a
local run should behave like production.

## Custom-domain values

Both variables belong to the API environment and both are optional. They enable Part 73's
custom domains — serving one workspace on a hostname its owner controls. The operator
guide is [`custom-domains.md`](custom-domains.md).

| Variable | Default | Accepted values | Notes |
|---|---|---|---|
| `CUSTOM_DOMAINS_ENABLED` | `false` | `true` / `false` | The whole feature. With it false the four workspace-domain routes and the public `GET /api/v1/domains/resolve` all answer `404`, the trusted-host check passes every request through untouched, and only the configured hosts are served. There is no second, web-side flag. |
| `CUSTOM_DOMAIN_CNAME_TARGET` | the `APP_URL` hostname | A bare hostname, ≤253 characters | The name administrators point their `CNAME` at, and one of the hostnames no tenant may claim. A value carrying a protocol, a port, or a path fails startup. |

`CUSTOM_DOMAIN_CNAME_TARGET` defaults to the `APP_URL` host, which is correct for the
single-edge topology; name something else only when tenant TLS terminates on a separate
edge. **In production the value must be a public hostname:** `localhost`, any
`*.localhost` name, and an IPv4 literal fail startup, because a tenant cannot `CNAME` to a
name that resolves only inside your network and the resulting failure would be reported to
them as a problem with their own DNS.

Enabling custom domains has a prerequisite outside this file: a TLS-terminating reverse
proxy that can obtain a certificate for a hostname it has never seen, and that serves the
web app, `/api/`, `/api/auth/`, and `/socket.io/` from the tenant's own origin. Notted
stores no certificate and no ACME account. Set `TRUST_PROXY_HOPS` to the number of proxies
in front of the API, or the forwarded host is ignored and every tenant request is refused
with `421 UNTRUSTED_HOST`. See [`custom-domains.md`](custom-domains.md) §§ 4–5.

`GET /api/v1/domains/resolve` sits on the default unauthenticated tier, not the sensitive
one: a proxy that asks it during TLS handshakes shares one IP bucket, and a refused ask is
a failed handshake that never reaches the application logs. A deployment onboarding many
hostnames at once may need to raise `RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE` above its
default of `60`.

[`compose.yaml`](../compose.yaml) sets neither variable, so the development and disposable
e2e stacks run with custom domains off.
