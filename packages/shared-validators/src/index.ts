/**
 * @notted/shared-validators
 *
 * Cross-boundary Zod schemas and inferred input types. Per ADR 0001, this
 * package owns the shared validation contracts and never imports from either
 * application. Zod itself and the schema set (auth, workspace, project, note,
 * common) are introduced in Part 6, so this barrel is intentionally empty until
 * then: it lets the package build and type-check today without pre-empting the
 * Part 6 contract decisions.
 */

export {};
