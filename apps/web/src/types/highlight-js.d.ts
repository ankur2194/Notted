/**
 * `highlight.js` ships per-language modules under `lib/languages/*` but no
 * matching declaration files, so importing one individually is untyped. The
 * package does publish the `LanguageFn` contract those modules satisfy, so the
 * wildcard declaration below types them precisely instead of leaving them
 * implicitly `any`.
 *
 * Only individual language modules are declared: the full `highlight.js`
 * bundle must never be imported into the client bundle.
 */
declare module "highlight.js/lib/languages/*" {
  import type { LanguageFn } from "highlight.js";

  const language: LanguageFn;
  export default language;
}
