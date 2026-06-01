import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { Finding, GateDetails, WatchDetails, WatchMode, WatchVerbosity, WorkflowUiContext } from "./types.ts";
import { textResult } from "./result.ts";
import { cwdFrom, repoRoot, normalizeDirtyPath } from "./fs-git.ts";
import { readContract, normalizePlanPath, starterContract, analyze } from "./contract.ts";
import { stateFile, readState, writeState, diffSnapshot, runsDirResolution } from "./state.ts";
import { formatCompactStatus, details, formatWatch } from "./formatting.ts";
import { evidenceDetails, formatEvidence, formatWhy, whyDetails, reviewPacketDetails, progressDetails, formatProgress, createEvidenceBundle, doctorDetails, formatDoctor } from "./evidence.ts";
import { appendLedgerEvent, formatDirtyApprovals, approveDirtyOverlap, appendWorkflowNote, importAcceptanceEvidence, resolveGateCommands, runGateCommands, formatGateCommandSummary, appendGateEvidence } from "./guards.ts";
import { clearWorkflowUi, refreshWorkflowUi, formatHelp } from "./ui.ts";
import { setWorkflowWatcherEnabled, workflowTogglePath, workflowWatcherEnabled } from "./toggle.ts";
import { sendShapePlanRequest } from "./shape-plan-command.ts";

