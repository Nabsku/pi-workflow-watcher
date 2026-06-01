import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function shapePlanPrompt(goal: string): string {
  const template = readFileSync(new URL("../prompts/shape-plan.md", import.meta.url), "utf8").trim();
  const request = goal.trim();
  return `${template.replace(/Requests:\s*\$@\s*$/m, "").trim()}\n\nRequests: ${request}`;
}

export function sendShapePlanRequest(pi: ExtensionAPI, goal: string): boolean {
  const request = goal.trim();
  if (!request) {
    pi.sendMessage({ customType: "workflow-watcher", display: true, content: "usage: /workflow shape-plan <goal>\nalias: /workflow new-plan <goal>" });
    return false;
  }
  pi.sendUserMessage(shapePlanPrompt(request));
  return true;
}
