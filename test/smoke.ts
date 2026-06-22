import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import workflowWatcher from "../index.ts";
import { setWorkflowWatcherEnabled } from "../src/toggle.ts";
import { consumeReviewRequest, loadReviewRequest, parseReviewEvidenceFence, REVIEWER_ATTESTATION, reviewFilesMatch, validateReviewCriteria, validateReviewerProvenance, validateReviewEvidenceForRequest, writeReviewRequest } from "../src/review-evidence.ts";
import { readContract } from "../src/contract.ts";
import { diffSnapshot, runtimeArtifactExcludes } from "../src/state.ts";
import type { ReviewEvidence, ReviewRequest } from "../src/types.ts";

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
type Hook = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown;
type Command = { description?: string; getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }>; handler: (args: string, ctx: { cwd: string; hasUI?: boolean; ui?: { setStatus?: (key: string, value: string | undefined) => void; setWidget?: (key: string, lines: string[] | undefined, options?: unknown) => void; theme?: { fg: (_color: string, text: string) => string } } }) => Promise<void> };

const tools: Tool[] = [];
const commands: Record<string, Command> = {};
const messages: Array<{ content: string; details?: unknown }> = [];
const userMessages: unknown[] = [];
const statuses: Record<string, string> = {};
const widgets: Record<string, string[]> = {};
const ui = {
  theme: { fg: (_color: string, text: string) => text },
  setStatus(key: string, value: string | undefined) { if (value === undefined) delete statuses[key]; else statuses[key] = value; },
  setWidget(key: string, lines: string[] | undefined) { if (lines === undefined) delete widgets[key]; else widgets[key] = lines; },
};
const hooks: Record<string, Hook[]> = {};
const fakePi = {
  registerTool(tool: Tool) {
    tools.push(tool);
  },
  registerCommand(name: string, command: Command) {
    commands[name] = command;
  },
  sendMessage(message: { content: string; details?: unknown }) {
    messages.push(message);
  },
  sendUserMessage(message: unknown) {
    userMessages.push(message);
  },
  on(event: string, handler: Hook) {
    hooks[event] ??= [];
    hooks[event].push(handler);
  },
};

workflowWatcher(fakePi as never);

function tool(name: string): Tool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function fixtureDiffHash(root: string): string {
  const contract = readContract(root).contract;
  return diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, contract) }).diffHash;
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-watcher-"));
  git(["init"], root);
  git(["config", "user.email", "watcher@example.invalid"], root);
  git(["config", "user.name", "Workflow Watcher"], root);
  return root;
}

function enableWatcher(root: string): void {
  setWorkflowWatcherEnabled(root, true);
}

function validContract(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: { name: "fixture", kind: "package", root: ".", packageManager: "pnpm", primaryLanguages: ["typescript"] },
    commands: {
      test: { cmd: "pnpm test", source: "package.json:scripts.test", confidence: "verified" },
      typecheck: { cmd: "pnpm run typecheck", source: "package.json:scripts.typecheck", confidence: "verified" },
      build: { cmd: "pnpm run build", source: "package.json:scripts.build", confidence: "verified" },
      testFocused: { cmd: null, source: "absent", confidence: "absent" },
    },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused slice checks", commands: ["testFocused"], required: false },
      beforeCommit: { description: "Pre-commit checks", commands: ["typecheck", "test"], required: true },
      final: { description: "Final checks", commands: ["build", "test"], required: true },
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
    ownership: { highRiskPaths: [], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] },
    ...overrides,
  };
}

function writeContract(root: string, contract: unknown) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/workflows.json"), `${JSON.stringify(contract, null, 2)}\n`);
}

async function watch(root: string, mode = "status", extra: Record<string, unknown> = {}) {
  return await tool("workflow_watch").execute("test", { cwd: root, mode, ...extra }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readStateFile(root: string, runsDir = ".pi/runs") {
  return JSON.parse(readFileSync(join(root, runsDir, "workflow-state.json"), "utf8"));
}

function readLedger(root: string, runsDir = ".pi/runs"): Array<Record<string, unknown>> {
  return readFileSync(join(root, runsDir, "workflow-watcher.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function reviewRequestFixture(root: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    schema: "pi-workflow-review-request/v1",
    id: "rw-smoke",
    createdAt: "2026-06-19T00:00:00.000Z",
    repo: root,
    diffHash: "diff-smoke",
    expectedFiles: ["src/app.ts", "README.md"],
    mode: "commit",
    allowedVerdicts: ["OK_TO_COMMIT"],
    status: "pending",
    consumedAt: null,
    ...overrides,
  };
}

function reviewerArtifact(root: string, runId = "smoke-run-1"): string {
  const dir = join(root, "..", "subagent-artifacts");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}_output.md`);
}
function reviewEvidenceFixture(root: string, overrides: Partial<ReviewEvidence> = {}): ReviewEvidence {
  const artifactPath = reviewerArtifact(root);
  const evidence = {
    schema: "pi-workflow-review-evidence/v1",
    reviewRequestId: "rw-smoke",
    repo: root,
    reviewedDiffHash: "diff-smoke",
    reviewedAt: "2026-06-19T00:00:00.000Z",
    reviewedFiles: ["README.md", "src/app.ts"],
    reviewer: { role: "reviewer", name: "smoke", source: "pi-subagents", runId: "smoke-run-1", artifactPath, attestation: REVIEWER_ATTESTATION },
    verdict: "OK_TO_COMMIT",
    criteria: [{ id: "scope", status: "satisfied", evidence: "reviewed expected files" }],
    verification: [],
    residualRisks: [],
    ...overrides,
  } as ReviewEvidence;
  writeFileSync(artifactPath, `pi-subagents reviewer run smoke-run-1\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`, "utf8");
  return evidence;
}

function commitBaselineWithReviewArtifactIgnored(root: string): void {
  writeFileSync(join(root, ".gitignore"), "review.md\n");
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".gitignore", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
}

function writeReviewEvidenceArtifact(root: string, evidence: ReviewEvidence, bodyPrefix = "Review clean.\n\n"): void {
  writeFileSync(join(root, "review.md"), `${bodyPrefix}\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
}

async function importReviewEvidenceArtifact(root: string): Promise<{ details: { accepted: boolean; source?: string; diffHash?: string; error?: string } }> {
  return await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: "review.md" }) as { details: { accepted: boolean; source?: string; diffHash?: string; error?: string } };
}

