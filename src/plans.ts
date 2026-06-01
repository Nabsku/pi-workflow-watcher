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
import { currentBranch } from "./project-inference.ts";
export function normalizePlanPath(root: string, contract: WorkflowContract | null, planPath: unknown, findings?: Finding[]): string | undefined {
  if (typeof planPath !== "string" || planPath.trim() === "") return undefined;
  const raw = planPath.trim();
  const direct = resolve(root, raw);
  const rel = relative(root, direct);
  if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(direct) && statSync(direct).isFile()) return direct;
  const plansDir = safeRepoLocalPath(root, contract?.artifacts?.plansDir, ".pi/plans", findings, "artifacts.plansDir");
  const candidates = existsSync(plansDir) ? readdirSync(plansDir)
    .filter((name) => name === raw || name === `${raw}.md` || name.startsWith(`${raw}-`) || name.includes(raw))
    .map((name) => join(plansDir, name))
    .filter((path) => existsSync(path) && statSync(path).isFile()) : [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function absolutePlanPath(root: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  return !rel.startsWith("..") && !isAbsolute(rel) && existsSync(resolved) && statSync(resolved).isFile() ? resolved : undefined;
}

export function findPlanBySlug(root: string, plans: string[], slug: string): string[] {
  const wanted = normalizeSlug(slug);
  if (!wanted) return [];
  return plans.filter((rel) => {
    const base = normalizeSlug(basename(rel));
    return base === wanted || base.includes(wanted) || wanted.includes(base);
  }).map((rel) => join(root, rel));
}

export function lastWatcherNote(root: string, contract: WorkflowContract | null, state: WorkflowState): string | undefined {
  if (state.lastNote?.note) return state.lastNote.note;
  const lines = readLog(root, contract).trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : undefined;
}

export function planFromNote(root: string, contract: WorkflowContract | null, plans: string[], note: string | undefined, findings: Finding[]): string | undefined {
  if (!note) return undefined;
  const pathMatch = note.match(/(?:^|\s)(\.pi\/[\w./-]+\.(?:md|json))\b/);
  if (pathMatch) return absolutePlanPath(root, pathMatch[1]);
  const slugMatch = note.match(/\b(?:active\s+plan|plan)\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9_.\/-]*)/i);
  if (!slugMatch) return undefined;
  const normalized = normalizePlanPath(root, contract, slugMatch[1], findings);
  if (normalized) return normalized;
  const matches = findPlanBySlug(root, plans, slugMatch[1]);
  return matches.length === 1 ? matches[0] : undefined;
}

export function inferActivePlan(root: string, contract: WorkflowContract | null, planPath: unknown, state: WorkflowState, plans: string[], findings: Finding[]): PlanInference {
  const explicit = normalizePlanPath(root, contract, planPath, findings);
  if (explicit) return { selectedPlan: explicit, findings: [], explanation: [`explicit tool input -> ${explicit.slice(root.length + 1)}`] };
  const candidates: Array<{ path: string; source: string }> = [];
  const statePlan = absolutePlanPath(root, state.activePlan);
  if (statePlan) candidates.push({ path: statePlan, source: "persisted state.activePlan" });
  const notePlan = planFromNote(root, contract, plans, lastWatcherNote(root, contract, state), findings);
  if (notePlan) candidates.push({ path: notePlan, source: "last watcher note" });
  const branch = currentBranch(root).split("/").pop() ?? "";
  const branchMatches = findPlanBySlug(root, plans, branch);
  if (branchMatches.length === 1) candidates.push({ path: branchMatches[0], source: `current branch slug ${JSON.stringify(branch)}` });
  else if (branchMatches.length > 1) candidates.push(...branchMatches.map((path) => ({ path, source: `current branch slug ${JSON.stringify(branch)}` })));
  if (plans[0]) candidates.push({ path: join(root, plans[0]), source: "most recently modified plan" });

  const byPath = new Map<string, string[]>();
  for (const candidate of candidates) byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate.source]);
  const distinct = [...byPath.entries()];
  const explanation = candidates.map((c) => `${c.source} -> ${c.path.slice(root.length + 1)}`);
  if (distinct.length > 1) return { selectedPlan: undefined, findings: [{ severity: "nudge", title: "Ambiguous active plan", detail: `Multiple plan candidates match: ${distinct.map(([path, sources]) => `${path.slice(root.length + 1)} (${sources.join(", ")})`).join("; ")}. Pass planPath explicitly or record workflow_note with plan: <slug>.` }], explanation };
  return { selectedPlan: distinct[0]?.[0], findings: [], explanation };
}

export function inspectPlan(path: string | undefined): { activePlan?: string; openPlanTasks?: number; completedPlanTasks?: number; reviewVerdicts: string[]; missingReviewBlocks: boolean; checkboxTasks?: Array<{ text: string; checked: boolean }>; parseable?: boolean; parseLimitations?: string[] } {
  if (!path) return { reviewVerdicts: [], missingReviewBlocks: false, parseable: false, parseLimitations: ["No active plan selected."] };
  try {
    const text = readFileSync(path, "utf8");
    const checkboxTasks: Array<{ text: string; checked: boolean }> = [];
    let inFence = false;
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const match = line.match(/^\s*[-*+]\s+\[([ xX])]\s+(.+)$/);
      if (match) checkboxTasks.push({ checked: match[1].toLowerCase() === "x", text: match[2].trim() });
    }
    const openPlanTasks = checkboxTasks.filter((task) => !task.checked).length;
    const completedPlanTasks = checkboxTasks.filter((task) => task.checked).length;
    const parseLimitations = checkboxTasks.length ? [] : ["No markdown checkbox tasks found; progress counts are unavailable for this plan format."];
    const reviewVerdicts = [...text.matchAll(/`?(OK_TO_MARK_DONE|OK_TO_MARK_FIXED|OK_TO_COMMIT|NEEDS_FIX|BLOCKED|OK_TO_PRESENT|NEEDS_WORK)`?/g)].map((m) => m[1]);
    const missingReviewBlocks = !text.includes("Adversarial review") && !text.includes("adversarial review");
    return { activePlan: path, openPlanTasks, completedPlanTasks, reviewVerdicts: [...new Set(reviewVerdicts)], missingReviewBlocks, checkboxTasks, parseable: checkboxTasks.length > 0, parseLimitations };
  } catch (error) { return { activePlan: path, reviewVerdicts: [], missingReviewBlocks: false, parseable: false, parseLimitations: [`Could not read active plan: ${error instanceof Error ? error.message : String(error)}`] }; }
}

export function listPlans(root: string, contract: WorkflowContract | null, findings?: Finding[]): string[] {
  const dir = safeRepoLocalPath(root, contract?.artifacts?.plansDir, ".pi/plans", findings, "artifacts.plansDir");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md") || name.endsWith(".json"))
    .map((name) => join(dir, name)).filter((path) => statSync(path).isFile()).sort((a, b) => {
      const mtimeDelta = statSync(b).mtimeMs - statSync(a).mtimeMs;
      return mtimeDelta || b.localeCompare(a);
    })
    .slice(0, 8).map((path) => path.slice(root.length + 1));
}
