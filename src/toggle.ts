import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = ".pi/workflow-watcher.json";

type ToggleConfig = { enabled?: boolean; updatedAt?: string };

export function workflowTogglePath(root: string): string {
  return join(root, CONFIG_PATH);
}

export function workflowWatcherEnabled(root: string): boolean {
  const path = workflowTogglePath(root);
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as ToggleConfig;
    return config.enabled === true;
  } catch {
    return false;
  }
}

export function setWorkflowWatcherEnabled(root: string, enabled: boolean): { path: string; enabled: boolean } {
  const path = workflowTogglePath(root);
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { path, enabled };
}
