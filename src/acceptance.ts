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
export function parseAcceptanceFence(text: string): Record<string, unknown> | undefined {
  const match = text.match(/```acceptance-report\s*\n([\s\S]*?)```/i);
  if (!match) return undefined;
  const parsed = JSON.parse(match[1].trim()) as unknown;
  const report = isObject(parsed) && isObject(parsed.acceptance) ? parsed.acceptance : parsed;
  return isObject(report) ? report : undefined;
}

export function acceptanceImportError(root: string, message: string, artifactPath?: string): AgentToolResult<AcceptanceImportDetails> {
  return textResult(`Acceptance import rejected: ${message}`, { root, accepted: false, artifactPath, error: message });
}

export function loadAcceptanceArtifact(root: string, artifactPath?: unknown, result?: unknown): { value?: unknown; artifactPath?: string; error?: string } {
  if (result !== undefined) return { value: result };
  if (typeof artifactPath !== "string" || artifactPath.trim() === "") return { error: "artifactPath or result is required" };
  const resolved = resolve(root, artifactPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "artifactPath must be inside the repo" };
  try { return { value: JSON.parse(readFileSync(resolved, "utf8")) as unknown, artifactPath: resolved }; }
  catch (err) {
    try { return { value: { finalOutput: readFileSync(resolved, "utf8") }, artifactPath: resolved }; }
    catch { return { error: err instanceof Error ? err.message : String(err), artifactPath: resolved }; }
  }
}

export function unwrapAcceptanceResult(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const candidates = Array.isArray(value.results) ? value.results : isObject(value.details) && Array.isArray(value.details.results) ? value.details.results : undefined;
  if (candidates) return candidates.length === 1 && isObject(candidates[0]) ? candidates[0] : undefined;
  const childCollections = [value.children, value.childResults, isObject(value.details) ? value.details.children : undefined, isObject(value.details) ? value.details.childResults : undefined];
  if (childCollections.some(Array.isArray)) return undefined;
  const kind = String(value.kind ?? value.type ?? value.mode ?? "").toLowerCase();
  if (/aggregate|fanout|collect|dynamic/.test(kind)) return undefined;
  return value;
}

export function provenanceDiffHash(...sources: Array<unknown>): string | undefined {
  for (const source of sources) {
    if (!isObject(source)) continue;
    const provenance = isObject(source.provenance) ? source.provenance : source;
    for (const key of ["diffHash", "diff_hash", "currentDiffHash", "reviewedDiffHash"]) {
      if (typeof provenance[key] === "string" && provenance[key]) return provenance[key] as string;
    }
  }
  return undefined;
}

export function runtimeCheckFailed(check: unknown): boolean {
  if (!isObject(check)) return false;
  const status = String(check.status ?? check.result ?? "").toLowerCase();
  if (status) return !["pass", "passed", "success", "succeeded", "ok", "skipped"].includes(status);
  if (typeof check.success === "boolean") return !check.success;
  if (typeof check.passed === "boolean") return !check.passed;
  return false;
}

