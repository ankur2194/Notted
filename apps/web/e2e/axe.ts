import { expect, type Page } from "@playwright/test";

/**
 * Runs axe-core against a live page and fails the test on what actually blocks
 * someone.
 *
 * NOT a `*.spec.ts`: `playwright.config.ts` would collect it as a test file.
 * Follows the `./mailpit.ts` and `./accounts.ts` precedent — plain module, no
 * `test.*` calls.
 *
 * **Why the bundled script rather than `@axe-core/playwright`.** `axe-core` was
 * already resolvable in this workspace (a transitive dependency of
 * `eslint-plugin-jsx-a11y`), so pinning it directly adds a version to ADR 0008's
 * matrix — see its "Part 76 accessibility-tooling dependency review" — and
 * nothing else — no new transitive tree, no wrapper whose API drifts
 * from axe's own. The wrapper's whole job is `addScriptTag` plus `evaluate`,
 * which is the ten lines below.
 *
 * **Why serious and critical only.** An axe `impact` of `minor` or `moderate` is
 * routinely a duplicate landmark or a redundant title — worth fixing, not worth
 * failing a browser run that already costs minutes. The two levels kept here are
 * the ones that mean a person using a screen reader, a keyboard, or a
 * high-contrast theme cannot complete the task at all. A `null` impact gates
 * too: axe leaves `impact` null when it cannot grade a finding, and treating
 * "ungraded" as "harmless" is the one reading of it that can only ever hide
 * things.
 */

/**
 * The bundled build, resolved through Node rather than hard-coded, so pnpm's
 * store layout stays pnpm's business. Requires `axe-core` to be a direct
 * devDependency of `apps/web`: under pnpm's strict layout a transitive
 * dependency is not linked into `apps/web/node_modules` and this throws.
 *
 * Resolved per call, not at module load. Playwright imports every spec file to
 * collect it, so a throw at import time would take the whole browser suite down
 * over a missing install instead of failing the scans that actually need it.
 */
function axeBundlePath(): string {
  // `require.resolve`, NOT `createRequire(import.meta.url)`. Playwright
  // transpiles specs to CommonJS here — `apps/web` is not `"type": "module"` —
  // so `import.meta` is a *syntax* error at run time, which takes down every
  // spec that imports this file before a single test is collected. The
  // transpiled module has `require`, and it resolves from this file's directory,
  // which is exactly the anchor `createRequire` was reaching for.
  return require.resolve("axe-core/axe.min.js");
}

/**
 * The conformance target, and nothing else.
 *
 * `best-practice` and every `*aaa` tag are deliberately absent. A best-practice
 * finding is advice — axe's own opinion about markup it would have written
 * differently — and an AAA finding is a level Notted has never claimed. Neither
 * is a conformance failure, so neither may fail a run: a suite that cries wolf
 * about advice is a suite people stop reading.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/**
 * Rules that axe files under `best-practice` but that are `serious` here.
 *
 * Excluding the whole `best-practice` tag is right for the advice it mostly
 * contains and wrong for these two, both of which describe a control a screen
 * reader announces with no name at all:
 *
 *  - `aria-treeitem-name` — `apps/web/src/components/notes/NoteTree.tsx` renders
 *    `role="treeitem"`, and the note tree is the primary navigation of the app.
 *  - `aria-dialog-name` — every modal in the product.
 *
 * Run as a SECOND pass with `runOnly: { type: "rule" }` rather than by widening
 * `WCAG_TAGS`, so the rest of `best-practice` stays out and this list remains a
 * short, reviewable enumeration of deliberate exceptions.
 */
const EXTRA_RULES = ["aria-treeitem-name", "aria-dialog-name"] as const;

/** Only what has to survive `page.evaluate`'s structured clone. */
interface AxeViolationNode {
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeViolationNode[];
}

/** The injected global. Untyped in the browser, narrowed to exactly this. */
interface AxeGlobal {
  run(
    context: unknown,
    options: unknown,
  ): Promise<{
    readonly violations: readonly AxeViolation[];
    /** Checks axe could not decide — every undecidable `color-contrast` case. */
    readonly incomplete: readonly AxeViolation[];
  }>;
}

/**
 * A finding that is knowingly not fixed yet.
 *
 * Every field is required because every one of them is what makes the entry
 * reviewable a year from now: `ruleId` and `surface` say what is suppressed and
 * where, `successCriterion` says which WCAG 2.2 clause is at stake,
 * `rationale` says why shipping it was acceptable, and `removedBy` names the
 * change that deletes the entry. An entry that cannot fill all five is not an
 * accepted violation, it is an unfixed bug.
 *
 * **Never** silence a finding with axe's own `rules: { <id>: { enabled: false } }`.
 * A disabled rule produces no result at all, so the next reader has no evidence
 * it was ever considered and no way to notice when it stops being true. An
 * allowlisted one still runs, still matches, and is printed by `scan` on every
 * single run — which is the difference between a decision and an omission.
 */
