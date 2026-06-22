import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";

export function cwdFrom(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") return process.cwd();
  return resolve(input);
}

export function git(args: string[], cwd: string): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

export function repoRoot(cwd: string): string {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  return root || cwd;
}

export function dirtyFiles(root: string): string[] {
  const out = git(["status", "--short"], root);
  return out ? out.split("\n").map((line) => line.trimEnd()).filter(Boolean) : [];
}

export function dirtyPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.split(" -> ").pop();
  return renamed ?? raw;
}

export function unquotePath(rawPath: string): string {
  const raw = rawPath.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw) as string; }
    catch { return raw.slice(1, -1); }
  }
  return raw;
}

export function normalizeDirtyPath(entry: string): string {
  const raw = entry.trim();
  const statusMatch = raw.match(/^([ MADRCU?!]{1,2})\s+(.+)$/);
  const path = statusMatch ? statusMatch[2].trim() : raw;
  return unquotePath(path.split(" -> ").pop() ?? path);
}

export function dirtyEntryPaths(entry: string): string[] {
  const raw = entry.trim();
  const statusMatch = raw.match(/^([ MADRCU?!]{1,2})\s+(.+)$/);
  const path = statusMatch ? statusMatch[2].trim() : raw;
  const parts = path.includes(" -> ") ? path.split(" -> ").map((item) => unquotePath(item.trim())).filter(Boolean) : [unquotePath(path)];
  return [...new Set(parts)];
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

export function repoLocalPath(root: string, configured: string | undefined, fallback: string): string {
  const raw = configured && configured.trim() ? configured : fallback;
  if (isAbsolute(raw)) throw new Error(`Configured workflow path must be repo-local: ${raw}`);
  const resolved = resolve(root, raw);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Configured workflow path escapes repo root: ${raw}`);
  return resolved;
}

export function safeRepoLocalPath(root: string, configured: string | undefined, fallback: string, findings?: Finding[], label = "workflow path"): string {
  try { return repoLocalPath(root, configured, fallback); }
  catch (err) {
    findings?.push({ severity: "blocker", title: "Workflow path escapes repo", detail: `${label}: ${err instanceof Error ? err.message : String(err)}` });
    return join(root, fallback);
  }
}
