# Backend Standard

- Preserve NestJS modules and named files from `Notted.md`; add internal layers only when complexity warrants them.
- Controllers, tRPC procedures, gateways, and processors validate/authenticate, call services, and map results.
- Application services own policies, invariants, transactions, and side-effect coordination.
- Adapters own Drizzle and provider clients; raw provider responses do not become domain contracts.
- Use dependency injection, typed configuration, timeouts, bounded retries, and graceful shutdown.
- Use stable safe errors and structured redacted logs with request/job IDs.
- Make jobs, webhooks, emails, exports, and indexing idempotent.
