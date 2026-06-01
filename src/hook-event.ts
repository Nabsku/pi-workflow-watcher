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

export function eventCwd(event: Record<string, unknown>): string { return cwdFrom((event.cwd ?? (isObject(event.input) ? event.input.cwd : undefined)) as unknown); }
export function toolInput(event: Record<string, unknown>): Record<string, unknown> { return isObject(event.input) ? event.input : isObject(event.args) ? event.args : {}; }
export function commandFromEvent(event: Record<string, unknown>): string { const input = toolInput(event); return String(input.command ?? input.cmd ?? input.input ?? ""); }
export function pathsFromEvent(event: Record<string, unknown>): string[] {
  const input = toolInput(event); const out: string[] = [];
  for (const key of ["path", "filePath", "file_path", "filename", "file", "target_file", "target"]) { const value = input[key]; if (typeof value === "string") out.push(value); }
  for (const key of ["paths", "files", "targets"]) { const value = input[key]; if (Array.isArray(value)) for (const item of value) if (typeof item === "string") out.push(item); }
  return out;
}
export function patchBodyFromEvent(event: Record<string, unknown>): string {
  const input = toolInput(event);
  for (const key of ["patch", "content", "input", "body", "diff", "patchText"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}
export function cleanPatchPath(raw: string): string | undefined {
  let path = unquotePath(raw);
  if (!path || path === "/dev/null") return undefined;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}
export function splitDiffGitPaths(line: string): string[] {
  const body = line.replace(/^diff --git\s+/, "");
  const separator = body.indexOf(" b/");
  if (body.startsWith("a/") && separator > 0) return [body.slice(0, separator), body.slice(separator + 1)];
  const quoted = [...body.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => match[1].replace(/\\"/g, '"'));
  if (quoted.length >= 2) return quoted.slice(0, 2);
  return body.split(/\s+/).slice(0, 2);
}
export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const v4a = line.match(/^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$/);
    if (v4a) { const path = cleanPatchPath(v4a[1]); if (path) paths.add(path); continue; }
    if (line.startsWith("diff --git ")) { for (const part of splitDiffGitPaths(line)) { const path = cleanPatchPath(part); if (path) paths.add(path); } continue; }
    const unified = line.match(/^(?:---|\+\+\+)\s+(.+)\s*$/);
    if (unified) { const path = cleanPatchPath(unified[1].replace(/\t.*$/, "")); if (path) paths.add(path); }
  }
  return [...paths];
}