export function registerWorkflowCommand(pi: ExtensionAPI) {
  pi.registerCommand("workflow", {
    description: "Compact workflow watcher: status | next | progress | doctor | evidence | why | review-prompt | bundle | dirty | note <text> | gate <name> [--dry-run] | plan [path|slug] | shape-plan/new-plan <goal> | toggle [on|off] | help",
    getArgumentCompletions(prefix) {
      const first = prefix.trimStart().split(/\s/)[0] ?? "";
      return ["status", "next", "progress", "doctor", "evidence", "why", "review-prompt", "bundle", "dirty", "note", "gate", "plan", "shape-plan", "new-plan", "toggle", "help"].filter((value) => value.startsWith(first)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const [subRaw, ...rest] = args.trim().split(/\s/).filter(Boolean);
      const sub = subRaw ?? "status";
      const root = repoRoot(cwdFrom(ctx.cwd));
      const send = (content: string, detailsValue?: unknown) => pi.sendMessage({ customType: "workflow-watcher", display: true, content, details: detailsValue });
      if (sub === "status") {
        const analysis = analyze(root, "status");
        send(formatCompactStatus(root, "status", analysis), details(root, "status", analysis));
        return;
      }
      if (sub === "help") {
        send(formatHelp(), { root, commands: ["status", "next", "progress", "doctor", "evidence", "why", "review-prompt", "bundle", "dirty", "note", "gate", "plan", "shape-plan", "new-plan", "toggle", "help"] });
        return;
      }
      if (sub === "toggle") {
        const requested = rest[0];
        const current = workflowWatcherEnabled(root);
        const enabled = requested === "on" ? true : requested === "off" ? false : !current;
        const result = setWorkflowWatcherEnabled(root, enabled);
        if (enabled) refreshWorkflowUi(ctx as WorkflowUiContext);
        else clearWorkflowUi(ctx as WorkflowUiContext);
        send(`workflow watcher: ${enabled ? "on" : "off"}\nconfig: ${result.path}\n${enabled ? "Nudges and guards are enabled for this repo." : "Nudges and guards are disabled for this repo."}`, { root, enabled, configPath: workflowTogglePath(root) });
        return;
      }
      if (sub === "next") {
        const analysis = analyze(root, "status");
        send(`next: ${analysis.nextAction}`, details(root, "status", analysis));
        return;
      }
      if (sub === "progress") {
        const d = progressDetails(root, rest.join(" ").trim() || undefined);
        send(formatProgress(d), d);
        return;
      }
      if (sub === "evidence") {
        const read = readContract(root);
        const d = evidenceDetails(root, read.contract);
        send(formatEvidence(d), d);
        return;
      }
      if (sub === "why") {
        const target = rest[0] === "commit" || rest[0] === "edit" ? rest[0] : "workflow";
        const path = target === "edit" ? rest.slice(1).join(" ").trim() : undefined;
        const d = whyDetails(root, target, path);
        send(formatWhy(d), d);
        return;
      }
      if (sub === "review-prompt") {
        const d = reviewPacketDetails(root);
        send(d.packet, d);
        return;
      }
      if (sub === "bundle") {
        const result = createEvidenceBundle(root, rest.join(" ").trim() || undefined);
        send(result.content[0]?.type === "text" ? result.content[0].text : "Evidence bundle exported", result.details);
        return;
      }
      if (sub === "doctor") {
        const d = doctorDetails(root);
        send(formatDoctor(d), d);
        return;
      }
      if (sub === "note") {
        const note = rest.join(" ").trim();
        if (!note) { send("usage: /workflow note <text | OK_TO_COMMIT | gate beforeCommit pass>"); return; }
        const result = appendWorkflowNote(root, note);
        send(`noted: ${note}`, result.details);
        refreshWorkflowUi(ctx as WorkflowUiContext);
        return;
      }
      if (sub === "dirty") {
        const read = readContract(root); const contract = read.contract; const state = readState(root, contract);
        if (rest[0] === "baseline" && rest[1] === "refresh") {
          const snap = diffSnapshot(root); state.dirtyBaseline = { at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles }; state.dirtyOverlapApprovals = [];
          writeState(root, contract, state);
          send(`dirty baseline refreshed: ${snap.dirtyFiles.length} file(s)\nbaselineDiffHash: ${snap.diffHash}`, { root, dirtyBaseline: state.dirtyBaseline, statePath: stateFile(root, contract) });
          return;
        }
        if (rest[0] === "approve") {
          const reasonIndex = rest.findIndex((item) => item === "--reason");
          const pathArg = rest.slice(1, reasonIndex >= 0 ? reasonIndex : undefined).join(" ").trim();
          const reason = reasonIndex >= 0 ? rest.slice(reasonIndex + 1).join(" ").replace(/^[\"']|[\"']$/g, "") : "";
          const result = approveDirtyOverlap(root, pathArg, reason);
          send(String(result.content[0]?.type === "text" ? result.content[0].text : "dirty-overlap approval result"), result.details);
          refreshWorkflowUi(ctx as WorkflowUiContext);
          return;
        }
        const lines = ["# Dirty baseline", `baseline: ${state.dirtyBaseline ? `${state.dirtyBaseline.dirtyFiles.length} file(s) at ${state.dirtyBaseline.at}` : "none"}`, ...(state.dirtyBaseline ? [`baselineDiffHash: ${state.dirtyBaseline.diffHash}`, "files:", ...state.dirtyBaseline.dirtyFiles.map((line) => `- ${normalizeDirtyPath(line)}`)] : ["Run /workflow dirty baseline refresh to record current dirty files."]), "", "approvals:", ...(formatDirtyApprovals(state).length ? formatDirtyApprovals(state) : ["- none"]), "", "approve: /workflow dirty approve <path> --reason \"why this edit must touch pre-existing dirty work\""];
        send(lines.join("\n"), { root, dirtyBaseline: state.dirtyBaseline, dirtyOverlapApprovals: state.dirtyOverlapApprovals ?? [], statePath: stateFile(root, contract) });
        return;
      }
      if (sub === "shape-plan" || sub === "new-plan") {
        sendShapePlanRequest(pi, rest.join(" ").trim());
        return;
      }
      if (sub === "plan") {
        const planArg = rest.join(" ").trim();
        const read = readContract(root); const contract = read.contract; const state = readState(root, contract);
        if (planArg) {
          const findings: Finding[] = [];
          const plan = normalizePlanPath(root, contract, planArg, findings);
          if (!plan) { send(`plan not found/ambiguous: ${planArg}`); return; }
          state.activePlan = plan.slice(root.length + 1); writeState(root, contract, state);
          const analysis = analyze(root, "status", state.activePlan);
          send(`plan: ${state.activePlan}\nnext: ${analysis.nextAction}`, details(root, "status", analysis));
          refreshWorkflowUi(ctx as WorkflowUiContext);
          return;
        }
        const analysis = analyze(root, "status");
        send(`plan: ${analysis.planInfo.activePlan ? analysis.planInfo.activePlan.slice(root.length + 1) : "none"}`, details(root, "status", analysis));
        return;
      }
      if (sub === "gate") {
        const dryRun = rest.includes("--dry-run") || rest.includes("--dryRun") || rest.includes("-n");
        const gate = rest.filter((item) => !["--dry-run", "--dryRun", "-n"].includes(item))[0] ?? "beforeCommit";
        const read = readContract(root);
        if (read.status !== "ok") { send(read.status === "missing" ? "No .pi/workflows.json found. Run workflow_init first." : `Invalid .pi/workflows.json: ${read.error}`); return; }
        const resolved = resolveGateCommands(read.contract, gate);
        if (resolved.error) { send(`gate ${gate}: FAIL\n${resolved.error}`, { root, gate, dryRun, status: "fail", commands: resolved.commands, error: resolved.error }); return; }
        if (dryRun) {
          const gateDetails: GateDetails = { root, gate, dryRun, status: "dry-run", commands: resolved.commands };
          gateDetails.logPath = appendGateEvidence(root, read.contract, gateDetails);
          gateDetails.statePath = stateFile(root, read.contract);
          send([`gate ${gate}: DRY RUN`, ...resolved.commands.map((command) => `- ${command.alias}: ${command.cmd}`)].join("\n"), gateDetails);
          return;
        }
        const { runs, failed } = runGateCommands(root, resolved.commands);
        const gateDetails: GateDetails = { root, gate, dryRun, status: failed ? "fail" : "pass", commands: runs };
        gateDetails.logPath = appendGateEvidence(root, read.contract, gateDetails);
        gateDetails.statePath = stateFile(root, read.contract);
        const state = readState(root, read.contract); const snap = diffSnapshot(root);
        state.lastGateResult = { gate, status: gateDetails.status === "pass" ? "pass" : "fail", at: new Date().toISOString(), diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles, source: "workflow_gate" };
        if (gateDetails.status === "pass") state.checkpoint = { at: new Date().toISOString(), mode: "gate", diffHash: snap.diffHash, dirtyFiles: snap.dirtyFiles };
        writeState(root, read.contract, state);
        send([`gate ${gate}: ${gateDetails.status.toUpperCase()}`, ...runs.map(formatGateCommandSummary)].join("\n"), gateDetails);
        refreshWorkflowUi(ctx as WorkflowUiContext);
        return;
      }
      send("usage: /workflow status | next | progress | doctor | evidence | why [commit|edit <path>] | review-prompt | bundle | dirty | note <text> | gate <name> [--dry-run] | plan [path|slug] | shape-plan/new-plan <goal> | toggle [on|off] | help");
    },
  });
}