function markLastReviewTrusted(root: string, source: "reviewer_evidence" = "reviewer_evidence") {
  const path = join(root, ".pi/runs/workflow-state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (!state.lastReviewVerdict) throw new Error("missing review verdict to mark trusted");
  state.lastReviewVerdict.source = source;
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

for (const name of ["workflow_watch", "workflow_next", "workflow_init", "workflow_approve_dirty_overlap", "workflow_gate", "workflow_progress", "workflow_complete", "workflow_export_evidence", "workflow_note", "workflow_import_review_evidence", "workflow_review_packet", "workflow_why"]) tool(name);
assert(!tools.some((candidate) => candidate.name === "workflow_import_acceptance"), "workflow_import_acceptance must not be registered");
assert(commands.workflow, "workflow slash command not registered");
assert(!commands["shape-plan"], "shape-plan should not be registered as a top-level slash command");
assert(!commands["new-plan"], "new-plan should not be registered as a top-level slash command");
assert(commands.workflow.description?.includes("help"), "workflow slash command description should mention help");
const workflowCompletions = commands.workflow.getArgumentCompletions?.("h") as Array<{ value?: string }> | undefined;
assert(workflowCompletions?.some((item) => item.value === "help"), "workflow slash command completions should include help");
const bundleCompletions = commands.workflow.getArgumentCompletions?.("b") as Array<{ value?: string }> | undefined;
assert(bundleCompletions?.some((item) => item.value === "bundle"), "workflow slash command completions should include bundle");
const progressCompletions = commands.workflow.getArgumentCompletions?.("p") as Array<{ value?: string }> | undefined;
assert(progressCompletions?.some((item) => item.value === "progress"), "workflow slash command completions should include progress");
const toggleCompletions = commands.workflow.getArgumentCompletions?.("t") as Array<{ value?: string }> | undefined;
assert(toggleCompletions?.some((item) => item.value === "toggle"), "workflow slash command completions should include toggle");
const shapePlanCompletions = commands.workflow.getArgumentCompletions?.("s") as Array<{ value?: string }> | undefined;
assert(shapePlanCompletions?.some((item) => item.value === "shape-plan"), "workflow slash command completions should include shape-plan");
const newPlanCompletions = commands.workflow.getArgumentCompletions?.("n") as Array<{ value?: string }> | undefined;
assert(newPlanCompletions?.some((item) => item.value === "new-plan"), "workflow slash command completions should include new-plan");
assert(hooks.tool_call?.length, "tool_call hook not registered");
assert(hooks.before_agent_start?.length, "before_agent_start hook not registered");
assert(hooks.session_start?.length, "session_start UI hook not registered");
assert(hooks.turn_end?.length, "turn_end UI hook not registered");

{
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert(readme.includes("Manual notes are recorded context, not trusted approval."), "README should document manual-note trust boundary");
  assert(readme.toLowerCase().includes("timeout"), "README should document gate timeout behavior");
  assert(readme.includes("Trusted evidence sources"), "README should document trusted evidence sources");
  assert(readme.includes("beforeCommit") && readme.includes("final"), "README should document required beforeCommit/final gate authorization");
  assert(readme.includes("artifacts.runsDir") && readme.includes("safe fallback"), "README should document safe runsDir fallback");
  assert(readme.includes("/workflow doctor") && readme.includes("without running gates or tests"), "README should document workflow doctor");
  assert(readme.includes("## Daily recipes"), "README should include daily recipes");
  assert(readme.includes("Starting work in a repo") && readme.includes("Before commit"), "README should include start/before-commit recipes");
  assert(readme.includes("Dirty files are blocking edits"), "README should include dirty-files blocking recipe");
  assert(readme.includes("Reviewer accepted but commit is still blocked"), "README should include reviewer accepted/commit blocked recipe");
  assert(readme.includes("Gate timed out"), "README should include gate timeout recipe");
  assert(readme.includes("Manual notes vs trusted evidence"), "README should include manual-vs-trusted recipe");
  assert(readme.includes("/workflow help"), "README should mention workflow help");
  assert(readme.includes("/workflow toggle"), "README should document watcher toggle");
  assert(readme.includes("prompts/shape-plan.md") && readme.includes("/workflow shape-plan <goal>") && readme.includes("/workflow new-plan <goal>") && !readme.includes("/shape-plan <goal>"), "README should document only workflow namespaced plan commands");
  assert(!readme.includes("cp ~/.pi/agent/git/github.com/Nabsku/pi-workflow-watcher/prompts/shape-plan.md ~/.pi/agent/prompts/shape-plan.md"), "README should not require copying shape-plan into private prompt templates");
  assert(readme.includes("Ownership paths fail closed"), "README should document ownership path fail-closed behavior");
  assert(readme.includes("JSONL ledger") && readme.includes("redacts"), "README should document JSONL ledger privacy/sanitization");
  assert(readme.includes("Schema and examples") && readme.includes("Release readiness checklist"), "README should document schema/examples and release readiness");
  assert(readme.includes("## Installation") && readme.includes("Compatible Pi version"), "README should document installation and compatible Pi version");
  assert(readme.includes("workflow_export_evidence") && readme.includes("/workflow bundle"), "README should document evidence bundle export");
  assert(readme.includes("workflow_progress") && readme.includes("/workflow progress"), "README should document progress summary");
  assert(readme.includes("Troubleshooting matrix") && readme.includes("canonical schema"), "README should document troubleshooting and canonical schema caveat");
}

{
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert(pkg.files?.includes("prompts/"), "package files should include public prompt starters");
  assert(pkg.peerDependencies?.["pi-subagents"] === "^0.27.0", "package should declare pi-subagents as the public subagent dependency");
  assert(pkg.devDependencies?.["pi-subagents"] === "^0.27.0", "package should install pi-subagents in dev for dependency verification");
  const prompt = readFileSync(new URL("../prompts/shape-plan.md", import.meta.url), "utf8");
  assert(prompt.includes("description: Shape a rough idea into a workflow-ready implementation plan"), "shape-plan starter should have public frontmatter");
  assert(prompt.includes("If a `grill-me` skill or equivalent questioning workflow is available"), "shape-plan starter should make grill-me conditional");
  assert(!prompt.includes("Yannick"), "shape-plan starter must not mention private user context");
  assert(!prompt.includes("openai-codex/gpt-5.5"), "shape-plan starter should not pin a private/default model");
  assert(!prompt.includes("~/.agents") && !prompt.includes("~/.pi/agent/prompts"), "shape-plan starter should not depend on private local paths");
  assert(prompt.includes("workflow_init") && prompt.includes("workflow_note") && prompt.includes("workflow_progress"), "shape-plan starter should integrate with public workflow tools");
  assert(prompt.includes("Subagents are mandatory for non-trivial plans"), "shape-plan starter should require subagents for non-trivial plans");
  assert(prompt.includes("Required roles: `scout`, `reviewer`, and `oracle`"), "shape-plan starter should name mandatory subagent roles");
  assert(prompt.includes("Requires the public `pi-subagents` extension"), "shape-plan starter should reference the actual public subagent dependency");
  assert(prompt.includes("If `pi-subagents` is unavailable, stop after repo inspection"), "shape-plan starter should stop instead of silently degrading without pi-subagents");
  assert(prompt.includes("Mandatory workflow steps"), "shape-plan starter should make the core workflow steps mandatory");
}

{
  const root = repo();
  writeContract(root, validContract());
  const evidence = reviewEvidenceFixture(root);
  const parsed = parseReviewEvidenceFence(`review complete\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\``);
  assert(parsed.ok === true && parsed.evidence.reviewRequestId === "rw-smoke", "workflow-review-evidence fence should parse valid v1 JSON");
  const crlfParsed = parseReviewEvidenceFence(`review complete\r\n\r\n\`\`\`workflow-review-evidence\r\n${JSON.stringify(evidence)}\r\n\`\`\``);
  assert(crlfParsed.ok === true, "workflow-review-evidence fence should parse CRLF Markdown");
  assert(parseReviewEvidenceFence("review complete OK_TO_COMMIT").ok === false, "prose-only review evidence must reject");
  const malformed = parseReviewEvidenceFence("```workflow-review-evidence\n{bad json}\n```");
  assert(malformed.ok === false && malformed.error.includes("malformed"), "malformed review evidence JSON should be actionable");
  const unknownSchema = parseReviewEvidenceFence(`\`\`\`workflow-review-evidence\n${JSON.stringify({ ...evidence, schema: "unknown" })}\n\`\`\``);
  assert(unknownSchema.ok === false && unknownSchema.error.includes("expected pi-workflow-review-evidence/v1"), "unknown review evidence schema should reject");
  const duplicate = parseReviewEvidenceFence(`\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\``);
  assert(duplicate.ok === false && duplicate.error.includes("exactly one"), "duplicate review evidence fences should reject");
}

{
  const root = repo();
  writeContract(root, validContract());
  const request = reviewRequestFixture(root);
  const requestPath = writeReviewRequest(root, request);
  assert(requestPath.endsWith(".pi/runs/review-requests/rw-smoke.json"), "review request should be stored under runsDir review-requests");
  const loaded = loadReviewRequest(root, "rw-smoke");
  assert(loaded.request?.id === "rw-smoke", "pending review request should load");
  const consumed = consumeReviewRequest(root, request, "2026-06-19T00:01:00.000Z");
  assert(consumed.request.status === "consumed" && consumed.request.consumedAt, "consumeReviewRequest should mark request consumed");
  const reloaded = loadReviewRequest(root, "rw-smoke");
  assert(reloaded.error?.includes("not pending"), "consumed review request should not load as pending");
  assert(loadReviewRequest(root, "../escape").error?.includes("only letters"), "review request id should reject path escape characters");
}

{
  const root = repo();
  writeContract(root, validContract());
  const request = reviewRequestFixture(root);
  const evidence = reviewEvidenceFixture(root);
  const valid = validateReviewEvidenceForRequest(root, evidence, request);
  assert(valid.ok === true && valid.reviewedFiles?.join(",") === "README.md,src/app.ts", "review evidence should validate against matching pending request");
  assert(reviewFilesMatch(root, ["src/app.ts", "README.md"], ["README.md", "src/app.ts"]).ok === true, "reviewed files should match independent of order");
  assert(reviewFilesMatch(root, ["../outside"], ["README.md"]).error?.includes("escapes repo"), "reviewed files should reject repo escape");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, repo: join(root, "other") }, request).error?.includes("repo"), "repo mismatch should reject");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, reviewedDiffHash: "other" }, request).error?.includes("diffHash"), "diff hash mismatch should reject");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, verdict: "OK_TO_MARK_DONE" }, request).error?.includes("not allowed"), "commit-mode request should reject non-commit verdicts");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, reviewedFiles: ["README.md"] }, request).error?.includes("reviewedFiles"), "reviewed files mismatch should reject");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, verdict: "OK_TO_PRESENT" }, request).error?.includes("not allowed"), "verdict outside request mode should reject");
  assert(validateReviewCriteria([]).error?.includes("non-empty"), "empty criteria should reject");
  assert(validateReviewerProvenance(undefined).error?.includes("provenance"), "reviewer provenance should be required");
  assert(validateReviewEvidenceForRequest(root, { ...evidence, reviewer: { role: "reviewer", name: "smoke", source: "manual" } }, request).error?.includes("pi-subagents"), "manual/self-authored reviewer provenance should reject");
  assert(validateReviewCriteria([{ id: "optional", required: false, status: "unsatisfied" }]).ok === true, "optional unsatisfied criteria should not block");
  assert(validateReviewCriteria([{ id: "required", status: "unsatisfied" }]).error?.includes("required criterion required"), "required unsatisfied criteria should reject");
}

{
  const schema = JSON.parse(readFileSync(new URL("../schemas/pi-workflows.schema.json", import.meta.url), "utf8"));
  assert(schema.$schema === "https://json-schema.org/draft-07/schema#", "workflow schema should be draft-07 JSON Schema");
  assert(schema.$id?.includes("pi-workflow-watcher"), "workflow schema should have a publishable package URL id");
  assert(schema.properties?.version?.const === 1, "workflow schema should pin version 1");
  assert(schema.properties?.gates?.required?.includes("beforeCommit"), "workflow schema should require beforeCommit gate");
  assert(schema.properties?.gates?.required?.includes("final"), "workflow schema should require final gate");

  for (const name of ["workflows.node.json", "workflows.python.json"]) {
    const example = JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));
    assert(example.$schema === "../schemas/pi-workflows.schema.json", `${name} should point at package-local schema`);
    const root = repo();
    writeContract(root, example);
    const result = await watch(root, "status");
    assert(!String(result.content[0].text).includes("Invalid workflow contract schema"), `${name} should pass runtime schema checks`);
    assert(!String(result.content[0].text).includes("Gate references unknown command"), `${name} should not reference unknown commands`);
  }
}

{
  const root = repo();
  messages.length = 0;
  await commands.workflow.handler("help", { cwd: root });
  const content = messages[0]?.content ?? "";
  assert(content.includes("# Workflow help"), "/workflow help should send help output");
  for (const name of ["status", "next", "progress", "doctor", "evidence", "why", "review-prompt", "bundle", "dirty", "note", "gate", "plan", "shape-plan", "new-plan", "help"]) {
    assert(content.includes(`/workflow ${name}`), `/workflow help should list ${name}`);
  }
  assert(content.includes("Examples:"), "/workflow help should include examples");
  assert(content.includes("/workflow gate beforeCommit --dry-run"), "/workflow help should include gate dry-run example");
  assert(content.includes("/workflow shape-plan Add GitHub issue triage automation"), "/workflow help should include shape-plan example");
  assert(content.includes("/workflow new-plan Add GitHub issue triage automation"), "/workflow help should include new-plan example");
  assert(content.includes("Trusted evidence warning"), "/workflow help should include trusted evidence warning");
  assert(content.includes("Manual notes are recorded context, not trusted approval."), "/workflow help should warn manual notes do not unlock commits");
}

{
  userMessages.length = 0;
  messages.length = 0;
  await commands.workflow.handler("shape-plan Add GitHub issue triage automation", { cwd: repo() });
  const sent = String(userMessages[0] ?? "");
  assert(sent.includes("Turn the user's rough request into an executable implementation plan"), "/workflow shape-plan should send the embedded shape-plan instructions as a user message");
  assert(sent.includes("Requests: Add GitHub issue triage automation"), "/workflow shape-plan should include the requested goal");
  assert(sent.includes("Subagents are mandatory for non-trivial plans"), "/workflow shape-plan should preserve mandatory subagent guidance");

  userMessages.length = 0;
  await commands.workflow.handler("new-plan Add GitHub issue triage automation", { cwd: repo() });
  assert(String(userMessages[0] ?? "").includes("Requests: Add GitHub issue triage automation"), "/workflow new-plan should delegate to the same built-in prompt");

  userMessages.length = 0;
  messages.length = 0;
  await commands.workflow.handler("shape-plan", { cwd: repo() });
  assert(userMessages.length === 0, "/workflow shape-plan without a goal should not send a user message");
  assert(messages[0]?.content.includes("usage: /workflow shape-plan <goal>"), "/workflow shape-plan without a goal should show namespaced usage");

  userMessages.length = 0;
  messages.length = 0;
  await commands.workflow.handler("new-plan", { cwd: repo() });
  assert(userMessages.length === 0, "/workflow new-plan without a goal should not send a user message");
  assert(messages[0]?.content.includes("alias: /workflow new-plan <goal>"), "/workflow new-plan without a goal should show namespaced alias usage");
}