export interface AcceptedViolation {
  readonly ruleId: string;
  readonly surface: string;
  readonly successCriterion: string;
  readonly rationale: string;
  readonly removedBy: string;
}

/**
 * Empty, and that is the intended steady state.
 *
 * Typed rather than `as const` so `[]` still carries `AcceptedViolation`'s
 * shape: a bare `[] as const` infers `readonly []`, whose members are `never`,
 * and the subtraction below would not type-check against it.
 */
export const ACCEPTED_VIOLATIONS: readonly AcceptedViolation[] = [];

export async function scan(
  page: Page,
  options: {
    readonly surface: string;
    /** CSS selector limiting the scan, e.g. `'[role="dialog"]'`. */
    readonly include?: string;
    /** CSS selectors cut out of the scan. */
    readonly exclude?: readonly string[];
  },
): Promise<void> {
  // `script-src` is `'self' 'unsafe-inline'` (see `apps/web/security-headers.js`),
  // so an injected inline tag is allowed and needs no `bypassCSP` context flag.
  await page.addScriptTag({ path: axeBundlePath() });

  const { violations, incomplete } = await page.evaluate(
    async ({
      include,
      exclude,
      tags,
      rules,
    }: {
      readonly include: string | null;
      readonly exclude: readonly string[];
      readonly tags: readonly string[];
      readonly rules: readonly string[];
    }): Promise<{
      readonly violations: readonly AxeViolation[];
      readonly incomplete: readonly AxeViolation[];
    }> => {
      const axe = (window as unknown as { readonly axe: AxeGlobal }).axe;
      const context =
        include === null && exclude.length === 0
          ? document
          : {
              ...(include === null ? {} : { include: [[include]] }),
              ...(exclude.length === 0 ? {} : { exclude: exclude.map((selector) => [selector]) }),
            };
      // Re-projected rather than returned whole: an axe result carries DOM
      // snapshots and `related` cycles that no structured clone survives.
      const project = (violation: AxeViolation): AxeViolation => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({ target: node.target.map(String) })),
      });
      const conformance = await axe.run(context, { runOnly: { type: "tag", values: tags } });
      // Second pass: the named best-practice rules. Two runs, not a widened tag
      // list, so the rest of `best-practice` stays advisory.
      const named = await axe.run(context, { runOnly: { type: "rule", values: rules } });
      const seen = new Set(conformance.violations.map((violation) => violation.id));
      return {
        violations: [
          ...conformance.violations,
          ...named.violations.filter((violation) => !seen.has(violation.id)),
        ].map(project),
        incomplete: [...conformance.incomplete, ...named.incomplete].map(project),
      };
    },
    {
      include: options.include ?? null,
      exclude: options.exclude ?? [],
      tags: WCAG_TAGS,
      rules: EXTRA_RULES,
    },
  );

  // REPORTED, NEVER GATED. `incomplete` is what axe could not decide — almost
  // always `color-contrast` over a gradient, an image, or a partly transparent
  // background, which it cannot compute from the DOM. Silently discarding it
  // (which this helper used to do) means contrast — a criterion this part is
  // explicitly about — could be entirely undecidable on a surface and the run
  // would still read as a clean pass. It cannot fail a run because axe is not
  // claiming a failure; a human has to look.
  for (const item of incomplete) {
    console.log(
      `axe: undecided on ${options.surface} — ${item.id} (${item.impact ?? "ungraded"}) @ ` +
        `${item.nodes.map((node) => node.target.join(" ")).join(", ")} — ${item.help}`,
    );
  }

  const blocking = violations.filter(
    (violation) =>
      violation.impact === "serious" ||
      violation.impact === "critical" ||
      // Ungraded. A rule that matched but carries no impact is still a matched
      // rule; reading `null` as "not serious" would be axe's silence deciding
      // the question.
      violation.impact === null,
  );

  // Subtracted AFTER the run, and announced every time. An accepted violation
  // that stops being reported here is an accepted violation someone can delete.
  const remaining = blocking.filter((violation) => {
    const accepted = ACCEPTED_VIOLATIONS.find(
      (entry) => entry.ruleId === violation.id && entry.surface === options.surface,
    );
    if (accepted === undefined) return true;
    console.log(
      `axe: accepted violation on ${options.surface} — ${accepted.ruleId} ` +
        `(${accepted.successCriterion}): ${accepted.rationale}. Removed by: ${accepted.removedBy}.`,
    );
    return false;
  });

  const failures = remaining.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id} @ ${node.target.join(" ")} — ${violation.help}`),
  );

  expect(
    failures,
    `axe found serious or critical WCAG 2.2 AA violations on ${options.surface}:\n${failures.join("\n")}`,
  ).toEqual([]);
}
