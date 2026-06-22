import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { readContract, analyze } from "./contract.ts";
import { repoRoot } from "./fs-git.ts";
import { renderWorkflowStatusLine } from "./formatting.ts";
import { evidenceDetails, formatEvidence } from "./evidence.ts";

export function clearWorkflowUi(ctx?: WorkflowUiContext) { ctx?.ui?.setStatus?.("workflow-watcher", undefined); ctx?.ui?.setWidget?.("workflow-watcher", undefined); }

export function refreshWorkflowUi(ctx?: WorkflowUiContext) { const root = repoRoot(ctx?.cwd ?? process.cwd()); const analysis = analyze(root, "status"); ctx?.ui?.setStatus?.("workflow-watcher", renderWorkflowStatusLine(root, analysis, ctx?.ui?.theme)); ctx?.ui?.setWidget?.("workflow-watcher", undefined); }

export function formatHelp(): string {
  return [
    "# Workflow help",
    "Commands:",
    "- /workflow status — compact workflow posture: dirty files, plan, blockers, next action.",
    "- /workflow next — only the next safe workflow action.",
    "- /workflow progress — show active plan/slice progress, stale evidence, and next safe action.",
    "- /workflow doctor — inspect contract/readiness without running gates or tests.",
    "- /workflow evidence — show trusted evidence, manual note status, missing pieces, and commit-ready yes/no.",
    "- /workflow why [commit|edit <path>] — explain the blocker source, why it blocks, and the exact next action.",
    "- /workflow review-prompt — print a compact reviewer/oracle handoff packet; does not launch subagents.",
    "- /workflow bundle — export a sanitized bounded evidence bundle under artifacts.runsDir.",
    "- /workflow dirty — show dirty baseline and one-shot dirty-overlap approvals.",
    "- /workflow dirty approve <path> --reason \"...\" — approve one path-scoped edit to a baseline dirty file.",
    "- /workflow dirty baseline refresh — replace the dirty baseline with the current checkout state.",
    "- /workflow note <text> — record a short manual breadcrumb; recognized verdict prose is still untrusted by default.",
    "- /workflow gate <name> [--dry-run] — resolve or run a named gate from .pi/workflows.json.",
    "- /workflow plan [path-or-slug] — show or pin the active plan.",
    "- /workflow shape-plan <goal> — start the built-in shape-plan flow without installing a prompt template.",
    "- /workflow new-plan <goal> — alias for /workflow shape-plan.",
    "- /workflow toggle [on|off] — enable/disable automatic nudges, status UI, and hook guards for this repo; default is off.",
    "- /workflow help — show this help.",
    "",
    "Examples:",
    "- /workflow status",
    "- /workflow doctor",
    "- /workflow evidence",
    "- /workflow bundle",
    "- /workflow gate beforeCommit --dry-run",
    "- /workflow gate beforeCommit",
    "- /workflow shape-plan Add GitHub issue triage automation",
    "- /workflow new-plan Add GitHub issue triage automation",
    "- /workflow note OK_TO_MARK_DONE reviewer approved slice 2",
    "- /workflow plan .pi/plans/add-auth.md",
    "",
    "Trusted evidence warning:",
    "- Protected commits require current trusted Workflow Watcher review evidence imported by workflow_import_review_evidence plus a current workflow_gate beforeCommit/final pass.",
    "- Manual notes are recorded context, not trusted approval.",
  ].join("\n");
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*([^\s,;]+)/gi, (_match, _secret) => "token=[REDACTED]");
}
export function safePreview(value: unknown, max = 160): string | undefined {
  const text = redactSecrets(String(value ?? "").replace(/\s+/g, " ").trim());
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
export function outputSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lines = value.split("\n").filter((line) => line.trim()).length;
  return `${value.length} chars${lines ? `, ${lines} lines` : ""}`;
}