{
  const root = repo();
  writeContract(root, validContract());
  statuses["workflow-watcher"] = "WF stale";
  widgets["workflow-watcher"] = ["stale widget"];
  await hooks.session_start[0]({ cwd: root }, { cwd: root, hasUI: true, ui } as never);
  assert(!("workflow-watcher" in statuses), "default-off session_start should clear stale status line");
  assert(!("workflow-watcher" in widgets), "default-off session_start should clear stale widget");
  const beforeStart = await hooks.before_agent_start[0]({ cwd: root });
  assert(beforeStart === undefined, "default-off workflow watcher should not inject before-agent nudges");
  const toolGuard = await hooks.tool_call[0]({ cwd: root, toolName: "terminal", args: { command: "git commit -m nope" } });
  assert(toolGuard === undefined, "default-off workflow watcher should not block tool calls");
  messages.length = 0;
  await commands.workflow.handler("toggle", { cwd: root, hasUI: true, ui });
  assert(messages[0]?.content.includes("workflow watcher: on"), "/workflow toggle with no args should enable from default off");
}

{
  const root = repo();
  writeContract(root, validContract());
  statuses["workflow-watcher"] = "WF stale";
  widgets["workflow-watcher"] = ["stale widget"];
  messages.length = 0;
  await commands.workflow.handler("toggle off", { cwd: root, hasUI: true, ui });
  assert(messages[0]?.content.includes("workflow watcher: off"), "/workflow toggle off should report disabled state");
  assert(!("workflow-watcher" in statuses), "/workflow toggle off should remove the status line instead of showing WF off");
  assert(!("workflow-watcher" in widgets), "/workflow toggle off should remove the workflow widget");
  statuses["workflow-watcher"] = "WF stale";
  widgets["workflow-watcher"] = ["stale widget"];
  await hooks.session_start[0]({ cwd: root }, { cwd: root, hasUI: true, ui } as never);
  assert(!("workflow-watcher" in statuses), "disabled session_start should clear stale status line");
  assert(!("workflow-watcher" in widgets), "disabled session_start should clear stale widget");
  const beforeStart = await hooks.before_agent_start[0]({ cwd: root });
  assert(beforeStart === undefined, "disabled workflow watcher should not inject before-agent nudges");
  const beforeStartFromContext = await hooks.before_agent_start[0]({}, { cwd: root } as never);
  assert(beforeStartFromContext === undefined, "disabled workflow watcher should honor hook context cwd when event cwd is missing");
  const toolGuard = await hooks.tool_call[0]({ cwd: root, toolName: "terminal", args: { command: "git commit -m nope" } });
  assert(toolGuard === undefined, "disabled workflow watcher should not block tool calls");
  const toolGuardFromContext = await hooks.tool_call[0]({ toolName: "terminal", args: { command: "git commit -m nope" } }, { cwd: root } as never);
  assert(toolGuardFromContext === undefined, "disabled workflow watcher should not block tool calls when only hook context has cwd");
  messages.length = 0;
  await commands.workflow.handler("toggle on", { cwd: root, hasUI: true, ui });
  assert(messages[0]?.content.includes("workflow watcher: on"), "/workflow toggle on should report enabled state");
}

