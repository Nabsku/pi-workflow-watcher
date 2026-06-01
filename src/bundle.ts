import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, git, repoRoot, dirtyFiles, dirtyPath, normalizeDirtyPath, readJson, repoLocalPath, safeRepoLocalPath } from "./fs-git.ts";
import { readContract, validateContractSchema, validateContractSemantics, normalizePlanPath, absolutePlanPath, inferActivePlan, inspectPlan, listPlans, severity, analyze, currentBranch } from "./contract.ts";
import { runsDirResolution, runsDir, watcherLog, ledgerFile, stateFile, readLog, defaultState, readState, writeState, repoRelativePath, diffSnapshot, markReviewStaleIfEdited, checkpoint, commitEvidenceCurrent } from "./state.ts";
import { pathMatchesPattern, editGuardForPath, redactSecrets } from "./guards.ts";

import { evidenceDetails } from "./evidence-status.ts";
export function recentLedgerEvents(root: string, contract: WorkflowContract | null, max = 8): LedgerEvent[] {
  try { return readFileSync(ledgerFile(root, contract), "utf8").trim().split("\n").filter(Boolean).slice(-max).map((line) => JSON.parse(line) as LedgerEvent); }
  catch { return []; }
}
export function currentDiffHashShort(root: string): string { return diffSnapshot(root).diffHash.slice(0, 12); }
export function boundedList(items: string[], max = 40): string[] { return items.length <= max ? items : [...items.slice(0, max), `...and ${items.length - max} more`]; }
export function sanitizeBundleText(value: string, max = 1200): string {
  const text = redactSecrets(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}
export function activeSliceFromPlan(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    let inFence = false;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const match = line.match(/^\s*[-*+]\s+\[ \]\s+(.+)$/);
      if (match) return sanitizeBundleText(match[1], 200);
    }
    return undefined;
  } catch { return undefined; }
}
export function summarizeLedgerEvent(event: LedgerEvent): string {
  const bits = [`${event.at} ${event.type}`];
  if (event.gate) bits.push(`gate=${event.gate}`);
  if (event.status) bits.push(`status=${event.status}`);
  if (event.verdict) bits.push(`verdict=${event.verdict}`);
  if (event.source) bits.push(`source=${event.source}`);
  if (event.diffHash) bits.push(`diffHash=${event.diffHash}`);
  if (event.notePreview) bits.push(`note=${sanitizeBundleText(event.notePreview, 180)}`);
  if (event.commands?.length) bits.push(`commands=${event.commands.map((c) => `${c.alias}:${c.status}`).join(",")}`);
  return `- ${bits.join("; ")}`;
}
export function createEvidenceBundle(root: string, planPath?: unknown): AgentToolResult<EvidenceBundleDetails> {
  const analysis = analyze(root, "before-commit", planPath);
  const contract = analysis.contract;
  const runs = runsDirResolution(root, contract);
  if (!runs.valid) return textResult<EvidenceBundleDetails>(`Evidence bundle rejected: ${runs.error}; safe fallback is ${runs.path}`, { root, bundlePath: join(runs.path, "workflow-evidence-bundle-rejected.md"), evidencePath: stateFile(root, contract), currentDiffHash: analysis.currentDiffHash, commitReady: false, missing: [runs.error ?? "invalid runsDir"], nextAction: "Fix artifacts.runsDir to a repo-local path before exporting evidence.", touchedFiles: analysis.dirty });
  mkdirSync(runs.path, { recursive: true });
  const evidence = evidenceDetails(root, contract);
  const activePlan = analysis.planInfo.activePlan ? analysis.planInfo.activePlan.slice(root.length + 1) : undefined;
  const activeSlice = activeSliceFromPlan(analysis.planInfo.activePlan);
  const branch = currentBranch(root);
  const touched = boundedList(evidence.gate?.dirtyFiles ?? evidence.review?.dirtyFiles ?? analysis.dirty);
  const baseline = analysis.state.dirtyBaseline;
  const recent = recentLedgerEvents(root, contract).filter((event) => event.type === "blocker" || event.type === "note" || event.type === "gate_run" || event.type === "review_evidence");
  const missing = evidence.missing;
  const checksRun = recent.filter((event) => event.type === "gate_run").flatMap((event) => event.commands?.length ? event.commands.map((command) => `${event.gate ?? "gate"} ${command.alias}:${command.status}`) : [`${event.gate ?? "gate"}:${event.status ?? "unknown"}`]);
  const openRisks = [
    ...missing,
    ...(analysis.workflowLessons.activeSliceNudge ? [analysis.workflowLessons.activeSliceNudge] : []),
    ...Object.entries(analysis.workflowLessons.specSignals).filter(([, present]) => !present).map(([name]) => `missing ${name === "testPlan" ? "test plan" : name}`),
  ];
  const nextTodos = analysis.planInfo.checkboxTasks?.filter((task) => !task.checked).slice(0, 5).map((task) => task.text) ?? [];
  const resumeCommands = [
    `/workflow progress${activePlan ? ` ${activePlan}` : ""}`,
    "/workflow review-prompt",
    "/workflow gate beforeCommit --dry-run",
    "/workflow gate beforeCommit",
    `/workflow bundle${activePlan ? ` ${activePlan}` : ""}`,
  ].filter((cmd, index, arr) => arr.indexOf(cmd) === index);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bundlePath = join(runs.path, `workflow-evidence-bundle-${timestamp}.md`);
  const nextAction = missing.length ? [...new Set(evidence.nextActions)][0] ?? analysis.nextAction : "Commit may proceed if the user wants; do not push without explicit approval.";
  const lines = [
    "# Workflow Evidence Bundle",
    `generated: ${new Date().toISOString()}`,
    `root: ${root}`,
    `branch: ${branch}`,
    `current diffHash: ${analysis.currentDiffHash}`,
    `current diffHash short: ${currentDiffHashShort(root)}`,
    `commit-ready: ${evidence.commitReady ? "yes" : "no"}`,
    `state path: ${stateFile(root, contract)}`,
    `bundle path: ${bundlePath}`,
    "",
    "## Active plan / slice",
    `- plan: ${activePlan ?? "none"}`,
    `- slice: ${activeSlice ?? "unknown"}`,
    "",
    "## Dirty baseline summary",
    baseline ? `- at: ${baseline.at}\n- diffHash: ${baseline.diffHash}\n- files: ${baseline.dirtyFiles.length}` : "- none recorded",
    "",
    "## Touched files",
    ...(touched.length ? touched.map((item) => `- ${sanitizeBundleText(item, 240)}`) : ["- none"]),
    "",
    "## Files changed",
    ...(touched.length ? touched.map((item) => `- ${sanitizeBundleText(item, 240)}`) : ["- none"]),
    "",
    "## Checks run",
    ...(checksRun.length ? checksRun.map((item) => `- ${sanitizeBundleText(item, 240)}`) : ["- none recorded"]),
    "",
    "## Open risks",
    ...(openRisks.length ? [...new Set(openRisks)].map((item) => `- ${sanitizeBundleText(item, 240)}`) : ["- none recorded"]),
    "",
    "## Next todos",
    ...(nextTodos.length ? nextTodos.map((item) => `- ${sanitizeBundleText(item, 240)}`) : ["- none detected"]),
    "",
    "## Resume commands",
    ...resumeCommands.map((item) => `- ${sanitizeBundleText(item, 240)}`),
    "",
    "## Trusted review state",
    evidence.review ? `- verdict: ${evidence.review.verdict}\n- source: ${evidence.review.source ?? "unknown"}\n- trusted: ${evidence.reviewTrusted ? "yes" : "no"}\n- fresh: ${evidence.reviewFresh ? "yes" : "no"}\n- verdict-ok: ${evidence.reviewVerdictOk ? "yes" : "no"}` : "- none",
    "",
    "## workflow_gate state",
    evidence.gate ? `- gate: ${evidence.gate.gate}\n- status: ${evidence.gate.status}\n- source: ${evidence.gate.source ?? "unknown"}\n- trusted: ${evidence.gateTrusted ? "yes" : "no"}\n- fresh: ${evidence.gateFresh ? "yes" : "no"}` : "- none",
    "",
    "## Commit readiness",
    `- ready: ${evidence.commitReady ? "yes" : "no"}`,
    ...(missing.length ? missing.map((item) => `- missing: ${sanitizeBundleText(item, 240)}`) : ["- missing: none"]),
    `- next action: ${sanitizeBundleText(nextAction, 500)}`,
    "",
    "## Recent blockers / approvals",
    ...(recent.length ? recent.map(summarizeLedgerEvent) : ["- none recorded"]),
    "",
    "## Sanitization",
    "- Raw prompts and large stdout/stderr are intentionally omitted. Command outputs are summarized in the ledger only. Obvious secrets/tokens are redacted and long fields are bounded.",
  ];
  const body = sanitizeBundleText(lines.join("\n"), 20000);
  writeFileSync(bundlePath, `${body}\n`, "utf8");
  return textResult(`Evidence bundle: ${bundlePath}\ncommit-ready: ${evidence.commitReady ? "yes" : "no"}\nnext: ${nextAction}`, { root, bundlePath, currentDiffHash: analysis.currentDiffHash, commitReady: evidence.commitReady, missing, nextAction, evidencePath: stateFile(root, contract), activePlan, activeSlice, touchedFiles: touched });
}
