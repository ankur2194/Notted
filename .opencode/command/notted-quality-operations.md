---
description: Review or verify a Notted part. Usage - /notted-quality-operations Review Part <number> | Verify Part <number> <focused|full>
agent: quality-reviewer
---

Load and use the `notted-quality-operations` skill for the selected `Plan.md` part, following `AGENTS.md` and the recursive Synchronous Delegation Protocol for any delegation. Remain read-only.

Arguments: $ARGUMENTS

Interpret the arguments as one of:
- `Review Part <number>` - perform an independent read-only review of the selected part
- `Verify Part <number> focused` - run focused verification for the selected part
- `Verify Part <number> full` - run the full applicable completion gate for the selected part

Run focused checks before broad checks. Report findings by severity with file and line evidence, impact, and remedy, followed by the checks actually executed, untested areas, and residual risk. Do not claim unavailable or skipped checks passed.
