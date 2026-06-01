import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, git, repoRoot, dirtyFiles, dirtyPath, normalizeDirtyPath, readJson, unquotePath, repoLocalPath, safeRepoLocalPath } from "./fs-git.ts";
import { readContract, validateContractSchema, validateContractSemantics, normalizePlanPath, starterContract, severity, analyze, isObject } from "./contract.ts";
import { runsDirResolution, runsDir, watcherLog, ledgerFile, stateFile, readLog, defaultState, readState, writeState, repoRelativePath, diffSnapshot, markReviewStaleIfEdited, checkpoint, commitEvidenceCurrent } from "./state.ts";

import { anyPathPattern } from "./path-patterns.ts";
import { consumeDirtyOverlapApproval } from "./dirty-approvals.ts";
export function hasDirtyOverlapApproval(state: WorkflowState, rel: string): boolean {
  const baselineHash = state.dirtyBaseline?.diffHash;
  return Boolean((state.dirtyOverlapApprovals ?? []).find((item) => item.path === rel && !item.consumedAt && item.baselineDiffHash === baselineHash));
}
export function editGuardForPath(root: string, analysis: ReturnType<typeof analyze>, target: string, consumeApproval = false): { block: true; reason: string } | undefined {
  const rel = repoRelativePath(root, target);
  if (!rel) return { block: true, reason: `Workflow watcher blocked edit outside repo root: ${target}` };
  const ownership = analysis.contract?.ownership;
  const highRiskMatch = anyPathPattern(rel, ownership?.highRiskPaths);
  if (highRiskMatch) return { block: true, reason: `Workflow watcher blocked high-risk path edit: ${rel} matches ownership.highRiskPaths ${JSON.stringify(highRiskMatch)}. Explicit high-risk path approval is required; this watcher currently fails closed.` };
  const lockfileMatch = anyPathPattern(rel, ownership?.lockfiles);
  if (lockfileMatch) return { block: true, reason: `Workflow watcher blocked lockfile edit: ${rel} matches ownership.lockfiles ${JSON.stringify(lockfileMatch)}. Approved dependency-change evidence or explicit workflow policy is required; this watcher currently fails closed.` };
  const generatedMatch = anyPathPattern(rel, ownership?.generatedPaths);
  if (generatedMatch) return { block: true, reason: `Workflow watcher blocked generated path edit: ${rel} matches ownership.generatedPaths ${JSON.stringify(generatedMatch)}. Edit the source and record source-generation command evidence instead; this watcher currently fails closed.` };
  const baselineDirty = analysis.state.dirtyBaseline?.dirtyFiles.map(normalizeDirtyPath) ?? [];
  if (baselineDirty.includes(rel)) {
    const approved = consumeApproval ? consumeDirtyOverlapApproval(root, analysis.contract, analysis.state, rel) : hasDirtyOverlapApproval(analysis.state, rel);
    if (!approved) return { block: true, reason: `Workflow watcher blocked edit to pre-existing dirty path: ${rel}. Approve one-shot overlap with: /workflow dirty approve ${JSON.stringify(rel)} --reason "why this edit must touch pre-existing dirty work"` };
  }
  return undefined;
}
