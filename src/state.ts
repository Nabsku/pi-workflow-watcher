import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { git, dirtyFiles, repoRoot, normalizeDirtyPath, repoLocalPath } from "./fs-git.ts";

export function runsDirResolution(root: string, contract: WorkflowContract | null): { path: string; valid: boolean; error?: string } {
  try { return { path: repoLocalPath(root, contract?.artifacts?.runsDir, ".pi/runs"), valid: true }; }
  catch (err) {
    const error = `artifacts.runsDir: ${err instanceof Error ? err.message : String(err)}`;
    return { path: join(root, ".pi/runs"), valid: false, error };
  }
}
export function runsDir(root: string, contract: WorkflowContract | null): string { return runsDirResolution(root, contract).path; }
export function watcherLog(root: string, contract: WorkflowContract | null): string { return join(runsDir(root, contract), "workflow-watcher.log"); }
export function ledgerFile(root: string, contract: WorkflowContract | null): string { return join(runsDir(root, contract), "workflow-watcher.jsonl"); }
export function stateFile(root: string, contract: WorkflowContract | null): string { return join(runsDir(root, contract), "workflow-state.json"); }
export function readLog(root: string, contract: WorkflowContract | null): string { try { return readFileSync(watcherLog(root, contract), "utf8"); } catch { return ""; } }
export function hasCommitEvidence(root: string, contract: WorkflowContract | null): boolean { return /OK_TO_COMMIT|OK_TO_MARK_DONE/.test(readLog(root, contract)) && /gate\s+(beforeCommit|final).*pass|beforeCommit.*pass|final.*pass/i.test(readLog(root, contract)); }
export function defaultState(): WorkflowState { return { version: 1 }; }
export function readState(root: string, contract: WorkflowContract | null): WorkflowState {
  try { const parsed = JSON.parse(readFileSync(stateFile(root, contract), "utf8")) as Partial<WorkflowState>; return parsed?.version === 1 ? { ...defaultState(), ...parsed, version: 1 } : defaultState(); }
  catch { return defaultState(); }
}
export function writeState(root: string, contract: WorkflowContract | null, state: WorkflowState): void { const dir = runsDir(root, contract); mkdirSync(dir, { recursive: true }); writeFileSync(stateFile(root, contract), `${JSON.stringify(state, null, 2)}\n`, "utf8"); }
export function repoRelativePath(root: string, target: string): string | undefined {
  const resolved = resolve(root, target);
  const rel = relative(root, resolved).replace(/\\/g, "/");
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}
function normalizedExcludePaths(root: string, excludePaths: string[] | undefined): string[] {
  return [...new Set((excludePaths ?? []).map((entry) => {
    const resolved = resolve(root, entry);
    return relative(root, resolved).replace(/\\/g, "/").replace(/\/$/, "");
  }).filter((entry) => entry && !entry.startsWith("..") && !isAbsolute(entry)))];
}

function pathIsExcluded(rel: string, excludePaths: string[]): boolean {
  const normalized = rel.replace(/\\/g, "/").replace(/\/$/, "");
  return excludePaths.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`));
}

export function runtimeArtifactExcludes(root: string, contract: WorkflowContract | null, extraPaths: string[] = []): string[] {
  return normalizedExcludePaths(root, [runsDir(root, contract), ".pi/runs", ".pi/tasks", ...extraPaths]);
}

export function diffSnapshot(root: string, options: { excludePaths?: string[] } = {}): { diffHash: string; dirtyFiles: string[] } {
  const excluded = normalizedExcludePaths(root, options.excludePaths);
  const dirty = dirtyFiles(root).filter((entry) => !pathIsExcluded(normalizeDirtyPath(entry), excluded));
  const diffArgs = excluded.length ? ["diff", "HEAD", "--binary", "--", ".", ...excluded.map((entry) => `:(exclude)${entry}`)] : ["diff", "HEAD", "--binary"];
  const diff = git(diffArgs, root);
  const hash = createHash("sha256").update(diff).update("\0").update(dirty.join("\n"));
  for (const entry of dirty) {
    if (!entry.trimStart().startsWith("??")) continue;
    const rel = normalizeDirtyPath(entry);
    const path = resolve(root, rel);
    const normalizedRel = relative(root, path);
    if (normalizedRel.startsWith("..") || isAbsolute(normalizedRel)) continue;
    try {
      const stat = statSync(path);
      if (stat.isFile()) hash.update("\0UNTRACKED\0").update(rel).update("\0").update(readFileSync(path));
    } catch { /* ignore vanishing files */ }
  }
  return { diffHash: hash.digest("hex"), dirtyFiles: dirty };
}
export function markReviewStaleIfEdited(state: WorkflowState, currentDiffHash: string): WorkflowState {
  if (state.lastReviewVerdict && state.lastReviewVerdict.stale !== true && state.lastReviewVerdict.diffHash !== currentDiffHash) state.lastReviewVerdict = { ...state.lastReviewVerdict, stale: true };
  return state;
}
export function checkpoint(root: string, mode: CheckpointMode): { at: string; mode: CheckpointMode; diffHash: string; dirtyFiles: string[] } { const snap = diffSnapshot(root); return { at: new Date().toISOString(), mode, diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles }; }
export function commitEvidenceCurrent(root: string, contract: WorkflowContract | null): boolean {
  const state = readState(root, contract);
  const current = diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, contract) });
  const reviewSource = state.lastReviewVerdict?.source;
  const reviewOk = Boolean(state.lastReviewVerdict && state.lastReviewVerdict.stale !== true && state.lastReviewVerdict.diffHash === current.diffHash && state.lastReviewVerdict.verdict === "OK_TO_COMMIT" && reviewSource === "reviewer_evidence");
  const gateOk = Boolean(state.lastGateResult && state.lastGateResult.status === "pass" && state.lastGateResult.diffHash === current.diffHash && state.lastGateResult.source === "workflow_gate" && (state.lastGateResult.gate === "beforeCommit" || state.lastGateResult.gate === "final"));
  const checkpointOk = !state.checkpoint || state.checkpoint.diffHash === current.diffHash;
  return reviewOk && gateOk && checkpointOk;
}
