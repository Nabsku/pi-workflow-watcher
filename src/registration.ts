import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHooks } from "./hooks.ts";
import { registerWorkflowCommand } from "./commands.ts";
import { registerWorkflowTools } from "./tools.ts";
import { registerShapePlanCommand } from "./shape-plan-command.ts";

export default function workflowWatcher(pi: ExtensionAPI) {
  registerHooks(pi);
  registerWorkflowCommand(pi);
  registerShapePlanCommand(pi);
  registerWorkflowTools(pi);
}
