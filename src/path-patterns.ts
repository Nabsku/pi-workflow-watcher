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

export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/^\.\//, "").replace(/\\/g, "/");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.slice(i, i + 3) === "**/") { source += "(?:.*/)?"; i += 2; continue; }
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") { source += ".*"; i++; }
      else source += "[^/]*";
    } else source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}
export function pathMatchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/^\.\//, "").replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes("*")) return globToRegExp(normalizedPattern).test(normalizedPath);
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`);
}
export function anyPathPattern(path: string, patterns: string[] | undefined): string | undefined { return patterns?.find((pattern) => pathMatchesPattern(path, pattern)); }
