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

export function redactSecrets(text: string): string { return String(text ?? "").replace(/\b(?:sk|ghp|github_pat|xox[baprs])-?[^\s,;]+/gi, "[REDACTED_TOKEN]").replace(/(api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>"); }
export function safePreview(text: unknown, max = 2000): string { return redactSecrets(String(text ?? "")).slice(0, max); }
export function outputSummary(text: unknown): string { const value = String(text ?? ""); const lines = value.split("\n").filter((line) => line.trim()).length; return `${value.length} chars${lines ? `, ${lines} lines` : ""}`; }
export function safeGateCommands(commands: GateCommandRun[]): LedgerEvent["commands"] { return commands.map((c) => ({ alias: c.alias, status: c.status, exitCode: c.exitCode, signal: c.signal, durationMs: c.durationMs, timeoutSeconds: c.timeoutSeconds, timedOut: c.timedOut, error: c.error, stdoutSummary: c.stdout ? outputSummary(c.stdout) : undefined, stderrSummary: c.stderr ? outputSummary(c.stderr) : undefined })); }

export function appendLedgerEvent(root: string, contract: WorkflowContract | null, event: LedgerEvent): string {
  const dir = runsDir(root, contract);
  mkdirSync(dir, { recursive: true });
  const path = ledgerFile(root, contract);
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  return path;
}
