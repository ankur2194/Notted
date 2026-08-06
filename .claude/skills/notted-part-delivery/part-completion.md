# Part Completion Checklist

- [ ] Selected scope matches one numbered implementation part.
- [ ] Relevant `Notted.md` requirements and canonical paths were followed.
- [ ] Prerequisite completion records, ADRs, and standards were read.
- [ ] Existing and unrelated changes were preserved.
- [ ] Every started subagent and descendant reached a terminal state through the synchronous wait protocol before parent work resumed.
- [ ] Each subagent supplied status, result/findings, files changed, commands/tests run, and unresolved issues; the parent reviewed each payload once and reported failures, blocks, or timeouts.
- [ ] Inputs are validated and errors are safe and actionable.
- [ ] Authentication, authorization, and workspace isolation are enforced server-side.
- [ ] Data invariants, transactions, concurrency, migrations, and rollback were considered.
- [ ] UI includes applicable loading, empty, error, retry, permission, offline, and accessible states.
- [ ] Logs and artifacts contain no secrets, tokens, private content, or personal data.
- [ ] Focused tests and relevant broad checks were actually run.
- [ ] New configuration, contracts, dependencies, and operational changes are documented.
- [ ] Final diff contains no accidental scope, debug code, or unexplained generated files.
- [ ] Part completion record and completed-parts index are current and factually accurate.
- [ ] Status remains non-complete if any required criterion failed or was skipped.
