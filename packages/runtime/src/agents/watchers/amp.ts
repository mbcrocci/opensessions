/**
 * Amp agent watcher — Cloud API + DTW WebSocket edition
 *
 * Uses a two-tier strategy for watching Amp thread status:
 *
 * 1. **Polling** (Phase 1): Periodically fetches the thread list API to
 *    discover threads and detect status changes. Used for seed, discovery
 *    of new threads, and as a fallback when WebSocket isn't available.
 *
 * 2. **DTW WebSocket** (Phase 2): For threads detected as actively running,
 *    connects to the Durable Thread Worker WebSocket for real-time
 *    `agentStates` updates. Provides instant status transitions without
 *    polling. Automatically disconnects on terminal states and falls back
 *    to polling on failure.
 *
 * ## Data source
 *
 * Amp stores threads in the cloud (Durable Thread Workers / DTW).
 * The local directory ~/.local/share/amp/threads/ is no longer written to.
 *
 * - Credentials: ~/.local/share/amp/secrets.json
 *   Key format: "apiKey@<ampUrl>" (e.g. "apiKey@https://ampcode.com/")
 *   Fallback: "apiKey" field
 *
 * - Amp URL: ~/.config/amp/settings.json `.url` field
 *   Default: https://ampcode.com
 *
 * - Thread list: GET <ampUrl>/api/threads?limit=20
 *   Returns array of threads with id, title, v, updatedAt,
 *   env.initial.trees[0].uri (project dir as file:// URI)
 *
 * - Thread detail: GET <ampUrl>/api/threads/<id>
 *   Returns full thread with messages[] array.
 *   Each message has role, state.type, state.stopReason — exactly
 *   what our determineStatus() function parses.
 *
 * - DTW WebSocket: POST <ampUrl>/api/durable-thread-workers with {threadId}
 *   returns {wsToken}. Connect to wss://production.ampworkers.com/threads/<id>?wsToken=<token>
 *   to receive real-time agentStates stream: { state: "idle"|"running"|"tool-running"|"waiting" }
 *
 * ## Amp Thread Message Lifecycle
 *
 * ### Message structure
 *   - role: "user" | "assistant"
 *   - state?: { type: string; stopReason?: string }  (assistant only)
 *   - interrupted?: boolean  (user only)
 *   - content: ContentItem[]  (tool_use, tool_result, text, thinking)
 *
 * ### State types (assistant messages)
 *   - `streaming`  → "running"
 *   - `complete` + stopReason:
 *       - `end_turn`   → "done"
 *       - `tool_use`   → "running"
 *       - other        → "error"
 *   - `cancelled`  → "interrupted"
 *
 * ### User messages
 *   - content=[tool_result] with run.status=in-progress → "tool-running"
 *   - otherwise → "running"
 *
 * ### Waiting / stale detection
 *   After TOOL_WAIT_MS (3s) with no version changes at a tool boundary,
 *   "running" → "waiting". After STUCK_RUNNING_MS (2m) with no version
 *   changes while actively running/waiting, → "stale".
 *
 * All network I/O is async to avoid blocking the server event loop.
 */

import { join } from "path";
import { homedir } from "os";
import type { AgentStatus } from "../../contracts/agent";
import { TERMINAL_STATUSES } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";

interface MessageState {
  type?: string;
  stopReason?: string;
}

interface Message {
  role?: string;
  state?: MessageState;
  interrupted?: boolean;
  content?: ContentItem[] | string;
}

interface ContentItem {
  type?: string;
  run?: {
    status?: string;
  };
}

interface ThreadSnapshot {
  status: AgentStatus;
  version: number;
  title?: string;
  projectDir?: string;
  /** Timestamp when we last saw meaningful progress. For stuck detection. */
  lastGrowthAt?: number;
  /** Whether this running snapshot represents a quiet tool boundary that should become waiting. */
  waitingEligible?: boolean;
  /** Last time this thread appeared in the recent thread list. */
  lastListedAt: number;
  /** Last time the effective status changed. Used to ignore stale async poll responses. */
  statusUpdatedAt: number;
}

interface WebSocketConnection {
  gen: number;
  phase: "connecting" | "open";
  ws: WebSocket | null;
}

/** API thread list item — subset of fields we use */
interface ApiThreadSummary {
  id: string;
  v: number;
  title?: string;
  updatedAt?: string;
  env?: {
    initial?: {
      trees?: Array<{ uri?: string }>;
    };
  };
}

/** API thread detail — subset of fields we use */
interface ApiThreadDetail {
  id: string;
  v: number;
  title?: string;
  messages?: Message[];
  env?: {
    initial?: {
      trees?: Array<{ uri?: string }>;
    };
  };
}

