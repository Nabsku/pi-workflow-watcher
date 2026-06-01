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
import { formatWorkflowLessons } from "./workflow-lessons.ts";
export function formatDoctor(d: DoctorDetails): string { return [`# Workflow doctor`, `readiness: ${d.ready ? "READY" : "NOT READY"}`, `contract: ${d.contractStatus}`, `commands: ${d.commands.join(", ") || "none"}`, `gates: ${d.gates.join(", ") || "none"}`, `commit-ready: ${d.commitReady ? "yes" : "no"}`, `commit-missing: ${d.commitMissing.join(", ") || "none"}`, "This command does not run gates or tests.", ...(d.workflowLessons ? ["", "## Workflow lessons", ...formatWorkflowLessons(d.workflowLessons as { specSignals: { spec: boolean; acceptance: boolean; testPlan: boolean }; activeSliceNudge?: string })] : []), ...d.blockers.map((b) => `blocker: ${b}`), ...d.warnings.map((w) => `warning: ${w}`), ...d.repairSteps.map((r) => `repair: ${r}`)].join("\n"); }
export function formatHelp(): string { return "workflow: status | next | progress | doctor | evidence | why | review-prompt | bundle | dirty | note <text> | gate <name> [--dry-run] | plan [path|slug] | help"; }
export function doctorDetails(root: string): DoctorDetails {
  const analysis = analyze(root, "status", undefined, { writeState: false });
  const read = analysis.contractRead;
  const contract = analysis.contract;
  const runs = runsDirResolution(root, contract);
  const evidence = evidenceDetails(root, contract);
  const blockers = analysis.findings.filter((f) => f.severity === "blocker").map((f) => `${f.title}: ${f.detail}`);
  const warnings = analysis.findings.filter((f) => f.severity === "nudge").map((f) => `${f.title}: ${f.detail}`);
  const repairSteps: string[] = [];
  if (read.status === "missing") repairSteps.push("Run workflow_init, then inspect and commit .pi/workflows.json.");
  if (read.status === "invalid-json") repairSteps.push(`Fix .pi/workflows.json JSON parse error: ${read.error}`);
  if (contract) {
    for (const f of analysis.findings) {
      if (f.title.includes("schema")) repairSteps.push(`Edit .pi/workflows.json: ${f.detail}`);
      else if (/[Gg]ate|[Cc]ommand/.test(f.title)) repairSteps.push(`Repair gates/commands in .pi/workflows.json: ${f.detail}`);
      else if (/[Pp]ath|runsDir/.test(f.title)) repairSteps.push(`Keep artifact paths repo-local; set artifacts.runsDir to .pi/runs or another repo-local directory. ${f.detail}`);
    }
  }
  if (contract && evidence.missing.length) repairSteps.push(...evidence.nextActions);
  if (repairSteps.length === 0) repairSteps.push("No repairs needed. Use /workflow gate <name> only when you intentionally want to run verification.");
  const ready = read.status === "ok" && blockers.length === 0;
  return { root, ready, contractStatus: read.status, blockers, warnings, repairSteps: [...new Set(repairSteps)], artifactPaths: { runsDir: runs.path, fallbackUsed: !runs.valid, error: runs.error }, commands: Object.keys(contract?.commands ?? {}), gates: Object.keys(contract?.gates ?? {}), commitReady: evidence.commitReady, commitMissing: evidence.missing, workflowLessons: analysis.workflowLessons } as DoctorDetails;
}
