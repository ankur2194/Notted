# Third-Party Notices

Notted is built on open-source software. This file is the project's attribution artifact: it records the third-party components whose licences impose obligations Notted must actively keep meeting, together with the direct runtime dependencies of the parts that introduced them. **Update it whenever a new runtime dependency enters the tree whose licence is not MIT, ISC, BSD (2- or 3-Clause), or Apache-2.0** — that is, any copyleft or unusual licence — and whenever an existing entry's version changes. The re-audit command in [Re-auditing for new copyleft](#re-auditing-for-new-copyleft) is how you find out.

**Scope.** This file covers (a) every copyleft component reachable from the production dependency graph and (b) the direct runtime dependencies added by Plan parts 40–44. It deliberately does **not** enumerate the full transitive tree, which runs to thousands of packages; that tree is fully reproducible from [`pnpm-lock.yaml`](pnpm-lock.yaml), which is the authoritative record of exactly what is installed.

**Verification method.** Every package name, version, and licence identifier below was read from the installed package manifests in `node_modules/.pnpm/*/node_modules/*/package.json` on 2026-08-07, not from registry web pages or from memory. Bundled-library inventories were read from the packages' own shipped `README.md`, `LICENSE`, and `versions.json` files.

**This is a documented engineering position recorded for traceability, not legal advice.** It reflects how the project understands its obligations and how it intends to keep meeting them. It has not been reviewed by counsel.

---

## Copyleft components

Two components in the production graph are licensed under the **GNU Lesser General Public License v3**, and both arrive as prebuilt binary payloads inside otherwise permissively licensed npm packages. **Both were reviewed and signed off by the project owner on 2026-08-07, decision: keep.** Both are treated under the same analysis and the same three ongoing obligations, set out in [Ongoing obligations](#ongoing-obligations) below.

### 1. `libheif-js@1.19.8` — LGPL-3.0

| | |
|---|---|
| **Package** | `libheif-js` |
| **Version** | `1.19.8` |
| **Licence** | `LGPL-3.0` (as declared in its `package.json`) |
| **Upstream npm package repository** | <https://github.com/catdad-experiments/libheif-js> |
| **Upstream `libheif` project** | <https://github.com/strukturag/libheif> |
| **How it enters the tree** | Transitively, and only transitively: `@notted/api` → `heic-convert@2.1.0` (ISC) → `heic-decode@2.1.0` (ISC) → **`libheif-js@1.19.8`** |
| **Licence text in the installed package** | `node_modules/libheif-js/LICENSE`, `node_modules/libheif-js/libheif/LICENSE`, `node_modules/libheif-js/libheif-wasm/LICENSE` |
| **Why Notted uses it** | The prebuilt libvips shipped with `sharp` cannot decode HEIC (see ADR 0008). `Notted.md` requires HEIC ingestion, so the decode happens in JavaScript. Every reference lives in the single file `apps/api/src/attachments/heic-decoder.ts`. |

**What the package actually contains.** `libheif-js` ships `index.js`, `wasm.js`, `wasm-bundle.js`, `libheif/libheif.js` (a ~2.1 MB asm.js build) and `libheif-wasm/libheif.wasm` (~1.0 MB) plus loaders. **libheif is compiled to WebAssembly and asm.js by Emscripten and bundled inside the npm package.** libheif is therefore statically linked into that blob — but the blob is the package, and Notted's own code is never compiled into it.

**On seeing "GNU GENERAL PUBLIC LICENSE" in these files — this is expected and is not a second licence.** `libheif/LICENSE` and `libheif-wasm/LICENSE` carry upstream libheif's own notice, which states that *"the library `libheif` is distributed under the terms of the GNU Lesser General Public License. The sample applications and the Go and C++ wrappers are distributed under the terms of the MIT License."* Both files also contain the full GPL-3.0 text. That is by design: **LGPL-3.0 is drafted as a short set of additional permissions layered on top of GPL-3.0**, so the GPL-3.0 text always ships alongside it and is incorporated by reference. Finding that string here does not mean any part of Notted is subject to the GPL.

**No GPL-only encoder is bundled.** libheif's HEIC *encoding* path would pull in x265 (GPL-2.0), which would be a materially different licence situation. This build is decode-only for Notted's purposes, and no x265, kvazaar, or AOM notice appears anywhere in the package's licence files. Verified on 2026-08-07:

```bash
grep -ioE "x265|kvazaar|aom|dav1d|svt-av1" \
  node_modules/.pnpm/libheif-js@1.19.8/node_modules/libheif-js/LICENSE \
  node_modules/.pnpm/libheif-js@1.19.8/node_modules/libheif-js/libheif/LICENSE \
  node_modules/.pnpm/libheif-js@1.19.8/node_modules/libheif-js/libheif-wasm/LICENSE
# exit status 1 — no matches
```

### 2. `@img/sharp-libvips-linux-x64@1.3.0` — LGPL-3.0-or-later

| | |
|---|---|
| **Package** | `@img/sharp-libvips-linux-x64` (and the equivalent package for any other platform the project builds for) |
| **Version** | `1.3.0` |
| **Licence** | `LGPL-3.0-or-later` (as declared in its `package.json`) |
| **Upstream repository** | <https://github.com/lovell/sharp-libvips> |
| **Upstream `libvips` project** | <https://github.com/libvips/libvips> |
| **How it enters the tree** | Transitively: `@notted/api` → `sharp@0.35.0` (Apache-2.0) → `@img/sharp-linux-x64@0.35.0` → **`@img/sharp-libvips-linux-x64@1.3.0`**. The same package is also reached through the reviewed `next@16.2.11 > sharp` override. |
| **Licence text in the installed package** | **The package ships no `LICENSE` file.** Its licensing notice is the "Licensing" table in `node_modules/@img/sharp-libvips-linux-x64/README.md`; the bundled library versions are in `versions.json`. Full licence texts must be obtained from the upstream projects. |

**What the package actually contains.** A single 18 MB prebuilt shared object, `lib/libvips-cpp.so.8.18.3`, into which libvips 8.18.3 and roughly thirty of its dependencies are statically linked. Per the package's own `README.md`, the following bundled libraries are **LGPLv3**: `libvips`, `glib`, `fribidi`, `libexif`, **`libheif`**, `librsvg`, `pango`, and `proxy-libintl`. `cairo` is **MPL-2.0**. The remainder are permissive (MIT, BSD, zlib, libpng, freetype, fontconfig, IJG). The package notes that the LGPLv3 use is via the "any later version" clause of LGPLv2/LGPLv2.1.

Two consequences worth recording, because both are easy to get wrong:

- **This build contains libheif 1.23.0** (`versions.json`), yet `sharp` still cannot decode HEIC here. That is not a contradiction: the bundled libheif is built with AV1 support (`aom` 3.14.1) but **no HEVC/H.265 decoder**, so it decodes AVIF and not HEIC. This is the underlying reason for the `sharp.format.heif.input.fileSuffix === [".avif"]` probe result recorded in ADR 0008 and in `heic-decoder.ts`, and it confirms rather than undermines the need for `heic-convert`.
- **`aom` is BSD-2-Clause plus the AOM patent licence, not GPL.** The "no GPL-only encoder" finding holds for this package as well.

> **Sign-off status — signed off 2026-08-07, decision: keep.** The owner's initial decision that day was scoped to `libheif-js`, which was believed at the time to be the only copyleft package in the tree. This package was surfaced immediately afterwards by the re-audit command below, and the owner extended the same sign-off to cover it. The structural analysis and the three obligations below apply to it identically — it is an unmodified, separately replaceable npm package loaded from `node_modules` at run time.
>
> One consequence is worth stating plainly, because it removes an option that looks available: **dropping HEIC support would not remove LGPL code from the tree.** This package arrives with `sharp`, which `Notted.md` names as the project's image-processing library, and it predates the Part 41 image work — it was already present through the reviewed `next > sharp` override. A genuinely copyleft-free tree would require dropping `sharp` itself, and with it the entire image pipeline. The `heic-convert` seam remains a one-file removal if HEIC is ever unwanted, but that is a feature decision, not a licence one.

### Non-LGPL copyleft: `lightningcss` — MPL-2.0 (triaged, no obligation in the shipped product)

`lightningcss@1.33.0` and `lightningcss-linux-x64-gnu@1.33.0` are **MPL-2.0** and appear in the re-audit output. They are reached only through frontend build and test tooling (`@tailwindcss/postcss`, `vite`, `vitest`); they are not imported by `apps/api`, not loaded at run time, and not part of the deployed artifact. They surface in the audit because the command errs toward over-inclusion (see the note under the command). MPL-2.0 is **file-level** copyleft: the obligation attaches only to modified MPL-covered files, and Notted modifies none. Recorded here so a future auditor does not have to re-triage it.

---

## Ongoing obligations

These are **standing rules, not one-time chores.** They apply to both LGPL components above, for as long as they remain in the tree.

### Why the analysis reaches "keep it"

1. **LGPL obligations trigger on conveying (distribution), not on use.** LGPL-3.0 is not AGPL-3.0: it has no network-use clause. Running the library on a server to answer requests is not conveying, and Notted's API is server-side. Where Notted *does* convey — self-hosted Docker images, source tarballs, anything handed to a third party — the obligations below apply in full.
2. **The relinking obligation is satisfied structurally.** LGPL-3.0 §4 permits satisfying the "the user must be able to relink against a modified version of the library" requirement by using a suitable **shared** library mechanism that operates at run time. Both packages are `require()`d as separate, unmodified npm packages resolved from `node_modules` at run time. libheif is statically linked into the WASM blob *inside* `libheif-js`, and libvips is statically linked into the `.so` *inside* `@img/sharp-libvips-linux-x64` — but in neither case is any Notted code combined into that blob. The unit a user replaces is the whole npm package, and swapping `node_modules/libheif-js` (or the libvips package) for a locally built one requires no change to, and no recompilation of, Notted. That is the JavaScript equivalent of dynamic linking. **This is a reasoned position, not a court holding.**
3. **Nothing propagates into Notted's own source.** No LGPL code is copied into `apps/api`. The interface Notted programs against is `heic-convert`'s ISC-licensed API and `sharp`'s Apache-2.0 API; the LGPL components sit two levels below that boundary.

### The three rules

1. **Do not modify these packages.** No patches, no `pnpm.patchedDependencies` entry, no vendoring, no post-install rewriting. If that ever changes, this analysis changes with it, and the modified library source must be published under the LGPL.
2. **Ship the notice.** This file, the licence texts, and the upstream source locations must travel with anything Notted distributes — release tarballs, self-host bundles, and container images alike.
   **Written offer of source.** Complete corresponding source for `libheif-js@1.19.8` is available from <https://github.com/catdad-experiments/libheif-js> and, for the underlying library, <https://github.com/strukturag/libheif>. Complete corresponding source for `@img/sharp-libvips-linux-x64@1.3.0` is available from <https://github.com/lovell/sharp-libvips> and, for the underlying library, <https://github.com/libvips/libvips>. The project will additionally provide the corresponding source for these components, on the medium customarily used for software interchange, to anyone who requests it from the project owner.
3. **Keep them replaceable.** Do not bundle, inline, or minify these packages into a single-file artifact, and do not strip them out of the runtime image in a way that prevents substitution. This holds today because `apps/api` is deployed as an ordinary Node application with a populated `node_modules` directory, so a user can replace either package in place.

> ### ⚠️ The one change that would break this
>
> **Introducing a bundler for `apps/api` — esbuild, `ncc`, `webpack`, `bun build`, or any other single-file / standalone-binary output — would collapse Notted's code and its dependencies into one artifact and destroy the "separately replaceable package" property that obligation 3 rests on.** At that point the LGPL relinking analysis above no longer holds and **must be redone before shipping**, which in practice means either providing relinkable object code, keeping these packages external to the bundle, or dropping them.
>
> The same applies to any move to a fully static or "distroless-with-no-node_modules" packaging strategy. If you are reading this while planning a build-tooling change to `apps/api`, this is the paragraph that concerns you.

---

## Direct runtime dependencies added by Plan parts 40–44

Versions and licence identifiers below were read from the installed manifests in `node_modules/.pnpm/*/node_modules/*/package.json` on 2026-08-07, and the Part 44 row on 2026-08-08.

| Package | Version | Licence | Relationship |
|---|---|---|---|
| `sharp` | `0.35.0` | Apache-2.0 | Direct dependency of `@notted/api` (image processing). Pulls the LGPL `@img/sharp-libvips-linux-x64` above. |
| `busboy` | `1.6.0` | MIT | Direct dependency of `@notted/api` (streaming multipart upload parser). |
| `heic-convert` | `2.1.0` | ISC | Direct dependency of `@notted/api` (HEIC → JPEG). Pulls the LGPL `libheif-js` above. |
| `heic-decode` | `2.1.0` | ISC | Transitive, via `heic-convert`. |
| `jpeg-js` | `0.4.4` | BSD-3-Clause | Transitive, via `heic-convert`. |
| `pngjs` | `6.0.0` | MIT | Transitive, via `heic-convert`. |
| `pdfjs-dist` | `5.6.205` | Apache-2.0 | Direct dependency of `@notted/web` (Part 44 in-app PDF attachment preview, rendered to `<canvas>`). Loaded only through a dynamic `import()`. **No new copyleft**, and it introduces no obligation beyond Apache-2.0 attribution, which this row discharges. The package ships its own `LICENSE` (the Apache-2.0 text) and **no `NOTICE` file**, so Apache-2.0 §4(d) adds nothing further to reproduce. |

Type-only packages (`@types/busboy`, `@types/heic-convert`) are DefinitelyTyped and MIT-licensed; they are development dependencies and are not present at run time.

---

## Re-auditing for new copyleft

Run from the repository root. It lists every package in the production graph whose declared licence looks copyleft, and prints a count to stderr.

```bash
pnpm licenses list --prod --json | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const groups = JSON.parse(s);
  const hits = [];
  for (const [licence, packages] of Object.entries(groups)) {
    if (!/GPL|MPL|EPL|CDDL|SSPL|CC-BY-SA/i.test(licence)) continue;
    for (const p of packages) hits.push(licence + "\t" + p.name + "@" + (p.versions || []).join(","));
  }
  hits.sort().forEach((h) => console.log(h));
  console.error(hits.length + " copyleft package(s) found");
});'
```

Verified output on 2026-08-07:

```
LGPL-3.0	libheif-js@1.19.8
LGPL-3.0-or-later	@img/sharp-libvips-linux-x64@1.3.0
MPL-2.0	lightningcss-linux-x64-gnu@1.33.0
MPL-2.0	lightningcss@1.33.0
4 copyleft package(s) found
```

Notes on reading the output:

- **The command errs toward over-inclusion, by design.** `pnpm licenses list --prod` resolves through peer and optional edges, so packages that are only ever used by build or test tooling can still appear (`lightningcss` is exactly this case). **Triage each hit** — establish whether it is actually loaded at run time or shipped — rather than assuming every line is an obligation. Over-reporting is the safe failure mode for a compliance check.
- **It reads declared `license` fields only.** It cannot see a library statically linked *inside* a permissively licensed package. `@img/sharp-libvips-linux-x64` happens to declare LGPL honestly; a package that did not would be invisible to this command. Any new dependency that ships a prebuilt native binary or WASM blob deserves a manual look at its `README`, `LICENSE`, and any `versions.json`.
- If a new line appears that is not documented above, **add it to this file before merging**, and record the licence decision in `docs/decisions/`.

---

## Related records

- [`docs/decisions/0008-runtime-and-package-compatibility.md`](docs/decisions/0008-runtime-and-package-compatibility.md) — the runtime and package matrix, the HEIC decoder rationale, and the recorded LGPL sign-off.
- [`docs/completed-parts/part-41-image-ingestion-processing.md`](docs/completed-parts/part-41-image-ingestion-processing.md) — the image ingestion part record.
- [`apps/api/src/attachments/heic-decoder.ts`](apps/api/src/attachments/heic-decoder.ts) — the single import site for the HEIC decoder.
- [`pnpm-lock.yaml`](pnpm-lock.yaml) — the authoritative record of the full installed dependency tree.