/** POST /api/durable-thread-workers response */
interface DtwTokenResponse {
  wsToken: string;
  threadVersion?: number;
  usesDtw?: boolean;
}

/** WebSocket agentStates message shape */
interface AgentStateMessage {
  type?: string;
  state?: string;
}

const DTW_WS_BASE = "wss://production.ampworkers.com";
const POLL_MS = 2000;
/** How long to wait before promoting quiet tool boundaries from running → waiting */
const TOOL_WAIT_MS = 3_000;
/** How long Amp can stay quiet before we consider the thread stale */
const STUCK_RUNNING_MS = 2 * 60 * 1000;
/** Only consider threads updated in the last 5 minutes */
const RECENT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const WS_RETRY_MS = 5_000;

/**
 * Determine the agent status from the last message in a thread.
 *
 * Returns the status implied by the message. Called with the last
 * element of the `messages` array from the thread JSON.
 */
export function determineStatus(lastMsg: { role?: string; state?: MessageState; interrupted?: boolean; content?: ContentItem[] | string } | null): AgentStatus {
  if (!lastMsg?.role) return "idle";

  if (lastMsg.role === "user") {
    if (hasToolResultRunStatus(lastMsg.content, "in-progress")) return "tool-running";
    return "running";
  }

  if (lastMsg.role === "assistant") {
    const state = lastMsg.state;
    if (!state || !state.type) return "running";

    if (state.type === "streaming") return "running";
    if (state.type === "cancelled") return "interrupted";

    if (state.type === "complete") {
      if (state.stopReason === "tool_use") return "running";
      if (state.stopReason === "end_turn") return "done";
      return "error";
    }

    return "running";
  }

  return "idle";
}

function hasContentType(content: Message["content"], type: string): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === type);
}

function hasToolResultRunStatus(content: Message["content"], status: string): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === "tool_result" && item.run?.status === status);
}

function isWaitingCandidate(lastMsg: Message | null): boolean {
  if (!lastMsg) return false;

  if (lastMsg.role === "assistant") {
    return lastMsg.state?.type === "complete" && lastMsg.state.stopReason === "tool_use";
  }

  if (lastMsg.role === "user") {
    return hasContentType(lastMsg.content, "tool_result") && !hasToolResultRunStatus(lastMsg.content, "in-progress");
  }

  return false;
}

async function loadAmpUrl(): Promise<string> {
  try {
    const settingsPath = join(homedir(), ".config", "amp", "settings.json");
    const raw = await Bun.file(settingsPath).text();
    const settings = JSON.parse(raw);
    if (settings.url && typeof settings.url === "string") return settings.url.replace(/\/$/, "");
  } catch {
  }
  return "https://ampcode.com";
}

