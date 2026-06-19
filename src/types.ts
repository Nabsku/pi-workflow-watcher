import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type Severity = "ok" | "nudge" | "blocker";
export type WatchMode = "status" | "planning" | "preflight" | "before-slice" | "slice-complete" | "after-slice" | "before-commit" | "final";
export type WatchVerbosity = "next" | "summary" | "full";
export type Confidence = "verified" | "inferred" | "absent";

export type Finding = { severity: Severity; title: string; detail: string };
export type CommandSpec = { cmd?: string | null; source?: string; confidence?: Confidence | string; timeoutSeconds?: number; requiresNetwork?: boolean; mutatesRepo?: boolean };
export type GateSpec = { description?: string; commands?: string[]; required?: boolean; allowEmpty?: boolean };
export type GateRunStatus = "pass" | "fail" | "dry-run";
export type EvidenceSource = "workflow_gate" | "reviewer_tool" | "oracle_tool" | "manual_note" | "reviewer_evidence";
export type GateCommandRun = { alias: string; cmd: string; status: GateRunStatus; exitCode?: number | null; signal?: NodeJS.Signals | null; durationMs?: number; stdout?: string; stderr?: string; timeoutSeconds?: number; timedOut?: boolean; error?: string };
export type GateDetails = { root: string; gate: string; dryRun: boolean; status: GateRunStatus; logPath?: string; statePath?: string; commands: GateCommandRun[]; error?: string };
export type NoteDetails = { root: string; path: string; statePath?: string; appended: boolean; status?: "ok" | "fail"; error?: string };
export type AcceptanceImportDetails = { root: string; accepted: boolean; source?: EvidenceSource; verdict?: string; statePath?: string; artifactPath?: string; diffHash?: string; error?: string };
export type ReviewEvidenceImportDetails = AcceptanceImportDetails & { requestPath?: string };
export type ReviewMode = "commit" | "slice" | "present";
export type ReviewRequestStatus = "pending" | "consumed";
export type ReviewRequest = { schema: "pi-workflow-review-request/v1"; id: string; createdAt: string; repo: string; diffHash: string; expectedFiles: string[]; mode: ReviewMode; allowedVerdicts: string[]; status: ReviewRequestStatus; consumedAt: string | null };
export type ReviewEvidenceCriterion = { id?: string; status?: string; evidence?: string; required?: boolean };
export type ReviewEvidence = { schema: "pi-workflow-review-evidence/v1"; reviewRequestId: string; repo: string; reviewedDiffHash: string; reviewedAt: string; reviewedFiles: string[]; reviewer?: Record<string, unknown>; verdict: string; criteria: ReviewEvidenceCriterion[]; verification?: unknown[]; residualRisks?: unknown[] };
export type ReviewEvidenceParseResult = { ok: true; evidence: ReviewEvidence } | { ok: false; error: string };
export type CheckpointMode = WatchMode | "gate" | "note";
export type EvidenceDetails = { root: string; statePath: string; currentDiffHash: string; commitReady: boolean; review?: WorkflowState["lastReviewVerdict"]; reviewTrusted: boolean; reviewFresh: boolean; reviewVerdictOk: boolean; manualNote?: WorkflowState["lastNote"]; manualNoteStatus: "none" | "breadcrumb" | "untrusted-review"; gate?: WorkflowState["lastGateResult"]; gateFresh: boolean; gateTrusted: boolean; checkpointFresh: boolean; missing: string[]; nextActions: string[] };
export type EvidenceBundleDetails = { root: string; bundlePath: string; currentDiffHash: string; commitReady: boolean; missing: string[]; nextAction: string; evidencePath: string; activePlan?: string; activeSlice?: string; touchedFiles: string[] };
export type DoctorDetails = { root: string; ready: boolean; contractStatus: ContractRead["status"]; blockers: string[]; warnings: string[]; repairSteps: string[]; artifactPaths: { runsDir: string; fallbackUsed: boolean; error?: string }; commands: string[]; gates: string[]; commitReady: boolean; commitMissing: string[]; workflowLessons?: unknown };
export type WhyDetails = { root: string; target: "workflow" | "commit" | "edit"; path?: string; blocked: boolean; source: string; reason: string; nextAction: string; evidence?: EvidenceDetails; finding?: Finding };
export type ReviewPacketDetails = { root: string; activePlan?: string; activeSlice?: string; touchedFiles: string[]; excludedFiles?: string[]; currentDiffHash: string; ownership: { highRisk: string[]; generated: string[]; lockfiles: string[] }; gateStatus: string; evidenceStatus: string; acceptanceRequirements: string[]; importRequirements: string[]; request?: ReviewRequest; requestPath?: string; requestError?: string; packet: string };
export type ProgressDetails = { root: string; activePlan?: string; currentSlice?: string; counts: { open?: number; completed?: number; reviewed?: number; gated?: number; total?: number; limitations: string[] }; staleEvidence: { review: boolean; gate: boolean; checkpoint: boolean; messages: string[] }; nextSafeAction: string; planParse: { parseable: boolean; limitations: string[] }; evidence: Pick<EvidenceDetails, "commitReady" | "reviewTrusted" | "reviewFresh" | "gateTrusted" | "gateFresh" | "missing">; workflowLessons?: unknown };
export type WorkflowCompleteDetails = { root: string; status: "complete" | "blocked"; clean: boolean; activePlan?: string; statePath: string; completedAt?: string; blockers: string[]; evidence: Pick<EvidenceDetails, "commitReady" | "reviewTrusted" | "reviewFresh" | "gateTrusted" | "gateFresh" | "missing">; counts: ProgressDetails["counts"] };
export type WorkflowState = {
  version: 1;
  activePlan?: string;
  lastNote?: { at: string; note: string };
  dirtyBaseline?: { at: string; diffHash: string; dirtyFiles: string[] };
  dirtyOverlapApprovals?: Array<{ path: string; reason: string; at: string; baselineDiffHash: string; consumedAt?: string }>;
  lastEdit?: { at: string; path?: string; tool?: string; diffHash: string; dirtyFiles: string[] };
  lastReviewVerdict?: { verdict: string; at: string; diffHash: string; dirtyFiles: string[]; stale?: boolean; source?: EvidenceSource; artifactPath?: string };
  lastGateResult?: { gate: string; status: "pass" | "fail"; at: string; diffHash: string; dirtyFiles: string[]; source?: EvidenceSource };
  checkpoint?: { at: string; mode: CheckpointMode; diffHash: string; dirtyFiles: string[] };
};
export type LedgerEvent = {
  type: "gate_run" | "review_evidence" | "note" | "blocker" | "dirty_overlap_approval" | "dirty_overlap_approval_consumed";
  at: string;
  diffHash?: string;
  gate?: string;
  verdict?: string;
  status?: string;
  source?: EvidenceSource | "workflow_gate" | "workflow_watch";
  notePreview?: string;
  commands?: Array<{ alias: string; status: GateRunStatus; exitCode?: number | null; signal?: NodeJS.Signals | null; durationMs?: number; timeoutSeconds?: number; timedOut?: boolean; error?: string; stdoutSummary?: string; stderrSummary?: string }>;
  artifactPath?: string;
  blockerCount?: number;
  path?: string;
  reason?: string;
  baselineDiffHash?: string;
};

