# Environment contracts

Notted separates configuration by consumer. Real environment files are ignored by Git;
only examples are committed. Run `pnpm env:init` to copy missing examples without
overwriting local values, then `pnpm env:check`.

| Owner | Local file | Allowed contents |
|---|---|---|
| Docker Compose | `docker/.env` | Service administration credentials, bucket names, and loopback-published ports |
| NestJS API | `apps/api/.env` | Server URLs and secrets, dependency clients, limits, and feature flags |
| Next.js web | `apps/web/.env.local` | Only `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_WS_URL` |

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
- `BETTER_AUTH_SECRET` is at least 32 bytes and is not a documented/example value.
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
  credentials. Compose-only root/master credentials remain in `docker/.env`; application
  credentials belong in `apps/api/.env`.
- Production SMTP uses implicit TLS or requires STARTTLS. SMTP user and password are
  either both present or both absent.
- AI remains disabled unless `FEATURE_AI_ENABLED=true` and at least one provider key is
  configured. Provider calls are implemented in later plan parts.

Validation errors name variables and safe requirement categories but never echo supplied
values. Do not paste real environment files into issue reports, logs, or test artifacts.

## Cross-file development consistency

For the local stack, the PostgreSQL user/password/database in `docker/.env` must match the
credentials and database name in the API `DATABASE_URL`. `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD` currently match the API development access key pair, and
`MEILI_MASTER_KEY` matches the API development search key. These are documented local
defaults only, not production credential-sharing guidance.

Published ports in `docker/.env` must match the host endpoints in `apps/api/.env`.
MinIO bucket names must also agree. `pnpm env:check` validates the credential/name
relationships and invokes both typed application validators.

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
account-level brute-force behavior. The bounded auth-email bridge
uses `AUTH_EMAIL_DISPATCH_INTERVAL_MS`, `AUTH_EMAIL_QUEUE_CONCURRENCY`,
`AUTH_EMAIL_QUEUE_ATTEMPTS`, `AUTH_EMAIL_QUEUE_BACKOFF_MS`, and
`AUTH_EMAIL_IDEMPOTENCY_RETENTION_DAYS`. These are operational limits, never payload or
secret inputs. `DATA_ENCRYPTION_KEYS` protects tokenized auth-email context at rest.

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
