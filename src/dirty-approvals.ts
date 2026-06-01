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

import { safePreview, appendLedgerEvent } from "./guard-logging.ts";
export function formatDirtyApprovals(state: WorkflowState): string[] {
  return (state.dirtyOverlapApprovals ?? []).map((approval) => `- ${approval.path}: ${approval.consumedAt ? `consumed ${approval.consumedAt}` : "pending"} baselineDiffHash=${approval.baselineDiffHash} reason=${approval.reason}`);
}

export function approveDirtyOverlap(root: string, pathInput: unknown, reasonInput: unknown): AgentToolResult<{ root: string; path?: string; approved: boolean; error?: string; baselineDiffHash?: string; statePath: string; ledgerPath?: string }> {
  const read = readContract(root); const contract = read.contract; const state = readState(root, contract);
  const path = typeof pathInput === "string" ? repoRelativePath(root, pathInput.trim()) : undefined;
  const reason = safePreview(reasonInput, 400);
  if (!path) return textResult("Dirty-overlap approval rejected: path must be repo-local.", { root, approved: false, error: "path must be repo-local", statePath: stateFile(root, contract) });
  if (!reason) return textResult(`Dirty-overlap approval rejected for ${path}: --reason is required.`, { root, path, approved: false, error: "reason required", statePath: stateFile(root, contract) });
  const baseline = state.dirtyBaseline;
  if (!baseline) return textResult("Dirty-overlap approval rejected: no dirty baseline exists. Run workflow_watch mode=preflight or /workflow dirty baseline refresh first.", { root, path, approved: false, error: "dirty baseline required", statePath: stateFile(root, contract) });
  const baselineDirty = baseline.dirtyFiles.map(normalizeDirtyPath);
  if (!baselineDirty.includes(path)) return textResult(`Dirty-overlap approval rejected: ${path} is not in dirtyBaseline.dirtyFiles. Run /workflow dirty to inspect baseline files.`, { root, path, approved: false, error: "path not in dirty baseline", baselineDiffHash: baseline.diffHash, statePath: stateFile(root, contract) });
  const at = new Date().toISOString();
  state.dirtyOverlapApprovals = [...(state.dirtyOverlapApprovals ?? []).filter((approval) => !(approval.path === path && !approval.consumedAt)), { path, reason, at, baselineDiffHash: baseline.diffHash }];
  writeState(root, contract, state);
  const ledgerPath = appendLedgerEvent(root, contract, { type: "dirty_overlap_approval", at, path, reason, baselineDiffHash: baseline.diffHash, diffHash: diffSnapshot(root).diffHash });
  return textResult(`approved one-shot dirty overlap: ${path}\nreason: ${reason}\nbaselineDiffHash: ${baseline.diffHash}\nNext: the next matching edit to ${path} will consume this approval; high-risk/generated/lockfile/outside-repo protections still apply.`, { root, path, approved: true, baselineDiffHash: baseline.diffHash, statePath: stateFile(root, contract), ledgerPath });
}

export function consumeDirtyOverlapApproval(root: string, contract: WorkflowContract | null, state: WorkflowState, rel: string): boolean {
  const baselineHash = state.dirtyBaseline?.diffHash;
  const approval = (state.dirtyOverlapApprovals ?? []).find((item) => item.path === rel && !item.consumedAt && item.baselineDiffHash === baselineHash);
  if (!approval) return false;
  approval.consumedAt = new Date().toISOString();
  writeState(root, contract, state);
  appendLedgerEvent(root, contract, { type: "dirty_overlap_approval_consumed", at: approval.consumedAt, path: rel, reason: approval.reason, baselineDiffHash: approval.baselineDiffHash, diffHash: diffSnapshot(root).diffHash });
  return true;
}
