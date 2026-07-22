# ADR 0002: Separate first-party tRPC and public REST transports

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 5, 6, 24, 61, 62, 84

## Context

The product brief names tRPC as the application API protocol and also requires a REST API for API keys, integrations, and webhooks. Implementing business rules separately in the two transports would create inconsistent authorization, tenancy, validation, and side effects.

## Decision

The NestJS application owns both interfaces:

- tRPC is the typed interface for the first-party Next.js application. Its contracts may evolve with the web application and are not a public compatibility promise.
- Versioned REST under `/api/v1` is the public and integration interface. It is documented with OpenAPI and follows an explicit compatibility and deprecation policy.
- Next.js route handlers remain minimal browser-framework adapters only where required; they do not become a second backend.
- Controllers and procedures authenticate, validate and normalize input, establish request context, call the same NestJS application services and policies, and map results to transport-specific responses. They contain no domain or persistence rules.
- Shared contracts use Zod where the same input or output crosses both transports. Database rows, provider responses, secrets, and internal error details are never transport contracts.

Every workspace-owned operation receives authenticated actor and workspace context. Application services authorize the action and prove the resource belongs to that workspace before reading or mutating it. Client-supplied workspace or resource IDs are selectors, not authority. Denials use stable errors that do not reveal whether a cross-workspace resource exists.

For mutations, the application service owns invariants and the database transaction. Retryable side effects require an idempotency key; durable jobs or events are recorded transactionally and dispatched only after commit. Request and correlation IDs flow through services and side effects, with sensitive input redacted from logs.

## Alternatives considered

- **tRPC only:** simpler initially, but does not provide the stable public integration surface required by the product.
- **REST only:** removes duplicate transports, but gives up the intended end-to-end typed first-party interface.
- **Independent tRPC and REST implementations:** rejected because authorization and behavior would drift.
- **Business APIs in Next.js route handlers:** rejected because it splits backend ownership and bypasses shared NestJS policies.

## Consequences

- New behavior is implemented once in an application service and contract-tested through both transports when exposed by both.
- REST breaking changes require a new API version or documented deprecation; tRPC changes are coordinated with the web deployment.
- Authentication mechanisms may differ by transport, but both produce the same actor/workspace authorization context.
- Rate limits, pagination, error envelopes, and idempotency rules can differ at the edge without changing domain behavior.

## Migration and rollback impact

This records a boundary before API implementation, so no data migration is required. A future boundary change must preserve existing REST versions during migration and receive a superseding ADR. Rollback consists of disabling an individual transport while retaining shared services; it must not duplicate domain logic elsewhere.
