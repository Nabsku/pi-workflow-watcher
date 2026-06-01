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
export function currentBranch(root: string): string { return git(["branch", "--show-current"], root) || "(no git branch)"; }

export function detectProject(root: string): WorkflowContract["project"] {
  const files = new Set(existsSync(root) ? readdirSync(root) : []);
  const languages: string[] = [];
  let packageManager: string | null = null;
  let kind = "unknown";
  if (files.has("package.json")) { languages.push("typescript/javascript"); kind = "package"; if (files.has("pnpm-lock.yaml")) packageManager = "pnpm"; else if (files.has("yarn.lock")) packageManager = "yarn"; else if (files.has("bun.lockb")) packageManager = "bun"; else packageManager = "npm"; }
  if (files.has("pyproject.toml")) { languages.push("python"); packageManager ??= "uv/poetry"; kind = kind === "unknown" ? "package" : kind; }
  if (files.has("go.mod")) { languages.push("go"); packageManager ??= "go"; kind = kind === "unknown" ? "service" : kind; }
  if (files.has("Cargo.toml")) { languages.push("rust"); packageManager ??= "cargo"; kind = kind === "unknown" ? "package" : kind; }
  return { name: basename(root), kind, root: ".", packageManager, primaryLanguages: [...new Set(languages)] };
}

export function command(cmd: string | null, source: string, confidence: Confidence = "verified"): CommandSpec { return { cmd, source, confidence }; }

export function inferCommands(root: string): WorkflowContract["commands"] {
  const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, "package.json"));
  if (pkg?.scripts) {
    const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
    const script = (name: string) => pkg.scripts?.[name] ? command(`${pm} ${name === "test" ? "test" : `run ${name}`}`, `package.json:scripts.${name}`) : command(null, "absent", "absent");
    return { install: command(pm === "pnpm" ? "pnpm install" : `${pm} install`, `${pm} lockfile/package.json`, "inferred"), test: script("test"), testFocused: command(null, "absent", "absent"), typecheck: script("typecheck"), lint: script("lint"), build: script("build"), ci: command(null, "absent", "absent") };
  }
  if (existsSync(join(root, "go.mod"))) return { test: command("go test ./...", "go.mod", "inferred"), build: command("go build ./...", "go.mod", "inferred") };
  return { test: command(null, "absent", "absent"), build: command(null, "absent", "absent") };
}

export function starterContract(root: string): WorkflowContract {
  return {
    $schema: "./schemas/pi-workflows.schema.json",
    version: 1,
    project: detectProject(root),
    commands: inferCommands(root),
    gates: {
      preflight: { description: "Baseline repo state checks before editing.", commands: [], required: false, allowEmpty: true },
      focused: { description: "Narrow verification for the active slice.", commands: ["testFocused"], required: false },
      beforeCommit: { description: "Checks required before committing.", commands: ["typecheck", "test"], required: true },
      final: { description: "Strongest practical final verification.", commands: ["build", "test"], required: true },
    },
    rules: {
      requirePlanForMultiFileChanges: true,
      requireReviewBeforeCommit: true,
      requireAdversarialReviewAfterEveryTask: true,
      oneWriter: true,
      commitPolicy: "plan",
      allowedSubagents: ["scout", "planner", "worker", "reviewer", "oracle"],
      stopOn: ["dirty-overlap", "unknown-command", "failed-gate", "review-failed", "unapproved-dependency-change", "external-side-effect"],
    },
    artifacts: { plansDir: ".pi/plans", runsDir: ".pi/runs", agentInstructions: "AGENTS.md" },
    ownership: { highRiskPaths: [], generatedPaths: [], lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "go.sum", "Cargo.lock"] },
    notes: ["Generated by pi-workflow-watcher. Verify commands before trusting gates."],
  };
}
