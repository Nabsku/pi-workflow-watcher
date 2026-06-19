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
import { architectureChecklist } from "./workflow-lessons.ts";
export function ownershipNotes(contract: WorkflowContract | null, files: string[]) {
  const own = contract?.ownership ?? {};
  const pick = (patterns: string[] | undefined) => files.filter((file) => (patterns ?? []).some((pattern) => pathMatchesPattern(file, pattern)));
  return { highRisk: pick(own.highRiskPaths), generated: pick(own.generatedPaths), lockfiles: pick(own.lockfiles) };
}
export function activeSlice(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return readFileSync(path, "utf8").split("\n").find((line) => /^\s*- \[ \]/.test(line))?.replace(/^\s*- \[ \]\s*/, "").trim(); }
  catch { return undefined; }
}
export function reviewTouchedFiles(root: string): string[] {
  const files = new Set<string>();
  for (const entry of diffSnapshot(root).dirtyFiles) {
    const rel = normalizeDirtyPath(entry).replace(/\/$/, "");
    const abs = resolve(root, rel);
    const normalizedRel = relative(root, abs).replace(/\\/g, "/");
    if (normalizedRel.startsWith("..") || isAbsolute(normalizedRel)) continue;
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            if (name === ".git") continue;
            const child = join(dir, name);
            const childStat = statSync(child);
            if (childStat.isDirectory()) walk(child);
            else if (childStat.isFile()) files.add(relative(root, child).replace(/\\/g, "/"));
          }
        };
        walk(abs);
      } else files.add(normalizedRel);
    } catch { files.add(normalizedRel); }
  }
  return [...files].sort();
}
export function reviewPacketDetails(root: string): ReviewPacketDetails {
  const read = readContract(root); const contract = read.contract; const analysis = analyze(root, "before-commit"); const evidence = evidenceDetails(root, contract);
  const touchedFiles = reviewTouchedFiles(root);
  const own = ownershipNotes(contract, touchedFiles);
  const plan = analysis.planInfo.activePlan?.slice(root.length + 1);
  const slice = activeSlice(analysis.planInfo.activePlan);
  const packetLines = ["# Workflow review packet", "Do not launch subagents from this packet; hand it to the reviewer/oracle.", `root: ${root}`, `active plan: ${plan ?? "none"}`, `active slice: ${slice ?? "unknown"}`, `current diffHash: ${analysis.currentDiffHash}`, "", "## Touched files", ...(touchedFiles.length ? touchedFiles.map((f) => `- ${f}`) : ["- none"]), "", "## Risk notes", `- high-risk paths: ${own.highRisk.length ? own.highRisk.join(", ") : "none"}`, `- generated paths: ${own.generated.length ? own.generated.join(", ") : "none"}`, `- lockfiles: ${own.lockfiles.length ? own.lockfiles.join(", ") : "none"}`, "", "## Architecture checklist", ...architectureChecklist.map((item) => `- ${item}`), "", "## Gate and evidence", `- gate: ${evidence.gate ? `${evidence.gate.gate} ${evidence.gate.status} fresh=${evidence.gateFresh}` : "none"}`, `- trusted review: ${evidence.review ? `${evidence.review.verdict} trusted=${evidence.reviewTrusted} fresh=${evidence.reviewFresh}` : "none"}`, "", "## Review evidence import requirements", "- Reviewer/oracle verdict must be allowed by the pending review request.", "- Evidence artifact must include one workflow-review-evidence JSON fence with schema pi-workflow-review-evidence/v1 for the current diffHash.", "- Import trusted evidence with workflow_import_review_evidence. Trusted state source is reviewer_evidence. Manual notes are recorded context, not trusted approval."];
  const packet = packetLines.join("\n");
  return { root, activePlan: plan, activeSlice: slice, touchedFiles, currentDiffHash: analysis.currentDiffHash, ownership: own, gateStatus: evidence.gate ? `${evidence.gate.gate}:${evidence.gate.status}` : "none", evidenceStatus: evidence.commitReady ? "commit-ready" : `missing: ${evidence.missing.join(", ")}`, acceptanceRequirements: ["allowed verdict", "current diffHash", "workflow-review-evidence schema"], importRequirements: ["workflow_import_review_evidence", "reviewer_evidence source", "manual notes are recorded context, not trusted approval"], packet };
}