{
  const root = repo();
  writeContract(root, validContract({ ownership: { highRiskPaths: ["src/secure/**"], generatedPaths: ["src/generated/**"], lockfiles: ["pnpm-lock.yaml"] } }));
  mkdirSync(join(root, "src/secure/nested"), { recursive: true });
  writeFileSync(join(root, "src/secure/.gitkeep"), "");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, "src/secure/auth.ts"), "export const changed = true;\n");
  writeFileSync(join(root, "src/secure/nested/auth.ts"), "export const nested = true;\n");
  const reviewFiles = ["src/secure/auth.ts", "src/secure/nested/auth.ts"];
  const missingFilesPacket = await tool("workflow_review_packet").execute("packet", { cwd: root }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(missingFilesPacket.details.requestError, "review packet should require explicit files for trusted requests");
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: reviewFiles, mode: "commit" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(packet.content[0].text.includes("# Workflow review packet"), "review packet should render a reviewer packet");
  assert(packet.content[0].text.includes("Do not launch subagents"), "review packet should not launch subagents");
  assert(packet.content[0].text.includes("src/secure/auth.ts"), "review packet should list touched files");
  assert(packet.content[0].text.includes("current diffHash"), "review packet should include diff hash");
  assert(packet.content[0].text.includes("reviewRequestId"), "review packet should include workflow-review-evidence template request id");
  assert(!packet.content[0].text.includes("```workflow-review-evidence"), "review packet must not emit directly importable review evidence");
  assert(packet.content[0].text.includes("```json"), "review packet should render non-importable evidence draft JSON");
  assert(packet.content[0].text.includes("OK_TO_COMMIT"), "commit-mode review packet should allow only commit verdict");
  assert(packet.content[0].text.includes("Manual notes are recorded context, not trusted approval."), "review packet should include manual note trust phrase");
  assert((packet.details.request as { id?: string } | undefined)?.id, "review packet should persist request details");
  assert((packet.details.request as { expectedFiles?: string[] } | undefined)?.expectedFiles?.length === 2, "review packet should bind expected files");
  const cleanExtraPacket = await tool("workflow_review_packet").execute("packet", { cwd: root, files: [...reviewFiles, "README.md"], mode: "commit" }) as { details: { requestError?: string; request?: unknown } };
  assert(cleanExtraPacket.details.requestError?.includes("not in current diff") && !cleanExtraPacket.details.request, "review packet should reject clean extra files that import scope cannot consume");
  assert((packet.details.ownership as { highRisk?: string[] }).highRisk?.includes("src/secure/auth.ts"), "review packet details should include ownership notes");
  assert((packet.details.ownership as { highRisk?: string[] }).highRisk?.includes("src/secure/nested/auth.ts"), "review packet should match recursive ** ownership patterns");
  assert(packet.content[0].text.includes("## Architecture checklist"), "review packet should include architecture checklist");
  assert(packet.content[0].text.includes("contracts/API boundaries"), "architecture checklist should prompt API boundary review");
  messages.length = 0;
  await commands.workflow.handler("review-prompt --mode commit src/secure/auth.ts src/secure/nested/auth.ts", { cwd: root });
  assert(messages[0]?.content.includes("# Workflow review packet") && messages[0]?.content.includes("reviewRequestId"), "/workflow review-prompt should send packet with request");
  messages.length = 0;
  await commands.workflow.handler("review-prompt src/secure/auth.ts src/secure/nested/auth.ts", { cwd: root });
  assert(messages[0]?.content.includes("# Workflow review packet") && messages[0]?.content.includes("src/secure/auth.ts"), "/workflow review-prompt default mode should preserve first file");
  messages.length = 0;
  await commands.workflow.handler("review-prompt", { cwd: root });
  assert(messages[0]?.content.includes("# Workflow review packet") && messages[0]?.content.includes("src/secure/auth.ts") && messages[0]?.content.includes("not created: files must explicitly list the review scope"), "/workflow review-prompt without files should still render packet guidance");
  messages.length = 0;
  await commands.workflow.handler("why commit", { cwd: root });
  assert(messages[0]?.content.includes("# Workflow why") && messages[0]?.content.includes("trusted reviewer/oracle evidence"), "/workflow why commit should explain missing commit evidence");
  const whyEdit = await tool("workflow_why").execute("why", { cwd: root, target: "edit", path: "src/secure/auth.ts" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(whyEdit.content[0].text.includes("source: edit guard"), "workflow_why edit should explain edit guard source");
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "src", agentInstructions: "AGENTS.md" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, "src/app.ts"), "export const value = 2;\n");
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: ["src/app.ts"] }) as { details: { touchedFiles: string[]; excludedFiles?: string[]; request?: { id?: string } } };
  assert(packet.details.touchedFiles.includes("src/app.ts"), "broad runsDir must not exclude source files from review scope");
  assert(!packet.details.excludedFiles?.includes("src/app.ts"), "source file should not be reported as runtime artifact");
  assert(packet.details.request?.id, "source review request should still be created with broad runsDir config");
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "src", agentInstructions: "AGENTS.md" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, "src/app.ts"), "export const value = 2;\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["src/app.ts"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["src/app.ts"] });
  writeFileSync(join(root, "src/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: "src/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === false && result.details.error?.includes("current review scope"), "broad runsDir artifact path should not hide extra dirty source files");
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "runs", agentInstructions: "AGENTS.md" } }));
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  mkdirSync(join(root, "runs"), { recursive: true });
  writeFileSync(join(root, "runs/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: "runs/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === true, `configured dedicated runsDir artifact should be excluded during import: ${result.details.error ?? ""}`);
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "custom", agentInstructions: "AGENTS.md" } }));
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: ["file.txt"] }) as { details: { request?: { id: string; diffHash: string; expectedFiles: string[] }; requestError?: string } };
  assert(packet.details.request && !packet.details.requestError, "custom runsDir review request should be created");
  const evidence = reviewEvidenceFixture(root, { reviewRequestId: packet.details.request.id, reviewedDiffHash: packet.details.request.diffHash, reviewedFiles: packet.details.request.expectedFiles });
  mkdirSync(join(root, "custom"), { recursive: true });
  writeFileSync(join(root, "custom/workflow-review-evidence-smoke.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: "custom/workflow-review-evidence-smoke.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === true, `custom runsDir watcher-owned artifacts should be excluded without hiding whole tree: ${result.details.error ?? ""}`);
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  mkdirSync(join(root, ".pi/runs"), { recursive: true });
  git(["mv", "src/app.ts", ".pi/runs/app.ts"], root);
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: ["src/app.ts"] }) as { details: { touchedFiles: string[]; request?: { diffHash: string; expectedFiles: string[] }; requestError?: string } };
  assert(packet.details.touchedFiles.includes("src/app.ts"), "rename into excluded runtime dir should keep source path in review scope");
  assert(packet.details.request && !packet.details.requestError, "rename into excluded runtime dir should allow review request for source path");
  const evidence = reviewEvidenceFixture(root, { reviewRequestId: (packet.details.request as { id?: string }).id, reviewedDiffHash: packet.details.request.diffHash, reviewedFiles: packet.details.request.expectedFiles });
  writeFileSync(join(root, ".pi/runs/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: ".pi/runs/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === true, `rename into runtime dir should import for reviewed source scope: ${result.details.error ?? ""}`);
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, "src/secure"), { recursive: true });
  writeFileSync(join(root, "src/secure/old.ts"), "export const value = 1;\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  mkdirSync(join(root, "src/public"), { recursive: true });
  git(["mv", "src/secure/old.ts", "src/public/new.ts"], root);
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: ["src/public/new.ts"] }) as { details: { touchedFiles: string[]; requestError?: string } };
  assert(packet.details.touchedFiles.includes("src/secure/old.ts") && packet.details.touchedFiles.includes("src/public/new.ts"), "rename review scope should include source and destination paths");
  assert(packet.details.requestError?.includes("outside expected files"), "rename source path should require explicit review scope coverage");
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: ".pi", agentInstructions: "AGENTS.md" } }));
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/plans/plan.md"), "# Plan\n- [ ] task\n");
  git(["add", "."], root);
  git(["commit", "-m", "baseline"], root);
  writeFileSync(join(root, ".pi/plans/plan.md"), "# Plan\n- [x] task\n");
  const packet = await tool("workflow_review_packet").execute("packet", { cwd: root, files: [".pi/plans/plan.md"] }) as { details: { touchedFiles: string[]; excludedFiles?: string[]; request?: { id?: string } } };
  assert(packet.details.touchedFiles.includes(".pi/plans/plan.md"), "broad .pi runsDir must not exclude plan files from review scope");
  assert(!packet.details.excludedFiles?.includes(".pi/plans/plan.md"), "plan file should not be reported as runtime artifact");
  assert(packet.details.request?.id, "plan review request should still be created with broad .pi runsDir config");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, ".gitignore"), "scratch/ignored.log\n");
  git(["add", ".pi/workflows.json", ".gitignore"], root);
  git(["commit", "-m", "baseline"], root);
  mkdirSync(join(root, "scratch"), { recursive: true });
  writeFileSync(join(root, "scratch/ignored.log"), "ignored\n");
  writeFileSync(join(root, "scratch/keep.txt"), "keep\n");
  const snap = diffSnapshot(root, { excludePaths: runtimeArtifactExcludes(root, readContract(root).contract) });
  assert(snap.dirtyFiles.includes("?? scratch/keep.txt"), "untracked directory expansion should include non-ignored files");
  assert(!snap.dirtyFiles.includes("?? scratch/ignored.log"), "untracked directory expansion must honor gitignore");
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/plans/lessons.md"), [
    "# Lessons plan",
    "- [ ] Implement everything across backend, frontend, docs, tests, and deployment",
    "",
    "## Acceptance Criteria",
    "- User can export a reviewed handoff bundle",
    "",
    "## Test Plan",
    "- pnpm test",
    "- pnpm run typecheck",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src.ts"), "export const changed = true;\n");
  const status = await watch(root, "status", { planPath: ".pi/plans/lessons.md" });
  assert(status.content[0].text.includes("acceptance criteria: present"), "status should surface spec/acceptance/test-plan detection");
  assert(status.content[0].text.includes("test plan: present"), "status should surface test-plan detection");
  assert(status.content[0].text.includes("Narrow active slice"), "status should nudge broad/vague active slices toward a vertical slice");
  const next = await tool("workflow_next").execute("next", { cwd: root, planPath: ".pi/plans/lessons.md" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(next.content[0].text.includes("Narrow active slice"), "workflow_next should prioritize vertical-slice nudge for broad/vague slices");
  assert((next.details.workflowLessons as { activeSliceNudge?: string }).activeSliceNudge?.includes("vertical slice"), "workflow_next details should include optional workflow lesson details");
  const progress = await tool("workflow_progress").execute("progress", { cwd: root, planPath: ".pi/plans/lessons.md" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(progress.content[0].text.includes("## Workflow lessons"), "progress should render workflow lessons");
  assert(progress.content[0].text.includes("acceptance criteria: present"), "progress should surface acceptance detection");
  assert(progress.content[0].text.includes("Narrow active slice"), "progress should nudge broad active slices");
  const doctor = await tool("workflow_doctor").execute("doctor", { cwd: root }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert(doctor.content[0].text.includes("acceptance criteria: present"), "doctor should surface spec/acceptance/test-plan detection without running checks");
  assert(doctor.content[0].text.includes("test plan: present"), "doctor should surface test-plan detection without running checks");
  assert(!existsSync(join(root, ".pi/runs/workflow-state.json")), "workflow_progress/doctor must remain read-only and not write workflow state");
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/plans/progress.md"), [
    "# Progress plan",
    "- [x] completed setup OK_TO_MARK_DONE",
    "```",
    "- [ ] example checkbox inside code fence",
    "```",
    "- [ ] ship progress command",
    "- [ ] document operator flow",
    "",
  ].join("\n"));
  const statePath = join(root, ".pi/runs/workflow-state.json");
  const result = await tool("workflow_progress").execute("progress", { cwd: root, planPath: ".pi/plans/progress.md" }) as { content: Array<{ text: string }>; details: { activePlan?: string; currentSlice?: string; counts: { open?: number; completed?: number; reviewed?: number; gated?: number; total?: number }; nextSafeAction?: string } };
  assert(!existsSync(statePath), "workflow_progress should not create or mutate workflow state");
  assert(result.content[0].text.includes("# Workflow progress"), "workflow_progress should render progress output");
  assert(result.details.activePlan === ".pi/plans/progress.md", "workflow_progress details should include active plan");
  assert(result.details.currentSlice === "ship progress command", "workflow_progress should report first unchecked slice");
  assert(result.details.counts.open === 2 && result.details.counts.completed === 1 && result.details.counts.total === 3, "workflow_progress should count markdown checkbox tasks");
  messages.length = 0;
  await commands.workflow.handler("progress .pi/plans/progress.md", { cwd: root });
  assert(messages[0]?.content.includes("# Workflow progress") && messages[0]?.content.includes("ship progress command"), "/workflow progress should send progress output");

  writeFileSync(join(root, ".pi/plans/fenced-only.md"), ["# Fenced only", "```", "- [ ] fenced example", "```", ""].join("\n"));
  const fencedOnly = await tool("workflow_progress").execute("progress", { cwd: root, planPath: ".pi/plans/fenced-only.md" }) as { details: { currentSlice?: string; counts: { total?: number } } };
  assert(fencedOnly.details.counts.total === undefined && fencedOnly.details.currentSlice === undefined, "workflow_progress should ignore fenced checkboxes for counts and current slice");
}

{
  const root = repo();
  messages.length = 0;
  await commands.workflow.handler("doctor", { cwd: root });
  const details = messages[0]?.details as { ready?: boolean; contractStatus?: string };
  assert(messages[0]?.content.includes("Workflow doctor"), "/workflow doctor should send operator output");
  assert(messages[0]?.content.includes("readiness: NOT READY"), "/workflow doctor missing contract should be not ready");
  assert(messages[0]?.content.includes("contract: missing"), "/workflow doctor should report missing contract");
  assert(messages[0]?.content.includes("Run workflow_init"), "/workflow doctor should include repair step for missing contract");
  assert(details.ready === false && details.contractStatus === "missing", "/workflow doctor missing details should mark not ready");
}

{
  const root = repo();
  writeContract(root, validContract());
  messages.length = 0;
  await commands.workflow.handler("doctor", { cwd: root });
  const details = messages[0]?.details as { ready?: boolean; contractStatus?: string; gates?: string[]; commands?: string[]; commitReady?: boolean; commitMissing?: string[] };
  assert(messages[0]?.content.includes("readiness: READY"), "/workflow doctor valid contract should be ready");
  assert(messages[0]?.content.includes("contract: ok"), "/workflow doctor should report ok contract");
  assert(messages[0]?.content.includes("beforeCommit") && messages[0]?.content.includes("final"), "/workflow doctor should list gates");
  assert(messages[0]?.content.includes("commit-ready: no"), "/workflow doctor should show current commit authorization status");
  assert(messages[0]?.content.includes("does not run gates or tests"), "/workflow doctor should state it does not execute gates/tests");
  assert(details.ready === true && details.contractStatus === "ok", "/workflow doctor valid details should mark ready");
  assert(details.gates?.includes("beforeCommit") && details.commands?.includes("test"), "/workflow doctor details should expose gates/commands");
  assert(details.commitReady === false && details.commitMissing?.includes("trusted reviewer/oracle evidence"), "/workflow doctor should reuse commit evidence details");
}

{
   const root = repo();
  const result = await tool("workflow_init").execute("init", { cwd: root }) as { details: { path: string } };
  const generated = JSON.parse(readFileSync(result.details.path, "utf8"));
  assert(generated.$schema === "./schemas/pi-workflows.schema.json", "generated starter should use package-local schema path");
  assert(!JSON.stringify(generated).includes("agents.local"), "generated starter should not reference agents.local schema URL");
  for (const [name, gate] of Object.entries(generated.gates)) {
    assert(typeof (gate as { description?: unknown }).description === "string", `generated gate ${name} missing description`);
  }
  assert(generated.rules.commitPolicy === "plan", "generated commitPolicy should be plan");
  assert(generated.rules.stopOn.includes("review-failed"), "generated stopOn missing review-failed");
  assert(generated.rules.stopOn.includes("external-side-effect"), "generated stopOn missing external-side-effect");
}

{
  const root = repo();
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/workflows.json"), "{ invalid json");
  const result = await watch(root, "preflight");
  assert(result.details.severity === "blocker", "invalid JSON should be blocker");
  assert(result.content[0].text.includes("Invalid workflow contract JSON"), "invalid JSON finding missing");
}

{
  const root = repo();
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/workflows.json"), "{ invalid json");
  const full = await watch(root, "preflight", { verbosity: "full" });
  const summary = await watch(root, "preflight", { verbosity: "summary" });
  const next = await watch(root, "preflight", { verbosity: "next" });
  assert(full.details.verbosity === "full" && summary.details.verbosity === "summary" && next.details.verbosity === "next", "workflow_watch details should expose verbosity");
  assert(next.content[0].text.length < full.content[0].text.length, "next verbosity should be shorter than full");
  assert(summary.content[0].text.length < full.content[0].text.length, "summary verbosity should be shorter than full");
  assert(next.content[0].text.includes("blockers:"), "next verbosity should expose blockers");
  assert(next.content[0].text.includes("Invalid workflow contract JSON"), "blocker should remain visible in next verbosity");
  assert(summary.content[0].text.includes("Invalid workflow contract JSON"), "summary should include non-OK findings");
}

{
  const root = repo();
  writeContract(root, { version: 2 });
  const result = await watch(root, "preflight");
  assert(result.details.severity === "blocker", "schema-invalid contract should be blocker");
  assert(result.content[0].text.includes("Invalid workflow contract schema"), "schema finding missing");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  statuses["workflow-watcher"] = "";
  widgets["workflow-watcher"] = [];
  await hooks.session_start[0]({ cwd: root }, { cwd: root, hasUI: true, ui } as never);
  assert(statuses["workflow-watcher"].startsWith("wf:"), "session_start should set compact workflow status line");
  assert(!("workflow-watcher" in widgets), "session_start should not set an intrusive workflow widget");
  messages.length = 0;
  await commands.workflow.handler("note OK_TO_MARK_DONE tui smoke", { cwd: root, hasUI: true, ui });
  assert(statuses["workflow-watcher"].includes("rev:"), "/workflow note should refresh compact review status");
  assert(!("workflow-watcher" in widgets), "/workflow note should keep the workflow widget cleared");
}

{
  const root = repo();
  writeContract(root, validContract());
  messages.length = 0;
  await commands.workflow.handler("status", { cwd: root });
  assert(messages[0]?.content.includes("workflow"), "/workflow status should send compact workflow output");
  assert(messages[0]?.content.includes("next:"), "/workflow status should include next nudge");
  messages.length = 0;
  await commands.workflow.handler("next", { cwd: root });
  assert(messages[0]?.content.startsWith("next:"), "/workflow next should send only next action");
}

{
  const root = repo();
  writeContract(root, validContract());
  messages.length = 0;
  await commands.workflow.handler("evidence", { cwd: root });
  const details = messages[0]?.details as { commitReady?: boolean; missing?: string[]; manualNoteStatus?: string };
  assert(messages[0]?.content.includes("commit-ready: no"), "/workflow evidence should show not ready without evidence");
  assert(messages[0]?.content.includes("trusted reviewer/oracle evidence"), "/workflow evidence should list missing review evidence");
  assert(messages[0]?.content.includes("workflow_gate beforeCommit/final pass"), "/workflow evidence should list missing gate evidence");
  assert(details.commitReady === false, "/workflow evidence details should mark missing evidence not commit-ready");
  assert(details.manualNoteStatus === "none", "/workflow evidence should distinguish absent manual notes");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: { ok: { cmd: "node -e \"process.exit(0)\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: ["ok"], required: false },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  writeFileSync(join(root, "file.txt"), "one\n"); git(["add", ".pi/workflows.json", "file.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  messages.length = 0;
  await commands.workflow.handler("evidence", { cwd: root });
  const details = messages[0]?.details as { commitReady?: boolean; reviewTrusted?: boolean; reviewFresh?: boolean; gateTrusted?: boolean; gateFresh?: boolean; missing?: string[] };
  assert(messages[0]?.content.includes("commit-ready: yes"), "/workflow evidence should show ready with fresh trusted evidence");
  assert(messages[0]?.content.includes("trusted=yes fresh=yes"), "/workflow evidence should show fresh trusted evidence");
  assert(messages[0]?.content.includes("- none"), "/workflow evidence should show no missing pieces when ready");
  assert(details.commitReady === true && details.reviewTrusted === true && details.reviewFresh === true && details.gateTrusted === true && details.gateFresh === true, "/workflow evidence ready details should be true");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: { ok: { cmd: "node -e \"process.exit(0)\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  writeFileSync(join(root, "file.txt"), "one\n"); git(["add", ".pi/workflows.json", "file.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_MARK_DONE" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  const details = await tool("workflow_export_evidence").execute("bundle", { cwd: root }) as { details: { commitReady: boolean; missing: string[] } };
  assert(details.details.commitReady === false, "slice review verdict must not authorize commit readiness");
  assert(details.details.missing.includes("commit review verdict OK_TO_COMMIT"), "non-commit review verdict should be explicit missing evidence");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: { ok: { cmd: "node -e \"process.exit(0)\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/plans/done.md"), "# Plan\n- [x] implement feature\n");
  writeFileSync(join(root, "file.txt"), "one\n"); git(["add", ".pi/workflows.json", "file.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  let result = await tool("workflow_complete").execute("complete", { cwd: root, planPath: ".pi/plans/done.md" }) as { content: Array<{ text: string }>; details: { clean: boolean; blockers: string[]; completedAt?: string; activePlan?: string } };
  assert(result.details.clean === false, "workflow_complete should fail closed without clean evidence");
  assert(result.content[0].text.includes("Workflow complete: BLOCKED"), "workflow_complete should explain blocked completion");
  assert(result.details.blockers.includes("trusted reviewer/oracle evidence"), "workflow_complete should require trusted review evidence");
  await tool("workflow_note").execute("note", { cwd: root, note: "OK_TO_COMMIT manual review" });
  await tool("workflow_note").execute("note", { cwd: root, note: "gate final pass" });
  result = await tool("workflow_complete").execute("complete", { cwd: root, planPath: ".pi/plans/done.md" }) as unknown as typeof result;
  assert(result.details.clean === false && result.details.blockers.includes("trusted reviewer/oracle evidence") && result.details.blockers.includes("current workflow_gate beforeCommit/final pass"), "workflow_complete should reject manual review/gate evidence");
  await tool("workflow_note").execute("note", { cwd: root, note: "OK_TO_MARK_DONE slice review" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "final" });
  result = await tool("workflow_complete").execute("complete", { cwd: root, planPath: ".pi/plans/done.md" }) as unknown as typeof result;
  assert(result.details.clean === false && result.details.blockers.includes("commit review verdict OK_TO_COMMIT"), "workflow_complete should block non-commit review verdicts");
  await tool("workflow_note").execute("note", { cwd: root, note: "OK_TO_COMMIT final review" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "focused" });
  result = await tool("workflow_complete").execute("complete", { cwd: root, planPath: ".pi/plans/done.md" }) as unknown as typeof result;
  assert(result.details.clean === false && result.details.blockers.includes("current workflow_gate beforeCommit/final pass"), "workflow_complete should reject focused gate evidence for commit completion");
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "final" });
  result = await tool("workflow_complete").execute("complete", { cwd: root, planPath: ".pi/plans/done.md" }) as unknown as typeof result;
  assert(result.details.clean === true && result.details.completedAt, "workflow_complete should succeed only when plan and evidence are clean");
  assert(result.content[0].text.includes("Workflow complete: OK"), "workflow_complete should report clean completion");
  const state = readStateFile(root);
  assert(!state.activePlan, "workflow_complete should clear activePlan after clean completion");
  assert(state.lastNote?.note.includes("WORKFLOW_COMPLETE"), "workflow_complete should leave a completion breadcrumb");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: { ok: { cmd: "node -e \"console.log('secret token=sk-1234567890abcdef1234567890abcdef'); console.log('x'.repeat(10000))\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  writeFileSync(join(root, ".pi/plans/bundle.md"), "# Plan\n- [ ] ship bundle export\n");
  writeFileSync(join(root, "file.txt"), "one\n"); git(["add", ".pi/workflows.json", "file.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "active plan: bundle api_key=supersecret OK_TO_COMMIT" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  const result = await tool("workflow_export_evidence").execute("bundle", { cwd: root, planPath: ".pi/plans/bundle.md" }) as { content: Array<{ text: string }>; details: { bundlePath: string; commitReady: boolean; currentDiffHash: string; missing: string[]; activeSlice?: string } };
  const body = readFileSync(result.details.bundlePath, "utf8");
  assert(result.content[0].text.includes("Evidence bundle:"), "workflow_export_evidence should return bundle path content");
  assert(result.details.commitReady === true, "workflow_export_evidence should report commit-ready when evidence is fresh");
  assert(result.details.bundlePath.includes(".pi/runs/workflow-evidence-bundle-"), "bundle should be written under .pi/runs");
  assert(body.includes("# Workflow Evidence Bundle") && body.includes("## Active plan / slice") && body.includes("ship bundle export"), "bundle should include plan/slice summary");
  assert(body.includes("## Trusted review state") && body.includes("## workflow_gate state") && body.includes("## Commit readiness"), "bundle should include evidence states and readiness");
  assert(body.includes("## Files changed") && body.includes("file.txt"), "bundle should include explicit files changed handoff section");
  assert(body.includes("## Checks run") && body.includes("beforeCommit") && body.includes("ok:pass"), "bundle should include explicit checks run handoff section");
  assert(body.includes("## Open risks") && body.includes("## Next todos") && body.includes("## Resume commands"), "bundle should include explicit handoff sections for risks, todos, and resume commands");
  assert(!body.includes("supersecret") && !body.includes("sk-123...cdef"), "bundle should redact obvious secrets/tokens");
  assert(!body.includes("x".repeat(1000)), "bundle should not include huge raw stdout");
  assert(body.length < 20000, "bundle output should be bounded");
}

{
  const root = repo();
  writeContract(root, validContract());
  messages.length = 0;
  await commands.workflow.handler("note OK_TO_MARK_DONE slash smoke", { cwd: root });
  assert(messages[0]?.content.includes("noted: OK_TO_MARK_DONE"), "/workflow note should acknowledge note");
  const state = readStateFile(root);
  assert(state.lastReviewVerdict?.verdict === "OK_TO_MARK_DONE", "/workflow note should persist recognized verdicts");
}

{
  const root = repo();
  writeContract(root, validContract({ gates: { final: { description: "Final", commands: ["missing"], required: true } } }));
  const result = await watch(root, "final");
  assert(result.details.severity === "blocker", "unknown required gate command should block");
  assert(result.content[0].text.includes("Gate references unknown command"), "unknown gate command finding missing");
}


{
  const root = repo();
  writeContract(root, validContract({
    commands: {
      ok: { cmd: "node -e \"console.log('ok')\"", source: "fixture", confidence: "verified" },
      second: { cmd: "node -e \"console.log('second')\"", source: "fixture", confidence: "verified" },
    },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok", "second"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  const result = await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit", dryRun: true }) as { content: Array<{ text: string }>; details: { status: string; dryRun: boolean; commands: Array<{ alias: string; cmd: string }>; logPath: string } };
  assert(result.details.status === "dry-run", "workflow_gate dryRun should not execute commands");
  assert(result.details.dryRun === true, "workflow_gate dryRun details should be true");
  assert(result.details.commands.length === 2, "workflow_gate dryRun should resolve both aliases");
  assert(result.content[0].text.includes("ok"), "workflow_gate dryRun output should include resolved command");
  assert(readFileSync(result.details.logPath, "utf8").includes("gate beforeCommit dry-run"), "workflow_gate dryRun should append log evidence");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: {
      first: { cmd: "node -e \"require('fs').appendFileSync('order.txt', '1')\"", source: "fixture", confidence: "verified" },
      second: { cmd: "node -e \"require('fs').appendFileSync('order.txt', '2')\"", source: "fixture", confidence: "verified" },
    },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["first", "second"], required: true },
      final: { description: "Final checks", commands: ["first"], required: true },
    },
  }));
  const result = await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" }) as { details: { status: string; commands: Array<{ status: string }>; logPath: string } };
  assert(result.details.status === "pass", "workflow_gate should pass when all commands pass");
  assert(readFileSync(join(root, "order.txt"), "utf8") === "12", "workflow_gate should execute commands sequentially");
  assert(result.details.commands.every((command) => command.status === "pass"), "all command runs should pass");
  assert(readFileSync(result.details.logPath, "utf8").includes("gate beforeCommit pass"), "workflow_gate pass should append log evidence");
  const ledger = readLedger(root);
  const event = ledger.find((entry) => entry.type === "gate_run" && entry.gate === "beforeCommit");
  assert(event?.status === "pass", "workflow_gate pass should write JSONL gate_run event");
  assert(event?.source === "workflow_gate", "workflow_gate JSONL event should include source");
  assert(typeof event?.diffHash === "string" && event.diffHash.length > 0, "workflow_gate JSONL event should include diffHash");
  assert(Array.isArray(event?.commands) && (event.commands as unknown[]).length === 2, "workflow_gate JSONL event should include command statuses");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: {
      first: { cmd: "node -e \"require('fs').appendFileSync('order.txt', '1'); process.exit(1)\"", source: "fixture", confidence: "verified" },
      second: { cmd: "node -e \"require('fs').appendFileSync('order.txt', '2')\"", source: "fixture", confidence: "verified" },
    },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["first", "second"], required: true },
      final: { description: "Final checks", commands: ["first"], required: true },
    },
  }));
  const result = await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" }) as { details: { status: string; commands: Array<{ alias: string; status: string; exitCode: number | null }>; logPath: string } };
  assert(result.details.status === "fail", "workflow_gate should fail when a command fails");
  assert(result.details.commands.length === 1, "workflow_gate should stop after first failed command");
  assert(result.details.commands[0].alias === "first", "workflow_gate should report failing alias");
  assert(readFileSync(join(root, "order.txt"), "utf8") === "1", "workflow_gate should not execute commands after failure");
  assert(readFileSync(result.details.logPath, "utf8").includes("gate beforeCommit fail"), "workflow_gate fail should append log evidence");
  const event = readLedger(root).find((entry) => entry.type === "gate_run" && entry.gate === "beforeCommit");
  assert(event?.status === "fail", "workflow_gate fail should write JSONL gate_run event");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: {
      slow: { cmd: "node -e \"setTimeout(() => {}, 1000)\"", source: "fixture", confidence: "verified", timeoutSeconds: 0.01 },
      second: { cmd: "node -e \"require('fs').writeFileSync('after-timeout.txt', 'ran')\"", source: "fixture", confidence: "verified" },
    },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["slow", "second"], required: true },
      final: { description: "Final checks", commands: ["slow"], required: true },
    },
  }));
  const started = Date.now();
  const result = await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" }) as { content: Array<{ text: string }>; details: { status: string; commands: Array<{ alias: string; status: string; timedOut?: boolean; error?: string }>; logPath: string } };
  assert(Date.now() - started < 800, "workflow_gate timeout should fail quickly");
  assert(result.details.status === "fail", "workflow_gate should fail on command timeout");
  assert(result.details.commands.length === 1, "workflow_gate should stop after timed-out command");
  assert(result.details.commands[0].alias === "slow", "workflow_gate should report timed-out alias");
  assert(result.details.commands[0].timedOut === true, "workflow_gate command details should mark timeout");
  assert(!existsSync(join(root, "after-timeout.txt")), "workflow_gate should not execute subsequent commands after timeout");
  assert(result.content[0].text.toLowerCase().includes("timeout"), "workflow_gate output should mention timeout");
  assert(readFileSync(result.details.logPath, "utf8").toLowerCase().includes("timeout"), "workflow_gate log should mention timeout");

  messages.length = 0;
  await commands.workflow.handler("gate beforeCommit", { cwd: root });
  const slashDetails = messages[0]?.details as { status: string; commands: Array<{ timedOut?: boolean }> };
  assert(slashDetails.status === "fail", "/workflow gate should fail on command timeout");
  assert(slashDetails.commands[0]?.timedOut === true, "/workflow gate command details should mark timeout");
  assert(messages[0]?.content.toLowerCase().includes("timeout"), "/workflow gate output should mention timeout");
}

