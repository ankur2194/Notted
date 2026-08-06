---
description: Author, diagnose, or verify Notted Playwright integration tests.
argument-hint: <author|diagnose|verify> [test or Plan part]
---

Handle this Playwright integration request, following `AGENTS.md` and its recursive Synchronous Delegation Protocol.

Arguments: $ARGUMENTS

Interpret the first argument as:

- `author` — add the smallest complete Playwright journey for the named test or Plan part
- `diagnose` — reproduce and fix the named failing journey without weakening required assertions
- `verify` — run focused scenarios followed by the applicable full browser project

Route this work to the `frontend-editor-engineer` agent using the `Agent` tool with `subagent_type: "frontend-editor-engineer"` and `run_in_background: false`, so the call blocks until that agent is terminal.

Invoke the `notted-playwright-integration` and `notted-frontend-editor` skills (via the `Skill` tool). Also invoke `notted-backend-data`, and add the `backend-platform-engineer` agent, when the journey touches API, database, Redis, queues, SMTP, authentication, or tenant fixtures.

Return status, findings or result, files changed, commands/tests run with counts, browser and fixture mode, generated artifacts, unavailable checks, and unresolved issues. Use `none` explicitly where empty.
