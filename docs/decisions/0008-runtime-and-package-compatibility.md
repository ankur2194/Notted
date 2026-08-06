# ADR 0008: Runtime and package compatibility baseline

- **Status:** Accepted
- **Date:** 2026-07-22
- **Last revised:** 2026-08-06 — Part 40 added the `busboy` upload-parser row and recorded why `file-type` cannot be a direct API dependency. Part 41 added the `sharp` and `heic-convert` image-pipeline rows, reconciled `sharp 0.35.0` against `Notted.md`'s `0.33.x` line, and recorded the LGPL flag in the HEIC decoder chain.
- **Related plan parts:** 1–7, 21, 33–38, 40, 41

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
| TipTap core/react/pm/starter-kit and every `@tiptap/extension-*` plus `@tiptap/suggestion` | `2.27.1` | MIT. One identical patch across the whole family, including the Part 34–36 additions (`extension-table`, `-table-row`, `-table-header`, `-table-cell`, `-code-block-lowlight`, `-placeholder`, `-mention`, and `@tiptap/suggestion`). Extensions peer on `^2.7.0` of core/pm, so a mixed-patch install must never be allowed to satisfy them. Use the headless React integration, not the separately packaged UI Components. |
| `lowlight` | `3.3.0` | MIT. The highlighting engine `@tiptap/extension-code-block-lowlight` peers on and the only one it supports; its declared peers are `lowlight: ^2 \|\| ^3` and `highlight.js: ^11`; the 3.x line is chosen for its ESM build and current maintenance. It depends on `highlight.js@~11.11.0`, which fixes the paired grammar version below. |
| `highlight.js` | `11.11.1` | BSD-3-Clause. The matching release inside `lowlight@3.3.0`'s `~11.11.0` range and inside the extension's `^11` peer. **Only individual `highlight.js/lib/languages/*` grammars may be imported — never the `all` or `common` bundle**, which would pull nearly two hundred grammars into the client bundle. `apps/web/src/types/highlight-js.d.ts` enforces this at the type level by declaring only the per-language subpath, and `apps/web/src/components/editor/extensions/code-block-languages.ts` registers the reviewed grammar list explicitly. |
| Better Auth | `1.6.24` | Current stable release. Its package and `@better-auth/drizzle-adapter@1.6.24` both require Drizzle ORM `^0.45.2`; Better Auth 1.7 prereleases remain excluded. |
| Socket.io / Yjs | `4.8.3` / `13.6.31` | Transport and CRDT packages remain separate authorities as defined by ADR 0004. |
| BullMQ | `5.80.10` | Redis-backed delivery only; durable intent remains in PostgreSQL as defined by ADR 0006. |
| Redis client | `ioredis 5.11.1` | MIT; lazy connections, bounded commands, no offline replay, and capped jittered reconnect are configured by the Part 11 adapter. |
| Object client | `minio 8.0.7` | Apache-2.0 SDK; raw client and credentials remain private behind the storage adapter. |
| Search client | `meilisearch 0.60.0` | MIT and ESM-only; Nest's CommonJS output loads it through one typed native dynamic-import boundary. |
| SMTP client | `nodemailer 9.0.3` / `@types/nodemailer 8.0.1` | MIT; bounded pooled transport with provider logging disabled. |
| Multipart upload parser | `busboy 1.6.0` / `@types/busboy 1.5.4` | MIT. Promoted from a `@nestjs/platform-express` transitive to a direct `apps/api` dependency (pnpm's strict layout makes a transitive un-importable). Chosen over `multer` because ADR 0005 requires byte limits enforced **before and during** transfer: busboy exposes the raw part stream so a running counter can abort mid-upload, while multer only buffers or spools and offers no per-chunk hook. It is CommonJS, so it loads directly under the API's `module: CommonJS` output, and skipping multer also avoids `@types/multer`. Registered per route in `src/attachments/multipart-upload.parser.ts`, never globally. |
| Image processing | `sharp 0.35.0` | Apache-2.0. **Explicit material deviation from `Notted.md`'s Sharp `0.33.x` line** (the second such deviation in this ADR, after Drizzle). `sharp` was already resolved in this tree at `0.35.0` through the reviewed `next@16.2.11 > sharp` advisory override below; Part 41 promotes that exact version to a direct `apps/api` dependency rather than installing a second one. Pinning `apps/api` to `0.33.x` would put **two sharp majors, and therefore two copies of the prebuilt libvips native binary, in one pnpm store** — duplicated native ABI surface, duplicated image-decoder CVE exposure, and two versions to patch on every advisory. It is `"type": "commonjs"` with a `./dist/index.cjs` main, so it loads directly under the API's `module: CommonJS` output. `Notted.md` is **not edited**: it is the product brief, and this ADR is the designated place to record a compatibility deviation from it (see the Drizzle `0.30.x` precedent above and the Consequences section). |
| HEIC decoding | `heic-convert 2.1.0` / `@types/heic-convert 2.1.1` | ISC (types MIT/DefinitelyTyped). **Needed because Sharp cannot decode HEIC here**: the installed `sharp@0.35.0` bundles the prebuilt libvips 8.18.3, which reports `sharp.format.heif.input.fileSuffix === [".avif"]`; Sharp's own typings state HEIC requires a globally installed libvips built with libheif/libde265/x265, which the container does not ship. `Notted.md` requires "HEIC (convert to JPEG)", so the decode happens in JavaScript first and the resulting JPEG then travels the ordinary Sharp pipeline. CommonJS (`main: index.js`, no `type: module`, no exports map), so unlike `file-type` it loads directly under `module: CommonJS` + `moduleResolution: Node10`. **Licence flag for human sign-off:** the chain is `heic-convert@2.1.0` (ISC) → `heic-decode@2.1.0` (ISC) → **`libheif-js@1.19.8` (LGPL-3.0)**, plus `jpeg-js@0.4.4` (BSD-3-Clause) and `pngjs@6.0.0` (MIT). The API is server-side and is not distributed to users, and the package is a separately replaceable `node_modules` dependency rather than a static link, so the LGPL relinking obligation is satisfied structurally — but it is the one Part 41 item that is a licence judgement rather than a fact. Containment: a pure-JS/WASM decoder cannot be interrupted once running, so it is guarded by its own `MAX_HEIC_UPLOAD_BYTES` cap checked *before* entry and a `Promise.race` wall-clock timeout, and every reference in the codebase lives in the single file `src/attachments/heic-decoder.ts`. Dropping HEIC is therefore a one-file change: `supports()` already consults `isHeicDecoderAvailable()` and returns 415 before any database row exists. |
| Content sniffing | first-party (`src/attachments/image-signature.ts`) | `file-type@21.3.4` — already listed below as a transitive advisory override — is **not usable as a direct API import**. It is `"type": "module"` with an exports-map-only entry, and its `strtok3`/`token-types` dependencies are ESM too; `apps/api` compiles with `module: CommonJS` + `moduleResolution: Node10`, so TypeScript cannot resolve it and a dynamic `import()` downlevels to `require()`. The supported surface is six image formats, so Part 40 ships a reviewed magic-byte sniffer with no runtime dependency. The `file-type` override row stays: it patches the transitive copy other tooling pulls in. |

### Targeted advisory overrides

The selected framework majors had patched transitive releases that their exact package
manifests did not yet select. Phase 2 therefore applies only these reviewed overrides:

| Parent | Transitive override | Reason |
|---|---|---|
| `@nestjs/platform-express@10.4.22` | `multer@2.2.0` | Removes the inherited high-severity upload-parser advisories without changing Nest's major. |
| `next@16.2.11` | `postcss@8.5.18` | Keeps Next 16 while selecting the patched CSS parser used by its internal path. |
| `next@16.2.11` | `sharp@0.35.0` | Keeps Next 16 while selecting the patched optional image runtime. Part 41 added `sharp` as a direct `apps/api` dependency at this **same exact version**, so the override and the direct pin must be changed together — letting them diverge reintroduces the duplicate-libvips problem the matrix row above rejects. |
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

### Parts 34–36 editor dependency review

The rich editor added eight further `@tiptap/*` packages, all at the already-evaluated `2.27.1` and all MIT, plus two genuinely new third-party runtime dependencies.

- **Need.** `extension-table`/`-table-row`/`-table-header`/`-table-cell` and `-placeholder` are required by `Notted.md`'s editor feature set; `-mention` and `@tiptap/suggestion` back `@` mentions and the slash menu; `-code-block-lowlight` is what makes code blocks highlightable. `lowlight` and `highlight.js` are the only chain that extension supports, so they are transitive by design rather than a free choice.
- **Maintenance.** All `@tiptap/*` packages ship from one release train, so they move together with the existing pin. `lowlight` and `highlight.js` are long-lived, actively released packages in wide use.
- **Licence.** `@tiptap/*` MIT, `lowlight` MIT, `highlight.js` BSD-3-Clause. All are permissive and compatible with the project's distribution.
- **Security and cost.** None of the three adds a network client, native binding, or telemetry. The only material cost is bundle size, which is why the grammar allow-list above is a hard constraint rather than a preference: the full `highlight.js` bundle is roughly an order of magnitude larger than the fourteen registered grammars. `pnpm audit --prod --audit-level=high` covers the additions and must stay green.

No new advisory override was needed for any of them.

### Part 41 image-pipeline dependency review

Image ingestion added exactly **two** direct runtime dependencies (`sharp`, `heic-convert`) plus one `@types/*` package. Both matrix rows above carry the detail; this section is the four-point review the standard requires.

- **Need.** `Notted.md` names Sharp as the image-processing library and requires JPEG/PNG/GIF/WebP/SVG/HEIC ingestion with thumbnail/medium/full variants. Sharp covers everything except HEIC, which its prebuilt libvips genuinely cannot decode, so `heic-convert` is the minimum addition that satisfies the stated requirement rather than a convenience.
- **Maintenance.** `sharp` is one of the most widely deployed Node image libraries and was already being tracked in this repository through the Next.js override. `heic-convert` is small and infrequently released; that is a real risk, which is why it sits behind a one-file seam that can be removed without touching the pipeline.
- **Licence.** `sharp` Apache-2.0. `heic-convert` ISC, but its transitive `libheif-js@1.19.8` is **LGPL-3.0** — flagged above and in the completion record as the single item needing explicit human sign-off.
- **Security and cost.** Both are decoders operating on untrusted bytes, which is the highest-risk dependency class in this codebase. Every decode is therefore bounded before it starts: a byte cap, a `.metadata()`-first pixel and frame budget, a per-format admission gate, and a wall-clock timeout, all operator-configurable through `src/config/image-processing.config.ts`. `sharp` adds a prebuilt native binary (no compiler needed at install); `heic-convert` is pure JS/WASM with no network client and no telemetry. `pnpm audit --prod --audit-level=high` covers both and must stay green.

**Deliberately not added** (each was considered and rejected, so a later contributor does not re-litigate it):

- `file-type` — **verified ESM-only**; see the Content sniffing row above. Replaced by the first-party magic-byte sniffer.
- `dompurify` / `jsdom` / `svgo` — not needed, because SVG is **rasterized rather than sanitized and served**. Rasterization uses the librsvg already inside libvips, so it costs no dependency, and it removes the whole sanitizer-bypass CVE class instead of subscribing to it.
- `blurhash` — not needed; the placeholder is a 16 px WebP carried as a `data:` URI inside the existing attachment metadata, so it needs no decoder on the client and no extra request.
- `multer` — already rejected in the busboy row above.

## Validation evidence

- Next.js installation documentation states Node `>=20.9`, TypeScript `>=5.1`, and direct React/React DOM declarations: <https://nextjs.org/docs/app/getting-started/installation>.
- Better Auth documents a Drizzle PostgreSQL adapter and separate client/server installation: <https://www.better-auth.com/docs/installation>.
- tRPC 11 documents TanStack React Query integration: <https://trpc.io/docs/client/react/setup>.
- pnpm's compatibility table supports pnpm 10 on Node 22: <https://pnpm.io/installation#compatibility>.
- TipTap's official compatibility notice for its UI Components motivates using only the headless React packages: <https://tiptap.dev/docs/ui-components/getting-started/overview>.
- Live npm registry metadata recorded the evaluated stable releases, including Next.js `16.2.11`, NestJS `10.4.22`, Better Auth `1.6.24`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, `pg` `8.22.0`, tRPC `11.18.0`, and pnpm `10.34.5`. It confirms that Better Auth and its Drizzle adapter require Drizzle ORM `^0.45.2`, and that `@tiptap/react` `2.27.1` permits React 19 and peers with the TipTap 2 core/ProseMirror packages: <https://www.npmjs.com/package/next>, <https://www.npmjs.com/package/%40nestjs/core>, <https://www.npmjs.com/package/better-auth>, <https://www.npmjs.com/package/%40better-auth%2Fdrizzle-adapter>, <https://www.npmjs.com/package/drizzle-orm>, <https://www.npmjs.com/package/drizzle-kit>, <https://www.npmjs.com/package/pg>, <https://www.npmjs.com/package/%40trpc/react-query>, <https://www.npmjs.com/package/%40tiptap/react>, and <https://www.npmjs.com/package/pnpm>.
- A disposable pnpm `10.34.5` install with strict peer checks failed with `ERR_PNPM_PEER_DEP_ISSUES` for Better Auth `1.6.24`, Drizzle ORM `0.30.10`, and `pg` `8.16.3`: Better Auth and `@better-auth/drizzle-adapter` both required Drizzle ORM `^0.45.2`.
- A disposable pnpm `10.34.5` install with strict peer checks succeeded for Better Auth `1.6.24`, Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, and `pg` `8.22.0`, resolving 125 packages without peer errors.
- Part 41: the **installed** package manifests were read directly out of the pnpm store rather than taken from registry pages. `sharp@0.35.0` reports `license: "Apache-2.0"`, `type: "commonjs"`, `main: "./dist/index.cjs"`. `heic-convert@2.1.0` reports `license: "ISC"`, `main: "index.js"`, no `type` field and no exports map, with dependencies `heic-decode@^2.0.0`, `jpeg-js@^0.4.4`, `pngjs@^6.0.0`. Resolved transitively: `heic-decode@2.1.0` (ISC) → `libheif-js@1.19.8` (**LGPL-3.0**); `jpeg-js@0.4.4` (BSD-3-Clause); `pngjs@6.0.0` (MIT).
- Part 41: that Sharp's prebuilt libvips cannot decode HEIC is the load-bearing justification for `heic-convert` and is recorded in `apps/api/src/attachments/heic-decoder.ts` from the implementing session's probe (libvips 8.18.3; `sharp.format.heif.input.fileSuffix === [".avif"]`). A reviewer can re-confirm it in one line: `node -e "console.log(require('sharp').format.heif.input.fileSuffix, require('sharp').versions)"` inside the API container. If that probe ever reports `.heic`, this dependency should be removed — the seam is designed for exactly that outcome.

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
