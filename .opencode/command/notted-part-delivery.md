---
description: Deliver one numbered Notted Plan.md part. Usage - /notted-part-delivery Part <number> <plan|implement|resume|handoff>
agent: lead-part-engineer
---

Load and use the `notted-part-delivery` skill to handle this request for the selected `Plan.md` part, following `AGENTS.md` and the recursive Synchronous Delegation Protocol for any delegation.

Arguments: $ARGUMENTS

Interpret the arguments as `Part <number> <action>` where `<action>` is one of:
- `plan` - analyze scope, dependencies, risks, and verification without editing
- `implement` - implement the selected part (default when the action is omitted)
- `resume` - continue unfinished work on the selected part
- `handoff` - write or update the `docs/completed-parts/part-NN-*.md` record and index

Apply the skill's corresponding workflow phase and return the standard completion payload: status, result or findings, files changed, commands or tests run, and unresolved issues.
