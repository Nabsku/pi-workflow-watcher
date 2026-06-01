import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { AcceptanceImportDetails, AgentToolResult, CheckpointMode, CommandSpec, Confidence, ContractRead, DoctorDetails, EvidenceBundleDetails, EvidenceDetails, EvidenceSource, Finding, GateCommandRun, GateDetails, GateRunStatus, GateSpec, LedgerEvent, NoteDetails, PlanInference, ProgressDetails, ReviewPacketDetails, Severity, WatchDetails, WatchMode, WatchVerbosity, WhyDetails, WorkflowContract, WorkflowState, WorkflowUi, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, git, repoRoot, dirtyFiles, dirtyPath, unquotePath, normalizeDirtyPath, readJson, repoLocalPath, safeRepoLocalPath } from "./fs-git.ts";
import { readLog, runsDirResolution, readState, diffSnapshot, markReviewStaleIfEdited, writeState } from "./state.ts";
export function readContract(root: string): ContractRead {
  const path = join(root, ".pi/workflows.json");
  if (!existsSync(path)) return { status: "missing", contract: null };
  try { return { status: "ok", contract: JSON.parse(readFileSync(path, "utf8")) as WorkflowContract }; }
  catch (err) { return { status: "invalid-json", contract: null, error: err instanceof Error ? err.message : String(err) }; }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateContractSchema(contract: WorkflowContract): Finding[] {
  const findings: Finding[] = [];
  const blocker = (detail: string) => findings.push({ severity: "blocker", title: "Invalid workflow contract schema", detail });
  if (!isObject(contract)) return [{ severity: "blocker", title: "Invalid workflow contract schema", detail: "Contract root must be an object." }];
  if (contract.version !== 1) blocker("version must be integer const 1.");
  if (!isObject(contract.project)) blocker("project is required and must be an object.");
  else {
    if (typeof contract.project.name !== "string" || !contract.project.name) blocker("project.name is required.");
    if (typeof contract.project.kind !== "string" || !["app", "service", "package", "library", "cli", "monorepo", "docs", "infra", "unknown"].includes(contract.project.kind)) blocker("project.kind must be one of the schema enum values.");
    if (typeof contract.project.root !== "string" || !contract.project.root) blocker("project.root is required.");
  }
  if (!isObject(contract.commands)) blocker("commands is required and must be an object.");
  else for (const [name, cmd] of Object.entries(contract.commands)) {
    if (!isObject(cmd)) { blocker(`commands.${name} must be an object.`); continue; }
    if (!("cmd" in cmd)) blocker(`commands.${name}.cmd is required.`);
    if (cmd.cmd !== null && typeof cmd.cmd !== "string") blocker(`commands.${name}.cmd must be string or null.`);
    if (typeof cmd.source !== "string" || !cmd.source) blocker(`commands.${name}.source is required.`);
    if (typeof cmd.confidence !== "string" || !["verified", "inferred", "absent"].includes(cmd.confidence)) blocker(`commands.${name}.confidence must be verified, inferred, or absent.`);
    if (cmd.confidence === "absent" && cmd.cmd !== null) blocker(`commands.${name}.cmd must be null when confidence is absent.`);
  }
  if (!isObject(contract.gates)) blocker("gates is required and must be an object.");
  else {
    for (const required of ["preflight", "focused", "beforeCommit", "final"]) if (!contract.gates[required]) blocker(`gates.${required} is required.`);
    for (const [name, gate] of Object.entries(contract.gates)) {
      if (!isObject(gate)) { blocker(`gates.${name} must be an object.`); continue; }
      if (typeof gate.description !== "string" || !gate.description) blocker(`gates.${name}.description is required.`);
      if (!Array.isArray(gate.commands)) blocker(`gates.${name}.commands is required and must be an array.`);
      else if (!gate.commands.every((item) => typeof item === "string" && item.length > 0)) blocker(`gates.${name}.commands entries must be non-empty strings.`);
    }
  }
  const r = contract.rules;
  if (!isObject(r)) blocker("rules is required and must be an object.");
  else {
    if (typeof r.requirePlanForMultiFileChanges !== "boolean") blocker("rules.requirePlanForMultiFileChanges is required.");
    if (typeof r.requireReviewBeforeCommit !== "boolean") blocker("rules.requireReviewBeforeCommit is required.");
    if (r.requireAdversarialReviewAfterEveryTask !== true) blocker("rules.requireAdversarialReviewAfterEveryTask must be true.");
    if (typeof r.oneWriter !== "boolean") blocker("rules.oneWriter is required.");
    if (typeof r.commitPolicy !== "string" || !["never", "ask", "plan", "always"].includes(r.commitPolicy)) blocker("rules.commitPolicy must be never, ask, plan, or always.");
  }
  return findings;
}

export function validateContractSemantics(contract: WorkflowContract, mode: WatchMode): Finding[] {
  const findings: Finding[] = [];
  const commands = contract.commands ?? {};
  for (const [gateName, gate] of Object.entries(contract.gates ?? {})) {
    const required = gate.required !== false;
    const refs = gate.commands ?? [];
    if (required && refs.length === 0 && gate.allowEmpty !== true) findings.push({ severity: "blocker", title: "Required gate has no commands", detail: `gates.${gateName} is required but commands is empty and allowEmpty is not true.` });
    for (const ref of refs) {
      const cmd = commands[ref];
      if (!cmd) { findings.push({ severity: required ? "blocker" : "nudge", title: "Gate references unknown command", detail: `gates.${gateName}.commands includes ${JSON.stringify(ref)}, but commands.${ref} is missing.` }); continue; }
      if (cmd.confidence === "absent" || cmd.cmd == null) findings.push({ severity: required ? "blocker" : "nudge", title: "Gate references absent command", detail: `gates.${gateName}.commands includes ${JSON.stringify(ref)}, but commands.${ref} is absent or has cmd: null.` });
      else if (cmd.confidence !== "verified") findings.push({ severity: "nudge", title: "Gate uses unverified command", detail: `gates.${gateName}.commands includes ${JSON.stringify(ref)} with confidence ${JSON.stringify(cmd.confidence)}.` });
      if (required && cmd.mutatesRepo === true) findings.push({ severity: "blocker", title: "Required gate mutates repo", detail: `gates.${gateName} uses ${ref}, which has mutatesRepo: true.` });
      if (required && cmd.requiresNetwork === true) findings.push({ severity: "nudge", title: "Required gate needs network", detail: `gates.${gateName} uses ${ref}, which has requiresNetwork: true.` });
    }
  }
  if ((mode === "before-commit" || mode === "final") && contract.rules?.commitPolicy === "never") findings.push({ severity: "blocker", title: "Commit policy forbids commit", detail: "rules.commitPolicy is never." });
  return findings;
}
