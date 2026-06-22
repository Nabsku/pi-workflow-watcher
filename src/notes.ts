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
import { runsDirResolution, runsDir, watcherLog, ledgerFile, stateFile, readLog, defaultState, readState, writeState, repoRelativePath, diffSnapshot, runtimeArtifactExcludes, markReviewStaleIfEdited, checkpoint, commitEvidenceCurrent } from "./state.ts";

import { safePreview, appendLedgerEvent } from "./guard-logging.ts";
export function appendWorkflowNote(root: string, noteInput: unknown): AgentToolResult<NoteDetails> {
  const read = readContract(root); const contract = read.contract;
  const runs = runsDirResolution(root, contract);
  if (!runs.valid) return textResult(`Workflow note rejected: ${runs.error}; safe fallback is ${runs.path}`, { root, path: join(runs.path, "workflow-watcher.log"), statePath: join(runs.path, "workflow-state.json"), appended: false, status: "fail", error: runs.error });
  const dir = runs.path; mkdirSync(dir, { recursive: true }); const path = join(dir, "workflow-watcher.log"); const note = String(noteInput).trim(); const safeNote = safePreview(note, 400) ?? ""; const line = `${new Date().toISOString()} ${safeNote}\n`;
  appendFileSync(path, line, "utf8");
  const state = readState(root, contract); const snap = diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, contract) });
  appendLedgerEvent(root, contract, { type: "note", at: new Date().toISOString(), diffHash: snap.diffHash, source: "manual_note", notePreview: safePreview(note) });
  state.lastNote = { at: new Date().toISOString(), note: safeNote };
  const verdict = note.match(/\b(OK_TO_MARK_DONE|OK_TO_MARK_FIXED|OK_TO_COMMIT|NEEDS_FIX|BLOCKED|OK_TO_PRESENT|NEEDS_WORK)\b/);
  if (verdict) { state.lastReviewVerdict = { verdict: verdict[1], at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, stale: false, source: "manual_note" }; state.checkpoint = { at: new Date().toISOString(), mode: "note", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles }; }
  const gate = note.match(/\bgate\s+([A-Za-z0-9_-]+)\s+(pass|fail)\b/i);
  if (gate) { state.lastGateResult = { gate: gate[1], status: gate[2].toLowerCase() as "pass" | "fail", at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, source: "manual_note" }; if (state.lastGateResult.status === "pass") state.checkpoint = { at: new Date().toISOString(), mode: "note", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles }; }
  writeState(root, contract, state);
  return textResult(`Appended watcher note to ${path}`, { root, path, statePath: stateFile(root, contract), appended: true, status: "ok" });
}
