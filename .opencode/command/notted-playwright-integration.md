---
description: Author, diagnose, or verify Notted Playwright integration tests. Usage - /notted-playwright-integration <author|diagnose|verify> [test or Plan part]
agent: frontend-editor-engineer
---

Load and use the `notted-playwright-integration` and `notted-frontend-editor` skills. Load
`notted-backend-data` when the journey touches API, database, Redis, queues, SMTP, authentication,
or tenant fixtures. Follow `AGENTS.md` and its recursive Synchronous Delegation Protocol.

Arguments: $ARGUMENTS

Interpret the first argument as:
- `author` - add the smallest complete Playwright journey for the named test or Plan part
- `diagnose` - reproduce and fix the named failing journey without weakening required assertions
- `verify` - run focused scenarios followed by the applicable full browser project

Return status, findings or result, files changed, commands/tests run with counts, browser and fixture
mode, generated artifacts, unavailable checks, and unresolved issues.
