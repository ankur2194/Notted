# Testing Standard

- Unit-test rules, validators, policies, transformations, and failure paths.
- Integration-test persistence and infrastructure boundaries against realistic services.
- Contract-test tRPC and REST through shared application services.
- Use Playwright for critical journeys, browsers, and accessibility.
- Add a regression test for reproducible defects.
- Keep fixtures deterministic, tenant-aware, and independent of execution order.
- Run focused checks, then relevant lint, type-check, integration/E2E, migration, and build checks.
- Never run a browser suite against the development database; use the disposable stack below.
- Record exact commands and honest results in the completion record.

## Disposable end-to-end stack

The `e2e` Compose profile is a second application stack — `api-e2e` and `web-e2e` on ports 3010 and
3011 — backed by its own PostgreSQL database (`notted_e2e_test`), its own MinIO buckets, and Redis
logical database 1. It shares the PostgreSQL, Redis, MinIO, Meilisearch and Mailpit *servers*, plus
the installed dependencies and compiled contract packages, with the development stack.

**Shared services require logical isolation.** Meilisearch uses distinct deterministic, versioned
index prefixes (`notted_dev_` and `notted_e2e_`) on the shared server, so an e2e rebuild cannot
contaminate developer indexes. Mailpit is likewise shared, and `clearMailpit()` empties
the entire mailbox, so a concurrent e2e run can delete a message a developer was reading; that is a
nuisance rather than a correctness problem, and it is why no spec should assert on mail it did not
itself send.

```bash
pnpm e2e:up      # start the profile; drops and recreates the database, migrates, seeds, flushes Redis db 1
pnpm e2e:test    # run the Playwright chromium project against it
pnpm e2e:test --grep "note"                      # arguments pass to Playwright verbatim (no `--`)
pnpm e2e:down    # remove the profile's containers; the development stack keeps running
```

`pnpm e2e:up` starts every run from the same state. `pnpm e2e:test` runs Playwright in the official
container joined to `api-e2e`'s network namespace, because Chromium cannot launch on the host. Inside
that namespace `127.0.0.1` is the API container, so Mailpit and PostgreSQL must be addressed by
Compose DNS (`http://mailpit:8025`, `postgres:5432`) while the application keeps the same
`localhost:3010`/`localhost:3011` origins the browser, the CORS allow-list and Better Auth all agree
on. Override `NOTTED_E2E_WEB_PORT` / `NOTTED_E2E_API_PORT` when another project holds those ports.

**Why it exists.** `PLAYWRIGHT_DISPOSABLE_TEST_RUN=true` used to gate specs without creating
anything: the suite ran against `notted_dev` and every run left users, workspaces, projects and notes
behind, so specs that assume a near-empty tenant failed on the previous run's rows. The flag now
names a stack that really is disposable. The development database is never written by a browser
test, and that is now enforced rather than merely documented: `playwright.config.ts` refuses to start
when `PLAYWRIGHT_APP_URL` is unset outside CI, so a bare `playwright test` fails closed with an
instruction instead of silently targeting `localhost:3000`. Set `PLAYWRIGHT_APP_URL` explicitly to
aim at some other stack on purpose.

The targeted startup names only `api-e2e` and `web-e2e`; Compose starts their shared infrastructure,
contract, migration, reset, and bucket dependencies transitively, but does not build or start the
development `api`, `web`, `db-init`, or `minio-init` services. Playwright is told these disposable
servers are external, so retries attach to the same healthy processes instead of invoking its
development-server commands or rebuilding between attempts.

For a resource-constrained local diagnosis where failure traces, screenshots, videos, and the HTML
report are not needed, opt into the lightweight runner explicitly:

```bash
PLAYWRIGHT_LIGHTWEIGHT_MODE=true pnpm e2e:test version-history.spec.ts
```

List output and assertions remain unchanged. CI ignores lightweight mode and retains the default
failure artifacts and HTML report.

Only the chromium project runs unless you pass your own `--project`. A `--grep` filter therefore
narrows the run without also widening it to firefox and webkit, which are not part of the maintained
baseline.

Two further sources of run-to-run drift are handled by the profile rather than by the specs: Redis
logical database 1 is flushed so sessions cannot outlive the rows they reference, and the API's
in-memory rate-limit buckets are raised, because a serial browser suite drives every request from the
single IP of the shared network namespace.

`db-reset-e2e` destroys a database unconditionally, so it validates `POSTGRES_E2E_DB` against a
pattern (`notted_e2e*_test`) that no development or production name can match, and `redis-reset-e2e`
hardcodes logical database 1. Never point either at development data, and never use
`pnpm infra:reset:dev` to prepare an end-to-end run.