async function loadApiKey(ampUrl: string): Promise<string | null> {
  try {
    const secretsPath = join(homedir(), ".local", "share", "amp", "secrets.json");
    const raw = await Bun.file(secretsPath).text();
    const secrets = JSON.parse(raw);

    const urlWithSlash = ampUrl.endsWith("/") ? ampUrl : `${ampUrl}/`;
    const urlWithoutSlash = ampUrl.replace(/\/$/, "");

    const key =
      secrets[`apiKey@${urlWithSlash}`] ??
      secrets[`apiKey@${urlWithoutSlash}`] ??
      secrets.apiKey;

    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function extractProjectDir(thread: { env?: { initial?: { trees?: Array<{ uri?: string }> } } }): string | undefined {
  const uri = thread.env?.initial?.trees?.[0]?.uri ?? "";
  return uri.startsWith("file://") ? uri.slice(7) : undefined;
}

export class AmpAgentWatcher implements AgentWatcher {
  readonly name = "amp";

  /** Internal thread state — exposed for testing via (watcher as any).threads */
  private threads = new Map<string, ThreadSnapshot>();
  /** Active WebSocket connections per thread ID */
  private wsConnections = new Map<string, WebSocketConnection>();
  private wsRetryAfter = new Map<string, number>();
  private requestControllers = new Set<AbortController>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private scanning = false;
  private seeded = false;
  private stopped = false;
  private lifecycle = 0;
  private wsGeneration = 0;

  /** Loaded once at start. Overridable for testing. */
  private ampUrl: string | null = null;
  private apiKey: string | null = null;

  _fetchTimeoutMs = FETCH_TIMEOUT_MS;
  _wsRetryMs = WS_RETRY_MS;

  /**
   * Override the fetch function for testing.
   * Defaults to globalThis.fetch.
   */
  _fetch: typeof fetch = globalThis.fetch.bind(globalThis);

  /**
   * Override WebSocket constructor for testing.
   * Defaults to globalThis.WebSocket.
   */
  _WebSocket: typeof WebSocket = globalThis.WebSocket;

  start(ctx: AgentWatcherContext): void {
    this.stopped = false;
    this.ctx = ctx;
    const lifecycle = ++this.lifecycle;
    void this.initAndPoll(lifecycle);
  }

  stop(): void {
    this.stopped = true;
    this.lifecycle++;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const controller of this.requestControllers) {
      try { controller.abort(); } catch {}
    }
    this.requestControllers.clear();
    for (const [, connection] of this.wsConnections) {
      if (!connection.ws) continue;
      try { connection.ws.close(); } catch {}
    }
    this.wsConnections.clear();
    this.wsRetryAfter.clear();
    this.threads.clear();
    this.seeded = false;
    this.scanning = false;
    this.ampUrl = null;
    this.apiKey = null;
    this.ctx = null;
  }

  private isActive(lifecycle = this.lifecycle): boolean {
    return !this.stopped && this.ctx !== null && this.lifecycle === lifecycle;
  }

  private resolveMuxSession(projectDir?: string): string | null {
    if (!this.ctx || !projectDir) return null;
    const session = this.ctx.resolveSession(projectDir);
    return session && session !== "unknown" ? session : null;
  }

  private shouldStreamThread(snapshot: ThreadSnapshot | undefined): boolean {
    return !!snapshot
      && snapshot.status !== "idle"
      && !TERMINAL_STATUSES.has(snapshot.status)
      && !!this.resolveMuxSession(snapshot.projectDir);
  }

  private scheduleRetry(threadId: string, now = Date.now()): void {
    this.wsRetryAfter.set(threadId, now + this._wsRetryMs);
  }

  private clearRetry(threadId: string): void {
    this.wsRetryAfter.delete(threadId);
  }

  private shouldRetry(threadId: string, now = Date.now()): boolean {
    return (this.wsRetryAfter.get(threadId) ?? 0) <= now;
  }

  private disconnectWebSocket(threadId: string): void {
    const connection = this.wsConnections.get(threadId);
    this.wsConnections.delete(threadId);
    this.clearRetry(threadId);
    if (connection?.ws) {
      try { connection.ws.close(); } catch {}
    }
  }

  private syncStreamConnection(threadId: string, snapshot: ThreadSnapshot | undefined, now: number, lifecycle = this.lifecycle): void {
    if (!this.isActive(lifecycle)) return;
    if (!this.shouldStreamThread(snapshot)) {
      this.disconnectWebSocket(threadId);
      return;
    }
    if (this.wsConnections.has(threadId)) return;
    if (!this.shouldRetry(threadId, now)) return;
    void this.connectWebSocket(threadId, lifecycle);
  }

  private pruneDormantThreads(now: number): void {
    for (const [threadId, snapshot] of this.threads) {
      if (now - snapshot.lastListedAt <= RECENT_MS) continue;
      this.disconnectWebSocket(threadId);
      this.threads.delete(threadId);
    }
  }

  private async initAndPoll(lifecycle: number): Promise<void> {
    const ampUrl = await loadAmpUrl();
    if (!this.isActive(lifecycle)) return;
    this.ampUrl = ampUrl;

    const apiKey = await loadApiKey(ampUrl);
    if (!this.isActive(lifecycle)) return;
    this.apiKey = apiKey;
    if (!apiKey) return;

    await this.poll(lifecycle);
    if (!this.isActive(lifecycle)) return;
    this.pollTimer = setInterval(() => {
      void this.poll(lifecycle);
    }, POLL_MS);
  }

  /** Emit a status change event if we have a valid session mapping */
  private emitStatus(threadId: string, snapshot: ThreadSnapshot): boolean {
    if (!this.ctx || snapshot.status === "idle") return false;

    const session = this.resolveMuxSession(snapshot.projectDir);
    if (!session) return false;

    this.ctx.emit({
      agent: "amp",
      session,
      status: snapshot.status,
      ts: Date.now(),
      threadId,
      threadName: snapshot.title,
    });
    return true;
  }

  private async poll(lifecycle = this.lifecycle): Promise<void> {
    if (this.scanning || !this.isActive(lifecycle) || !this.ampUrl || !this.apiKey) return;
    this.scanning = true;
    const initialSeed = !this.seeded;

    try {
      const threads = await this.fetchThreadList(lifecycle);
      if (!threads) return;
      if (!this.isActive(lifecycle)) return;

      const now = Date.now();

      for (const thread of threads) {
        const updatedAt = thread.updatedAt ? new Date(thread.updatedAt).getTime() : 0;
        if (now - updatedAt > RECENT_MS) continue;

        const prev = this.threads.get(thread.id);
        if (prev) prev.lastListedAt = now;

        if (prev && thread.v === prev.version) {
          if (!this.seeded) continue;

          if (prev.status === "running" && prev.waitingEligible && prev.lastGrowthAt && now - prev.lastGrowthAt >= TOOL_WAIT_MS) {
            prev.status = "waiting";
            prev.waitingEligible = false;
            prev.statusUpdatedAt = now;
            this.emitStatus(thread.id, prev);
            this.syncStreamConnection(thread.id, prev, now, lifecycle);
            continue;
          }

          if ((prev.status === "tool-running" || prev.status === "waiting" || (prev.status === "running" && !prev.waitingEligible)) && prev.lastGrowthAt && now - prev.lastGrowthAt >= STUCK_RUNNING_MS) {
            prev.status = "stale";
            prev.lastGrowthAt = undefined;
            prev.waitingEligible = false;
            prev.statusUpdatedAt = now;
            this.emitStatus(thread.id, prev);
            this.syncStreamConnection(thread.id, prev, now, lifecycle);
            continue;
          }

          this.syncStreamConnection(thread.id, prev, now, lifecycle);
          continue;
        }

        await this.processThread(thread.id, thread, now, lifecycle);
        if (!this.isActive(lifecycle)) return;
      }

      this.pruneDormantThreads(now);
    } finally {
      if (initialSeed && this.isActive(lifecycle)) {
        this.seeded = true;
        const now = Date.now();
        for (const [threadId, snapshot] of this.threads) {
          this.emitStatus(threadId, snapshot);
          this.syncStreamConnection(threadId, snapshot, now, lifecycle);
        }
      }
      this.scanning = false;
    }
  }

  private async processThread(
    threadId: string,
    summary: ApiThreadSummary,
    now: number,
    lifecycle = this.lifecycle,
  ): Promise<void> {
    const fetchStartedAt = Date.now();
    const detail = await this.fetchThreadDetail(threadId, lifecycle);
    if (!detail) return;
    if (!this.isActive(lifecycle)) return;

    const messages = detail.messages ?? [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const projectDir = extractProjectDir(detail);
    const title = detail.title || undefined;
    const version = detail.v ?? summary.v ?? 0;
    const current = this.threads.get(threadId);

    if (current && current.version > version) return;

    const polledStatus = determineStatus(lastMsg ? { role: lastMsg.role, state: lastMsg.state, interrupted: lastMsg.interrupted, content: lastMsg.content } : null);
    const polledWaitingEligible = polledStatus === "running" && isWaitingCandidate(lastMsg);
    const preserveRealtimeStatus = !!current && current.version === version && current.statusUpdatedAt > fetchStartedAt;
    const status = preserveRealtimeStatus ? current.status : polledStatus;
    const waitingEligible = preserveRealtimeStatus ? current.waitingEligible : polledWaitingEligible;
    const base = current;
    const statusChanged = base?.status !== status;
    const titleChanged = base?.title !== title;
    const projectDirChanged = base?.projectDir !== projectDir;

    if (base && version === base.version && !statusChanged && !titleChanged && !projectDirChanged) {
      base.lastListedAt = now;
      base.waitingEligible = waitingEligible;
      return;
    }

    const snapshot: ThreadSnapshot = {
      status,
      version,
      title,
      projectDir,
      lastGrowthAt: preserveRealtimeStatus
        ? current.lastGrowthAt
        : status === "running" || status === "tool-running"
          ? now
          : status === "waiting"
            ? current?.lastGrowthAt ?? now
            : undefined,
      waitingEligible,
      lastListedAt: now,
      statusUpdatedAt: preserveRealtimeStatus
        ? current.statusUpdatedAt
        : statusChanged
          ? now
          : base?.statusUpdatedAt ?? now,
    };
    this.threads.set(threadId, snapshot);

    if (!this.seeded) return;

    if (statusChanged || titleChanged || projectDirChanged) this.emitStatus(threadId, snapshot);
    this.syncStreamConnection(threadId, snapshot, now, lifecycle);
  }

  private async connectWebSocket(threadId: string, lifecycle = this.lifecycle): Promise<void> {
    if (!this.isActive(lifecycle) || !this.ampUrl || !this.apiKey) return;
    if (this.wsConnections.has(threadId)) return;
    if (!this.shouldRetry(threadId)) return;

    const snapshot = this.threads.get(threadId);
    if (!this.shouldStreamThread(snapshot)) return;

    const gen = ++this.wsGeneration;
    this.wsConnections.set(threadId, { gen, phase: "connecting", ws: null });

    const token = await this.fetchDtwToken(threadId, lifecycle);
    const connection = this.wsConnections.get(threadId);
    if (!this.isActive(lifecycle) || !connection || connection.gen !== gen) return;

    if (!token) {
      this.wsConnections.delete(threadId);
      this.scheduleRetry(threadId);
      return;
    }

    const latestSnapshot = this.threads.get(threadId);
    if (!this.shouldStreamThread(latestSnapshot)) {
      this.wsConnections.delete(threadId);
      this.clearRetry(threadId);
      return;
    }

    try {
      const wsUrl = `${DTW_WS_BASE}/threads/${threadId}?wsToken=${token}`;
      const ws = new this._WebSocket(wsUrl);
      const current = this.wsConnections.get(threadId);
      if (!current || current.gen !== gen) {
        try { ws.close(); } catch {}
        return;
      }

      current.phase = "open";
      current.ws = ws;
      this.clearRetry(threadId);

      ws.onmessage = (event) => {
        this.handleWsMessage(threadId, gen, event.data);
      };

      ws.onclose = () => {
        const active = this.wsConnections.get(threadId);
        if (!active || active.gen !== gen || active.ws !== ws) return;
        this.wsConnections.delete(threadId);
        if (this.shouldStreamThread(this.threads.get(threadId)) && this.isActive(lifecycle)) {
          this.scheduleRetry(threadId);
        } else {
          this.clearRetry(threadId);
        }
      };

      ws.onerror = () => {
        const active = this.wsConnections.get(threadId);
        if (!active || active.gen !== gen || active.ws !== ws) return;
        this.wsConnections.delete(threadId);
        if (this.shouldStreamThread(this.threads.get(threadId)) && this.isActive(lifecycle)) {
          this.scheduleRetry(threadId);
        } else {
          this.clearRetry(threadId);
        }
        try { ws.close(); } catch {}
      };
    } catch {
      const active = this.wsConnections.get(threadId);
      if (active?.gen === gen) {
        this.wsConnections.delete(threadId);
        this.scheduleRetry(threadId);
      }
    }
  }

  private handleWsMessage(threadId: string, gen: number, data: unknown): void {
    if (!this.ctx) return;
    const connection = this.wsConnections.get(threadId);
    if (!connection || connection.gen !== gen) return;

    try {
      const raw = typeof data === "string" ? data : String(data);
      const msg: AgentStateMessage = JSON.parse(raw);

      if (!msg.state) return;

      const status = msg.state as AgentStatus;
      const snapshot = this.threads.get(threadId);
      if (!snapshot) {
        this.disconnectWebSocket(threadId);
        return;
      }

      if (snapshot.status === status) return;

      const now = Date.now();
      snapshot.status = status;
      snapshot.lastGrowthAt = status === "running" || status === "tool-running"
        ? now
        : status === "waiting"
          ? snapshot.lastGrowthAt ?? now
          : undefined;
      snapshot.waitingEligible = false;
      snapshot.statusUpdatedAt = now;

      this.emitStatus(threadId, snapshot);

      if (TERMINAL_STATUSES.has(status) || status === "idle") {
        this.disconnectWebSocket(threadId);
      }
    } catch {
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}, lifecycle = this.lifecycle): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._fetchTimeoutMs);
    this.requestControllers.add(controller);

    try {
      const res = await this._fetch(url, { ...init, signal: controller.signal });
      if (!this.isActive(lifecycle) || !res.ok) return null;
      return await res.json() as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      this.requestControllers.delete(controller);
    }
  }

  private async fetchDtwToken(threadId: string, lifecycle = this.lifecycle): Promise<string | null> {
    const body = await this.fetchJson<DtwTokenResponse>(`${this.ampUrl}/api/durable-thread-workers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ threadId }),
    }, lifecycle);
    return body?.wsToken ?? null;
  }

  private async fetchThreadList(lifecycle = this.lifecycle): Promise<ApiThreadSummary[] | null> {
    return this.fetchJson<ApiThreadSummary[]>(`${this.ampUrl}/api/threads?limit=20`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }, lifecycle);
  }

  private async fetchThreadDetail(threadId: string, lifecycle = this.lifecycle): Promise<ApiThreadDetail | null> {
    return this.fetchJson<ApiThreadDetail>(`${this.ampUrl}/api/threads/${threadId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }, lifecycle);
  }
}
