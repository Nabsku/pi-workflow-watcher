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
export function formatWhy(d: WhyDetails): string {
  return ["# Workflow why", `decision: ${d.blocked ? "blocked" : "not blocked"}`, `source: ${d.source}`, `reason: ${d.reason}`, `next action: ${d.nextAction}`, ...(d.path ? [`path: ${d.path}`] : []), "", "Manual notes are recorded context, not trusted approval."].join("\n");
}
export function whyDetails(root: string, target: "workflow" | "commit" | "edit" = "workflow", path?: string): WhyDetails {
  const read = readContract(root); const analysis = analyze(root, target === "commit" ? "before-commit" : "status");
  if (target === "commit") {
    const evidence = evidenceDetails(root, read.contract);
    return { root, target, blocked: !evidence.commitReady, source: "commit evidence", reason: evidence.commitReady ? "Trusted review and gate evidence match the current diff." : evidence.missing.join("; "), nextAction: evidence.nextActions[0] ?? "Commit may proceed if the user wants; do not push without explicit approval.", evidence };
  }
  if (target === "edit") {
    const guard = path ? editGuardForPath(root, analysis, path) : { block: true, reason: "No path supplied." };
    return { root, target, path, blocked: Boolean(guard?.block), source: "edit guard", reason: guard?.reason ?? "No edit-specific blocker found for this path.", nextAction: guard?.block ? "Resolve the guard, narrow the path, or get explicit approval before editing." : "Proceed with a surgical edit, then run focused verification." };
  }
  const finding = analysis.findings.find((f) => f.severity === "blocker") ?? analysis.findings.find((f) => f.severity === "nudge");
  return { root, target, blocked: severity(analysis.findings) === "blocker", source: finding ? `${finding.severity} finding` : "workflow watcher", reason: finding ? `${finding.title}: ${finding.detail}` : "No blocker findings are active.", nextAction: analysis.nextAction, finding };
}
