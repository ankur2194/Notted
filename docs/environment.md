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

## Production requirements

- `APP_URL`, `API_URL`, `BETTER_AUTH_URL`, and every trusted auth origin use HTTPS;
  `WS_URL` uses WSS. Public URLs are credential-free origins without paths, queries, or
  fragments.
- `DATABASE_URL` includes a non-placeholder application user and strong password.
- `BETTER_AUTH_SECRET` is at least 32 bytes and is not a documented/example value.
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
