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
| Redis client | `ioredis 5.11.1` | MIT; lazy connections, bounded commands, no offline replay, and capped jittered reconnect are configured by the Part 11 adapter. |
| Object client | `minio 8.0.7` | Apache-2.0 SDK; raw client and credentials remain private behind the storage adapter. |
| Search client | `meilisearch 0.60.0` | MIT and ESM-only; Nest's CommonJS output loads it through one typed native dynamic-import boundary. |
| SMTP client | `nodemailer 9.0.3` / `@types/nodemailer 8.0.1` | MIT; bounded pooled transport with provider logging disabled. |

### Targeted advisory overrides

The selected framework majors had patched transitive releases that their exact package
manifests did not yet select. Phase 2 therefore applies only these reviewed overrides:

| Parent | Transitive override | Reason |
|---|---|---|
| `@nestjs/platform-express@10.4.22` | `multer@2.2.0` | Removes the inherited high-severity upload-parser advisories without changing Nest's major. |
| `next@16.2.11` | `postcss@8.5.18` | Keeps Next 16 while selecting the patched CSS parser used by its internal path. |
| `next@16.2.11` | `sharp@0.35.0` | Keeps Next 16 while selecting the patched optional image runtime. |
| Various (Phase 4) | `body-parser@1.20.6` | Resolves GHSA-v422 (DoS via invalid limit value) without changing Express major. |
| Various (Phase 4) | `esbuild@0.28.1` | Resolves GHSA‑67mh (dev-server request leakage) without changing tooling majors. |
| Various (Phase 4) | `file-type@21.3.4` | Resolves GHSA‑5v7r (infinite loop) and GHSA‑j47w (ZIP bomb) without changing NestJS v10. |
| Various (Phase 4) | `qs@6.15.3` | Resolves GHSA‑q8mj (DoS in qs.stringify comma arrays) without changing Express. |

The single remaining `@nestjs/core` advisory (GHSA‑36xv) is a semver false positive:
the vulnerable `SseStream` class does not exist in `@nestjs/core@10.4.22`. Suppressed
via `pnpm audit --ignore` and the `audit:prod` root script.

They are compatibility exceptions, not permission for broad/global dependency
replacement. Strict installation, API/web tests, type checks, production builds, runtime
smoke tests, and `pnpm audit --prod --audit-level=high` must remain green. A failure
blocks the affected part rather than authorizing a Nest or Next major upgrade.

### Development container baseline

Phase 2 pins deployable tags and multi-architecture manifest digests:

- `pgvector/pgvector:0.8.5-pg16` —
  `sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`
- `redis:7.2.14-alpine` —
  `sha256:dfa18828cbc07b3ae6a95ec7343f6c214fdee2d836197b4be8e9904420762cd8`
- `getmeili/meilisearch:v1.45.1` —
  `sha256:ac40212f9e5a7526d8007586e3e46fb0441d29dd36c7b02fa2341d2c9a1f6493`
- `axllent/mailpit:v1.30.0` —
  `sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d`

Redis remains on the 7.2 BSD-licensed line required by `Notted.md`. MinIO Community
Edition is built reproducibly from server commit
`7aac2a2c5b7c882e68c1ce017d8256be2feea27f` and client commit
`77f82e18b5401a65958f1619df6ebb994634bd88`. Its build base is
`golang:1.24.5-alpine3.22@sha256:daae04ebad0c21149979cd8e9db38f565ecefd8547cf4a591240dc1972cf1399`;
its runtime base is
`alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`.
The source archives are independently checksum-pinned to
`sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6`
(server) and
`sha256:167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975`
(client). Source commits, archive checksums, bases, and build targets move together after
the same runtime gate.

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
