import { z } from "zod";

// Imported, not redeclared. This package validates the contracts
// `@notted/shared-types` declares, so the recursive JSON type has exactly one
// definition and cannot drift from the one the API and web clients compile
// against. ADR 0001 permits packages to depend on packages.
import type { JsonValue } from "@notted/shared-types";

const integerQueryValue = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/, "Expected a base-10 non-negative integer")
    .transform((value) => Number(value)),
]);

export const uuidSchema = z.string().uuid();
export type UuidInput = z.input<typeof uuidSchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Use letters, numbers, dots, underscores, colons, or hyphens");

/**
 * Shared tag-assignment rule for every tagged entity (`note_tags`,
 * `task_tags`). Lives here so notes and tasks cannot drift apart on the bound
 * or the duplicate rule.
 */
export const tagIdsSchema = z
  .array(uuidSchema)
  .max(50)
  .refine((items) => new Set(items).size === items.length, {
    message: "Tag identifiers must be unique",
  });

export const isoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestampInput = z.input<typeof isoTimestampSchema>;

/**
 * Six-digit hex colour, `#rrggbb`. One definition for every colour a tenant can
 * choose — project colours (Part 32), task status colours, tag colours, note
 * highlights, and the Part 72 workspace accent — so a value accepted by one
 * surface is accepted by the others and `color-contrast.ts` can assume the
 * shape it parses.
 *
 * Deliberately NOT the three-digit or eight-digit form: the persisted values,
 * the seeded fixtures, and the email branding parser are all six-digit, and
 * accepting alpha would let a workspace pick a transparent accent that fails
 * contrast in a way no ratio can describe.
 *
 * The pattern is exported because four other modules need the rule itself, not
 * a Zod schema, and they had already drifted while restating it:
 * `TAG_COLOR_PATTERN` carried no `i` flag where the rest did, so `#FFF000`
 * reached `tagColorSchema` only because that schema happens to `.toLowerCase()`
 * first. Delete that one normalisation and two rules that read identically
 * would silently disagree.
 */
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

export const hexColorSchema = z.string().regex(HEX_COLOR_PATTERN, "Expected a six-digit hex color");

export const sortDirectionSchema = z.enum(["asc", "desc"]);
export const sortSchema = z
  .object({
    field: z.string().trim().min(1).max(64),
    direction: sortDirectionSchema.default("asc"),
  })
  .strict();
export type SortInput = z.input<typeof sortSchema>;

/**
 * Query-only numeric coercion. Body schemas use plain z.number/z.boolean and
 * therefore never accept string lookalikes.
 */
export const paginationQuerySchema = z
  .object({
    page: integerQueryValue.pipe(z.number().int().min(1).max(10_000)).default(1),
    limit: integerQueryValue.pipe(z.number().int().min(1).max(100)).default(25),
  })
  .strict();
export type PaginationQueryInput = z.input<typeof paginationQuerySchema>;

export const explicitBooleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export type ExplicitBooleanQueryInput = z.input<typeof explicitBooleanQuerySchema>;

/**
 * A completed-out-of-total counter. One shape for every progress reading in the
 * product (inline checklists, task rows) so two surfaces can never disagree on
 * the field names or on whether the numbers may be fractional.
 */
export const progressSchema = z
  .object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type ProgressInput = z.input<typeof progressSchema>;

/**
 * Bounds on arbitrary JSON, because this schema is published from the barrel as
 * the package's answer to "validate any JSON".
 *
 * The recursive `z.lazy` union underneath has no depth, breadth or length limit
 * of its own: measured, it accepted 10 000-deep nesting in 14 ms and a
 * 200 000-key object in 162 ms without complaint. Its only consumer today is
 * `auditLogEntrySchema.metadata`, which is server-produced and redacted before
 * it is ever stored — so this is not a live vector. But the first consumer that
 * points it at request input inherits an unbounded parse, and nothing in the
 * type or the name warns them.
 *
 * The numbers are deliberately generous: audit metadata is a flat-ish bag of
 * identifiers and short strings, so anything that trips these is not metadata.
 *
 * ponytail: a hand-written walk rather than Zod combinators, because Zod
 * recursion has no depth knob — the same reason `document.schema.ts` validates
 * its tree by hand. Upgrade path if this ever needs per-consumer limits: take
 * them as parameters and export a factory instead of a singleton.
 */
export const JSON_VALUE_LIMITS = {
  maxDepth: 32,
  maxKeys: 1_000,
  maxItems: 1_000,
  maxStringLength: 16_384,
} as const;

function jsonValueWithinBounds(value: unknown, depth: number): boolean {
  if (depth > JSON_VALUE_LIMITS.maxDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= JSON_VALUE_LIMITS.maxStringLength;
  if (Array.isArray(value)) {
    return (
      value.length <= JSON_VALUE_LIMITS.maxItems &&
      value.every((item) => jsonValueWithinBounds(item, depth + 1))
    );
  }
  // Plain objects only. `Object.entries(new Date())` is `[]`, so a bare
  // `typeof value === "object"` would call a Date valid JSON — which is what
  // the union this replaced correctly refused.
  if (typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const entries = Object.entries(value);
  return (
    entries.length <= JSON_VALUE_LIMITS.maxKeys &&
    entries.every(
      ([key, item]) =>
        key.length <= JSON_VALUE_LIMITS.maxStringLength && jsonValueWithinBounds(item, depth + 1),
    )
  );
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => jsonValueWithinBounds(value, 0),
  { message: "Expected JSON within the depth, breadth, and length bounds" },
);
export type JsonValueInput = z.input<typeof jsonValueSchema>;

export const dateRangeQuerySchema = z
  .object({
    from: isoTimestampSchema.optional(),
    to: isoTimestampSchema.optional(),
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || Date.parse(from) <= Date.parse(to),
    {
      message: "from must be earlier than or equal to to",
      path: ["to"],
    },
  );
export type DateRangeQueryInput = z.input<typeof dateRangeQuerySchema>;
