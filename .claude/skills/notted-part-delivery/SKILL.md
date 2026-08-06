---
name: notted-part-delivery
description: Execute one numbered Notted Plan.md part from context gathering through implementation, verification, and cross-session completion recording. Use for starting, planning, implementing, resuming, or completing any numbered project part, and for determining its prerequisites and allowed scope.
---

# Deliver a Notted Plan Part

## Establish context

1. Read `AGENTS.md`, relevant `Notted.md` sections, the full selected `Plan.md` part, and prerequisite completion records.
2. Read applicable ADRs and standards. Treat `Notted.md` as primary for directory structure.
3. Inspect current code and changes. Do not infer that an earlier part is complete because files exist.
4. State part number, bounded scope, dependencies, affected layers, risks, and verification.

## Execute

1. Keep work limited to the selected part unless explicitly expanded.
2. Delegate bounded work to the `frontend-editor-engineer`, `backend-platform-engineer`, or `quality-reviewer` agents when their domain applies, and require each specialist to load its corresponding Notted skill.
   After spawning specialists, apply the Synchronous Delegation Protocol recursively (see below): spawn with the `Agent` tool using `run_in_background: false`, which blocks until the specialist is terminal; do not poll, inspect files, run commands, duplicate work, or start other work while waiting. Require the standard completion payload, handle failure/block/timeout explicitly, then review each payload once and merge only after all specialists are terminal.
3. Preserve existing work and patterns; add an ADR for a material architectural deviation.
4. Implement complete, authorized, validated behavior and add tests and documentation with it.

## Verify and hand off

1. Run focused checks, then broad safe checks relevant to the part.
2. Review authorization, tenant isolation, validation, errors, logs, migrations, accessibility, and operations as applicable.
3. Inspect the final diff for accidental scope and generated artifacts.
4. Create or update `docs/completed-parts/part-NN-short-name.md` and the index.
5. Mark complete only when all criteria pass. Report outcome, decisions, evidence, changed areas, and remaining work.

Before handoff, apply the checklist in [`part-completion.md`](part-completion.md).

## Synchronous Delegation Protocol in Claude Code

These rules govern every delegation, including delegation performed by a subagent:

1. Delegate only bounded tasks with explicit ownership and an expected completion payload.
2. Use the `Agent` tool with `run_in_background: false`. That call blocks until the subagent reaches a terminal state, and it is the supported finite blocking wait in this harness. Never use `run_in_background: true` for protocol-governed delegation, because it returns control while the subagent is still active.
3. Remain blocked and do no other work while waiting. Do not substitute polling, periodic file reads, unrelated commands, duplicate investigation, or speculative work. Issue independent delegations in a single tool block so they all resolve before you continue.
4. An agent may continue only after every subagent it started has returned a final result. Each subagent must wait for all of its own subagents before returning, so no agent returns while descendants are still active.
5. Every subagent final result must use a completion payload containing: `status` (`completed`, `blocked`, or `failed`); result or findings; files changed; commands or tests run; and unresolved issues. Use `none` explicitly where an item is empty.
6. If a subagent fails, reports `blocked`, or does not finish, stop it with `TaskStop` so it reaches a terminal state, then report the condition and its partial payload. Do not wait indefinitely or repeatedly poll.
7. After all started subagents are terminal, review each returned payload once, reconcile and merge the results, and only then resume your own workflow. A failed, blocked, or timed-out delegation cannot be represented as successful or silently redone by the parent.

## Actions

- `plan` — analyze scope, dependencies, risks, and verification without editing.
- `implement` — implement the selected part (the default).
- `resume` — continue unfinished work on the selected part, typically after review found issues.
- `handoff` — write or update the `docs/completed-parts/part-NN-*.md` record and index.
