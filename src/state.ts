import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { git, dirtyFiles, repoRoot, normalizeDirtyPath, dirtyEntryPaths, repoLocalPath } from "./fs-git.ts";

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

function untrackedFiles(root: string, rel: string, excludePaths: string[]): string[] {
  const out = git(["ls-files", "--others", "--exclude-standard", "--", rel], root);
  return out ? out.split("\n").map((line) => line.trimEnd().replace(/\\/g, "/")).filter((file) => file && !pathIsExcluded(file, excludePaths)).sort() : [];
}

export function dedicatedRuntimeDir(root: string, dir: string): boolean {
  const rel = relative(root, dir).replace(/\\/g, "/");
  if (rel === ".pi/runs" || rel.startsWith(".pi/")) return true;
  const segments = rel.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.some((segment) => segment === "runs" || segment === "artifacts" || segment === "workflow-artifacts" || segment === "workflow");
}

function pathInsideDir(root: string, path: string, dir: string): boolean {
  const rel = relative(resolve(root, dir), resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function importedRuntimeArtifactPaths(root: string, contract: WorkflowContract | null, runDirs: string[]): string[] {
  const artifactPath = readState(root, contract).lastReviewVerdict?.artifactPath;
  if (!artifactPath) return [];
  return runDirs.some((dir) => pathInsideDir(root, artifactPath, dir)) ? [artifactPath] : [];
}

function existingWatcherArtifacts(dir: string): string[] {
  const artifacts = [join(dir, "workflow-watcher.log"), join(dir, "workflow-watcher.jsonl"), join(dir, "workflow-state.json")];
  const reviewRequests = join(dir, "review-requests");
  if (existsSync(reviewRequests)) artifacts.push(reviewRequests);
  try {
    for (const name of readdirSync(dir)) {
      if (/^workflow-evidence-bundle-.*\.md$/.test(name) || /^workflow-review-evidence-.*\.md$/.test(name)) artifacts.push(join(dir, name));
    }
  } catch { /* runsDir may not exist yet */ }
  return artifacts;
}

export function runtimeArtifactExcludes(root: string, contract: WorkflowContract | null, extraPaths: string[] = []): string[] {
  const configured = runsDirResolution(root, contract);
  const defaultRunsDir = join(root, ".pi/runs");
  const configuredIsRuntime = configured.valid && dedicatedRuntimeDir(root, configured.path);
  const runDirs = configuredIsRuntime && configured.path !== defaultRunsDir ? [configured.path, defaultRunsDir] : [defaultRunsDir];
  return normalizedExcludePaths(root, [...runDirs, ...runDirs.flatMap(existingWatcherArtifacts), ...importedRuntimeArtifactPaths(root, contract, runDirs), join(root, ".pi/tasks"), ...extraPaths]);
}

export function diffSnapshot(root: string, options: { excludePaths?: string[] } = {}): { diffHash: string; dirtyFiles: string[] } {
  const excluded = normalizedExcludePaths(root, options.excludePaths);
  const dirty: string[] = [];
  for (const entry of dirtyFiles(root)) {
    const rel = normalizeDirtyPath(entry);
    const paths = dirtyEntryPaths(entry);
    if (paths.length > 0 && paths.every((path) => pathIsExcluded(path, excluded))) continue;
    if (entry.trimStart().startsWith("??")) {
      const files = untrackedFiles(root, rel, excluded);
      if (files.length) dirty.push(...files.map((file) => `?? ${file}`));
      continue;
    }
    dirty.push(entry);
  }
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