{
  const root = repo();
  writeContract(root, validContract({
    commands: { noisy: { cmd: "node -e \"console.log('BIG_OUTPUT_' + 'x'.repeat(9000))\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: [], required: false, allowEmpty: true },
      beforeCommit: { description: "Pre-commit checks", commands: ["noisy"], required: true },
      final: { description: "Final checks", commands: ["noisy"], required: true },
    },
  }));
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  const ledgerText = readFileSync(join(root, ".pi/runs/workflow-watcher.jsonl"), "utf8");
  assert(!ledgerText.includes("BIG_OUTPUT_"), "workflow_gate JSONL must not copy command stdout");
  assert(ledgerText.includes("stdoutSummary"), "workflow_gate JSONL should keep stdout summary metadata");
}

{
  const root = repo();
  writeContract(root, validContract());
  await tool("workflow_note").execute("note", { cwd: root, note: "token=super-secret-value and ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  const ledgerText = readFileSync(join(root, ".pi/runs/workflow-watcher.jsonl"), "utf8");
  assert(!ledgerText.includes("super-secret-value"), "workflow_note JSONL should redact token assignments");
  assert(!ledgerText.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "workflow_note JSONL should redact obvious API tokens");
}

{
  const root = repo();
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: ".pi/custom-runs", agentInstructions: "AGENTS.md" } }));
  const result = await tool("workflow_note").execute("note", { cwd: root, note: "OK_TO_MARK_DONE tested" }) as { details: { path: string; statePath?: string } };
  assert(result.details.path.endsWith(".pi/custom-runs/workflow-watcher.log"), "workflow_note ignored artifacts.runsDir");
  assert(result.details.statePath?.endsWith(".pi/custom-runs/workflow-state.json"), "workflow_note state ignored artifacts.runsDir");
  assert(existsSync(join(root, ".pi/custom-runs/workflow-state.json")), "custom workflow state file missing");
  const event = readLedger(root, ".pi/custom-runs").find((entry) => entry.type === "note");
  assert(event?.source === "manual_note", "workflow_note should write manual_note JSONL event");
  assert(String(event?.notePreview).includes("OK_TO_MARK_DONE"), "workflow_note JSONL event should include sanitized preview");
}

