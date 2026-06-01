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

import { eventCwd, toolInput, commandFromEvent, pathsFromEvent, patchBodyFromEvent, extractPatchPaths } from "./hook-event.ts";
import { editGuardForPath } from "./edit-guard.ts";
import { normalizeToolName, isTerminalTool, isEditTool, isGitCommitCommand, isGitPushCommand, isDependencyChangeCommand, isDestructiveCommand, isBroadFormatterCommand } from "./command-classification.ts";
export async function inspectToolCallEvent(event: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
    const toolName = normalizeToolName(event.toolName ?? event.name ?? "");
    const root = repoRoot(eventCwd(event));
    const analysis = analyze(root, "before-commit");
    const contract = analysis.contract;
    if (toolName === "parallel" && Array.isArray(toolInput(event).tool_uses)) {
      for (const child of toolInput(event).tool_uses as unknown[]) if (isObject(child)) {
        const nested = await inspectToolCallEvent({ ...child, cwd: event.cwd ?? toolInput(event).cwd, toolName: child.recipient_name ?? child.toolName ?? child.name, input: child.parameters ?? child.input ?? child.args });
        if (nested) return nested;
      }
    }
    if (isEditTool(toolName)) {
      const targets = new Set<string>();
      for (const target of pathsFromEvent(event)) targets.add(target);
      if (normalizeToolName(toolName) === "patch") {
        const patchBody = patchBodyFromEvent(event);
        if (patchBody) {
          const patchTargets = extractPatchPaths(patchBody);
          if (patchTargets.length === 0) return { block: true, reason: "Workflow watcher blocked patch with no parseable target paths. Use an explicit path or a supported patch header." };
          for (const target of patchTargets) targets.add(target);
        } else if (targets.size === 0) return { block: true, reason: "Workflow watcher blocked patch with no body or target paths. Use an explicit path and supported patch header." };
      } else if (targets.size === 0) return { block: true, reason: "Workflow watcher blocked edit with no parseable target path. Use path/files/targets explicitly." };
      const editTargets = [...targets];
      for (const target of editTargets) {
        const blocked = editGuardForPath(root, analysis, target);
        if (blocked) return blocked;
      }
      for (const target of editTargets) editGuardForPath(root, analysis, target, true);
    }
    if (isTerminalTool(toolName)) {
      const command = commandFromEvent(event);
      if (isGitCommitCommand(command) && contract?.rules?.requireReviewBeforeCommit !== false && !commitEvidenceCurrent(root, contract)) return { block: true, reason: "Workflow watcher blocked git commit: missing current trusted review verdict and workflow_gate beforeCommit/final pass, or matching checkpoint." };
      if (isGitPushCommand(command)) return { block: true, reason: "Workflow watcher blocked git push: external side effect needs explicit approval." };
      if (isDependencyChangeCommand(command)) return { block: true, reason: "Workflow watcher blocked dependency change: plan/approval evidence required first." };
      if (isDestructiveCommand(command)) return { block: true, reason: "Workflow watcher blocked destructive command." };
      if (isBroadFormatterCommand(command)) return { block: true, reason: "Workflow watcher blocked broad formatter/fixer. Scope it to approved files or plan it explicitly." };
    }
    return undefined;
}
