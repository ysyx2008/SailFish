# 2026-10-11 HOL Guard example review fixes

Status: 已完成 (implementation and validation completed; known baseline failures documented below)

Address the maintainer's review on PR #160 without changing the guarded tool or SailFish approval policy.

- Use asynchronous child-process execution with the existing timeout and fail-closed behavior.
- Verify the Guard CLI argument separator against the current parser before changing argument order.
- Include the example's JavaScript tests in the existing Vitest configuration and cover asynchronous execution, malformed responses and process failures.
- Document that only execute_command is covered, review requires human approval even in permissive mode, and an enabled plugin blocks covered calls when Guard is unavailable.
- Narrow the manifest description to the actual tool scope.

Validation: focused Vitest tests, exact parser argument tests, lint/type checks and the repository's no-AI CLI regression command where the cloud environment supports them. Record blocked checks explicitly. No new tools, agent setup, security settings or policy changes.

## Validation results

- Node 24.19.0, Vitest 4.1.11.
- Focused plugin suite: 12 passed. The normal Vitest discovery now includes this example.
- Project typecheck: passed.
- Project lint: passed with two pre-existing unused-argument warnings in conversation-original-handoff.e2e.test.ts.
- Isolated no-AI CLI regression: 56 passed, 0 failed, 3 AI-dependent checks skipped. Desktop data borrowing was disabled.
- Static asar dependency coverage: passed.
- Full unit suite in this Linux cloud workspace: 3277 passed, 82 failed, 32 skipped; one unhandled error. The unchanged PR head produces the exact same 82 failing test names across the same 12 files (3265 passed). These existing/environment-dependent failures are not claimed as a full-suite pass.
- The actual HOL Guard 3.42.0 parser preserves five representative command strings with `command test --json -- <command>`, including leading dashes, quotes and newlines.
- A real Guard subprocess leaves the Node event loop responsive. Native inspection is unavailable in this workspace, so Guard exits nonzero and the adapter blocks as designed; this is not a successful native policy-evaluation test.
- Independent code review found no blocking defect. The repository's optional local Claude review command was unavailable and was not run.
- Production Vite build: passed with a 4 GB Node heap after the default 2 GB heap was exhausted. No repository build configuration was changed.
