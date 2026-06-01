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

export function normalizeToolName(name: unknown): string {
  const raw = String(name ?? "").trim().toLowerCase();
  return raw.split(/[./:]/).filter(Boolean).pop() ?? raw;
}
export function isTerminalTool(name: string): boolean { return ["terminal", "bash", "shell", "run_command"].includes(normalizeToolName(name)); }
export function isEditTool(name: string): boolean { return ["write", "write_file", "edit", "str_replace_editor", "patch"].includes(normalizeToolName(name)); }
export function commandWords(command: string): string[] { return command.toLowerCase().match(/[^\s"']+|"[^"]*"|'[^']*'/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? []; }
export function baseCommand(word: string | undefined): string { return (word ?? "").split(/[\\/]/).pop() ?? ""; }
export function unwrapShellCommands(command: string): string[] {
  const parts = command.split(/\n|&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const words = commandWords(part); let i = 0;
    while (words[i]) {
      const bin = baseCommand(words[i]);
      if (/^[a-z_][a-z0-9_]*=.*/i.test(words[i])) { i++; continue; }
      if (bin === "command" || bin === "env") { i++; continue; }
      if (bin === "sudo") { i++; while ((words[i] ?? "").startsWith("-")) i += ["-u", "-g", "-h", "-p"].includes(words[i]) ? 2 : 1; continue; }
      if ((words[i] ?? "").startsWith("-")) { i++; continue; }
      break;
    }
    const bin = baseCommand(words[i]);
    const cIndex = words.findIndex((word, idx) => idx >= i && /^-[^-]*c[^\s]*$/.test(word));
    if (["sh", "bash", "zsh"].includes(bin) && cIndex >= 0) { const c = words[cIndex + 1]; if (c) out.push(...unwrapShellCommands(c)); }
    else out.push(words.slice(i).join(" "));
  }
  return out.length ? out : [command];
}
export function commandVariants(command: string): string[] {
  const variants: string[] = [];
  for (const part of unwrapShellCommands(command)) {
    variants.push(part);
    const words = commandWords(part); const first = baseCommand(words[0]); const second = words[1];
    if (["npm", "npx", "pnpm", "yarn", "bun"].includes(first)) {
      const skip = new Set(["exec", "dlx", "x", "run", "--yes", "-y", "--"]); let i = 1; while (skip.has(words[i] ?? "")) i++;
      if (i > 1 || ["npx", "yarn", "bun"].includes(first)) variants.push(words.slice(i).join(" "));
      if (first === "npm" && second === "exec") variants.push(words.slice(2).join(" "));
      if (first === "pnpm" && second === "exec") variants.push(words.slice(2).join(" "));
    }
  }
  return variants.filter(Boolean);
}
export function gitSubcommand(words: string[]): string | undefined {
  let i = 0;
  while (words[i] === "command" || words[i] === "env" || /^[a-z_][a-z0-9_]*=.*/i.test(words[i] ?? "")) i++;
  if (baseCommand(words[i]) !== "git") return undefined;
  i++;
  while (i < words.length) {
    const word = words[i];
    if (word === "-c" || word === "--config-env" || word === "-C") { i += 2; continue; }
    if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=") || word.startsWith("--namespace=")) { i++; continue; }
    if (word === "--git-dir" || word === "--work-tree" || word === "--namespace" || word === "--exec-path") { i += 2; continue; }
    return word;
  }
  return undefined;
}
export function isGitCommitCommand(command: string): boolean { return commandVariants(command).some((cmd) => gitSubcommand(commandWords(cmd)) === "commit"); }
export function isGitPushCommand(command: string): boolean { return commandVariants(command).some((cmd) => gitSubcommand(commandWords(cmd)) === "push"); }
export function isDependencyChangeCommand(command: string): boolean {
  for (const variant of commandVariants(command)) {
  const words = commandWords(variant); const first = baseCommand(words[0]); const second = words[1];
  if (first === "npm" && ["install", "i", "update", "uninstall", "remove", "rm"].includes(second)) return true;
  if (first === "npm" && second === "audit" && words[2] === "fix") return true;
  if (first === "pnpm" && ["add", "install", "i", "remove", "rm", "update", "import"].includes(second)) return true;
  if (first === "yarn" && ["install", "add", "remove", "upgrade"].includes(second)) return true;
  if (first === "bun" && ["install", "add", "remove"].includes(second)) return true;
  if (first === "go" && (second === "get" || (second === "mod" && words[2] === "tidy"))) return true;
  if (first === "cargo" && ["add", "update"].includes(second)) return true;
  if (first === "uv" && ["add", "remove", "sync"].includes(second)) return true;
  if (first === "poetry" && ["add", "remove", "update"].includes(second)) return true;
  }
  return false;
}
export function isDestructiveCommand(command: string): boolean {
  for (const variant of commandVariants(command)) { const words = commandWords(variant);
  const gitSub = gitSubcommand(words);
  if (gitSub === "clean") return true;
  const gitIndex = words.findIndex((word) => baseCommand(word) === "git");
  if (gitSub === "reset" && words.slice(gitIndex + 1).includes("--hard")) return true;
  if ((gitSub === "restore" || gitSub === "checkout") && words.slice(gitIndex + 1).includes(".") && words.includes("--")) return true;
  if (baseCommand(words[0]) === "sudo") return true;
  if (baseCommand(words[0]) === "find" && (words.includes("-delete") || (words.includes("-exec") && words.some((w) => baseCommand(w) === "rm")))) return true;
  if (baseCommand(words[0]) === "xargs" && words.some((w) => baseCommand(w) === "rm")) return true;
  if (baseCommand(words[0]) === "rsync" && words.includes("--delete")) return true;
  if (baseCommand(words[0]) !== "rm") continue;
  const flags = words.slice(1).filter((word) => word.startsWith("-")).join("");
  return flags.includes("r") && flags.includes("f");
  }
  return false;
}
export function isBroadFormatterCommand(command: string): boolean { return commandVariants(command).some((variant) => { const words = commandWords(variant); return ["prettier", "eslint", "ruff"].includes(baseCommand(words[0])) && words.includes(".") && (words.includes("--write") || words.includes("--fix")); }); }
