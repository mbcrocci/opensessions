import type { AgentEvent } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";

const MAX_EVENT_TIMESTAMPS = 30;
const TERMINAL_PRUNE_MS = 5 * 60 * 1000;

const STATUS_PRIORITY: Record<string, number> = {
  running: 5,
  error: 4,
  interrupted: 3,
  waiting: 2,
  done: 1,
  idle: 0,
};

function instanceKey(event: AgentEvent): string {
  return event.threadId ? `${event.agent}:${event.threadId}` : event.agent;
}

export class AgentTracker {
  // Outer key: session name, inner key: instance key (agent or agent:threadId)
  private instances = new Map<string, Map<string, AgentEvent>>();
  private eventTimestamps = new Map<string, number[]>();
  private unseen = new Set<string>();
  private active = new Set<string>();

  applyEvent(event: AgentEvent): void {
    const key = instanceKey(event);

    // Store instance
    let sessionInstances = this.instances.get(event.session);
    if (!sessionInstances) {
      sessionInstances = new Map();
      this.instances.set(event.session, sessionInstances);
    }
    sessionInstances.set(key, event);

    // Track event timestamps
    let timestamps = this.eventTimestamps.get(event.session);
    if (!timestamps) {
      timestamps = [];
      this.eventTimestamps.set(event.session, timestamps);
    }
    timestamps.push(event.ts);
    if (timestamps.length > MAX_EVENT_TIMESTAMPS) {
      timestamps.splice(0, timestamps.length - MAX_EVENT_TIMESTAMPS);
    }

    // Unseen tracking based on aggregate state
    if (TERMINAL_STATUSES.has(event.status)) {
      if (!this.active.has(event.session)) {
        this.unseen.add(event.session);
      }
    } else {
      this.unseen.delete(event.session);
    }
  }

  /** Returns the most important agent state for backward compat */
  getState(session: string): AgentEvent | null {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances || sessionInstances.size === 0) return null;

    let best: AgentEvent | null = null;
    let bestPriority = -1;
    for (const event of sessionInstances.values()) {
      const p = STATUS_PRIORITY[event.status] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = event;
      }
    }
    return best;
  }

  /** Returns all agent instances for a session (including terminal states) */
  getAgents(session: string): AgentEvent[] {
    const sessionInstances = this.instances.get(session);
    if (!sessionInstances) return [];
    return [...sessionInstances.values()];
  }

  /** Returns recent event timestamps for sparkline rendering */
  getEventTimestamps(session: string): number[] {
    return this.eventTimestamps.get(session) ?? [];
  }

  markSeen(session: string): boolean {
    const cleared = this.unseen.delete(session);
    if (cleared) {
      // Only remove terminal instances, keep running/waiting ones
      const sessionInstances = this.instances.get(session);
      if (sessionInstances) {
        for (const [key, event] of sessionInstances) {
          if (TERMINAL_STATUSES.has(event.status)) {
            sessionInstances.delete(key);
          }
        }
        if (sessionInstances.size === 0) this.instances.delete(session);
      }
    }
    return cleared;
  }

  pruneStuck(timeoutMs: number): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      for (const [key, event] of sessionInstances) {
        if (event.status === "running" && now - event.ts > timeoutMs) {
          sessionInstances.delete(key);
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
        this.unseen.delete(session);
      }
    }
  }

  /** Auto-prune terminal instances older than timeout, but only if session is not unseen */
  pruneTerminal(): void {
    const now = Date.now();
    for (const [session, sessionInstances] of this.instances) {
      if (this.unseen.has(session)) continue; // Don't prune unseen — user hasn't looked yet
      for (const [key, event] of sessionInstances) {
        if (TERMINAL_STATUSES.has(event.status) && now - event.ts > TERMINAL_PRUNE_MS) {
          sessionInstances.delete(key);
        }
      }
      if (sessionInstances.size === 0) {
        this.instances.delete(session);
      }
    }
  }

  isUnseen(session: string): boolean {
    return this.unseen.has(session);
  }

  getUnseen(): string[] {
    return [...this.unseen];
  }

  handleFocus(session: string): boolean {
    this.active.clear();
    this.active.add(session);

    const hadUnseen = this.unseen.delete(session);
    if (hadUnseen) {
      // Only clear terminal instances when user visits
      const sessionInstances = this.instances.get(session);
      if (sessionInstances) {
        for (const [key, event] of sessionInstances) {
          if (TERMINAL_STATUSES.has(event.status)) {
            sessionInstances.delete(key);
          }
        }
        if (sessionInstances.size === 0) this.instances.delete(session);
      }
    }
    return hadUnseen;
  }

  setActiveSessions(sessions: string[]): void {
    this.active.clear();
    for (const s of sessions) this.active.add(s);
  }
}
