import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { analyze, severity } from "./contract.ts";
import { readContract } from "./contract.ts";
import { readState, diffSnapshot, stateFile } from "./state.ts";
import { formatWorkflowLessons } from "./workflow-lessons.ts";

export function formatWatch(root: string, mode: WatchMode, contractRead: ContractRead, findings: Finding[], dirty: string[], plans: string[], nextAction: string, planInfo: ReturnType<typeof analyze>["planInfo"], verbosity: WatchVerbosity = "full", workflowLessons?: ReturnType<typeof analyze>["workflowLessons"]): string {
  if (verbosity === "next") return [`next: ${nextAction}`, "blockers:", ...findings.filter((f) => f.severity === "blocker").map((f) => `- ${f.title}: ${f.detail}`), ...(workflowLessons ? ["workflow lessons:", ...formatWorkflowLessons(workflowLessons)] : [])].join("\n");
  const lines = [`workflow: ${severity(findings)}`, `mode: ${mode}`, `contract: ${contractRead.status}`, `dirty: ${dirty.length}`, `plans: ${plans.length}`, `activePlan: ${planInfo.activePlan ? planInfo.activePlan.slice(root.length + 1) : "none"}`, `next: ${nextAction}`];
  if (workflowLessons) lines.push("", "workflow lessons:", ...formatWorkflowLessons(workflowLessons));
  if (findings.length) lines.push("", "findings:", ...findings.map((f) => `- ${f.severity}: ${f.title} — ${f.detail}`));
  if (verbosity === "full") lines.push("", "dirty files:", ...(dirty.length ? dirty.map((d) => `- ${d}`) : ["- none"]), "", "plans:", ...(plans.length ? plans.map((p) => `- ${p}`) : ["- none"]));
  return lines.join("\n");
}

export function details(root: string, mode: WatchMode, analysis: ReturnType<typeof analyze>, verbosity?: WatchVerbosity): WatchDetails {
  const sev = severity(analysis.findings);
  return {
    root, mode, verbosity, hasContract: analysis.contractRead.status === "ok", contractStatus: analysis.contractRead.status,
    contractErrors: analysis.findings.filter((f) => f.title.includes("contract") || f.title.includes("Contract") || f.title.includes("schema")).map((f) => f.detail),
    dirtyFiles: analysis.dirty, planFiles: analysis.plans, severity: sev,
    blockers: analysis.findings.filter((f) => f.severity === "blocker").length,
    nudges: analysis.findings.filter((f) => f.severity === "nudge").length,
    nextAction: analysis.nextAction, activePlan: analysis.planInfo.activePlan, openPlanTasks: analysis.planInfo.openPlanTasks, reviewVerdicts: analysis.planInfo.reviewVerdicts,
    statePath: stateFile(root, analysis.contract), checkpointDiffHash: analysis.state.checkpoint?.diffHash, currentDiffHash: analysis.currentDiffHash, reviewStale: analysis.state.lastReviewVerdict?.stale, lastReviewVerdict: analysis.state.lastReviewVerdict?.verdict, lastGateStatus: analysis.state.lastGateResult?.status, lastGateName: analysis.state.lastGateResult?.gate, activePlanInference: analysis.planInference.explanation,
    workflowLessons: analysis.workflowLessons,
  } as WatchDetails;
}

export function formatCompactStatus(root: string, mode: WatchMode, analysis: ReturnType<typeof analyze>): string {
  const d = details(root, mode, analysis);
  const plan = d.activePlan ? d.activePlan.slice(root.length + 1) : "none";
  const counts = `${d.severity.toUpperCase()} b=${d.blockers} n=${d.nudges} dirty=${d.dirtyFiles.length} open=${d.openPlanTasks ?? "?"}`;
  return [`workflow ${counts}`, `plan: ${plan}`, `next: ${d.nextAction}`].join("\n");
}

export function relPlan(root: string, activePlan: string | undefined): string { return activePlan ? activePlan.slice(root.length + 1) : "none"; }
export function shortPlanLabel(plan: string | undefined): string {
  if (!plan) return "no plan";
  const name = basename(plan).replace(/\.(md|json)$/i, "");
  return name.length > 28 ? `${name.slice(0, 25)}…` : name;
}
export function workflowBadge(sev: Severity): string { return sev === "blocker" ? "WF BLOCK" : sev === "nudge" ? "WF NUDGE" : "WF OK"; }
export function colorize(theme: WorkflowUi["theme"] | undefined, color: string, text: string): string { return theme?.fg ? theme.fg(color, text) : text; }

export function renderWorkflowStatusLine(root: string, analysis: ReturnType<typeof analyze>, theme?: WorkflowUi["theme"]): string {
  const d = details(root, "status", analysis);
  const sevColor = d.severity === "blocker" ? "error" : d.severity === "nudge" ? "warning" : "success";
  const gate = d.lastGateName ? ` · gate ${d.lastGateName}:${d.lastGateStatus ?? "?"}` : "";
  const review = d.lastReviewVerdict ? ` · review ${d.lastReviewVerdict}${d.reviewStale ? " stale" : ""}` : "";
  return [colorize(theme, sevColor, workflowBadge(d.severity)), colorize(theme, "dim", ` · dirty ${d.dirtyFiles.length}`), colorize(theme, "dim", ` · ${shortPlanLabel(d.activePlan)}`), colorize(theme, "dim", gate), colorize(theme, d.reviewStale ? "warning" : "dim", review)].join("");
}

export function renderWorkflowWidget(root: string, analysis: ReturnType<typeof analyze>, theme?: WorkflowUi["theme"]): string[] {
  const d = details(root, "status", analysis);
  const sevColor = d.severity === "blocker" ? "error" : d.severity === "nudge" ? "warning" : "success";
  const topFinding = analysis.findings.find((finding) => finding.severity === "blocker") ?? analysis.findings.find((finding) => finding.severity === "nudge");
  const lines = [
    `${colorize(theme, sevColor, workflowBadge(d.severity))} ${colorize(theme, "dim", `blockers ${d.blockers} · nudges ${d.nudges} · dirty ${d.dirtyFiles.length}`)}`,
    `${colorize(theme, "accent", "plan")} ${relPlan(root, d.activePlan)}${d.openPlanTasks === undefined ? "" : colorize(theme, "dim", ` · open ${d.openPlanTasks}`)}`,
  ];
  if (d.lastGateName || d.lastReviewVerdict) lines.push(`${colorize(theme, "accent", "evidence")} gate ${d.lastGateName ?? "none"}:${d.lastGateStatus ?? "none"} · review ${d.lastReviewVerdict ?? "none"}${d.reviewStale ? " stale" : ""}`);
  if (topFinding) lines.push(`${colorize(theme, topFinding.severity === "blocker" ? "error" : "warning", topFinding.title)} — ${topFinding.detail}`);
  lines.push(`${colorize(theme, "accent", "next")} ${d.nextAction}`);
  return lines;
}
