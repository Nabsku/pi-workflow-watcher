---
description: Shape a rough idea into a workflow-ready implementation plan
---

Turn the user's rough request into an executable implementation plan at `.pi/plans/<short-kebab-slug>.md`. This is planning, not implementation. Scale depth to risk and scope: concise for small obvious changes, thorough for risky, multi-file, product, UX, architecture, data, security, or migration work.

## Core contract

- If no request is provided, stop and ask for the goal.
- Do not implement during plan shaping unless the user explicitly asks for implementation too.
- Prefer dense bullets over prose.
- The only file you may create or modify is the plan artifact under `<plansDir>/<slug>.md`, usually `.pi/plans/<slug>.md`, unless the user explicitly authorizes more.
- If `workflow_watch` is available, call it early with `mode: "planning"`; treat blockers as stop signs and nudges as plan inputs.
- If `workflow_init` is available and `.pi/workflows.json` is missing, use it or ask the user before creating a minimal workflow contract. If no workflow tools are available, continue safely and mark the contract as missing.
- `/workflow ...` commands are human/operator-facing. Agents should prefer `workflow_*` tools when available.

## Start with repo state protection

1. Run `git status --short --branch` and record it as the initial baseline.
2. Classify dirty/untracked files as:
   - relevant to this request
   - unrelated user work
   - unknown
3. If planned files overlap already-modified or untracked files, inspect `git diff -- <path>` for tracked files and document the safety risk.
4. Do not overwrite, delete, reformat, stage, or commit unrelated user work.
5. If overlap is not clearly part of the request, mark a blocker/question instead of assuming.

## Read before asking

Inspect files before asking questions answerable from the repo:

- `.pi/workflows.json` first if it exists; treat it as the executable workflow contract.
- `AGENTS.md`, `CLAUDE.md`, and relevant nested instruction files.
- Existing `.pi/plans/*.md` for local plan style and active plan context.
- Package manifests, test configs, app entrypoints, and similar existing features as needed.
- Relevant source files, tests, schemas, migrations, docs, and CI config needed to ground the plan.

## Workflow contract handling

Extract from `.pi/workflows.json` when present:

- `project`
- `commands`
- `gates.preflight`
- `gates.focused`
- `gates.beforeCommit`
- `gates.final`
- `rules`
- `artifacts.plansDir` defaulting to `.pi/plans`
- `artifacts.runsDir` defaulting to `.pi/runs`
- `ownership.highRiskPaths`, `generatedPaths`, `lockfiles`

Preserve these rules in the plan when present:

- dirty-work protection
- one-writer execution
- review before commit
- adversarial review after every task
- commit policy
- stop conditions

If `.pi/workflows.json` is missing, still shape safely, but mark the workflow contract as missing and recommend initializing the repo workflow before implementation. If the contract has invalid JSON or impossible gates, stop and report the blocker unless the request is to plan the contract fix. Do not invent commands. Prefer commands from `.pi/workflows.json`; otherwise use repo-file evidence and label assumptions.

## Question loop

If a `grill-me` skill or equivalent questioning workflow is available, use it here. If not, use this lightweight loop:

- Ask one question at a time only when the answer materially changes scope, architecture, acceptance criteria, risk, or execution mode.
- Each question must include:
  - why it matters
  - a recommended default answer
  - 2-4 concrete options when useful
- Prefer a default and proceed when the ambiguity is low-risk.
- Stop questioning when remaining ambiguity can be captured as explicit assumptions/non-goals.
- If a question blocks safe planning, stop and ask; do not bury it in the plan.

## Mandatory workflow steps

For any non-trivial plan, these steps are mandatory:

1. Capture repo baseline with `git status --short --branch`.
2. Inspect repo files before asking questions.
3. Read or initialize workflow context using `.pi/workflows.json` and `workflow_init` when available.
4. Produce an evidence-backed code map with exact files/symbols/tests/configs.
5. Write the plan artifact under `.pi/plans/` or the configured `artifacts.plansDir`.
6. Include acceptance traceability, slice ownership, verification commands, and adversarial review blocks.
7. Record `workflow_note PLAN_CREATED <path>` when `workflow_note` is available.
8. Check `workflow_progress` when available before the final response.

## Mandatory subagents and review

Subagents are mandatory for non-trivial plans. Required roles: `scout`, `reviewer`, and `oracle`. Requires the public `pi-subagents` extension (`pi install pi-subagents`, npm package `pi-subagents@^0.27.0`).

- Use `scout` for codebase context before drafting. Ask for exact files/symbols/tests/configs, likely change points, risks, and verification commands.
- Use `reviewer` for adversarial plan review against acceptance criteria and repo evidence.
- Use `oracle` as the final decision-consistency reviewer. Oracle is advisory and must not edit.
- Use `researcher` only when external docs/current facts matter.
- Use `planner` only for alternate decomposition, not edits.

If `pi-subagents` is unavailable, stop after repo inspection and tell the user to install/enable it (`pi install pi-subagents`) or explicitly approve a degraded self-reviewed plan. Do not silently downgrade a non-trivial plan to self-review.

For trivial plans, you may skip subagents only when the change is single-file, low-risk, has obvious verification, and the final response explicitly says subagents were skipped because the plan is trivial. Council-style review is optional and only for ambiguous, risky, cross-cutting, or multi-approach changes; keep each reviewer to at most 5 bullets: strongest concern, missed file/test, simpler option, acceptance gap, verdict.

