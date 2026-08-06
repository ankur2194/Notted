---
description: Independently review or verify a Notted Plan.md part, read-only.
argument-hint: Review Part <number> | Verify Part <number> <focused|full>
---

Perform a read-only review or verification for the selected `Plan.md` part, following `AGENTS.md` and the recursive Synchronous Delegation Protocol for any delegation.

Arguments: $ARGUMENTS

Interpret the arguments as one of:

- `Review Part <number>` — perform an independent read-only review of the selected part
- `Verify Part <number> focused` — run focused verification for the selected part
- `Verify Part <number> full` — run the full applicable completion gate for the selected part

Route this work to the `quality-reviewer` agent using the `Agent` tool with `subagent_type: "quality-reviewer"` and `run_in_background: false`, so the call blocks until that agent is terminal. That agent has no `Edit` or `Write` tool, which enforces the read-only contract.

Invoke the `notted-quality-operations` skill (via the `Skill` tool). Remain read-only: do not apply fixes, only report them.

Run focused checks before broad checks. Report findings by severity with file and line evidence, impact, and remedy, followed by the checks actually executed, untested areas, and residual risk. Do not claim unavailable or skipped checks passed.

Return the standard completion payload: status, result or findings, files changed, commands or tests run, and unresolved issues. Use `none` explicitly where empty.
