# Workflow Watcher

Workflow Watcher keeps a Pi coding session aligned with a repo's agreed workflow: it reads repo workflow state, warns when the session is drifting, and blocks unsafe next actions until required evidence exists.

## Language

### Actors

**Operator**:
A human directing a Pi coding session for this repo.
_Avoid_: User when the role specifically means the person approving workflow choices.

**Coding Agent**:
The AI agent acting inside Pi on the operator's behalf.
_Avoid_: Bot, assistant when discussing workflow responsibilities.

**Reviewer**:
A separate agent or human pass that checks current work before it is marked done or committed.
_Avoid_: Approval when no independent review occurred.

**Oracle**:
A higher-context second opinion used when a workflow decision may depend on inherited context or hidden assumptions.
_Avoid_: Reviewer when the role is decision consistency rather than ordinary diff review.

### Workflow control

**Workflow**:
The repo-local agreement for how coding work moves from planning through implementation, review, verification, and handoff.
_Avoid_: CI workflow, GitHub Actions workflow, single run, process when referring to this product's tracked state machine.

**Workflow Authority**:
The right to decide scope, continue past a blocker, commit, push, or mark work complete. The watcher reports and enforces workflow state; it does not hold workflow authority.
_Avoid_: Automation when a human or accepted plan must decide.

**Workflow Contract**:
The repo's machine-readable workflow agreement: allowed commands, gates, artifacts, ownership rules, and stop rules.
_Avoid_: Config when the file represents enforcement policy, not preferences.

**Workflow State**:
The persisted current facts about workflow progress and evidence, such as active plan, dirty baseline, last review, last gate, and checkpoint.
_Avoid_: Workflow Contract, which defines policy rather than current facts.

**Workflow Lesson**:
A lightweight planning-quality signal that points out missing workflow discipline such as a spec, acceptance criteria, test plan, or narrow slice.
_Avoid_: Learning when the signal is only about current plan shape.

**Watcher**:
The part of the extension that inspects current repo workflow state and returns the next safe action.
_Avoid_: Scheduler, orchestrator.

**Guardrail**:
A hard workflow protection that prevents a risky coding-agent action before it mutates repo state or violates policy.
_Avoid_: Nudge when the protection blocks execution.

**Nudge**:
A non-blocking workflow finding that tells the coding agent to correct course before continuing.
_Avoid_: Warning when the finding is advisory but not a hard stop.

**Blocker**:
A workflow finding that requires the coding agent to stop until the named condition is resolved.
_Avoid_: Error when the repo state is valid but continuation is unsafe.

**Gate**:
A named verification checkpoint that records pass or fail evidence. Gates run only when an operator or coding agent explicitly triggers them; they are never automatic background checks.
_Avoid_: Test when the checkpoint may include checks other than tests.

**Command Alias**:
A contract-defined name for a concrete repo command that a gate can run.
_Avoid_: Script when the command may not be a package script.

### Work artifacts

**Plan**:
A repo-local implementation checklist that describes intended work, progress, review status, and verification status.
_Avoid_: Spec when it is tracking execution rather than requirements alone.

**Active Plan**:
The plan currently selected as the workflow's source of truth for progress and next action.
_Avoid_: Current task when the whole plan, not one checkbox, is selected.

**Slice**:
A bounded unit of work within a plan that should be implemented, reviewed, and verified before moving on.
_Avoid_: Task when the unit includes review and evidence obligations.

**Handoff**:
A durable summary that lets another operator or agent continue from the current workflow state without relying on chat history.
_Avoid_: Summary when it is intended to transfer responsibility.

### Safety and evidence

**Evidence**:
Recorded proof that a required workflow event happened for the current repo state.
_Avoid_: Note when the record is used to satisfy workflow requirements.

**Trusted Evidence**:
Evidence accepted by the workflow as sufficient for a protected action because it came from a recognized tool path and matches the current repo state.
_Avoid_: Manual approval.

**Fresh Evidence**:
Evidence whose diff hash still matches the current repo changes.
_Avoid_: Valid evidence when the question is only whether edits made it stale.

**Commit Ready**:
The workflow state where current trusted review evidence and current gate evidence both match the current repo changes, so a protected commit may proceed if the operator wants it.
_Avoid_: Clean when only git status is clean or tests pass.

**Manual Note**:
A human-readable breadcrumb recorded for audit context but not trusted by itself for protected actions.
_Avoid_: Approval.

**Diff Hash**:
A fingerprint of the current repo changes used to decide whether review, gate, or checkpoint evidence is still fresh.
_Avoid_: Commit hash.

**Checkpoint**:
A recorded workflow snapshot used to decide whether later evidence still matches the repo changes it was created for.
_Avoid_: Savepoint or backup.

**Dirty Baseline**:
The protected set of repo changes that already existed before a coding-agent edit sequence began.
_Avoid_: Working tree when specifically referring to pre-existing protected work.

**Dirty Overlap Approval**:
A path-scoped operator approval allowing one intentional edit to a path already present in the dirty baseline.
_Avoid_: Global permission.

**Protected Path**:
A repo path that requires extra workflow evidence or explicit approval before the coding agent may change it, such as high-risk paths, generated files, or lockfiles.
_Avoid_: Sensitive path when the protection is about workflow ownership rather than secrecy.

**Review Packet**:
A compact, bounded handoff prepared for a reviewer or oracle so they can assess the current diff and evidence state.
_Avoid_: Prompt dump.

**Evidence Bundle**:
A sanitized, bounded export of workflow evidence for handoff, release review, or commit review.
_Avoid_: Full log.
