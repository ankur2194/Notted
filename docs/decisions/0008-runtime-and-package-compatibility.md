# ADR 0008: Runtime and package compatibility baseline

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1–7, 21, 33–38

## Context

`Notted.md` names technology major lines, sometimes as `latest`, but reproducible development needs a supported runtime and a compatibility-tested package set. Some current upstream major releases exceed the brief's selected lines; silently upgrading them would change scope.

## Decision

The evaluated baseline is Node.js `22.23.1` and pnpm `10.34.5`. Node `22.12.0` is the minimum supported runtime and Node 23 or newer is outside this baseline. Part 2 will pin the evaluated versions in the version file and `packageManager`; CI and containers must use those same pins unless that part revalidates and records a newer patch.

Use this foundation matrix, with exact patch versions resolved and locked during the part that first installs each package:

| Component | Evaluated version | Compatibility constraint |
|---|---|---|
| Next.js | `16.2.11` | Requires Node `>=20.9`; App Router uses React 19-era behavior. |
| React / React DOM | `19.2.8` | Both packages use the identical patch and satisfy Next.js 16 peer metadata. |
| TypeScript | `5.9.3` | One workspace version; exceeds Next.js' 5.1 minimum. |
| NestJS core/common/platform | `10.4.22` | Runs on the common Node 22 runtime; core Nest packages stay on this patch. |
| tRPC client/server/React Query | `11.18.0` | Identical adapter patches, paired with `@tanstack/react-query` `5.101.4`; shared Zod is pinned when Part 6 introduces its contracts. |
| Drizzle ORM / Kit / PostgreSQL driver | `0.45.2` / `0.31.10` / `pg` `8.22.0` | Explicit material deviation from `Notted.md`'s Drizzle ORM `0.30.x` line. Better Auth's current stable adapter requires Drizzle ORM `^0.45.2`; these exact stable versions pass strict peer resolution. Drizzle 1.0 prereleases remain excluded. |
| TipTap core/react/starter-kit | `2.27.1` | Identical package patches; use the headless React integration, not the separately packaged UI Components. |
| Better Auth | `1.6.24` | Current stable release. Its package and `@better-auth/drizzle-adapter@1.6.24` both require Drizzle ORM `^0.45.2`; Better Auth 1.7 prereleases remain excluded. |
| Socket.io / Yjs | `4.8.3` / `13.6.31` | Transport and CRDT packages remain separate authorities as defined by ADR 0004. |
| BullMQ | `5.80.10` | Redis-backed delivery only; durable intent remains in PostgreSQL as defined by ADR 0006. |

This is a deliberate compatibility baseline, not permission to float ranges in a lockfile. Registry metadata and official integration documentation were reviewed on 2026-07-22. Before each first installation, inspect the then-published engine and peer metadata, resolve this exact set with pnpm's strict peer checks enabled, and run install, type-check, tests, and production builds. Any inability to resolve without peer overrides blocks that later part and requires an ADR update; `--force`, ignored peers, and unreviewed package patches are not validation.

TipTap's separately distributed UI Components currently warn that React 19 and newer framework support is still being upgraded. Notted therefore uses `@tiptap/react` as a headless editor binding and builds its own Shadcn-based UI as specified. Part 34 must smoke-test editor mount, SSR/client boundaries, and production build before accepting the combination.

## Validation evidence

- Next.js installation documentation states Node `>=20.9`, TypeScript `>=5.1`, and direct React/React DOM declarations: <https://nextjs.org/docs/app/getting-started/installation>.
- Better Auth documents a Drizzle PostgreSQL adapter and separate client/server installation: <https://www.better-auth.com/docs/installation>.
- tRPC 11 documents TanStack React Query integration: <https://trpc.io/docs/client/react/setup>.
- pnpm's compatibility table supports pnpm 10 on Node 22: <https://pnpm.io/installation#compatibility>.
- TipTap's official compatibility notice for its UI Components motivates using only the headless React packages: <https://tiptap.dev/docs/ui-components/getting-started/overview>.
- Live npm registry metadata recorded the evaluated stable releases, including Next.js `16.2.11`, NestJS `10.4.22`, Better Auth `1.6.24`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, `pg` `8.22.0`, tRPC `11.18.0`, and pnpm `10.34.5`. It confirms that Better Auth and its Drizzle adapter require Drizzle ORM `^0.45.2`, and that `@tiptap/react` `2.27.1` permits React 19 and peers with the TipTap 2 core/ProseMirror packages: <https://www.npmjs.com/package/next>, <https://www.npmjs.com/package/%40nestjs/core>, <https://www.npmjs.com/package/better-auth>, <https://www.npmjs.com/package/%40better-auth%2Fdrizzle-adapter>, <https://www.npmjs.com/package/drizzle-orm>, <https://www.npmjs.com/package/drizzle-kit>, <https://www.npmjs.com/package/pg>, <https://www.npmjs.com/package/%40trpc/react-query>, <https://www.npmjs.com/package/%40tiptap/react>, and <https://www.npmjs.com/package/pnpm>.
- A disposable pnpm `10.34.5` install with strict peer checks failed with `ERR_PNPM_PEER_DEP_ISSUES` for Better Auth `1.6.24`, Drizzle ORM `0.30.10`, and `pg` `8.16.3`: Better Auth and `@better-auth/drizzle-adapter` both required Drizzle ORM `^0.45.2`.
- A disposable pnpm `10.34.5` install with strict peer checks succeeded for Better Auth `1.6.24`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, and `pg` `8.22.0`, resolving 125 packages without peer errors.

The matrix is mutually compatible at the documented engine and peer-resolution level: Node 22.23.1 satisfies the runtime floors, React 19.2 satisfies Next 16, and the exact Better Auth/Drizzle/PostgreSQL package set resolves under strict pnpm peer checks. This ADR explicitly deviates from the product brief's Drizzle ORM `0.30.x` line because retaining that line is incompatible with the current stable Better Auth adapter. Full typed integration, migration, runtime, and production-build proof occurs when Parts 2, 4, 5, 12, 13, 21, and 33 introduce runnable packages.

## Alternatives considered

- Use every current latest package: rejected because TipTap 3 and NestJS newer than 10 would silently override the product brief; Drizzle is upgraded only to the minimum stable line required by the selected stable Better Auth adapter.
- Use Node 20: rejected in favor of the currently evaluated Node 22 LTS operational baseline, which provides one runtime for the web, API, auth tooling, workers, CI, and containers.
- Retain Drizzle ORM `0.30.10` by downgrading Better Auth: rejected because no stable Better Auth release was found with verified support for Drizzle ORM `0.30.x`; historical releases were developed against at least Drizzle ORM `0.33.0`, and downgrading authentication to obsolete releases would conflict with `Notted.md`'s `latest` selection and the project's security posture.
- Adopt Better Auth 1.7 prereleases: rejected because authentication is security-sensitive and stable 1.6.24 satisfies the required integration with Drizzle ORM `0.45.2`.

## Consequences

Part 2 records the evaluated runtime/package-manager pins. Part 12 must validate generated PostgreSQL migrations and schema APIs against Drizzle ORM `0.45.2`; Parts 13 and 21 must generate and test Better Auth tables using the installed `1.6.24` adapter. Do not use peer overrides or downgrade Better Auth to conceal incompatibility. Each package-owning part records these exact dependency pins and executable verification, or documents a revalidated patch update. Dependabot or manual updates stay within selected lines unless an ADR approves a major-line change.

## Migration and rollback

There is no package graph yet. Runtime or major-line changes require synchronized CI/container updates and an ADR; rolling back restores the lockfile and runtime pins together.