{
  const root = repo();
  const outsidePath = join(root, "..", "outside", "workflow-watcher.log");
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "../outside", agentInstructions: "AGENTS.md" } }));
  const result = await tool("workflow_note").execute("note", { cwd: root, note: "should not escape" }) as { content: Array<{ text: string }>; details: { appended: boolean; status?: string; error?: string; path: string; statePath?: string } };
  assert(result.details.appended === false, "workflow_note should not append when artifacts.runsDir escapes repo");
  assert(result.details.status === "fail", "workflow_note should return structured fail for escaping artifacts.runsDir");
  assert(result.details.error?.includes("artifacts.runsDir"), "workflow_note fail should identify artifacts.runsDir");
  assert(result.details.path.endsWith(".pi/runs/workflow-watcher.log"), "workflow_note should report safe fallback log path");
  assert(!existsSync(outsidePath), "workflow_note wrote outside repo for escaping artifacts.runsDir");
}

{
  const root = repo();
  const outsidePath = join(root, "..", "outside", "workflow-watcher.log");
  writeContract(root, validContract({ commands: { ok: { cmd: "true", source: "test", confidence: "verified" } }, gates: { beforeCommit: { description: "safe", commands: ["ok"], required: true } }, artifacts: { plansDir: ".pi/plans", runsDir: "../outside", agentInstructions: "AGENTS.md" } }));
  const result = await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit", dryRun: true }) as { content: Array<{ text: string }>; details: { status: string; error?: string; logPath?: string; statePath?: string } };
  assert(result.details.status === "fail", "workflow_gate should return structured fail for escaping artifacts.runsDir");
  assert(result.details.error?.includes("artifacts.runsDir"), "workflow_gate fail should identify artifacts.runsDir");
  assert(result.details.logPath?.endsWith(".pi/runs/workflow-watcher.log"), "workflow_gate should report safe fallback log path");
  assert(!existsSync(outsidePath), "workflow_gate wrote outside repo for escaping artifacts.runsDir");
}

{
  const root = repo();
  const outsideState = join(root, "..", "outside", "workflow-state.json");
  writeContract(root, validContract({ artifacts: { plansDir: ".pi/plans", runsDir: "../outside", agentInstructions: "AGENTS.md" } }));
  const result = await watch(root, "preflight");
  assert(result.details.severity === "blocker", "workflow_watch should return blocker for escaping artifacts.runsDir");
  assert(result.content[0].text.includes("artifacts.runsDir"), "workflow_watch blocker should identify artifacts.runsDir");
  assert(!existsSync(outsideState), "workflow_watch wrote state outside repo for escaping artifacts.runsDir");
  assert(existsSync(join(root, ".pi/runs/workflow-state.json")), "workflow_watch should use safe fallback state path");
}


