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
2. Delegate bounded work to `frontend_editor_engineer`, `backend_platform_engineer`, or `quality_reviewer` when their domain applies, and require each specialist to use its corresponding Notted skill.
   After spawning specialists, apply the `AGENTS.md` Synchronous Delegation Protocol recursively: use the supported finite blocking wait until every started specialist is terminal; do not poll, inspect files, run commands, duplicate work, or start other work while waiting. Require the standard completion payload, handle failure/block/timeout explicitly, then review each payload once and merge only after all specialists are terminal.
3. Preserve existing work and patterns; add an ADR for a material architectural deviation.
4. Implement complete, authorized, validated behavior and add tests/documentation with it.

## Verify and hand off

1. Run focused checks, then broad safe checks relevant to the part.
2. Review authorization, tenant isolation, validation, errors, logs, migrations, accessibility, and operations as applicable.
3. Inspect the final diff for accidental scope and generated artifacts.
4. Create/update `docs/completed-parts/part-NN-short-name.md` and the index.
5. Mark complete only when all criteria pass. Report outcome, decisions, evidence, changed areas, and remaining work.
