import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readContract, isObject } from "./contract.ts";
import { diffSnapshot, readState, runtimeArtifactExcludes, runsDir, stateFile, watcherLog, writeState } from "./state.ts";
import { textResult } from "./result.ts";
import { appendLedgerEvent } from "./guard-logging.ts";
import type { AgentToolResult, ReviewEvidence, ReviewEvidenceCriterion, ReviewEvidenceImportDetails, ReviewEvidenceParseResult, ReviewMode, ReviewRequest } from "./types.ts";

export const REVIEW_EVIDENCE_SCHEMA = "pi-workflow-review-evidence/v1";
export const REVIEW_REQUEST_SCHEMA = "pi-workflow-review-request/v1";

export function allowedVerdictsForMode(mode: ReviewMode): string[] {
  if (mode === "slice") return ["OK_TO_MARK_DONE", "OK_TO_MARK_FIXED"];
  if (mode === "present") return ["OK_TO_PRESENT"];
  return ["OK_TO_COMMIT"];
}

export function reviewRequestsDir(root: string): string {
  const read = readContract(root);
  return join(runsDir(root, read.contract), "review-requests");
}

export function reviewRequestPath(root: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("reviewRequestId must contain only letters, numbers, dot, underscore, or dash");
  return join(reviewRequestsDir(root), `${id}.json`);
}

export function loadReviewRequest(root: string, id: string): { request?: ReviewRequest; path?: string; error?: string } {
  let path: string;
  try { path = reviewRequestPath(root, id); }
  catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  if (!existsSync(path)) return { path, error: `review request ${id} is not pending or does not exist` };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const request = reviewRequestFromUnknown(parsed);
    if (!request) return { path, error: `review request ${id} is malformed or has unknown schema` };
    if (request.id !== id) return { path, error: `review request file id ${request.id} does not match requested id ${id}` };
    if (request.status !== "pending") return { path, error: `review request ${id} is not pending` };
    if (request.consumedAt !== null) return { path, error: `review request ${id} has already been consumed` };
    return { request, path };
  } catch (err) {
    return { path, error: `could not read review request ${id}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function writeReviewRequest(root: string, request: ReviewRequest): string {
  const path = reviewRequestPath(root, request.id);
  mkdirSync(reviewRequestsDir(root), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return path;
}

export function consumeReviewRequest(root: string, request: ReviewRequest, consumedAt = new Date().toISOString()): { request: ReviewRequest; path: string } {
  const consumed: ReviewRequest = { ...request, status: "consumed", consumedAt };
  const path = writeReviewRequest(root, consumed);
  return { request: consumed, path };
}

export function parseReviewEvidenceFence(text: string): ReviewEvidenceParseResult {
  const matches = [...text.matchAll(/```workflow-review-evidence[ \t]*\r?\n([\s\S]*?)```/g)];
  if (matches.length === 0) return { ok: false, error: "missing workflow-review-evidence fenced JSON block" };
  if (matches.length > 1) return { ok: false, error: "expected exactly one workflow-review-evidence fenced JSON block" };
  try {
    const parsed = JSON.parse(matches[0][1].trim()) as unknown;
    const evidence = reviewEvidenceFromUnknown(parsed);
    if (!evidence) return { ok: false, error: `unknown or malformed review evidence schema; expected ${REVIEW_EVIDENCE_SCHEMA}` };
    return { ok: true, evidence };
  } catch (err) {
    return { ok: false, error: `malformed workflow-review-evidence JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function normalizeReviewFiles(root: string, files: unknown): { files?: string[]; error?: string } {
  if (!Array.isArray(files)) return { error: "reviewedFiles must be an array" };
  const normalized: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || file.trim() === "") return { error: "reviewedFiles entries must be non-empty strings" };
    const resolved = resolve(root, file);
    const rel = relative(root, resolved).replace(/\\/g, "/");
    if (rel.startsWith("..") || isAbsolute(rel)) return { error: `reviewedFiles entry escapes repo: ${file}` };
    normalized.push(rel);
  }
  return { files: [...new Set(normalized)].sort() };
}

