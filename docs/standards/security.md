# Security Standard

- Deny by default; enforce authentication, resource authorization, and workspace scope in reusable backend policies.
- Validate type, size, shape, ownership, and allowed values at trust boundaries.
- Hash API keys, encrypt provider secrets, use the auth provider for passwords, and keep buckets private.
- Address XSS, CSRF, SSRF, redirects, traversal, upload bombs, brute force, and host abuse where relevant.
- Redact credentials, cookies, content, personal data, signed URLs, and secrets from logs/artifacts.
- Use least-privilege networking and short-lived authorized downloads.
- Add negative authorization and cross-tenant tests for affected resources.

## See also

- [Threat model](../security/threat-model.md)
- [Remediation checklist](../security/remediation-checklist.md)
- `pnpm security:check` — on-demand production-dependency and container scan (see [`docs/README.md`](../README.md#quality-commands))
