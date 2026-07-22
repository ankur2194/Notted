# Operations Standard

- Build pinned reproducible multi-stage images that run non-root and terminate gracefully.
- Keep data services private and expose web/API through a TLS reverse proxy.
- Validate configuration and run migrations once through an explicit release step.
- Prefer compatible migrations and health-checked rollout over unconditional shutdown.
- Encrypt off-host backups and regularly test database/object restore and search rebuilding.
- Document rollback, irreversible changes, resource limits, health checks, and incidents.
- Production commands are explicit; development resets must refuse production targets.
