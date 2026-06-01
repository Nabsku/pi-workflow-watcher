import { readFileSync } from "node:fs";

export type WorkflowLessons = {
  specSignals: {
    spec: boolean;
    acceptance: boolean;
    testPlan: boolean;
  };
  activeSliceNudge?: string;
};

export const architectureChecklist = [
  "contracts/API boundaries are explicit and backward-compatible",
  "data flow, state ownership, and failure modes are reviewed",
  "security/privacy and dependency/lockfile risks are called out",
  "tests cover the changed architecture seam, not only happy paths",
];

export function inspectWorkflowLessons(planPath: string | undefined, activeSlice: string | undefined): WorkflowLessons {
  const text = readPlan(planPath);
  const specSignals = detectSpecSignals(text);
  const activeSliceNudge = verticalSliceNudge(activeSlice);
  return { specSignals, activeSliceNudge };
}

export function readPlan(planPath: string | undefined): string {
  if (!planPath) return "";
  try { return readFileSync(planPath, "utf8"); }
  catch { return ""; }
}

export function detectSpecSignals(planText: string): WorkflowLessons["specSignals"] {
  return {
    spec: /(^|\n)\s{0,3}#{1,6}\s*(spec|specification|requirements?)\b/i.test(planText),
    acceptance: /(^|\n)\s{0,3}#{1,6}\s*acceptance\s+(criteria|tests?)\b|\bacceptance\s+criteria\b/i.test(planText),
    testPlan: /(^|\n)\s{0,3}#{1,6}\s*test\s+plan\b|\btest\s+plan\b/i.test(planText),
  };
}

export function verticalSliceNudge(activeSlice: string | undefined): string | undefined {
  if (!activeSlice) return undefined;
  const normalized = activeSlice.toLowerCase();
  const broadWords = ["everything", "all ", "backend", "frontend", "docs", "documentation", "tests", "deployment", "infra", "architecture", "refactor", "cleanup"];
  const commaOrAnd = /,|\band\b|\//i.test(activeSlice);
  const broadHits = broadWords.filter((word) => normalized.includes(word)).length;
  if (activeSlice.length < 80 && broadHits < 2 && !commaOrAnd) return undefined;
  return `Narrow active slice to one vertical slice with a user-visible outcome, bounded files, and focused checks before broad implementation.`;
}

export function formatSpecSignals(lessons: WorkflowLessons): string[] {
  return [
    `spec: ${lessons.specSignals.spec ? "present" : "missing"}`,
    `acceptance criteria: ${lessons.specSignals.acceptance ? "present" : "missing"}`,
    `test plan: ${lessons.specSignals.testPlan ? "present" : "missing"}`,
  ];
}

export function formatWorkflowLessons(lessons: WorkflowLessons): string[] {
  return [
    ...formatSpecSignals(lessons).map((line) => `- ${line}`),
    ...(lessons.activeSliceNudge ? [`- ${lessons.activeSliceNudge}`] : []),
  ];
}
