import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { Finding, GateDetails, WatchDetails, WatchMode, WatchVerbosity, WorkflowCompleteDetails, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, repoRoot, normalizeDirtyPath } from "./fs-git.ts";
import { readContract, normalizePlanPath, starterContract, analyze } from "./contract.ts";
import { stateFile, readState, writeState, diffSnapshot, runsDirResolution } from "./state.ts";
import { formatCompactStatus, details, formatWatch } from "./formatting.ts";
import { evidenceDetails, formatEvidence, formatWhy, whyDetails, reviewPacketDetails, progressDetails, formatProgress, createEvidenceBundle, doctorDetails, formatDoctor } from "./evidence.ts";
import { appendLedgerEvent, formatDirtyApprovals, approveDirtyOverlap, appendWorkflowNote, importAcceptanceEvidence, resolveGateCommands, runGateCommands, formatGateCommandSummary, appendGateEvidence } from "./guards.ts";
import { refreshWorkflowUi, formatHelp } from "./ui.ts";

export function registerWorkflowTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow_watch", label: "Workflow Watch",
    description: "Watch repo workflow state and nudge Pi toward the next safe action. Reads .pi/workflows.json, git status, and plan artifacts.",
    promptSnippet: "Use before planning, before/after implementation slices, before commit, and final reporting. Treat blocker findings as stop signs.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current process cwd" })), mode: Type.Optional(StringEnum(["status", "planning", "preflight", "before-slice", "slice-complete", "after-slice", "before-commit", "final"], { description: "Workflow phase" })), planPath: Type.Optional(Type.String({ description: "Optional plan path or slug under artifacts.plansDir" })), verbosity: Type.Optional(StringEnum(["next", "summary", "full"], { description: "Output detail: next action only plus blockers, concise summary, or full detail; defaults to full" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd)); const mode = (params.mode ?? "status") as WatchMode; const analysis = analyze(root, mode, params.planPath, { writeState: mode !== "status" });
      const verbosity = (params.verbosity ?? "full") as WatchVerbosity;
      return textResult(formatWatch(root, mode, analysis.contractRead, analysis.findings, analysis.dirty, analysis.plans, analysis.nextAction, analysis.planInfo, verbosity, analysis.workflowLessons), details(root, mode, analysis, verbosity));
    },
    renderCall(args, theme) { const mode = (args as { mode?: string }).mode ?? "status"; return new Text(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", mode), 0, 0); },
    renderResult(result, _opts, theme) { const d = result.details as WatchDetails; const color = d.severity === "blocker" ? "error" : d.severity === "nudge" ? "warning" : "success"; return new Text(theme.fg(color, `${d.severity}: ${d.nextAction}`), 0, 0); },
  });

  pi.registerTool({
    name: "workflow_next", label: "Workflow Next", description: "Return only the next workflow nudge/action for the current repo and mode.", promptSnippet: "Use when unsure what to do next in a repo workflow.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), mode: Type.Optional(StringEnum(["status", "planning", "preflight", "before-slice", "slice-complete", "after-slice", "before-commit", "final"])), planPath: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) { const root = repoRoot(cwdFrom(params.cwd)); const mode = (params.mode ?? "status") as WatchMode; const analysis = analyze(root, mode, params.planPath, { writeState: false }); return textResult(analysis.nextAction, details(root, mode, analysis)); },
  });

  pi.registerTool({
    name: "workflow_init", label: "Workflow Init", description: "Create a conservative .pi/workflows.json starter contract if it does not exist.", promptSnippet: "Use when workflow_watch reports a missing contract. Inspect and verify generated commands before trusting gates.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing .pi/workflows.json; default false" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd)); const piDir = join(root, ".pi"); const path = join(piDir, "workflows.json"); const existed = existsSync(path);
      if (existed && params.overwrite !== true) return textResult(`Exists: ${path}\nNot overwritten.`, { root, path, created: false, overwritten: false });
      mkdirSync(piDir, { recursive: true }); const contract = starterContract(root); writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
      return textResult(`${existed ? "Overwrote" : "Created"} ${path}\nNext: inspect commands/gates and adjust anything inferred.`, { root, path, created: !existed, overwritten: existed });
    },
  });

  pi.registerTool({
    name: "workflow_approve_dirty_overlap",
    label: "Workflow Approve Dirty Overlap",
    description: "Approve one path-scoped edit to a file captured in dirtyBaseline.dirtyFiles. Requires a reason and is consumed by the next matching edit.",
    promptSnippet: "Use only after the user/operator intentionally approves editing pre-existing dirty work. This does not bypass high-risk/generated/lockfile/outside-repo protections.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), path: Type.String({ description: "Repo-local path present in dirtyBaseline.dirtyFiles" }), reason: Type.String({ description: "Required rationale for overlapping pre-existing dirty work" }) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      return approveDirtyOverlap(root, params.path, params.reason);
    },
  });

  pi.registerTool({
    name: "workflow_gate",
    label: "Workflow Gate",
    description: "Explicitly run a named gate from .pi/workflows.json, resolving command aliases and appending pass/fail evidence.",
    promptSnippet: "Use only when ready to execute verification. Use dryRun first if unsure what commands a gate expands to.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), gate: Type.String({ description: "Gate name from .pi/workflows.json, e.g. preflight, focused, beforeCommit, final" }), dryRun: Type.Optional(Type.Boolean({ description: "Resolve and report commands without executing them; default false" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const read = readContract(root);
      const gate = String(params.gate ?? "").trim();
      const dryRun = params.dryRun === true;
      if (read.status === "missing") return textResult<GateDetails>("No .pi/workflows.json found. Run workflow_init first.", { root, gate, dryRun, status: "fail", commands: [], error: "missing contract" });
      if (read.status === "invalid-json") return textResult<GateDetails>(`Invalid .pi/workflows.json: ${read.error}`, { root, gate, dryRun, status: "fail", commands: [], error: read.error });
      const contract = read.contract;
      const runsPath = runsDirResolution(root, contract);
      if (!runsPath.valid) return textResult<GateDetails>(`Workflow gate ${gate}: FAIL\n${runsPath.error}\nSafe fallback: ${runsPath.path}`, { root, gate, dryRun, status: "fail", commands: [], error: runsPath.error, logPath: join(runsPath.path, "workflow-watcher.log"), statePath: join(runsPath.path, "workflow-state.json") });
      const resolved = resolveGateCommands(contract, gate);
      if (resolved.error) {
        const details: GateDetails = { root, gate, dryRun, status: "fail", commands: resolved.commands, error: resolved.error };
        details.logPath = appendGateEvidence(root, contract, details);
        details.statePath = stateFile(root, contract);
        const state = readState(root, contract); const snap = diffSnapshot(root);
        state.lastGateResult = { gate, status: "fail", at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, source: "workflow_gate" };
        writeState(root, contract, state);
        return textResult(`Workflow gate ${gate}: FAIL\n${resolved.error}\nEvidence: ${details.logPath}`, details);
      }
      if (dryRun) {
        const details: GateDetails = { root, gate, dryRun, status: "dry-run", commands: resolved.commands };
        details.logPath = appendGateEvidence(root, contract, details);
        details.statePath = stateFile(root, contract);
        return textResult([`Workflow gate ${gate}: DRY RUN`, ...resolved.commands.map((command) => `- ${command.alias}: ${command.cmd}`), `Evidence: ${details.logPath}`].join("\n"), details);
      }
      const { runs, failed } = runGateCommands(root, resolved.commands);
      const details: GateDetails = { root, gate, dryRun, status: failed ? "fail" : "pass", commands: runs };
      details.logPath = appendGateEvidence(root, contract, details);
      details.statePath = stateFile(root, contract);
      const state = readState(root, contract); const snap = diffSnapshot(root);
      state.lastGateResult = { gate, status: details.status === "pass" ? "pass" : "fail", at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, source: "workflow_gate" };
      if (details.status === "pass") state.checkpoint = { at: new Date().toISOString(), mode: "gate", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles };
      writeState(root, contract, state);
      return textResult([`Workflow gate ${gate}: ${details.status.toUpperCase()}`, ...runs.map(formatGateCommandSummary), `Evidence: ${details.logPath}`].join("\n"), details);
    },
    renderCall(args, theme) { const gate = (args as { gate?: string }).gate ?? "gate"; return new Text(theme.fg("toolTitle", theme.bold("workflow gate ")) + theme.fg("accent", gate), 0, 0); },
    renderResult(result, _opts, theme) { const d = result.details as GateDetails; const color = d.status === "fail" ? "error" : d.status === "dry-run" ? "warning" : "success"; return new Text(theme.fg(color, `${d.gate}: ${d.status}`), 0, 0); },
  });

  pi.registerTool({
    name: "workflow_doctor",
    label: "Workflow Doctor",
    description: "Diagnose workflow contract, planning artifacts, and setup issues without running gates or mutating state.",
    promptSnippet: "Use when workflow setup or planning quality is unclear. This is read-only.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const details = doctorDetails(root);
      return textResult(formatDoctor(details), details);
    },
  });

  pi.registerTool({
    name: "workflow_progress",
    label: "Workflow Progress",
    description: "Summarize active plan progress, current slice, conservative counts, stale review/gate evidence, and next safe action without editing plans or running gates.",
    promptSnippet: "Use when you need to know where the task stands. This is read-only and never runs gates or edits plan files.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), planPath: Type.Optional(Type.String({ description: "Optional plan path or slug under artifacts.plansDir" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const details = progressDetails(root, params.planPath);
      return textResult(formatProgress(details), details);
    },
  });

  pi.registerTool({
    name: "workflow_complete",
    label: "Workflow Complete",
    description: "Mark the active workflow complete only when the workflow is clean: active plan has zero open tasks and trusted final/beforeCommit evidence is current.",
    promptSnippet: "Call only at final handoff. This fails closed unless the active plan is complete and trusted reviewer/oracle plus workflow_gate evidence are fresh for the current diff.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), planPath: Type.Optional(Type.String({ description: "Optional plan path or slug under artifacts.plansDir" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const read = readContract(root);
      const contract = read.contract;
      const progress = progressDetails(root, params.planPath);
      const evidence = evidenceDetails(root, contract);
      const blockers: string[] = [];
      if (!progress.activePlan) blockers.push("no active plan selected");
      if (!progress.planParse.parseable) blockers.push("active plan checklist is not parseable");
      if (progress.counts.open === undefined) blockers.push("open task count is unknown");
      else if (progress.counts.open > 0) blockers.push(`${progress.counts.open} open plan task(s) remain`);
      if (!evidence.commitReady) blockers.push(...evidence.missing);
      const clean = blockers.length === 0;
      const statePath = stateFile(root, contract);
      const details: WorkflowCompleteDetails = { root, status: clean ? "complete" : "blocked", clean, activePlan: progress.activePlan, statePath, blockers: [...new Set(blockers)], evidence: { commitReady: evidence.commitReady, reviewTrusted: evidence.reviewTrusted, reviewFresh: evidence.reviewFresh, gateTrusted: evidence.gateTrusted, gateFresh: evidence.gateFresh, missing: evidence.missing }, counts: progress.counts };
      if (!clean) return textResult(`Workflow complete: BLOCKED\n${details.blockers.map((item) => `- ${item}`).join("\n")}\nNext: ${progress.nextSafeAction}`, details);
      const state = readState(root, contract);
      const completedAt = new Date().toISOString();
      delete state.activePlan;
      state.lastNote = { at: completedAt, note: `WORKFLOW_COMPLETE ${progress.activePlan ?? "active-plan"}` };
      writeState(root, contract, state);
      details.completedAt = completedAt;
      return textResult(`Workflow complete: OK\nactive plan: ${progress.activePlan}\nstate: ${statePath}\nNext: use /workflow toggle off if you want to quiet watcher surfaces for this repo.`, details);
    },
  });

  pi.registerTool({
    name: "workflow_export_evidence", label: "Workflow Export Evidence", description: "Export a sanitized bounded markdown evidence bundle under artifacts.runsDir.", promptSnippet: "Use before handoff, final reporting, or commit review to create a durable sanitized evidence bundle. Do not include raw prompts or huge outputs.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), planPath: Type.Optional(Type.String({ description: "Optional plan path or slug under artifacts.plansDir" })) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      return createEvidenceBundle(root, params.planPath);
    },
  });

  pi.registerTool({
    name: "workflow_note", label: "Workflow Note", description: "Append a short watcher note to artifacts.runsDir/workflow-watcher.log.", promptSnippet: "Use for durable concise workflow breadcrumbs: blocker, review verdict, gate result, or next step.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), note: Type.String({ description: "Short note to append" }) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      return appendWorkflowNote(root, params.note);
    },
  });

  pi.registerTool({
    name: "workflow_review_packet",
    label: "Workflow Review Packet",
    description: "Return a compact reviewer/oracle handoff packet. Does not launch subagents.",
    promptSnippet: "Use when trusted review is missing or stale; copy the packet to reviewer/oracle, then import accepted evidence with workflow_import_acceptance.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const details = reviewPacketDetails(root);
      return textResult(details.packet, details);
    },
  });

  pi.registerTool({
    name: "workflow_why",
    label: "Workflow Why",
    description: "Explain the current workflow/commit/edit blocker source, why it blocks, and the exact next action.",
    promptSnippet: "Use when a workflow blocker is unclear. For edit blockers pass target=edit and path.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), target: Type.Optional(StringEnum(["workflow", "commit", "edit"])), path: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      const details = whyDetails(root, (params.target ?? "workflow") as "workflow" | "commit" | "edit", params.path);
      return textResult(formatWhy(details), details);
    },
  });

  pi.registerTool({
    name: "workflow_import_acceptance",
    label: "Workflow Import Acceptance",
    description: "Import a pi-subagents v0.26 reviewer/oracle acceptance artifact as trusted review evidence only when fenced acceptance, provenance, and current diff hash validate.",
    promptSnippet: "Prefer this for reviewer/oracle subagent results that used pi-subagents acceptance gates. Do not use manual OK_TO_COMMIT prose as trusted evidence.",
    parameters: Type.Object({ cwd: Type.Optional(Type.String()), artifactPath: Type.Optional(Type.String({ description: "Repo-local JSON/text artifact path from pi-subagents status/result" })), result: Type.Optional(Type.Any({ description: "Raw status/result object to validate instead of reading artifactPath" })), verdict: Type.Optional(StringEnum(["OK_TO_COMMIT", "OK_TO_MARK_DONE", "OK_TO_MARK_FIXED", "OK_TO_PRESENT"])) }),
    async execute(_toolCallId, params) {
      const root = repoRoot(cwdFrom(params.cwd));
      return importAcceptanceEvidence(root, params as Record<string, unknown>);
    },
  });
}