export type WorkflowContract = {
  $schema?: string;
  version?: number;
  project?: { name?: string; kind?: string; root?: string; packageManager?: string | null; primaryLanguages?: string[] };
  commands?: Record<string, CommandSpec>;
  gates?: Record<string, GateSpec>;
  rules?: {
    requirePlanForMultiFileChanges?: boolean;
    requireReviewBeforeCommit?: boolean;
    requireAdversarialReviewAfterEveryTask?: boolean;
    oneWriter?: boolean;
    commitPolicy?: "never" | "ask" | "plan" | "always" | string;
    allowedSubagents?: string[];
    stopOn?: string[];
  };
  artifacts?: { plansDir?: string; runsDir?: string; agentInstructions?: string };
  ownership?: { highRiskPaths?: string[]; generatedPaths?: string[]; lockfiles?: string[] };
  notes?: string[];
};

export type ContractRead =
  | { status: "missing"; contract: null; error?: undefined }
  | { status: "invalid-json"; contract: null; error: string }
  | { status: "ok"; contract: WorkflowContract; error?: undefined };

export type WatchDetails = {
  root: string;
  mode: WatchMode;
  verbosity?: WatchVerbosity;
  hasContract: boolean;
  contractStatus: ContractRead["status"];
  contractErrors?: string[];
  dirtyFiles: string[];
  planFiles: string[];
  severity: Severity;
  blockers: number;
  nudges: number;
  nextAction: string;
  activePlan?: string;
  openPlanTasks?: number;
  reviewVerdicts?: string[];
  statePath?: string;
  checkpointDiffHash?: string;
  currentDiffHash?: string;
  reviewStale?: boolean;
  lastReviewVerdict?: string;
  lastGateStatus?: string;
  lastGateName?: string;
  activePlanInference?: string[];
  workflowLessons?: unknown;
};

export type PlanInference = { selectedPlan?: string; findings: Finding[]; explanation: string[] };
export type WorkflowUi = { setStatus?: (key: string, value: string | undefined) => void; setWidget?: (key: string, lines: string[] | undefined, options?: { placement?: string }) => void; notify?: (message: string, level?: string) => void; theme?: { fg?: (color: string, text: string) => string; bold?: (text: string) => string } };
export type WorkflowUiContext = { cwd?: string; hasUI?: boolean; ui?: WorkflowUi };

export type { AgentToolResult };
