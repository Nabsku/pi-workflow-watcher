import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, git, repoRoot, dirtyFiles, dirtyPath, unquotePath, normalizeDirtyPath, readJson, repoLocalPath, safeRepoLocalPath } from "./fs-git.ts";
import { readLog, runsDirResolution, readState, diffSnapshot, runtimeArtifactExcludes, markReviewStaleIfEdited, writeState } from "./state.ts";
import { readContract, validateContractSchema, validateContractSemantics } from "./contract-read.ts";
import { listPlans, inferActivePlan, inspectPlan } from "./plans.ts";
import { inspectWorkflowLessons } from "./workflow-lessons.ts";
export function severity(findings: Finding[]): Severity {
  if (findings.some((f) => f.severity === "blocker")) return "blocker";
  if (findings.some((f) => f.severity === "nudge")) return "nudge";
  return "ok";
}

export function analyze(root: string, mode: WatchMode, planPath?: unknown, options: { writeState?: boolean } = {}): { contractRead: ContractRead; contract: WorkflowContract | null; findings: Finding[]; dirty: string[]; plans: string[]; nextAction: string; planInfo: ReturnType<typeof inspectPlan>; state: WorkflowState; currentDiffHash: string; planInference: PlanInference; workflowLessons: ReturnType<typeof inspectWorkflowLessons> } {
  const contractRead = readContract(root);
  const contract = contractRead.contract;
  const findings: Finding[] = [];
  if (contractRead.status === "invalid-json") findings.push({ severity: "blocker", title: "Invalid workflow contract JSON", detail: `.pi/workflows.json exists but could not be parsed: ${contractRead.error}` });
  if (contract) findings.push(...validateContractSchema(contract), ...validateContractSemantics(contract, mode));
  const runs = runsDirResolution(root, contract);
  if (!runs.valid) findings.push({ severity: "blocker", title: "Workflow runsDir escapes repo", detail: `${runs.error}; using safe fallback .pi/runs for state/log artifacts.` });
  const dirty = dirtyFiles(root);
  const plans = listPlans(root, contract, findings);
  let state = readState(root, contract);
  const planInference = inferActivePlan(root, contract, planPath, state, plans, findings);
  findings.push(...planInference.findings);
  const planInfo = inspectPlan(planInference.selectedPlan);
  const workflowLessons = inspectWorkflowLessons(planInfo.activePlan, planInfo.checkboxTasks?.find((task) => !task.checked)?.text);
  if (workflowLessons.activeSliceNudge) findings.push({ severity: "nudge", title: "Narrow active slice", detail: workflowLessons.activeSliceNudge });
  const current = diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, contract) });
  if (planInfo.activePlan) state.activePlan = planInfo.activePlan.slice(root.length + 1);
  if ((mode === "preflight" || mode === "before-slice") && !state.dirtyBaseline) state.dirtyBaseline = { at: new Date().toISOString(), diffHash: current.diffHash, dirtyFiles: current.dirtyFiles };
  state = markReviewStaleIfEdited(state, current.diffHash);

  if (contractRead.status === "missing") findings.push({ severity: "nudge", title: "No workflow contract", detail: "Create .pi/workflows.json with workflow_init before relying on repo gates." });
  if ((mode === "planning" || mode === "preflight") && contract && !planInfo.activePlan) findings.push({ severity: "nudge", title: "No active plan selected", detail: "Create or pass the exact .pi/plans/<slug>.md plan before execution." });
  if (dirty.length > 0) findings.push({ severity: "nudge", title: "Dirty checkout", detail: `${dirty.length} changed/untracked file(s). Classify overlap before editing.` });
  if ((mode === "slice-complete" || mode === "after-slice") && contract?.rules?.requireAdversarialReviewAfterEveryTask === true) findings.push({ severity: "blocker", title: "Review required now", detail: "Run a separate reviewer/oracle before marking the slice done or continuing." });
  if (planInfo.missingReviewBlocks) findings.push({ severity: "blocker", title: "Plan missing adversarial review block", detail: "The completed spine requires each slice to name its adversarial review contract and verdicts." });
  if (planInfo.completedPlanTasks && contract?.rules?.requireAdversarialReviewAfterEveryTask === true && planInfo.reviewVerdicts.length < planInfo.completedPlanTasks) findings.push({ severity: "blocker", title: "Completed tasks missing review verdicts", detail: `${planInfo.completedPlanTasks} completed task(s), ${planInfo.reviewVerdicts.length} adversarial verdict(s) found.` });
  if ((mode === "before-slice" || mode === "preflight") && planInfo.openPlanTasks === 0 && planInfo.activePlan) findings.push({ severity: "nudge", title: "No open checklist tasks", detail: "Plan has no unchecked tasks; verify whether this should be final/oracle mode instead." });
  if ((mode === "before-commit" || mode === "final") && contract?.rules?.requireReviewBeforeCommit !== false) findings.push({ severity: "nudge", title: "Verify review evidence", detail: "Import Workflow Watcher review evidence with workflow_import_review_evidence, then run the exact workflow_gate command output." });
  if (plans.length === 0 && mode !== "status") findings.push({ severity: "nudge", title: "No plan artifact found", detail: "For multi-file work, create/update .pi/plans/<slug>.md before implementation." });
  if ((mode === "before-commit" || mode === "final") && state.lastReviewVerdict?.stale === true) findings.push({ severity: "blocker", title: "Review verdict is stale", detail: "Current diff changed after the last review verdict. Re-run review before commit/final." });
  if ((mode === "before-commit" || mode === "final") && state.checkpoint && state.checkpoint.diffHash !== current.diffHash) findings.push({ severity: "blocker", title: "Diff changed since checkpoint", detail: `Current diff does not match checkpoint from ${state.checkpoint.at}. Re-check/review before commit/final.` });
  if ((mode === "before-commit" || mode === "final") && contract?.rules?.requireReviewBeforeCommit !== false && !state.lastReviewVerdict) findings.push({ severity: "nudge", title: "No persisted review verdict", detail: "Import reviewer/oracle evidence for a pending Workflow Watcher review request with workflow_import_review_evidence before commit/final." });
  if ((mode === "before-commit" || mode === "final") && !state.lastGateResult) findings.push({ severity: "nudge", title: "No persisted gate result", detail: "Run workflow_gate before commit/final." });
  if ((mode === "before-commit" || mode === "final") && state.lastGateResult && state.lastGateResult.status !== "pass") findings.push({ severity: "blocker", title: "Last gate did not pass", detail: `${state.lastGateResult.gate} last recorded ${state.lastGateResult.status}.` });
  if ((mode === "before-commit" || mode === "final") && state.lastGateResult && state.lastGateResult.diffHash !== current.diffHash) findings.push({ severity: "blocker", title: "Gate result is stale", detail: "Current diff changed after the last gate result. Re-run gate before commit/final." });

  let nextAction = "Continue; keep changes surgical and report exact verification.";
  if (contractRead.status === "invalid-json") nextAction = "Fix .pi/workflows.json JSON before continuing.";
  else if (contractRead.status === "missing") nextAction = "Run workflow_init, then inspect generated .pi/workflows.json.";
  else if (workflowLessons.activeSliceNudge) nextAction = workflowLessons.activeSliceNudge;
  else if (severity(findings) === "blocker") nextAction = "Stop and resolve blocker findings before editing or committing.";
  else if (mode === "slice-complete" || mode === "after-slice") nextAction = "Stop implementation and run reviewer/oracle on the completed slice.";
  else if (mode === "planning") nextAction = "Generate/update the plan artifact, then run oracle before presenting it.";
  else if (dirty.length > 0) nextAction = "Classify dirty files, protect unrelated work, then proceed with the smallest safe slice.";
  else if (plans.length === 0 && mode !== "status") nextAction = "Create a concise plan artifact before editing multiple files.";
  if (options.writeState !== false) writeState(root, contract, state);
  return { contractRead, contract, findings, dirty, plans, nextAction, planInfo, state, currentDiffHash: current.diffHash, planInference, workflowLessons };
}
