# API Standard

- tRPC is the typed first-party interface; `/api/v1` REST is the public integration interface. Both reuse services and policies.
- Use shared Zod inputs where contracts are shared; never expose database-only or secret fields.
- Use stable error codes, request IDs, bounded pagination, and explicit filters/sorts.
- Avoid cross-workspace existence leaks and apply authorization before returning resources.
- Version and document breaking REST changes in OpenAPI and completion records.
- Apply idempotency to retryable side-effecting mutations and risk-based rate limits.
