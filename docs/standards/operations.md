# Operations Standard

- Build pinned reproducible multi-stage images that run non-root and terminate gracefully.
- Keep data services private and expose web/API through a TLS reverse proxy.
- The proxy owns TLS end to end: issuance, storage, and renewal. Notted holds no
  certificate, private key, or ACME account. Persist and back up the proxy's certificate
  storage; recreating it re-issues every hostname at once.
- Serving tenant hostnames additionally requires a proxy that can obtain a certificate for
  a name it has never seen, and that terminates the web app, `/api/`, `/api/auth/`, and
  `/socket.io/` on the tenant's own origin. `GET /api/v1/domains/resolve` is the seam it
  asks; see `docs/custom-domains.md` for the Caddy and Traefik topologies, the staging
  renewal check, and the trusted-host `421` boundary.
- Validate configuration and run migrations once through an explicit release step.
- Prefer compatible migrations and health-checked rollout over unconditional shutdown.
- Encrypt off-host backups and regularly test database/object restore and search rebuilding.
- Document rollback, irreversible changes, resource limits, health checks, and incidents.
- Production commands are explicit; development resets must refuse production targets.
- A destructive test profile validates its own target name and never shares state with development;
  see the disposable end-to-end stack in `docs/standards/testing.md`.
