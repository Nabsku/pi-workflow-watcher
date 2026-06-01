import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, git, repoRoot, dirtyFiles, dirtyPath, normalizeDirtyPath, readJson, repoLocalPath, safeRepoLocalPath } from "./fs-git.ts";
import { readContract, validateContractSchema, validateContractSemantics, normalizePlanPath, absolutePlanPath, inferActivePlan, inspectPlan, listPlans, severity, analyze, currentBranch } from "./contract.ts";
import { runsDirResolution, runsDir, watcherLog, ledgerFile, stateFile, readLog, defaultState, readState, writeState, repoRelativePath, diffSnapshot, markReviewStaleIfEdited, checkpoint, commitEvidenceCurrent } from "./state.ts";
import { pathMatchesPattern, editGuardForPath, redactSecrets } from "./guards.ts";

import { evidenceDetails } from "./evidence-status.ts";
import { activeSliceFromPlan, sanitizeBundleText } from "./bundle.ts";
import { inspectWorkflowLessons, formatWorkflowLessons } from "./workflow-lessons.ts";
export function progressDetails(root: string, planPath?: unknown): ProgressDetails {
  const read = readContract(root);
  const contract = read.contract;
  const findings: Finding[] = [];
  const state = readState(root, contract);
  const plans = listPlans(root, contract, findings);
  const planInference = inferActivePlan(root, contract, planPath, state, plans, findings);
  const planInfo = inspectPlan(planInference.selectedPlan);
  const evidence = evidenceDetails(root, contract);
  const tasks = planInfo.checkboxTasks ?? [];
  const limitations: string[] = [...(planInfo.parseLimitations ?? [])];
  if (!planInfo.activePlan) limitations.push("No active plan selected; counts are unavailable until a plan is pinned or inferred.");
  for (const finding of [...findings, ...planInference.findings]) limitations.push(`${finding.title}: ${finding.detail}`);
  const completed = planInfo.parseable ? tasks.filter((task) => task.checked).length : undefined;
  const open = planInfo.parseable ? tasks.filter((task) => !task.checked).length : undefined;
  const total = planInfo.parseable ? tasks.length : undefined;
  const reviewed = planInfo.reviewVerdicts.length ? Math.min(planInfo.reviewVerdicts.length, completed ?? planInfo.reviewVerdicts.length) : 0;
  if (completed !== undefined && reviewed < completed) limitations.push("Reviewed count is conservatively estimated from review verdict tokens in the plan; per-slice review mapping is not exact.");
  const gated = evidence.gateTrusted && evidence.gateFresh ? 1 : 0;
  limitations.push("Gated count is current-diff evidence only; historical per-slice gate mapping is not persisted exactly.");
  const staleMessages: string[] = [];
  const reviewStale = Boolean(evidence.review && (!evidence.reviewFresh || evidence.review.stale === true));
  const gateStale = Boolean(evidence.gate && !evidence.gateFresh);
  const checkpointStale = !evidence.checkpointFresh;
  if (reviewStale) staleMessages.push("Review evidence is stale after edits; re-run/import reviewer or oracle evidence for the current diff before relying on it.");
  if (gateStale) staleMessages.push("Gate evidence is stale after edits; rerun an explicit workflow_gate beforeCommit/final only when ready to verify.");
  if (checkpointStale) staleMessages.push("Checkpoint diff does not match the current diff.");
  const currentSlice = tasks.find((task) => !task.checked)?.text ?? activeSliceFromPlan(planInfo.activePlan);
  const workflowLessons = inspectWorkflowLessons(planInfo.activePlan, currentSlice);
  const nextSafeAction = staleMessages[0] ?? workflowLessons.activeSliceNudge ?? (evidence.missing.length ? [...new Set(evidence.nextActions)][0] ?? "Satisfy missing trusted evidence before commit." : (open && open > 0 ? `Continue current slice: ${currentSlice ?? "next unchecked task"}` : "Plan appears complete; run final review/gate before commit."));
  return { root, activePlan: planInfo.activePlan ? planInfo.activePlan.slice(root.length + 1) : undefined, currentSlice, counts: { open, completed, reviewed, gated, total, limitations: [...new Set(limitations)] }, staleEvidence: { review: reviewStale, gate: gateStale, checkpoint: checkpointStale, messages: staleMessages }, nextSafeAction, planParse: { parseable: Boolean(planInfo.parseable), limitations: planInfo.parseLimitations ?? [] }, evidence: { commitReady: evidence.commitReady, reviewTrusted: evidence.reviewTrusted, reviewFresh: evidence.reviewFresh, gateTrusted: evidence.gateTrusted, gateFresh: evidence.gateFresh, missing: evidence.missing }, workflowLessons } as ProgressDetails;
}

export function formatProgress(d: ProgressDetails): string {
  const lines = [
    "# Workflow progress",
    `root: ${d.root}`,
    `active plan: ${d.activePlan ?? "none"}`,
    `current slice: ${d.currentSlice ?? "unknown"}`,
    "",
    "## Counts",
    `- open: ${d.counts.open ?? "unknown"}`,
    `- completed: ${d.counts.completed ?? "unknown"}`,
    `- reviewed: ${d.counts.reviewed ?? "unknown"}`,
    `- gated: ${d.counts.gated ?? "unknown"}`,
    `- total: ${d.counts.total ?? "unknown"}`,
    "",
    "## Evidence freshness",
    `- review stale after edits: ${d.staleEvidence.review ? "yes" : "no"}`,
    `- gate stale after edits: ${d.staleEvidence.gate ? "yes" : "no"}`,
    `- checkpoint stale: ${d.staleEvidence.checkpoint ? "yes" : "no"}`,
  ];
  lines.push(...(d.staleEvidence.messages.length ? d.staleEvidence.messages.map((item) => `- ${item}`) : ["- no stale review/gate evidence detected"]));
  lines.push("", "## Limitations", ...(d.counts.limitations.length ? d.counts.limitations.map((item) => `- ${item}`) : ["- none"]));
  if (d.workflowLessons) lines.push("", "## Workflow lessons", ...formatWorkflowLessons(d.workflowLessons as { specSignals: { spec: boolean; acceptance: boolean; testPlan: boolean }; activeSliceNudge?: string }));
  lines.push("", "## Next safe action", d.nextSafeAction);
  return lines.join("\n");
}