export function reviewFilesMatch(root: string, reviewedFiles: unknown, expectedFiles: unknown): { ok: boolean; reviewed?: string[]; expected?: string[]; error?: string } {
  const reviewed = normalizeReviewFiles(root, reviewedFiles);
  if (reviewed.error) return { ok: false, error: reviewed.error };
  const expected = normalizeReviewFiles(root, expectedFiles);
  if (expected.error) return { ok: false, error: expected.error };
  const reviewedList = reviewed.files ?? [];
  const expectedList = expected.files ?? [];
  const ok = reviewedList.length === expectedList.length && reviewedList.every((file, index) => file === expectedList[index]);
  return { ok, reviewed: reviewedList, expected: expectedList, error: ok ? undefined : `reviewedFiles do not match expectedFiles: reviewed=${reviewedList.join(",")} expected=${expectedList.join(",")}` };
}

export function validateReviewCriteria(criteria: unknown): { ok: boolean; error?: string } {
  if (!Array.isArray(criteria) || criteria.length === 0) return { ok: false, error: "criteria must be a non-empty array" };
  for (const criterion of criteria) {
    if (!isObject(criterion)) return { ok: false, error: "criteria entries must be objects" };
    const id = typeof criterion.id === "string" && criterion.id.trim() ? criterion.id : "<unknown>";
    const required = criterion.required !== false;
    const status = typeof criterion.status === "string" ? criterion.status : "";
    if (required && status !== "satisfied" && status !== "not-applicable") return { ok: false, error: `required criterion ${id} is not satisfied` };
  }
  return { ok: true };
}

export function validateReviewEvidenceForRequest(root: string, evidence: ReviewEvidence, request: ReviewRequest): { ok: boolean; error?: string; reviewedFiles?: string[] } {
  if (evidence.reviewRequestId !== request.id) return { ok: false, error: "reviewRequestId does not match pending request" };
  if (resolve(evidence.repo) !== resolve(root)) return { ok: false, error: "evidence repo does not match current repo root" };
  if (evidence.reviewedDiffHash !== request.diffHash) return { ok: false, error: "reviewedDiffHash does not match review request diffHash" };
  const files = reviewFilesMatch(root, evidence.reviewedFiles, request.expectedFiles);
  if (!files.ok) return { ok: false, error: files.error };
  if (!request.allowedVerdicts.includes(evidence.verdict)) return { ok: false, error: `verdict ${evidence.verdict} is not allowed for request mode ${request.mode}` };
  const criteria = validateReviewCriteria(evidence.criteria);
  if (!criteria.ok) return criteria;
  return { ok: true, reviewedFiles: files.reviewed };
}

export function reviewEvidenceImportError(root: string, message: string, artifactPath?: string): AgentToolResult<ReviewEvidenceImportDetails> {
  return textResult(`Review evidence import rejected: ${message}`, { root, accepted: false, artifactPath, error: message });
}

export function loadReviewEvidenceArtifact(root: string, artifactPath: unknown): { text?: string; artifactPath?: string; error?: string } {
  if (typeof artifactPath !== "string" || artifactPath.trim() === "") return { error: "artifactPath is required" };
  const resolved = resolve(root, artifactPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "artifactPath must be inside the repo" };
  try { return { text: readFileSync(resolved, "utf8"), artifactPath: resolved }; }
  catch (err) { return { artifactPath: resolved, error: `could not read artifactPath: ${err instanceof Error ? err.message : String(err)}` }; }
}

