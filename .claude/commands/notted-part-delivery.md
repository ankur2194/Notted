---
description: Deliver one numbered Notted Plan.md part (plan, implement, resume, or handoff).
argument-hint: Part <number> <plan|implement|resume|handoff>
---

Handle this request for the selected `Plan.md` part, following `AGENTS.md` and the recursive Synchronous Delegation Protocol for any delegation.

Arguments: $ARGUMENTS

Interpret the arguments as `Part <number> <action>` where `<action>` is one of:

- `plan` — analyze scope, dependencies, risks, and verification without editing
- `implement` — implement the selected part (default when the action is omitted)
- `resume` — continue unfinished work on the selected part
- `handoff` — write or update the `docs/completed-parts/part-NN-*.md` record and index

Route this work to the `lead-part-engineer` agent using the `Agent` tool with `subagent_type: "lead-part-engineer"` and `run_in_background: false`, so the call blocks until that agent is terminal. If you are already acting as `lead-part-engineer`, do the work directly instead of re-delegating to yourself.

Invoke the `notted-part-delivery` skill (via the `Skill` tool) and apply its corresponding workflow phase.

Return the standard completion payload: status, result or findings, files changed, commands or tests run, and unresolved issues. Use `none` explicitly where empty.