{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "user dirty\n");
  await watch(root, "preflight");
  const baselineState = readStateFile(root);
  assert((baselineState.dirtyBaseline?.dirtyFiles as string[] | undefined)?.some((line) => line.includes("file.txt")), "preflight should record dirty baseline file.txt");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "pre-existing dirty file from baseline should block overlapping edit");
  assert(blocked.reason?.includes("pre-existing dirty path"), "dirty baseline block reason should identify pre-existing dirty path");
  assert(blocked.reason?.includes("/workflow dirty approve"), "dirty baseline block reason should include exact approval slash command");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: [], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] } }));
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "user dirty\n");
  await watch(root, "preflight");
  const missingReason = await tool("workflow_approve_dirty_overlap").execute("approve", { cwd: root, path: "file.txt", reason: "" }) as { details: { approved: boolean; error?: string } };
  assert(missingReason.details.approved === false && missingReason.details.error === "reason required", "dirty overlap approval should require a reason");
  const approved = await tool("workflow_approve_dirty_overlap").execute("approve", { cwd: root, path: "file.txt", reason: "operator accepted overlap" }) as { content: Array<{ text: string }>; details: { approved: boolean; baselineDiffHash?: string } };
  assert(approved.details.approved === true && approved.content[0].text.includes("one-shot"), "workflow_approve_dirty_overlap should approve one-shot overlap");
  const hook = hooks.tool_call[0];
  const first = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean } | undefined;
  assert(first === undefined || first.block !== true, "approved dirty overlap should allow first matching edit");
  let state = readStateFile(root);
  assert(state.dirtyOverlapApprovals?.[0]?.consumedAt, "dirty overlap approval should be consumed in state on first matching edit");
  const second = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(second?.block === true, "dirty overlap approval should be one-shot");
  const ledger = readLedger(root);
  assert(ledger.some((entry) => entry.type === "dirty_overlap_approval" && entry.path === "file.txt"), "approval should be visible in ledger");
  assert(ledger.some((entry) => entry.type === "dirty_overlap_approval_consumed" && entry.path === "file.txt"), "consumption should be visible in ledger");
  messages.length = 0;
  await commands.workflow.handler("dirty", { cwd: root });
  assert(messages[0]?.content.includes("Dirty baseline") && messages[0]?.content.includes("consumed"), "/workflow dirty should show baseline and approval state");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: ["file.txt"], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] } }));
  writeFileSync(join(root, "file.txt"), "one\n"); git(["add", ".pi/workflows.json", "file.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "user dirty\n");
  await watch(root, "preflight");
  await tool("workflow_approve_dirty_overlap").execute("approve", { cwd: root, path: "file.txt", reason: "operator accepted overlap" });
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true && blocked.reason?.includes("high-risk path"), "dirty approval must not bypass high-risk protections");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: ["danger.txt"], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] } }));
  writeFileSync(join(root, "file.txt"), "one\n");
  writeFileSync(join(root, "danger.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt", "danger.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "user dirty\n");
  await watch(root, "preflight");
  await tool("workflow_approve_dirty_overlap").execute("approve", { cwd: root, path: "file.txt", reason: "operator accepted overlap" });
  const hook = hooks.tool_call[0];
  const mixed = await hook({ toolName: "edit", input: { targets: ["file.txt", "danger.txt"] }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(mixed?.block === true && mixed.reason?.includes("high-risk path"), "mixed edit should still block on later high-risk target");
  const state = readStateFile(root);
  assert(!state.dirtyOverlapApprovals?.[0]?.consumedAt, "blocked mixed edit must not consume dirty overlap approval before any edit occurs");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  await watch(root, "preflight");
  writeFileSync(join(root, "file.txt"), "agent first edit\n");
  const hook = hooks.tool_call[0];
  const allowed = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean } | undefined;
  assert(allowed === undefined || allowed.block !== true, "clean baseline should allow agent second edit to same dirty file");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  await watch(root, "preflight");
  writeFileSync(join(root, "file.txt"), "agent-created dirty file\n");
  const hook = hooks.tool_call[0];
  const allowed = await hook({ toolName: "edit", input: { path: "file.txt" }, cwd: root }) as { block?: boolean } | undefined;
  assert(allowed === undefined || allowed.block !== true, "dirty file created after baseline should not be treated as pre-existing user work");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  writeFileSync(join(root, "dirty.txt"), "one\n");
  writeFileSync(join(root, "clean.txt"), "one\n");
  git(["add", "dirty.txt", "clean.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "dirty.txt"), "user dirty\n");
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "patch", input: { patch: "*** Begin Patch\n*** Update File: clean.txt\n@@\n one\n*** Update File: dirty.txt\n@@\n user dirty\n*** End Patch\n" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "multi-file patch touching baseline dirty file should be blocked");
  assert(blocked.reason?.includes("dirty.txt"), "multi-file dirty patch block reason should name dirty.txt");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "functions.patch", input: { patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+outside\n*** End Patch\n" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "patch attempting ../outside.txt should be blocked");
  assert(blocked.reason?.includes("outside repo root"), "outside patch block reason should mention outside repo root");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "patch", input: { path: "clean.txt", patch: "not a recognized patch header but still a patch body" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "patch body with explicit path but no parseable patch target should fail closed");
  assert(blocked.reason?.includes("no parseable target paths"), "ambiguous patch block reason should mention parseable target paths");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  writeFileSync(join(root, "clean.txt"), "one\n");
  git(["add", "clean.txt"], root);
  git(["commit", "-m", "init"], root);
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const allowed = await hook({ toolName: "patch", input: { patch: "diff --git a/clean.txt b/clean.txt\n--- a/clean.txt\n+++ b/clean.txt\n@@ -1 +1 @@\n-one\n+two\n" }, cwd: root }) as { block?: boolean } | undefined;
  assert(allowed === undefined || allowed.block !== true, "normal patch touching approved clean repo file should be allowed");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: ["infra/**", "SECURITY.md"], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] } }));
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "write_file", input: { path: "SECURITY.md" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "configured high-risk path edit should block without evidence");
  assert(blocked.reason?.includes("high-risk path") && blocked.reason?.includes("ownership.highRiskPaths"), "high-risk block reason should mention ownership.highRiskPaths");
  const patchBlocked = await hook({ toolName: "patch", input: { patch: "*** Begin Patch\n*** Update File: infra/prod.tf\n@@\n-old\n+new\n*** End Patch\n" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(patchBlocked?.block === true, "patch-derived high-risk path should block without evidence");
  assert(patchBlocked.reason?.includes("infra/prod.tf"), "high-risk patch block reason should name patch path");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: [], generatedPaths: [], lockfiles: ["pnpm-lock.yaml", "**/package-lock.json"] } }));
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "edit", input: { path: "pnpm-lock.yaml" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "direct lockfile edit should block without dependency approval");
  assert(blocked.reason?.includes("lockfile edit") && blocked.reason?.includes("dependency-change evidence"), "lockfile block reason should mention dependency approval evidence");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: [], generatedPaths: ["src/generated/**"], lockfiles: ["pnpm-lock.yaml"] } }));
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "patch", input: { patch: "diff --git a/src/generated/api.ts b/src/generated/api.ts\n--- a/src/generated/api.ts\n+++ b/src/generated/api.ts\n@@ -1 +1 @@\n-old\n+new\n" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "generated path edit should produce a block/nudge without generation evidence");
  assert(blocked.reason?.includes("generated path") && blocked.reason?.includes("source-generation command evidence"), "generated path reason should mention source-generation evidence");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  writeFileSync(join(root, "space name.txt"), "one\n");
  git(["add", "space name.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "space name.txt"), "user dirty\n");
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "patch", input: { patch: "diff --git a/space name.txt b/space name.txt\n--- a/space name.txt\n+++ b/space name.txt\n@@ -1 +1 @@\n-one\n+two\n" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "git patch touching baseline dirty file with spaces should be blocked");
  assert(blocked.reason?.includes("space name.txt"), "space path patch block reason should name the dirty file");
}


{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  const state = readStateFile(root);
  assert(state.lastReviewVerdict?.verdict === "OK_TO_COMMIT", "workflow_note should persist review verdict");
  assert(state.lastReviewVerdict?.stale === false, "new review verdict should not be stale");
  assert(state.checkpoint?.diffHash === state.lastReviewVerdict.diffHash, "review verdict should set checkpoint");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  writeFileSync(join(root, "file.txt"), "three\n");
  const result = await watch(root, "before-commit");
  const state = readStateFile(root);
  assert(state.lastReviewVerdict?.stale === true, "review should become stale after diff changes");
  assert(result.details.severity === "blocker", "stale review should block before-commit");
  assert(result.content[0].text.includes("Review verdict is stale"), "stale review finding missing");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  writeFileSync(join(root, "file.txt"), "three\n");
  const result = await watch(root, "final");
  assert(result.details.severity === "blocker", "checkpoint mismatch should block final");
  assert(result.content[0].text.includes("Diff changed since checkpoint"), "checkpoint mismatch finding missing");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({
    commands: { ok: { cmd: "node -e \"process.exit(0)\"", source: "fixture", confidence: "verified" } },
    gates: {
      preflight: { description: "Preflight checks", commands: [], required: false, allowEmpty: true },
      focused: { description: "Focused checks", commands: ["ok"], required: false },
      beforeCommit: { description: "Pre-commit checks", commands: ["ok"], required: true },
      final: { description: "Final checks", commands: ["ok"], required: true },
    },
  }));
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const hook = hooks.tool_call[0];

  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  await tool("workflow_note").execute("note", { cwd: root, note: "gate beforeCommit pass" });
  const manualBlocked = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(manualBlocked?.block === true, "manual review note plus manual gate note must not allow git commit");

  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  let state = readStateFile(root);
  assert(state.lastGateResult?.source === "workflow_gate", "workflow_gate should record gate evidence source workflow_gate");

  await tool("workflow_note").execute("note", { cwd: root, note: "review OK_TO_COMMIT" });
  markLastReviewTrusted(root);
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "focused" });
  const focusedBlocked = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(focusedBlocked?.block === true, "focused gate plus trusted review must not allow git commit");
  assert(focusedBlocked.reason?.includes("beforeCommit") && focusedBlocked.reason?.includes("final"), "commit block reason should mention required gates");

  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit" });
  const beforeCommitAllowed = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean } | undefined;
  assert(beforeCommitAllowed === undefined || beforeCommitAllowed.block !== true, "beforeCommit gate plus trusted review should allow git commit");

  await tool("workflow_gate").execute("gate", { cwd: root, gate: "final" });
  const finalAllowed = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean } | undefined;
  assert(finalAllowed === undefined || finalAllowed.block !== true, "final gate plus trusted review should allow git commit");

  writeFileSync(join(root, "file.txt"), "three\n");
  const blocked = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "git commit should be blocked after diff changes");
  assert(blocked.reason?.includes("missing current trusted review verdict"), "commit block reason should mention current trusted evidence");
}


{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  const hook = hooks.tool_call[0];
  const blocked = await hook({ toolName: "bash", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(blocked?.block === true, "git commit should be blocked without review/gate evidence");
  assert(blocked.reason?.includes("review"), "git commit block reason should mention review");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  const hook = hooks.tool_call[0];
  const namespacedCommit = await hook({ toolName: "functions.terminal", input: { command: "git commit -m test" }, cwd: root }) as { block?: boolean } | undefined;
  assert(namespacedCommit?.block === true, "namespaced terminal tool should block git commit without evidence");
  const gitCCommit = await hook({ toolName: "terminal", input: { command: "git -C . commit -m x" }, cwd: root }) as { block?: boolean } | undefined;
  assert(gitCCommit?.block === true, "git -C . commit should block without evidence");
  const gitConfigCommit = await hook({ toolName: "terminal", input: { command: "git -c user.name=x commit -m x" }, cwd: root }) as { block?: boolean } | undefined;
  assert(gitConfigCommit?.block === true, "git -c key=value commit should block without evidence");
  const commandGitCommit = await hook({ toolName: "terminal", input: { command: "command git commit -m x" }, cwd: root }) as { block?: boolean } | undefined;
  assert(commandGitCommit?.block === true, "command git commit should block without evidence");

  const outsideEdit = await hook({ toolName: "functions.write_file", input: { path: "../outside.txt" }, cwd: root }) as { block?: boolean } | undefined;
  assert(outsideEdit?.block === true, "namespaced write tool should block outside-repo edit");

  for (const command of ["npm i left-pad", "pnpm install left-pad", "rm -r -f dist", "rm -Rf dist"]) {
    const blocked = await hook({ toolName: "functions.terminal", input: { command }, cwd: root }) as { block?: boolean } | undefined;
    assert(blocked?.block === true, `${command} should be blocked`);
  }
  for (const command of ["git status", "npm test", "prettier --write src/file.ts"]) {
    const allowed = await hook({ toolName: "functions.terminal", input: { command }, cwd: root }) as { block?: boolean } | undefined;
    assert(allowed === undefined || allowed.block !== true, `${command} should be allowed`);
  }
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  const olderPlan = join(root, ".pi/plans/older.md");
  const branchPlan = join(root, ".pi/plans/branch-slug.md");
  writeFileSync(olderPlan, "# Older\n- [ ] task\nAdversarial review\n");
  writeFileSync(branchPlan, "# Branch slug\n- [ ] task\nAdversarial review\n");
  utimesSync(olderPlan, new Date(1_000), new Date(1_000));
  utimesSync(branchPlan, new Date(2_000), new Date(2_000));
  git(["checkout", "-b", "feature/branch-slug"], root);
  const result = await watch(root, "before-slice");
  assert(String(result.details.activePlan).endsWith(".pi/plans/branch-slug.md"), "workflow_watch should infer active plan from current branch slug");
  assert((result.details.activePlanInference as string[]).some((line) => line.includes("current branch slug")), "branch-slug inference explanation missing");
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, ".pi/plans"), { recursive: true });
  const branchPlan = join(root, ".pi/plans/branch-plan.md");
  const recentPlan = join(root, ".pi/plans/recent-plan.md");
  writeFileSync(branchPlan, "# Branch plan\n- [ ] task\nAdversarial review\n");
  writeFileSync(recentPlan, "# Recent plan\n- [ ] task\nAdversarial review\n");
  utimesSync(branchPlan, new Date(1_000), new Date(1_000));
  utimesSync(recentPlan, new Date(2_000), new Date(2_000));
  git(["checkout", "-b", "feature/branch-plan"], root);
  const result = await watch(root, "before-slice");
  assert(result.details.activePlan === undefined, "ambiguous inference should not silently pick an active plan");
  assert(result.content[0].text.includes("Ambiguous active plan"), "ambiguous inference nudge missing");
  assert((result.details.activePlanInference as string[]).length >= 2, "ambiguity details should list candidate sources");
}

