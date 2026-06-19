import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { analyze, readContract } from "./contract.ts";
import { normalizeDirtyPath } from "./fs-git.ts";
import { pathMatchesPattern } from "./guards.ts";
import { allowedVerdictsForMode, normalizeReviewFiles, REVIEW_EVIDENCE_SCHEMA, REVIEW_REQUEST_SCHEMA, writeReviewRequest } from "./review-evidence.ts";
import { diffSnapshot, runtimeArtifactExcludes } from "./state.ts";
import type { ReviewMode, ReviewPacketDetails, ReviewRequest, WorkflowContract } from "./types.ts";
import { evidenceDetails } from "./evidence-status.ts";
import { architectureChecklist } from "./workflow-lessons.ts";

export function ownershipNotes(contract: WorkflowContract | null, files: string[]) {
  const own = contract?.ownership ?? {};
  const pick = (patterns: string[] | undefined) => files.filter((file) => (patterns ?? []).some((pattern) => pathMatchesPattern(file, pattern)));
  return { highRisk: pick(own.highRiskPaths), generated: pick(own.generatedPaths), lockfiles: pick(own.lockfiles) };
}

export function activeSlice(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return readFileSync(path, "utf8").split("\n").find((line) => /^\s*- \[ \]/.test(line))?.replace(/^\s*- \[ \]\s*/, "").trim(); }
  catch { return undefined; }
}

function pathExcluded(rel: string, excluded: string[]): boolean {
  const normalized = rel.replace(/\\/g, "/").replace(/\/$/, "");
  return excluded.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

export function reviewTouchedFiles(root: string, excludePaths: string[] = []): { files: string[]; excluded: string[] } {
  const snap = diffSnapshot(root);
  const excluded = new Set<string>();
  const files = new Set<string>();
  for (const entry of snap.dirtyFiles) {
    const rel = normalizeDirtyPath(entry).replace(/\/$/, "");
    if (pathExcluded(rel, excludePaths)) { excluded.add(rel); continue; }
    const abs = resolve(root, rel);
    const normalizedRel = relative(root, abs).replace(/\\/g, "/");
    if (normalizedRel.startsWith("..") || isAbsolute(normalizedRel)) continue;
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            if (name === ".git") continue;
            const child = join(dir, name);
            const childStat = statSync(child);
            if (childStat.isDirectory()) walk(child);
            else if (childStat.isFile()) {
              const childRel = relative(root, child).replace(/\\/g, "/");
              if (pathExcluded(childRel, excludePaths)) excluded.add(childRel);
              else files.add(childRel);
            }
          }
        };
        walk(abs);
      } else files.add(normalizedRel);
    } catch { files.add(normalizedRel); }
  }
  return { files: [...files].sort(), excluded: [...excluded].sort() };
}

function reviewMode(value: unknown): { mode?: ReviewMode; error?: string } {
  if (value === undefined || value === null || value === "") return { mode: "commit" };
  if (value === "commit" || value === "slice" || value === "present") return { mode: value };
  return { error: "mode must be commit, slice, or present" };
}

function requestId(root: string, diffHash: string, expectedFiles: string[]): string {
  const digest = createHash("sha256").update(root).update("\0").update(diffHash).update("\0").update(expectedFiles.join("\0")).digest("hex").slice(0, 10);
  return `rw-${Date.now().toString(36)}-${digest}`;
}

function reviewEvidenceTemplate(root: string, request: ReviewRequest): string {
  return JSON.stringify({
    schema: REVIEW_EVIDENCE_SCHEMA,
    reviewRequestId: request.id,
    repo: root,
    reviewedDiffHash: request.diffHash,
    reviewedAt: new Date().toISOString(),
    reviewedFiles: request.expectedFiles,
    reviewer: { role: "reviewer", name: "", source: "" },
    verdict: request.allowedVerdicts[0],
    criteria: [{ id: "scope", status: "satisfied", evidence: "Reviewed expected files for this request." }],
    verification: [],
    residualRisks: [],
  }, null, 2);
}

