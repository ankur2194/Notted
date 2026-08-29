import { z } from "zod";

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

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
 * choose — project colours (Part 32) and the Part 72 workspace accent — so a
 * value accepted by one surface is accepted by the other and
 * `color-contrast.ts` can assume the shape it parses.
 *
 * Deliberately NOT the three-digit or eight-digit form: the persisted values,
 * the seeded fixtures, and the email branding parser are all six-digit, and
 * accepting alpha would let a workspace pick a transparent accent that fails
 * contrast in a way no ratio can describe.
 */
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit hex color");

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

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
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
