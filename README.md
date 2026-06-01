# pi-workflow-watcher

Pi extension that makes repo workflow state executable and nudges the coding agent back onto rails.

The split is simple:

- **User-facing:** `/workflow ...` commands and the Pi TUI status/widget.
- **Agent-facing:** `workflow_*` tools, hooks, `.pi/workflows.json`, and persisted evidence/state.

## Installation

Compatible Pi version: this package targets Pi / `@earendil-works/pi-coding-agent` `0.75.x` (tested with `^0.75.5`) and Node.js 20+.

This is a TS-source Pi extension: the package ships `index.ts` directly through the `pi.extensions` entry. Pi is expected to provide `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at runtime; they are declared as peer dependencies and kept as dev dependencies only for local typecheck/test.

Install from the package/repo according to your Pi package workflow, then verify Pi loaded it:

```text
/workflow help
/workflow doctor
```

Expected loaded commands/tools:

- Slash command: `/workflow status|next|progress|doctor|evidence|why|review-prompt|bundle|dirty|note|gate|plan|toggle|help`
- Agent tools: `workflow_watch`, `workflow_next`, `workflow_init`, `workflow_approve_dirty_overlap`, `workflow_gate`, `workflow_progress`, `workflow_export_evidence`, `workflow_note`, `workflow_review_packet`, `workflow_why`, `workflow_import_acceptance`

If `/workflow help` is unavailable, restart Pi, confirm the package is in Pi's extension/package config, and check that the installed package includes `index.ts` plus the `pi.extensions` entry in `package.json`.

The watcher can be noisy if it is active for casual sessions. Use `/workflow toggle off` in a repo to disable automatic startup nudges, remove TUI status/widget surfaces, and disable hook guardrails for that repo. Use `/workflow toggle on` to re-enable them. The toggle is stored in `.pi/workflow-watcher.json`.

## Quickstart: create a workflow

The easiest public entry ramp is the starter prompt in `prompts/shape-plan.md`.

Install or copy it into your Pi prompt directory:

```bash
mkdir -p ~/.pi/agent/prompts
cp ~/.pi/agent/git/github.com/Nabsku/pi-workflow-watcher/prompts/shape-plan.md ~/.pi/agent/prompts/shape-plan.md
```

Then, inside a repo:

```text
/shape-plan <goal>
```

Example:

```text
/shape-plan Add GitHub issue triage automation
```

The starter prompt inspects the repo, reads or initializes workflow context when the `workflow_*` tools are available, writes a plan under `.pi/plans/<slug>.md`, records `workflow_note PLAN_CREATED <path>` when possible, and tells the user the next implementation command. It is opinionated by default: `grill-me` is conditional, but non-trivial plans require subagent-style scout/reviewer/oracle passes. If subagents are unavailable, the prompt stops after repo inspection and asks for explicit approval before producing a degraded self-reviewed plan.

After a plan exists, use:

```text
/workflow plan .pi/plans/<slug>.md
/workflow progress
```

This package only ships the starter template. You can replace it with an organization-specific `/shape-plan` prompt while keeping the plugin as the deterministic workflow/evidence substrate.

## Publishing and schema caveat

The canonical schema for this package is `schemas/pi-workflows.schema.json` in this repository/package. Existing repos may have older `.pi/workflows.json` files from pre-schema adoption or from local starter copies. Treat `$schema` as an editor/validation aid; `/workflow doctor` and the runtime validator are authoritative for current package behavior. When adopting the schema, copy one example to `.pi/workflows.json`, verify every command against the repo, and keep artifact paths repo-local.

## What the user should use

These are the surfaces meant for a human sitting in Pi:

### `/workflow status`

Show the current workflow posture: dirty files, active plan, latest gate/review evidence, blockers, and next action.

Use when you want to ask: “Where are we, and is the agent allowed to continue?”

### `/workflow next`

Show only the next recommended workflow action.

Use when the TUI/status is noisy and you just want the next move.

### `/workflow evidence`

Show human-readable commit evidence: last trusted reviewer/oracle import, manual note breadcrumb/untrusted status, last `workflow_gate` beforeCommit/final result, diffHash freshness, missing pieces, next safe actions, and commit-ready yes/no.

Use before asking the agent to commit or when a commit was blocked and you need to know exactly which evidence is missing.

### `/workflow bundle`

Export a sanitized markdown evidence bundle under the resolved `artifacts.runsDir` (default `.pi/runs`) with active plan/slice, branch/current diff hash, dirty baseline summary, touched files, trusted review state, `workflow_gate` state, commit-ready status, missing requirements, recent ledger approvals/blockers, and the evidence path.

Use before handoff or release review:

```text
/workflow bundle
```

The bundle intentionally omits raw prompts and huge stdout/stderr, redacts obvious secrets/tokens, and bounds output size.

### `/workflow doctor`

Inspect workflow readiness without running gates or tests. Doctor checks contract presence/JSON/schema/semantic findings, artifact path safety and fallback status, command/gate discoverability, and whether commit authorization is currently satisfiable from trusted evidence.

Use when onboarding a repo or repairing a blocked workflow:

```text
/workflow doctor
```

### `/workflow plan [path-or-slug]`

Without an argument, show the currently inferred active plan.

With a path or slug, pin the active plan explicitly, for example:

```text
/workflow plan .pi/plans/add-auth.md
```

Use this when multiple plan files exist and the watcher refuses to guess.

### `/workflow gate <name> [--dry-run]`

Run a named verification gate from `.pi/workflows.json`, or show the resolved commands without executing them:

```text
/workflow gate beforeCommit --dry-run
/workflow gate beforeCommit
```

Use this when you want explicit verification evidence before allowing commit/landing work.

### `/workflow dirty`

Inspect the protected dirty baseline and path-scoped dirty-overlap approvals. Dirty-work protection is a built-in invariant, not a configurable workflow rule.

```text
/workflow dirty
/workflow dirty approve <path> --reason "operator approved this exact overlap"
/workflow dirty baseline refresh
```

Approvals are reason-required, must target a path already in `dirtyBaseline.dirtyFiles`, are tied to that baseline diff hash, and are consumed by the first matching edit. They do not bypass outside-repo, high-risk, generated-path, or lockfile protections.

### `/workflow note <text>`

Add compact human/operator evidence to the watcher log and state.

Recognized verdicts include:

```text
/workflow note OK_TO_MARK_DONE reviewer approved slice 2
/workflow note OK_TO_COMMIT final review clean
/workflow note gate beforeCommit pass
```

Use this when a review/verdict happened outside the watcher tool path and needs to be recorded.

Manual notes are recorded context, not trusted approval.

They preserve operator context in the text log, state, and JSONL ledger, but commit authorization requires trusted tool evidence, not prose that looks like approval.

### `/workflow why [commit|edit <path>]`

Explain the current blocker source, why it blocks, and the exact next action. Use `/workflow why commit` for missing commit authorization and `/workflow why edit <path>` for edit-guard blocks.

### `/workflow review-prompt`

Print a compact reviewer/oracle handoff packet. It does **not** launch subagents. The packet includes active plan/slice when known, touched files, current diff hash, ownership notes (high-risk/generated/lockfiles), gate/evidence status, and exact acceptance/import requirements.

Equivalent agent-facing tool: `workflow_review_packet`.

## Daily recipes

### Starting work in a repo

```text
/workflow help
/workflow doctor
/workflow status
/workflow plan .pi/plans/<active-plan>.md
```

Use `doctor` first when a repo is new or acting strangely. It only inspects readiness; it does not run gates or tests. If the contract is missing, ask the agent to run `workflow_init`, then inspect `.pi/workflows.json` before trusting gates.

### Before commit

```text
/workflow evidence
/workflow gate beforeCommit --dry-run
/workflow gate beforeCommit
/workflow bundle
/workflow evidence
```

Commit only after `/workflow evidence` says `commit-ready: yes`. Protected commits require both current trusted reviewer/oracle evidence and a current `workflow_gate` `beforeCommit` or `final` pass for the same diff hash. Use `/workflow bundle` when you need a durable sanitized artifact for handoff/release review.

### Dirty files are blocking edits

```text
/workflow status
/workflow next
/workflow dirty
/workflow dirty approve <path> --reason "operator approved this exact overlap"
```

If the watcher reports dirty-file overlap, treat it as user work protection. Prefer avoiding those paths or splitting the change. If the overlap is intentional, approve exactly one path with the command printed by the blocker: `/workflow dirty approve <path> --reason "..."`. Do not clear or overwrite dirty files just to unblock the workflow.

### Reviewer accepted but commit is still blocked

```text
/workflow evidence
```

A reviewer/oracle acceptance alone is not enough. The acceptance must be imported as trusted evidence with `workflow_import_acceptance`, must match the current diff hash, and must be paired with a fresh `workflow_gate beforeCommit` or `workflow_gate final` pass. If `/workflow evidence` says the review is manual/untrusted or stale, rerun/import reviewer evidence for the current diff.

### Gate timed out

```text
/workflow gate beforeCommit --dry-run
/workflow gate beforeCommit
```

A timed-out gate command fails the gate, stops later commands, and does not authorize commit. Inspect the command timeout in `.pi/workflows.json`; either fix the underlying hang/failure or intentionally adjust `timeoutSeconds`, then rerun the gate.

### Manual notes vs trusted evidence

```text
/workflow note OK_TO_COMMIT human reviewed locally
/workflow evidence
```

Manual notes are useful audit breadcrumbs, but they are not trusted evidence by default. Use notes to preserve operator context; use validated `workflow_import_acceptance` reviewer/oracle imports and `workflow_gate` runs to unlock protected commits.

## What the user sees but usually does not operate directly

### TUI status line

The plugin refreshes a native Pi status item:

```text
WF OK/NUDGE/BLOCK · dirty N · <plan> · gate <name>:<status> · review <verdict>
```

This is meant to be glanceable. It tells you whether the agent is clear to proceed, should adjust, or must stop.

### Below-editor widget

The widget shows:

- blockers and nudges
- active plan and open tasks
- latest gate/review evidence
- top finding
- next action

This is passive guidance for both user and agent. You should not need to copy text from it into prompts unless Pi fails to act on it.

## What the agent should use

These are primarily for Pi/the coding agent, prompt templates, and hooks.

### `workflow_watch`

Inspect repo state, `.pi/workflows.json`, plan artifacts, git dirtiness, persisted evidence, and return OK/nudge/block findings.

Supports `verbosity: "full" | "summary" | "next"` (default `full`). `summary` keeps output concise while listing non-OK findings; `next` returns only the next action plus any blockers. Blockers are always shown.

Agent use:

- call at workflow phase boundaries: planning, preflight, before slice, after slice, before commit, final
- treat blockers as stop signs
- treat nudges as corrective guidance before continuing

### `workflow_next`

Return the next safe action in compact form.

Agent use:

- call when deciding what to do after a gate, review, or dirty-state change
- prefer this over guessing from prompt prose

### `workflow_init`

Create a conservative `.pi/workflows.json` starter if the repo has no workflow contract.

Agent use:

- call during `/agentize-repo` or initial workflow setup
- do not overwrite an existing contract casually

### `workflow_gate`

Resolve and execute a named gate from `.pi/workflows.json`, then write pass/fail evidence.

Agent use:

- call only when explicitly entering a verification step
- use `dryRun: true` first if command resolution is uncertain
- do not use hooks to run tests implicitly

### `workflow_progress`

Read-only progress summary for the active plan/slice. It reports conservative checkbox counts, review/gate freshness, stale evidence after edits, parser limitations, and the next safe action.

Use it when the agent/operator asks “where are we?” without running gates, editing plan files, or launching reviewers. Slash equivalent: `/workflow progress [plan]`.

### `workflow_export_evidence`

Create a sanitized bounded markdown evidence bundle under `artifacts.runsDir`, returning the bundle path, current diff hash, commit-ready yes/no, missing requirements, and next action.

Agent use:

- call before final handoff, commit review, or release packaging when an auditable artifact is useful
- rely on the returned `bundlePath`; do not paste raw prompts or raw command logs into the bundle manually
- if `commitReady` is false, resolve the returned `missing` items before committing

### `workflow_note`

Append a compact watcher note and persist recognized review/gate/checkpoint state.

Agent use:

- record reviewer/oracle verdicts such as `OK_TO_MARK_DONE` or `OK_TO_COMMIT` only as manual notes
- record gate pass/fail evidence when produced outside `workflow_gate`
- keep notes short; this is workflow evidence, not a transcript

### `workflow_import_acceptance`

Import a pi-subagents v0.26 reviewer/oracle acceptance artifact or status result as trusted review evidence.

The importer is intentionally narrow. It promotes evidence to `reviewer_tool` or `oracle_tool` only when all of these are true:

- the child result is from a reviewer/oracle agent
- there is exactly one child result; zero-child or aggregate/dynamic status objects are rejected
- the result contains a fenced `acceptance-report` JSON block or a pi-subagents acceptance ledger with a child report
- the acceptance ledger is not rejected and has no failed runtime checks or blocking review result
- provenance includes a `diffHash`/`currentDiffHash`/`reviewedDiffHash` matching the current repo diff hash

Use this for pi-subagents acceptance-gated reviewer/oracle runs instead of relying on manual `OK_TO_COMMIT` prose. Manual notes remain useful breadcrumbs, but they do not unlock protected commits.

## Evidence trust boundaries

- **Trusted evidence sources:** `workflow_gate` gate runs and validated `workflow_import_acceptance` reviewer/oracle imports (`reviewer_tool`/`oracle_tool`) whose provenance matches the current diff hash.
- **Manual evidence sources:** `/workflow note` and `workflow_note` entries (`manual_note`) are audit breadcrumbs only. They can explain what a human observed, but manual notes do not unlock commits by default.
- **Commit authorization:** protected `git commit` is allowed only with current trusted reviewer/oracle evidence plus a current required `beforeCommit` or `final` gate pass from `workflow_gate`. Manual gate/review notes are insufficient unless policy is intentionally changed in code.
- **Gate timeouts:** each gate command can declare `timeoutSeconds`; timed-out commands fail the gate, stop subsequent gate commands, mark the command as timed out in details/log output, and do not authorize commits.
- **Remaining limitations:** the watcher is not a full sandbox. It blocks known risky tool calls and path escapes, but command side effects still run in the repo process environment when an explicit gate is invoked.

## Hardened runtime state

- `artifacts.runsDir` may be customized inside the repo. If it is missing or unsafe, the watcher uses `.pi/runs` as a safe fallback and returns structured failure/blocker details instead of writing outside the repo.
- Ownership paths fail closed: edits to configured `ownership.highRiskPaths`, `ownership.generatedPaths`, and lockfiles are blocked without the relevant review, generation, or dependency-change evidence.
- The JSONL ledger (`workflow-watcher.jsonl`) stores compact structured events with sanitized previews and metadata. It avoids copying large command stdout/stderr and redacts obvious secrets/tokens.
- Evidence bundles (`workflow-evidence-bundle-*.md`) are generated in `artifacts.runsDir`, are sanitized/bounded, and should be treated as shareable summaries rather than complete transcripts.

## Troubleshooting matrix

- `/workflow help` missing: package is not loaded; restart Pi, verify extension config, and confirm `package.json` has `pi.extensions: ["./index.ts"]`.
- `/workflow doctor` says contract missing: run `workflow_init` or copy an example to `.pi/workflows.json`, then inspect/verify commands before trusting gates.
- Schema or gate command errors: compare against canonical `schemas/pi-workflows.schema.json`; make every gate command reference an existing `commands.<name>` entry.
- Commit blocked after review: import current reviewer/oracle evidence with `workflow_import_acceptance`; manual notes are breadcrumbs only.
- Commit blocked after gate: rerun `workflow_gate beforeCommit` or `workflow_gate final` on the current diff hash.
- Bundle export rejected: fix `artifacts.runsDir` so it is repo-local; absolute paths and `..` escapes are rejected.
- Gate timed out: raise/fix `timeoutSeconds` only after understanding the hang, then rerun the gate.

## Pi subagent acceptance gates vs watcher repo gates

- Pi subagent acceptance gates validate a delegated child run: structured child report, evidence kinds, optional runtime verify commands, provenance ledger, and independent review status. They are best for reviewer/oracle evidence.
- Watcher repo gates (`workflow_gate`) execute repository commands from `.pi/workflows.json` in the parent repo and persist command output as `workflow_gate` evidence. They remain the source of before-commit/final command verification.
- Protected commits require both: current trusted reviewer/oracle evidence imported from a validated acceptance artifact, and a current `workflow_gate` beforeCommit/final pass.

## Hooks

Hooks are automatic guardrails for the agent. Users normally should not call them.

- `session_start` — refreshes the TUI status/widget.
- `turn_end` — refreshes the TUI status/widget after each turn.
- `before_agent_start` — injects a compact nudge only when repo state is non-OK.
- `tool_call` — blocks risky agent actions:
  - unreviewed `git commit`
  - `git push`
  - dependency changes
  - destructive commands
  - broad formatters/fixers
  - edits outside the repo
  - edits overlapping protected pre-existing dirty files

## Project files

These files are meant to be committed per repository:

- `.pi/workflows.json` — machine-readable workflow contract: commands, gates, rules, artifacts, high-risk paths. New contracts should use `$schema: "./schemas/pi-workflows.schema.json"` when the schema is copied into the repo, or point at this package's published `schemas/pi-workflows.schema.json`.
- `AGENTS.md` — human-readable/repo-readable long-form workflow guidance.
- `.pi/plans/*.md` — active implementation plans.

## Schema and examples

This package includes publishable starter assets:

- `schemas/pi-workflows.schema.json` — JSON Schema for the current workflow contract shape.
- `examples/workflows.node.json` — copy/paste starter for Node/TypeScript projects.
- `examples/workflows.python.json` — copy/paste starter for Python/uv projects.

To adopt one, copy an example to `.pi/workflows.json`, verify every command against the actual repo, and run `/workflow doctor` before trusting gates.

## Release readiness checklist

Before publishing a new package version:

- Run `pnpm test` and `pnpm run typecheck`.
- Confirm `package.json` metadata, `files`, and `engines` match the package contents.
- Confirm `schemas/pi-workflows.schema.json` validates the starter/examples.
- Confirm README examples and `/workflow help` still describe the same operator flow.
- Confirm `/workflow bundle` and `workflow_export_evidence` create sanitized bundles and do not include raw prompts or large stdout/stderr.
- Confirm `CHANGELOG.md` has an Unreleased entry for user-visible changes.

These files are runtime state and usually should not be committed:

- `.pi/runs/workflow-watcher.log`
- `.pi/runs/workflow-state.json`
- other `.pi/runs/*` evidence ledgers

## Design boundary

The plugin is a watcher, not a broad orchestrator.

It may nudge, block, resolve gates, and record evidence. It only runs repo verification commands when `workflow_gate` or `/workflow gate` is explicitly invoked. It never commits, pushes, edits plans, or decides scope on its own.
