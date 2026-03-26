export type AgentStatus = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

export interface AgentEvent {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadId?: string;
  threadName?: string;
}

export const TERMINAL_STATUSES = new Set<AgentStatus>(["done", "error", "interrupted"]);
