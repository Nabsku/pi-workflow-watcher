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
import { runsDirResolution, runsDir, watcherLog, ledgerFile, stateFile, readLog, defaultState, readState, writeState, repoRelativePath, diffSnapshot, runtimeArtifactExcludes, markReviewStaleIfEdited, checkpoint, commitEvidenceCurrent } from "./state.ts";
import { pathMatchesPattern, editGuardForPath, redactSecrets } from "./guards.ts";

export function evidenceDetails(root: string, contract: WorkflowContract | null): EvidenceDetails {
  const state = readState(root, contract); const snap = diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, contract) }); const commitReady = commitEvidenceCurrent(root, contract);
  const review = state.lastReviewVerdict; const gate = state.lastGateResult;
  const reviewFresh = !!review && review.diffHash === snap.diffHash && review.stale !== true; const gateFresh = !!gate && gate.diffHash === snap.diffHash && gate.status === "pass";
  const missing: string[] = []; if (!reviewFresh) missing.push("trusted reviewer/oracle evidence"); if (!gateFresh) missing.push("current workflow_gate beforeCommit/final pass"); if (state.checkpoint?.diffHash !== snap.diffHash) missing.push("current diff checkpoint");
  return { root, statePath: stateFile(root, contract), currentDiffHash: snap.diffHash, commitReady, review, reviewTrusted: !!review?.source, reviewFresh, reviewVerdictOk: !!review?.verdict?.startsWith("OK_TO_"), manualNote: state.lastNote, manualNoteStatus: state.lastNote ? "breadcrumb" : "none", gate, gateFresh, gateTrusted: gate?.source === "workflow_gate", checkpointFresh: state.checkpoint?.diffHash === snap.diffHash, missing, nextActions: missing.length ? ["Import fresh review evidence and run required gate."] : ["Evidence is current; proceed per user commit policy."] };
}
export function formatEvidence(d: EvidenceDetails): string {
  const review = d.review ? `${d.review.verdict} at ${d.review.at} source=${d.review.source ?? "unknown"} trusted=${d.reviewTrusted ? "yes" : "no"} fresh=${d.reviewFresh ? "yes" : "no"} verdict-ok=${d.reviewVerdictOk ? "yes" : "no"} diffHash=${d.review.diffHash}` : "none";
  const note = d.manualNoteStatus === "none" ? "none" : `${d.manualNoteStatus}${d.manualNote ? ` at ${d.manualNote.at} — ${d.manualNote.note}` : ""}`;
  const gate = d.gate ? `${d.gate.gate} ${d.gate.status} at ${d.gate.at} source=${d.gate.source ?? "unknown"} trusted=${d.gateTrusted ? "yes" : "no"} fresh=${d.gateFresh ? "yes" : "no"} diffHash=${d.gate.diffHash}` : "none";
  const lines = ["# Workflow evidence", `decision: ${d.commitReady ? "commit evidence is current" : "commit is blocked"}`, `root: ${d.root}`, `current diffHash: ${d.currentDiffHash}`, `commit-ready: ${d.commitReady ? "yes" : "no"}`, "", "## Evidence", `- trusted reviewer/oracle: ${review}`, `- manual note status: ${note}`, `- workflow_gate beforeCommit/final: ${gate}`, `- checkpoint fresh: ${d.checkpointFresh ? "yes" : "no"}`, "", "## Missing pieces"];
  lines.push(...(d.missing.length ? d.missing.map((item) => `- ${item}`) : ["- none"]));
  lines.push("", "## Next safe actions", ...(d.nextActions.length ? [...new Set(d.nextActions)].map((item) => `- ${item}`) : ["- Commit may proceed if the user wants; do not push without explicit approval."]));
  if (d.missing.some((item) => item.includes("reviewer/oracle"))) lines.push("- Use /workflow review-prompt to create a compact reviewer/oracle handoff packet.");
  lines.push("", "Manual notes are recorded context, not trusted approval.");
  return lines.join("\n");
}