export function importAcceptanceEvidence(root: string, params: Record<string, unknown>): AgentToolResult<AcceptanceImportDetails> {
  const read = readContract(root); const contract = read.contract;
  const loaded = loadAcceptanceArtifact(root, params.artifactPath, params.result);
  if (loaded.error) return acceptanceImportError(root, loaded.error, loaded.artifactPath);
  const item = unwrapAcceptanceResult(loaded.value);
  if (!item) return acceptanceImportError(root, "expected exactly one child result; aggregate/zero-child results are not trusted review evidence", loaded.artifactPath);
  const finalOutput = typeof item.finalOutput === "string" ? item.finalOutput : typeof item.output === "string" ? item.output : "";
  let fencedReport: Record<string, unknown> | undefined;
  try { if (finalOutput) fencedReport = parseAcceptanceFence(finalOutput); }
  catch (err) { return acceptanceImportError(root, `malformed acceptance-report fence: ${err instanceof Error ? err.message : String(err)}`, loaded.artifactPath); }
  const acceptance = isObject(item.acceptance) ? item.acceptance : undefined;
  if (!acceptance && !fencedReport) return acceptanceImportError(root, "missing pi-subagents acceptance ledger/report", loaded.artifactPath);
  if (acceptance && typeof acceptance.childReportParseError === "string") return acceptanceImportError(root, `ledger has parse error: ${acceptance.childReportParseError}`, loaded.artifactPath);
  const childReport = isObject(acceptance?.childReport) ? acceptance.childReport : fencedReport;
  if (!childReport) return acceptanceImportError(root, "missing fenced child acceptance report", loaded.artifactPath);
  const status = String(acceptance?.status ?? "attested");
  if (!["attested", "checked", "verified", "reviewed", "accepted"].includes(status)) return acceptanceImportError(root, `acceptance status ${status} is not trusted`, loaded.artifactPath);
  const failedCheck = Array.isArray(acceptance?.runtimeChecks) && acceptance.runtimeChecks.some(runtimeCheckFailed);
  if (failedCheck) return acceptanceImportError(root, "acceptance ledger contains failed runtime checks", loaded.artifactPath);
  const reviewResult = isObject(acceptance?.reviewResult) ? acceptance.reviewResult : undefined;
  if (reviewResult && reviewResult.status !== "no-blockers") return acceptanceImportError(root, `acceptance review status ${String(reviewResult.status)} is not clean`, loaded.artifactPath);
  const agent = String(item.agent ?? item.name ?? "").toLowerCase();
  const source: EvidenceSource | undefined = /oracle/.test(agent) ? "oracle_tool" : /reviewer|review/.test(agent) ? "reviewer_tool" : undefined;
  if (!source) return acceptanceImportError(root, "child result is not from reviewer/oracle", loaded.artifactPath);
  const reportedDiffHash = provenanceDiffHash(childReport, acceptance, item.provenance);
  const snap = diffSnapshot(root);
  if (!reportedDiffHash) return acceptanceImportError(root, "missing provenance diffHash", loaded.artifactPath);
  if (reportedDiffHash !== snap.diffHash) return acceptanceImportError(root, "provenance diffHash does not match current repo diff", loaded.artifactPath);
  const criteria = Array.isArray(childReport.criteriaSatisfied) ? childReport.criteriaSatisfied : Array.isArray(childReport.criteria) ? childReport.criteria : undefined;
  if (!criteria || criteria.length === 0) return acceptanceImportError(root, "acceptance report has no satisfied criteria", loaded.artifactPath);
  const criteriaBad = criteria.some((criterion) => isObject(criterion) && criterion.status && criterion.status !== "satisfied" && criterion.status !== "not-applicable");
  if (criteriaBad) return acceptanceImportError(root, "acceptance report has unsatisfied criteria", loaded.artifactPath);
  const verdict = typeof params.verdict === "string" ? params.verdict : "OK_TO_COMMIT";
  if (!/^(OK_TO_COMMIT|OK_TO_MARK_DONE|OK_TO_MARK_FIXED|OK_TO_PRESENT)$/.test(verdict)) return acceptanceImportError(root, "verdict must be an OK_TO_* trusted review verdict", loaded.artifactPath);
  const state = readState(root, contract);
  const at = new Date().toISOString();
  state.lastReviewVerdict = { verdict, at, diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, stale: false, source };
  state.checkpoint = { at, mode: "note", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles };
  writeState(root, contract, state);
  const path = watcherLog(root, contract); mkdirSync(runsDir(root, contract), { recursive: true });
  appendFileSync(path, `${at} imported pi-subagents acceptance ${source} ${verdict} diffHash=${snap.diffHash}\n`, "utf8");
  appendLedgerEvent(root, contract, { type: "review_evidence", at, diffHash: snap.diffHash, source, verdict, status: "accepted", artifactPath: loaded.artifactPath });
  return textResult(`Imported trusted ${source} acceptance evidence as ${verdict}`, { root, accepted: true, source, verdict, statePath: stateFile(root, contract), artifactPath: loaded.artifactPath, diffHash: snap.diffHash });
}