export function importReviewEvidence(root: string, params: Record<string, unknown>): AgentToolResult<ReviewEvidenceImportDetails> {
  const read = readContract(root); const contract = read.contract;
  const loaded = loadReviewEvidenceArtifact(root, params.artifactPath);
  if (loaded.error || loaded.text === undefined) return reviewEvidenceImportError(root, loaded.error ?? "artifactPath is required", loaded.artifactPath);
  const parsed = parseReviewEvidenceFence(loaded.text);
  if (!parsed.ok) return reviewEvidenceImportError(root, parsed.error, loaded.artifactPath);
  const requestResult = loadReviewRequest(root, parsed.evidence.reviewRequestId);
  if (requestResult.error || !requestResult.request) return reviewEvidenceImportError(root, requestResult.error ?? "review request is not pending", loaded.artifactPath);
  const request = requestResult.request;
  if (resolve(request.repo) !== resolve(root)) return reviewEvidenceImportError(root, "review request repo does not match current repo root", loaded.artifactPath);
  const excluded = runtimeArtifactExcludes(root, contract);
  const snap = diffSnapshot(root, { excludePaths: excluded });
  if (parsed.evidence.reviewedDiffHash !== snap.diffHash) return reviewEvidenceImportError(root, "reviewedDiffHash does not match current repo diffHash", loaded.artifactPath);
  const validation = validateReviewEvidenceForRequest(root, parsed.evidence, request);
  if (!validation.ok) return reviewEvidenceImportError(root, validation.error ?? "review evidence does not match review request", loaded.artifactPath);
  const at = new Date().toISOString();
  consumeReviewRequest(root, request, at);
  const state = readState(root, contract);
  state.lastReviewVerdict = { verdict: parsed.evidence.verdict, at, diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, stale: false, source: "reviewer_evidence" };
  state.checkpoint = { at, mode: "note", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles };
  writeState(root, contract, state);
  mkdirSync(runsDir(root, contract), { recursive: true });
  appendFileSync(watcherLog(root, contract), `${at} imported workflow review evidence reviewer_evidence ${parsed.evidence.verdict} diffHash=${snap.diffHash}\n`, "utf8");
  appendLedgerEvent(root, contract, { type: "review_evidence", at, diffHash: snap.diffHash, source: "reviewer_evidence", verdict: parsed.evidence.verdict, status: "accepted", artifactPath: loaded.artifactPath });
  return textResult(`Imported trusted reviewer_evidence as ${parsed.evidence.verdict}`, { root, accepted: true, source: "reviewer_evidence", verdict: parsed.evidence.verdict, statePath: stateFile(root, contract), artifactPath: loaded.artifactPath, requestPath: requestResult.path, diffHash: snap.diffHash });
}

function reviewEvidenceFromUnknown(value: unknown): ReviewEvidence | undefined {
  if (!isObject(value) || value.schema !== REVIEW_EVIDENCE_SCHEMA) return undefined;
  if (typeof value.reviewRequestId !== "string" || !value.reviewRequestId.trim()) return undefined;
  if (typeof value.repo !== "string" || !value.repo.trim()) return undefined;
  if (typeof value.reviewedDiffHash !== "string" || !value.reviewedDiffHash.trim()) return undefined;
  if (typeof value.reviewedAt !== "string" || !value.reviewedAt.trim()) return undefined;
  if (!Array.isArray(value.reviewedFiles)) return undefined;
  if (typeof value.verdict !== "string" || !value.verdict.trim()) return undefined;
  if (!Array.isArray(value.criteria)) return undefined;
  return value as ReviewEvidence;
}

function reviewRequestFromUnknown(value: unknown): ReviewRequest | undefined {
  if (!isObject(value) || value.schema !== REVIEW_REQUEST_SCHEMA) return undefined;
  if (typeof value.id !== "string" || !value.id.trim()) return undefined;
  if (typeof value.createdAt !== "string" || !value.createdAt.trim()) return undefined;
  if (typeof value.repo !== "string" || !value.repo.trim()) return undefined;
  if (typeof value.diffHash !== "string" || !value.diffHash.trim()) return undefined;
  if (!Array.isArray(value.expectedFiles)) return undefined;
  if (value.mode !== "commit" && value.mode !== "slice" && value.mode !== "present") return undefined;
  if (!Array.isArray(value.allowedVerdicts) || !value.allowedVerdicts.every((item) => typeof item === "string")) return undefined;
  const allowedVerdicts = value.allowedVerdicts as string[];
  const allowed = allowedVerdictsForMode(value.mode);
  if (allowedVerdicts.length !== allowed.length || !allowed.every((verdict) => allowedVerdicts.includes(verdict))) return undefined;
  if (value.status !== "pending" && value.status !== "consumed") return undefined;
  if (value.consumedAt !== null && typeof value.consumedAt !== "string") return undefined;
  return value as ReviewRequest;
}

export type { ReviewEvidenceCriterion };