{
  const root = repo();
  writeContract(root, validContract());
  commitBaselineWithReviewArtifactIgnored(root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeReviewEvidenceArtifact(root, evidence);
  const result = await importReviewEvidenceArtifact(root);
  assert(result.details.accepted === true, `valid workflow review evidence should import: ${result.details.error ?? ""}`);
  assert(result.details.source === "reviewer_evidence", "valid workflow review evidence should be trusted as reviewer_evidence");
  assert(result.details.diffHash === diffHash, "import should record current diff hash");
  const state = readStateFile(root);
  assert(state.lastReviewVerdict?.source === "reviewer_evidence" && state.lastReviewVerdict.diffHash === diffHash, "import should persist reviewer_evidence state for current diff");
  const request = JSON.parse(readFileSync(join(root, ".pi/runs/review-requests/rw-smoke.json"), "utf8"));
  assert(request.status === "consumed" && request.consumedAt, "successful import should consume review request");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  mkdirSync(join(root, ".pi/runs"), { recursive: true });
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeFileSync(join(root, ".pi/runs/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: ".pi/runs/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === true, `runtime review artifact/request files should be excluded from import diff hash: ${result.details.error ?? ""}`);
}

{
  const root = repo();
  writeContract(root, validContract());
  mkdirSync(join(root, ".pi/runs"), { recursive: true });
  writeFileSync(join(root, ".pi/runs/.keep"), "\n");
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", ".pi/runs/.keep", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeFileSync(join(root, ".pi/runs/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: ".pi/runs/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === true, `import should exclude explicit runtime artifact path even when runsDir exists in the index: ${result.details.error ?? ""}`);
  assert(fixtureDiffHash(root) === diffHash, "imported runtime artifact path should remain excluded after import");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  writeFileSync(join(root, "other.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt", "other.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  writeFileSync(join(root, "other.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  const request = reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt", "other.txt"] });
  const requestPath = writeReviewRequest(root, request);
  writeFileSync(requestPath, `${JSON.stringify({ ...request, expectedFiles: ["file.txt"] }, null, 2)}\n`, "utf8");
  mkdirSync(join(root, ".pi/runs"), { recursive: true });
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeFileSync(join(root, ".pi/runs/review.md"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: ".pi/runs/review.md" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === false && result.details.error?.includes("current review scope"), "tampered review request expectedFiles must not narrow current dirty scope");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "file.txt"), "one\n");
  git(["add", ".pi/workflows.json", "file.txt"], root);
  git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeFileSync(join(root, "backdoor.ts"), `Review clean.\n\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
  const result = await tool("workflow_import_review_evidence").execute("accept", { cwd: root, artifactPath: "backdoor.ts" }) as { details: { accepted: boolean; error?: string } };
  assert(result.details.accepted === false && result.details.error?.includes("current review scope"), "non-runtime artifact path must remain in current review scope");
}

{
  const root = repo();
  writeContract(root, validContract());
  commitBaselineWithReviewArtifactIgnored(root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const diffHash = fixtureDiffHash(root);
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
  writeReviewEvidenceArtifact(root, evidence, "");
  const first = await importReviewEvidenceArtifact(root) as { details: { accepted: boolean } };
  assert(first.details.accepted === true, "first review evidence import should succeed");
  const second = await importReviewEvidenceArtifact(root);
  assert(second.details.accepted === false && second.details.error?.includes("not pending"), "consumed review request must reject second import");
}

{
  const makeFixture = () => {
    const root = repo();
    writeContract(root, validContract());
    commitBaselineWithReviewArtifactIgnored(root);
    writeFileSync(join(root, "file.txt"), "two\n");
    const diffHash = fixtureDiffHash(root);
    return { root, diffHash };
  };

  {
    const { root } = makeFixture();
    writeFileSync(join(root, "review.md"), "Review clean. OK_TO_COMMIT\n");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("missing workflow-review-evidence"), "prose-only tool import must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] });
    writeFileSync(join(root, "review.md"), `\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("exactly one"), "duplicate workflow-review-evidence fences must reject");
  }
  {
    const { root } = makeFixture();
    writeFileSync(join(root, "review.md"), "```workflow-review-evidence\n{bad json}\n```\n");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("malformed"), "malformed workflow-review-evidence JSON must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    const evidence = { ...reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] }), schema: "unknown" };
    writeFileSync(join(root, "review.md"), `\`\`\`workflow-review-evidence\n${JSON.stringify(evidence)}\n\`\`\`\n`);
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("expected pi-workflow-review-evidence/v1"), "unknown review evidence schema must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("not pending"), "missing review request must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { repo: join(root, "other"), reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("repo"), "evidence repo mismatch must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { repo: join(root, "other"), diffHash, expectedFiles: ["file.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("request repo"), "request repo mismatch must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["other.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("current review scope"), "request scope mismatch must reject before import trust");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"], verdict: "OK_TO_PRESENT" }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("not allowed"), "invalid verdict must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"], criteria: [] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("non-empty"), "empty criteria must reject");
  }
  {
    const { root, diffHash } = makeFixture();
    writeReviewRequest(root, reviewRequestFixture(root, { diffHash, expectedFiles: ["file.txt"] }));
    writeReviewEvidenceArtifact(root, reviewEvidenceFixture(root, { reviewedDiffHash: diffHash, reviewedFiles: ["file.txt"], criteria: [{ id: "required", status: "unsatisfied" }] }), "");
    const result = await importReviewEvidenceArtifact(root);
    assert(result.details.accepted === false && result.details.error?.includes("required criterion required"), "unsatisfied required criterion must reject");
  }
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  commitBaselineWithReviewArtifactIgnored(root);
  git(["add", ".pi/workflow-watcher.json"], root);
  git(["commit", "-m", "enable watcher"], root);
  writeFileSync(join(root, "file.txt"), "two\n");
  const staleHash = fixtureDiffHash(root);
  writeFileSync(join(root, "file.txt"), "three\n");
  writeReviewRequest(root, reviewRequestFixture(root, { diffHash: staleHash, expectedFiles: ["file.txt"] }));
  const evidence = reviewEvidenceFixture(root, { reviewedDiffHash: staleHash, reviewedFiles: ["file.txt"] });
  // stale hash case intentionally writes file again after request hash capture
  writeReviewEvidenceArtifact(root, evidence, "");
  const result = await importReviewEvidenceArtifact(root);
  assert(result.details.accepted === false && result.details.error?.includes("current repo diffHash"), "mismatched current diff hash must not import");
  const hook = hooks.tool_call[0];
  const commitBlocked = await hook({ toolName: "terminal", input: { command: "git commit -m stale" }, cwd: root }) as { block?: boolean } | undefined;
  assert(commitBlocked?.block === true, "stale review evidence must not unlock commit");
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract());
  const hook = hooks.tool_call[0];
  for (const command of [
    "echo ok && git commit -m bypass",
    "sh -c 'git push origin main'",
    "bash -lc 'git commit -m x'",
    "env -i FOO=1 git commit -m x",
    "command env -i FOO=1 git commit -m x",
    "sudo -u root git commit -m x",
    "FOO=1 /usr/bin/git commit -m x",
    "npx --yes prettier . --write",
    "npm exec -- prettier . --write",
    "pnpm exec eslint . --fix",
    "npm audit fix",
    "pnpm remove left-pad",
    "yarn upgrade left-pad",
    "bun install",
    "go mod tidy",
    "cargo update",
    "uv sync",
    "poetry update",
    "find . -delete",
    "find . -exec rm -rf {} ;",
    "xargs rm -rf",
    "rsync -a --delete src/ dst/",
    "git restore -- .",
    "git checkout -- .",
    "prettier . --write",
    "ruff check . --fix",
  ]) {
    const blocked = await hook({ toolName: "functions.terminal", input: { command }, cwd: root }) as { block?: boolean } | undefined;
    assert(blocked?.block === true, `${command} should be blocked`);
  }
}

{
  const root = repo();
  enableWatcher(root);
  writeContract(root, validContract({ ownership: { highRiskPaths: ["secrets/**"], generatedPaths: [], lockfiles: ["pnpm-lock.yaml"] } }));
  await watch(root, "preflight");
  const hook = hooks.tool_call[0];
  const noTarget = await hook({ toolName: "write_file", input: { content: "x" }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(noTarget?.block === true, "edit tool with no target should fail closed");
  const explicitPatchTarget = await hook({ toolName: "functions.patch", input: { path: "clean.txt", old_string: "a", new_string: "b" }, cwd: root }) as { block?: boolean } | undefined;
  assert(explicitPatchTarget === undefined || explicitPatchTarget.block !== true, "patch replace mode with explicit safe path should be allowed");
  const arrayTarget = await hook({ toolName: "edit", input: { files: ["secrets/prod.env"] }, cwd: root }) as { block?: boolean; reason?: string } | undefined;
  assert(arrayTarget?.block === true && arrayTarget.reason?.includes("secrets/prod.env"), "edit files[] target should be inspected");
  const bodyAlias = await hook({ toolName: "patch", input: { body: "*** Begin Patch\n*** Update File: secrets/prod.env\n@@\n-a\n+b\n*** End Patch\n" }, cwd: root }) as { block?: boolean } | undefined;
  assert(bodyAlias?.block === true, "patch body alias should be parsed");
  const nested = await hook({ toolName: "multi_tool_use.parallel", input: { tool_uses: [{ recipient_name: "functions.write_file", parameters: { path: "secrets/nested.env", content: "x" } }] }, cwd: root }) as { block?: boolean } | undefined;
  assert(nested?.block === true, "multi_tool_use.parallel nested edit should be inspected");
}

{
  const root = repo();
  writeContract(root, validContract());
  writeFileSync(join(root, "tracked.txt"), "base\n"); git(["add", "tracked.txt"], root); git(["commit", "-m", "init"], root);
  writeFileSync(join(root, "new.txt"), "one\n");
  const first = (await watch(root, "status")).details.currentDiffHash;
  writeFileSync(join(root, "new.txt"), "two\n");
  const second = (await watch(root, "status")).details.currentDiffHash;
  assert(first !== second, "untracked regular file content changes should change diffHash");
}

{
  const root = repo();
  writeContract(root, validContract({ commands: { leak: { cmd: "API_KEY=super-secret-value node -e \"process.exit(0)\"", source: "fixture", confidence: "verified" } }, gates: { beforeCommit: { description: "leak", commands: ["leak"], required: true } } }));
  await tool("workflow_note").execute("note", { cwd: root, note: "password=hunter2 token=super-secret-value" });
  await tool("workflow_gate").execute("gate", { cwd: root, gate: "beforeCommit", dryRun: true });
  const log = readFileSync(join(root, ".pi/runs/workflow-watcher.log"), "utf8");
  const state = readFileSync(join(root, ".pi/runs/workflow-state.json"), "utf8");
  assert(!log.includes("hunter2") && !log.includes("super-secret-value"), "watcher log should redact note and command secrets");
  assert(!state.includes("hunter2") && !state.includes("super-secret-value"), "watcher state should not persist raw note secrets");
}

console.log(`registered=${tools.map((candidate) => candidate.name).join(",")} hooks=${Object.keys(hooks).join(",")}`);
