import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import workflowWatcher from "../index.ts";
import { setWorkflowWatcherEnabled } from "../src/toggle.ts";

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
type Hook = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown;
type Command = { handler: (args: string, ctx: { cwd: string }) => Promise<void> };

const tools: Tool[] = [];
const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];
const hooks: Record<string, Hook[]> = {};

workflowWatcher({
  registerTool(tool: Tool) { tools.push(tool); },
  registerCommand(name: string, command: Command) { commands[name] = command; },
  sendMessage(message: { content: string; details?: unknown }) { messages.push(message); },
  on(event: string, handler: Hook) { hooks[event] ??= []; hooks[event].push(handler); },
} as never);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tool(name: string): Tool {
  const found = tools.find((candidate) => candidate.name === name);
  assert(found, `missing tool ${name}`);
  return found;
}

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}


function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-e2e-"));
  git(["init"], root);
  git(["config", "user.email", "watcher@example.invalid"], root);
  git(["config", "user.name", "Workflow Watcher"], root);
  return root;
}


function writeContract(root: string) {
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/workflows.json"), `${JSON.stringify({
    version: 1,
    project: { name: "e2e-fixture", kind: "package", root: ".", packageManager: "pnpm", primaryLanguages: ["typescript"] },
    commands: {
      test: { cmd: "node -e \"process.exit(0)\"", source: "e2e", confidence: "verified" },
      typecheck: { cmd: "node -e \"process.exit(0)\"", source: "e2e", confidence: "verified" },
      build: { cmd: "node -e \"process.exit(0)\"", source: "e2e", confidence: "verified" },
      testFocused: { cmd: null, source: "absent", confidence: "absent" },
    },
    gates: {
      preflight: { description: "Preflight", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused", commands: ["testFocused"], required: false },
      beforeCommit: { description: "Before commit", commands: ["typecheck", "test"], required: true },
      final: { description: "Final", commands: ["build", "test"], required: true },
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
    ownership: { highRiskPaths: ["src/secure/**"], generatedPaths: ["src/generated/**"], lockfiles: ["pnpm-lock.yaml"] },
  }, null, 2)}\n`);
}

async function toolCallGuard(root: string, command: string) {
  const handler = hooks.tool_call?.[0];
  assert(handler, "tool_call hook should be registered");
  return await handler({ toolName: "bash", input: { command }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
}


const root = repo();
setWorkflowWatcherEnabled(root, true);
writeContract(root);
writeFileSync(join(root, "package.json"), `${JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", typecheck: "node -e \"process.exit(0)\"", build: "node -e \"process.exit(0)\"" } }, null, 2)}\n`);
writeFileSync(join(root, ".gitignore"), "review.md\n");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n");
writeFileSync(join(root, ".pi/plans/e2e.md"), [
  "# E2E plan",
  "- [x] baseline ready OK_TO_MARK_DONE",
  "- [ ] ship watched change",
  "- [ ] prepare commit evidence",
  "",
].join("\n"));
git(["add", "."], root);
git(["commit", "-m", "baseline"], root);


const initialProgress = await tool("workflow_progress").execute("progress", { cwd: root, planPath: ".pi/plans/e2e.md" }) as { details: { currentSlice?: string; counts: { open?: number; completed?: number; total?: number } } };
assert(initialProgress.details.currentSlice === "ship watched change", "progress should identify the first open slice");
assert(initialProgress.details.counts.open === 2 && initialProgress.details.counts.completed === 1 && initialProgress.details.counts.total === 3, "progress should count plan tasks");

writeFileSync(join(root, "src/app.ts"), "export const value = 2;\n");

const beforeEvidence = await toolCallGuard(root, "git commit -m e2e");
assert(beforeEvidence?.block === true, "commit should be blocked before trusted review and gate evidence");
assert(beforeEvidence.reason?.includes("missing current trusted review verdict"), `commit blocker should explain missing trusted review evidence, got: ${beforeEvidence.reason ?? "none"}`);

const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: ["src/app.ts"], mode: "commit" }) as { content: Array<{ text: string }>; details: { requestError?: string; request?: { id: string; repo: string; diffHash: string; expectedFiles: string[]; allowedVerdicts: string[] } } };
assert(!packet.details.requestError && packet.details.request, `review packet should create request: ${packet.details.requestError ?? ""}`);
const request = packet.details.request;
const reviewedEvidence = {
  schema: "pi-workflow-review-evidence/v1",
  reviewRequestId: request.id,
  repo: request.repo,
  reviewedDiffHash: request.diffHash,
  reviewedAt: new Date().toISOString(),
  reviewedFiles: request.expectedFiles,
  reviewer: { role: "reviewer", name: "e2e", source: "test" },
  verdict: request.allowedVerdicts[0],
  criteria: [{ id: "e2e", status: "satisfied", evidence: "reviewed current diff" }],
  verification: [],
  residualRisks: [],
};
mkdirSync(join(root, ".pi/runs"), { recursive: true });
writeFileSync(join(root, ".pi/runs/workflow-review-evidence-e2e.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(reviewedEvidence)}\n\`\`\`\n`);
const importResult = await tool("workflow_import_review_evidence").execute("accept", {
  cwd: root,
  artifactPath: ".pi/runs/workflow-review-evidence-e2e.md",
}) as { details: { accepted: boolean; error?: string } };
assert(importResult.details.accepted === true, `trusted review evidence should import for current diff: ${importResult.details.error ?? ""}`);

messages.length = 0;
await commands.workflow.handler("gate beforeCommit", { cwd: root });
assert(messages[0]?.content.includes("gate beforeCommit: PASS"), "slash beforeCommit gate should pass and persist evidence");

const evidence = await tool("workflow_export_evidence").execute("bundle", { cwd: root, planPath: ".pi/plans/e2e.md" }) as { details: { commitReady: boolean; bundlePath: string; evidencePath: string; missing: string[] } };
assert(evidence.details.commitReady === true, `evidence bundle should be commit-ready, missing=${evidence.details.missing.join(",")}`);
assert(existsSync(evidence.details.bundlePath), "evidence bundle should be written under runs dir");
assert(evidence.details.evidencePath.endsWith("workflow-state.json"), "evidencePath should point at persisted workflow state, not duplicate bundlePath");
const bundle = readFileSync(evidence.details.bundlePath, "utf8");
assert(bundle.includes("# Workflow Evidence Bundle") && bundle.includes("ship watched change"), "bundle should include plan/slice context");

const afterEvidence = await toolCallGuard(root, "git commit -m e2e");
assert(afterEvidence?.block !== true, `commit should be allowed after trusted review + beforeCommit gate: ${afterEvidence?.reason ?? "no reason"}`);

messages.length = 0;
await commands.workflow.handler("progress .pi/plans/e2e.md", { cwd: root });
await commands.workflow.handler("bundle .pi/plans/e2e.md", { cwd: root });
assert(messages.some((message) => message.content.includes("# Workflow progress")), "/workflow progress should render operator progress output");
assert(messages.some((message) => message.content.includes("Evidence bundle:")), "/workflow bundle should render bundle output");

console.log(`e2e root=${root} bundle=${evidence.details.bundlePath}`);
