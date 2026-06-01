import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowUiContext } from "./types.ts";
import { repoRoot } from "./fs-git.ts";
import { analyze, severity } from "./contract.ts";
import { details } from "./formatting.ts";
import { clearWorkflowUi, refreshWorkflowUi } from "./ui.ts";
import { eventCwd, inspectToolCallEvent } from "./guards.ts";
import { workflowWatcherEnabled } from "./toggle.ts";

export function registerHooks(pi: ExtensionAPI) {
  const api = pi as unknown as { on?: (event: string, handler: (event: Record<string, unknown>, ctx?: WorkflowUiContext) => unknown) => void };
  if (!api.on) return;

  api.on("session_start", async (event, ctx) => {
    const root = repoRoot(ctx?.cwd ?? eventCwd(event ?? {}));
    if (!workflowWatcherEnabled(root)) { clearWorkflowUi({ ...ctx, cwd: root }); return undefined; }
    return refreshWorkflowUi({ ...ctx, cwd: root });
  });
  api.on("turn_end", async (event, ctx) => {
    const root = repoRoot(ctx?.cwd ?? eventCwd(event ?? {}));
    if (!workflowWatcherEnabled(root)) { clearWorkflowUi({ ...ctx, cwd: root }); return undefined; }
    return refreshWorkflowUi({ ...ctx, cwd: root });
  });

  api.on("before_agent_start", async (event) => {
    const root = repoRoot(eventCwd(event ?? {}));
    if (!workflowWatcherEnabled(root)) return undefined;
    const analysis = analyze(root, "status");
    const sev = severity(analysis.findings);
    if (sev === "ok") return undefined;
    return { message: { customType: "workflow-watcher", content: `Workflow watcher: ${sev.toUpperCase()}\nNext: ${analysis.nextAction}`, display: "Workflow watcher nudge", details: details(root, "status", analysis) } };
  });

  api.on("tool_call", async (event) => {
    const root = repoRoot(eventCwd(event ?? {}));
    if (!workflowWatcherEnabled(root)) return undefined;
    return inspectToolCallEvent(event);
  });
}