## Plan artifact requirements

- Path: `<plansDir>/<short-kebab-slug>.md`, usually `.pi/plans/<short-kebab-slug>.md`.
- If `<plansDir>/` does not exist and creating it is allowed, create it.
- State the exact path near the top of the plan and final response.
- Do not stage or commit the plan unless the user explicitly asks.
- If `workflow_note` is available, record `PLAN_CREATED <path>` after the plan is written.
- If `/workflow plan <path>` is needed to pin it and no agent tool exists, tell the user the exact command instead of pretending it happened.
- If `workflow_progress` is available, use it near the end to verify the watcher can see the plan/progress state.

## Plan contents

The plan must include:

1. Title and one-line goal.
2. Original request.
3. Shaping summary:
   - questions asked and answers/defaults chosen
   - unresolved assumptions
   - explicit non-goals
4. Workflow contract summary:
   - contract path or missing/invalid
   - project kind/package manager
   - commit policy
   - one-writer setting
   - adversarial-review-after-every-task setting
   - stop conditions
   - high-risk paths
5. Acceptance criteria split into:
   - explicitly requested
   - inferred assumptions
   - non-goals
   Do not treat inferred criteria as authorization for extra scope.
6. Acceptance traceability: map each criterion to slice(s), focused gate(s), adversarial review(s), and final gate(s).
7. Current repo state summary, including dirty/untracked safety baseline.
8. Evidence-backed code map: exact files, functions/classes, entrypoints, tests, configs, and risk areas. Include why each item matters; do not list plausible files from names alone.
9. Product/UX/architecture decision record when relevant:
   - chosen direction
   - alternatives rejected
   - tradeoffs
   - future work deliberately excluded
10. File-by-file implementation strategy.
11. Small implementation slices. Each slice must be implementation-sized, not theme-sized, and include:
    - scope
    - allowed files
    - forbidden files
    - exclusive file ownership
    - acceptance criteria
    - skills/tools to load/use if available
    - focused verification command(s), preferably via `workflow_gate` for `.pi/workflows.json` gates when available
    - adversarial review contract for this slice
    - expected artifact/commit boundary per commit policy
12. Dependency graph between slices.
13. Recommended execution mode: parallel only when slices are independent and have exclusive file ownership; serial when they touch the same files, generated artifacts, lockfiles, migrations, fixtures, or depend on prior results. Ask the user only if both are genuinely viable.
14. Risks, rollback notes, and open questions.
15. Checklist with one checkbox per slice.

## Required per-slice adversarial review block

```md
**Adversarial review:** Required after focused verification and before marking this task done.
- Reviewer/oracle/self-review must check: acceptance criteria, allowed-file boundaries, dirty-work safety, verification relevance, hidden edge cases, speculative abstractions, and regression risk.
- Verdict must be one of: `OK_TO_MARK_DONE`, `NEEDS_FIX`, `BLOCKED`.
- If verdict is `NEEDS_FIX` or `BLOCKED`, implementation must not continue to the next task until resolved or explicitly waived by the user. If `workflow_note` is available, record `OK_TO_MARK_DONE` evidence after approval.
```

## High-risk file rules

- Treat lockfiles, dependency manifests, generated files, snapshots, migrations, vendored code, and large formatted outputs as high-risk. Touch them only when required by the slice. If touched, explain why and verify the generating command or package-manager command used.
- Do not add, remove, or upgrade dependencies unless explicitly required or no local-code fix is viable.
- If `.pi/workflows.json` names high-risk paths, use those over generic guesses.

## Review input checklist

For reviewer/oracle/self-review, include:

- original request
- questions/answers/defaults from questioning
- `.pi/workflows.json` summary or missing-contract blocker
- acceptance criteria
- codebase evidence
- plan path
- dirty-tree safety baseline
- proposed slice ownership and gates

Review output must include:

- Original request satisfied: yes/no + evidence
- Acceptance criteria covered: yes/no per criterion + evidence
- Workflow contract used correctly: yes/no + evidence
- Questioning sufficient: yes/no + remaining blocking ambiguity
- Adversarial review after every task present: yes/no
- Code map evidence reviewed: yes/no
- Dirty-tree/user-work safety checked: yes/no
- Execution mode/file ownership safe: yes/no
- Remaining risks
- Verdict: `OK_TO_PRESENT`, `NEEDS_WORK`, or `BLOCKED`

## Quality bar

- A future implementer should not need to guess file paths, commands, acceptance criteria, or ownership boundaries.
- Tasks should be bite-sized enough to verify independently.
- Verification must exercise changed behavior, not just run unrelated broad checks.
- Prefer test-first implementation when code changes are planned.
- No speculative abstractions, broad rewrites, or future-proofing beyond the request.

## Final response format

- Plan path: ...
- Workflow contract: found/missing/invalid + path
- Questions resolved: ...
- Summary: ...
- Recommended execution: parallel/serial + why
- Gates: focused/beforeCommit/final commands selected
- Adversarial review: required after every task, yes/no
- Review verdict: ...
- Final git status: ...
- Open questions/blockers: ...

Requests: $@
