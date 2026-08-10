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
    page: integerQueryValue.pipe(z.number().int().min(1)).default(1),
    limit: integerQueryValue.pipe(z.number().int().min(1).max(100)).default(25),
  })
  .strict();
export type PaginationQueryInput = z.input<typeof paginationQuerySchema>;

export const explicitBooleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export type ExplicitBooleanQueryInput = z.input<typeof explicitBooleanQuerySchema>;

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
