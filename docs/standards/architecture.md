# Architecture Standard

- `Notted.md` is canonical for named project structure.
- Direct dependencies from UI/transport toward application/domain abstractions, never from domain logic toward framework adapters.
- tRPC and REST reuse NestJS application services and policies.
- PostgreSQL is authoritative; search/vector indexes are rebuildable; Redis is ephemeral; MinIO stores private binaries.
- Publish idempotent events/jobs only after database commit.
- Cross-module access uses exported contracts, not another module's internals.
- Add an ADR before changing a major boundary, persisted format, integration owner, or specified directory.
