import type { AgentToolResult } from "./types.ts";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}
