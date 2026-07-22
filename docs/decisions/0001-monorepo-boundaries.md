# ADR 0001: pnpm and Turborepo monorepo boundaries

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 2, 4, 5, 6

## Context

Notted contains a Next.js web application, a NestJS API and worker runtime, and contracts that both applications consume. The repository needs reproducible dependency management without allowing framework details or secret-bearing persistence models to leak into shared packages.

## Decision

Use one pnpm workspace coordinated by Turborepo. Preserve the canonical roots in `Notted.md`: `apps/web`, `apps/api`, `packages/shared-types`, and `packages/shared-validators`. Applications are independently buildable and deployable; packages publish stable public exports and must not import from either application.

Dependencies flow from applications toward shared packages. `shared-validators` owns cross-boundary Zod schemas and inferred input types; `shared-types` owns framework-neutral output and domain contracts that are not more safely inferred from a schema. Database rows, provider SDK objects, secrets, NestJS types, and React types remain outside shared contracts.

Turborepo orchestrates tasks and caching, while pnpm owns the lockfile and workspace graph. Each deployable application declares its direct runtime dependencies. Root scripts are convenience entry points, not hidden build logic.

## Tenancy and data flow

Shared contracts may carry workspace identifiers but never establish authorization. Browser requests enter a typed or public transport in `apps/api`; authenticated NestJS services and policies establish workspace scope before persistence or provider access. No package can bypass that backend boundary.

## Alternatives considered

- Separate repositories: rejected because atomic contract changes and a single reproducible development workflow are valuable at this stage.
- Framework-owned shared code inside `apps/web`: rejected because it would invert dependencies and couple backend contracts to Next.js.
- Nx: capable, but adds a second project model where pnpm plus Turborepo is sufficient for the specified structure.

## Consequences

Parts 2 and 6 must define package exports and task dependencies explicitly. Cyclic imports and application-to-application source imports are prohibited. A future split into separate repositories would require publishing the shared contracts but does not change their ownership.

## Migration and rollback

There is no current application code to migrate. Replacing the workspace tool later requires an ADR and equivalent lockfile, task, and package-boundary guarantees.
