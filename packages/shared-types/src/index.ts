/**
 * @notted/shared-types
 *
 * Framework-neutral TypeScript domain contracts shared across apps/web and
 * apps/api. Per ADR 0001, this package owns output/domain contracts that are not
 * more safely inferred from Zod schemas; database rows, provider SDK objects,
 * secrets, NestJS types, and React types are intentionally excluded.
 *
 * The full domain contract set (user, workspace, project, note, attachment,
 * search, task, pagination/sort, API responses) is introduced in Part 6. This
 * barrel exposes the small set of constants that are safe to share beforehand
 * and lets later parts prove workspace resolution.
 */

/** Product/application display name. */
export const APP_NAME = "Notted" as const;