export function reviewPacketDetails(root: string, params: { files?: unknown; mode?: unknown } = {}): ReviewPacketDetails {
  const read = readContract(root); const contract = read.contract; const analysis = analyze(root, "before-commit"); const evidence = evidenceDetails(root, contract);
  const runtimeExcludes = runtimeArtifactExcludes(root, contract);
  const touched = reviewTouchedFiles(root, runtimeExcludes);
  const own = ownershipNotes(contract, touched.files);
  const plan = analysis.planInfo.activePlan?.slice(root.length + 1);
  const slice = activeSlice(analysis.planInfo.activePlan);
  const modeResult = reviewMode(params.mode);
  const expected = normalizeReviewFiles(root, params.files);
  const current = diffSnapshot(root, { excludePaths: runtimeExcludes });
  let request: ReviewRequest | undefined;
  let requestPath: string | undefined;
  let requestError = modeResult.error ?? expected.error;
  if (!requestError) {
    const expectedFiles = expected.files ?? [];
    const outside = touched.files.filter((file) => !expectedFiles.includes(file));
    if (expectedFiles.length === 0) requestError = "files must explicitly list the review scope";
    else if (outside.length) requestError = `current diff contains files outside expected files: ${outside.join(", ")}`;
    else {
      request = { schema: REVIEW_REQUEST_SCHEMA, id: requestId(root, current.diffHash, expectedFiles), createdAt: new Date().toISOString(), repo: root, diffHash: current.diffHash, expectedFiles, mode: modeResult.mode ?? "commit", allowedVerdicts: allowedVerdictsForMode(modeResult.mode ?? "commit"), status: "pending", consumedAt: null };
      requestPath = writeReviewRequest(root, request);
    }
  }
  const packetLines = [
    "# Workflow review packet",
    "Do not launch subagents from this packet; hand it to the reviewer/oracle.",
    `root: ${root}`,
    `active plan: ${plan ?? "none"}`,
    `active slice: ${slice ?? "unknown"}`,
    `current diffHash: ${current.diffHash}`,
    "",
    "## Review request",
    request ? `- id: ${request.id}` : `- not created: ${requestError}`,
    request ? `- schema: ${request.schema}` : "- schema: none",
    request ? `- mode: ${request.mode}` : `- mode: ${modeResult.mode ?? "unknown"}`,
    request ? `- allowed verdicts: ${request.allowedVerdicts.join(", ")}` : "- allowed verdicts: none",
    request ? `- expected files: ${request.expectedFiles.join(", ")}` : `- expected files: ${(expected.files ?? []).join(", ") || "none"}`,
    requestPath ? `- request path: ${relative(root, requestPath).replace(/\\/g, "/")}` : "- request path: none",
    "",
    "## Touched files",
    ...(touched.files.length ? touched.files.map((f) => `- ${f}`) : ["- none"]),
    "",
    "## Runtime/generated watcher artifacts excluded from review scope",
    ...(touched.excluded.length ? touched.excluded.map((f) => `- ${f}`) : ["- none"]),
    "",
    "## Risk notes",
    `- high-risk paths: ${own.highRisk.length ? own.highRisk.join(", ") : "none"}`,
    `- generated paths: ${own.generated.length ? own.generated.join(", ") : "none"}`,
    `- lockfiles: ${own.lockfiles.length ? own.lockfiles.join(", ") : "none"}`,
    "",
    "## Architecture checklist",
    ...architectureChecklist.map((item) => `- ${item}`),
    "",
    "## Gate and evidence",
    `- gate: ${evidence.gate ? `${evidence.gate.gate} ${evidence.gate.status} fresh=${evidence.gateFresh}` : "none"}`,
    `- trusted review: ${evidence.review ? `${evidence.review.verdict} trusted=${evidence.reviewTrusted} fresh=${evidence.reviewFresh}` : "none"}`,
    "",
    "## Review evidence import requirements",
    "- Reviewer/oracle verdict must be allowed by the pending review request.",
    "- Evidence artifact must include one workflow-review-evidence JSON fence with schema pi-workflow-review-evidence/v1 for the current diffHash.",
    "- Import trusted evidence with workflow_import_review_evidence. Trusted state source is reviewer_evidence. Manual notes are recorded context, not trusted approval.",
    "",
    "## workflow-review-evidence template",
    request ? "```workflow-review-evidence" : "```text",
    request ? reviewEvidenceTemplate(root, request) : "No template: create the packet with explicit files first.",
    "```",
  ];
  const packet = packetLines.join("\n");
  return { root, activePlan: plan, activeSlice: slice, touchedFiles: touched.files, excludedFiles: touched.excluded, currentDiffHash: current.diffHash, ownership: own, gateStatus: evidence.gate ? `${evidence.gate.gate}:${evidence.gate.status}` : "none", evidenceStatus: evidence.commitReady ? "commit-ready" : `missing: ${evidence.missing.join(", ")}`, acceptanceRequirements: ["allowed verdict", "current diffHash", "workflow-review-evidence schema"], importRequirements: ["workflow_import_review_evidence", "reviewer_evidence source", "manual notes are recorded context, not trusted approval"], request, requestPath, requestError, packet };
}
