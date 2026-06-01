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

import { safePreview, appendLedgerEvent, safeGateCommands } from "./guard-logging.ts";
export function truncateOutput(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}
...[truncated ${value.length - max} chars]`;
}

const DEFAULT_GATE_COMMAND_TIMEOUT_SECONDS = 10 * 60;

export function commandTimeoutSeconds(spec: CommandSpec): number {
  return typeof spec.timeoutSeconds === "number" && Number.isFinite(spec.timeoutSeconds) && spec.timeoutSeconds > 0 ? spec.timeoutSeconds : DEFAULT_GATE_COMMAND_TIMEOUT_SECONDS;
}

export function resolveGateCommands(contract: WorkflowContract, gateName: string): { gate?: GateSpec; commands: GateCommandRun[]; error?: string } {
  const gate = contract.gates?.[gateName];
  if (!gate) return { commands: [], error: `Unknown gate ${JSON.stringify(gateName)}.` };
  const commands = contract.commands ?? {};
  const resolved: GateCommandRun[] = [];
  for (const alias of gate.commands ?? []) {
    const spec = commands[alias];
    if (!spec) return { gate, commands: resolved, error: `Gate ${gateName} references unknown command ${JSON.stringify(alias)}.` };
    if (spec.cmd == null || spec.confidence === "absent") return { gate, commands: resolved, error: `Gate ${gateName} references absent command ${JSON.stringify(alias)}.` };
    resolved.push({ alias, cmd: spec.cmd, status: "dry-run", timeoutSeconds: commandTimeoutSeconds(spec) });
  }
  return { gate, commands: resolved };
}

export function runGateCommands(root: string, commands: GateCommandRun[]): { runs: GateCommandRun[]; failed: boolean } {
  const runs: GateCommandRun[] = [];
  let failed = false;
  for (const command of commands) {
    const started = Date.now();
    const timeoutSeconds = command.timeoutSeconds ?? DEFAULT_GATE_COMMAND_TIMEOUT_SECONDS;
    const result = spawnSync(command.cmd, { cwd: root, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.max(1, Math.ceil(timeoutSeconds * 1000)) });
    const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
    const status: GateRunStatus = result.status === 0 && !timedOut ? "pass" : "fail";
    const error = timedOut ? `timeout after ${timeoutSeconds}s` : result.error ? result.error.message : undefined;
    runs.push({ alias: command.alias, cmd: command.cmd, status, exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, stdout: truncateOutput(result.stdout ?? ""), stderr: truncateOutput(result.stderr ?? ""), timeoutSeconds, timedOut, error });
    if (status === "fail") { failed = true; break; }
  }
  return { runs, failed };
}

export function formatGateCommandSummary(command: GateCommandRun): string {
  const exit = command.exitCode === undefined ? "" : ` exit=${command.exitCode}`;
  const signal = command.signal ? ` signal=${command.signal}` : "";
  const timeout = command.timedOut ? ` timeout=${command.timeoutSeconds ?? DEFAULT_GATE_COMMAND_TIMEOUT_SECONDS}s` : "";
  return `- ${command.alias}: ${command.status}${exit}${signal}${timeout} ${command.cmd}`;
}

export function appendGateEvidence(root: string, contract: WorkflowContract | null, details: GateDetails): string {
  const dir = runsDir(root, contract);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "workflow-watcher.log");
  const lines = [
    `${new Date().toISOString()} gate ${details.gate} ${details.status}${details.dryRun ? " dryRun" : ""}`,
    ...details.commands.map((command) => {
      const code = command.exitCode === undefined ? "" : ` exit=${command.exitCode}`;
      const signal = command.signal ? ` signal=${command.signal}` : "";
      const duration = command.durationMs === undefined ? "" : ` durationMs=${command.durationMs}`;
      const timeout = command.timedOut ? ` timeout=${command.timeoutSeconds ?? DEFAULT_GATE_COMMAND_TIMEOUT_SECONDS}s` : "";
      const error = command.error ? ` error=${JSON.stringify(command.error)}` : "";
      return `  - ${command.alias}: ${command.status}${code}${signal}${duration}${timeout}${error} cmd=${JSON.stringify(safePreview(command.cmd, 200) ?? "")}`;
    }),
  ];
  if (details.error) lines.push(`  error=${details.error}`);
  appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
  appendLedgerEvent(root, contract, { type: "gate_run", at: new Date().toISOString(), diffHash: diffSnapshot(root).diffHash, gate: details.gate, status: details.status, source: "workflow_gate", commands: safeGateCommands(details.commands), ...(details.error ? { notePreview: safePreview(details.error) } : {}) });
  return path;
}
