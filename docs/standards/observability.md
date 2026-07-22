# Observability Standard

- Emit structured logs with service, environment, request/job ID, safe entity IDs, duration, and outcome.
- Never log secrets, authorization headers, cookies, raw content, uploaded contents, or full AI prompts.
- Separate liveness from dependency-aware readiness.
- Measure HTTP, database pools, queues, WebSockets, dependencies, exports, storage, and AI quota usage.
- Make alerts actionable with runbooks and avoid noisy transient paging.
- Preserve correlation across requests, transactions, jobs, webhooks, and emails.
