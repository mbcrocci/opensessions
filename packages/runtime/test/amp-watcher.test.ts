import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AmpAgentWatcher, determineStatus } from "../src/agents/watchers/amp";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --- determineStatus ---

describe("Amp determineStatus", () => {
  // Null / empty cases
  test("returns idle for null message", () => {
    expect(determineStatus(null)).toBe("idle");
  });

  test("returns idle for message with no role", () => {
    expect(determineStatus({})).toBe("idle");
  });

  test("returns idle for empty messages array (no last message)", () => {
    expect(determineStatus(null)).toBe("idle");
  });

  // User messages — always running (new prompt or tool result)
  test("returns running for user message (new prompt)", () => {
    expect(determineStatus({ role: "user" })).toBe("running");
  });

  test("returns running for user message with text content", () => {
    expect(determineStatus({ role: "user", content: [{ type: "text" }] })).toBe("running");
  });

  test("returns running for user message with tool_result", () => {
    expect(determineStatus({ role: "user", content: [{ type: "tool_result" }] })).toBe("running");
  });

  test("returns tool-running for user message with in-progress tool_result", () => {
    expect(determineStatus({ role: "user", content: [{ type: "tool_result", run: { status: "in-progress" } }] })).toBe("tool-running");
  });

  test("returns running for user message with interrupted=true", () => {
    expect(determineStatus({ role: "user", interrupted: true, content: [{ type: "text" }] })).toBe("running");
  });

  // Assistant streaming — model actively generating
  test("returns running for assistant with no state (pre-streaming)", () => {
    expect(determineStatus({ role: "assistant" })).toBe("running");
  });

  test("returns running for assistant with empty state", () => {
    expect(determineStatus({ role: "assistant", state: {} })).toBe("running");
  });

  test("returns running for streaming assistant (thinking)", () => {
    expect(determineStatus({ role: "assistant", state: { type: "streaming" } })).toBe("running");
  });

  test("returns running for streaming assistant with tool_use content", () => {
    expect(determineStatus({
      role: "assistant",
      state: { type: "streaming" },
      content: [{ type: "thinking" }, { type: "tool_use" }],
    })).toBe("running");
  });

  // Assistant complete — check stopReason
  test("returns running for complete with tool_use stopReason", () => {
    expect(determineStatus({ role: "assistant", state: { type: "complete", stopReason: "tool_use" } })).toBe("running");
  });

  test("returns done for complete with end_turn stopReason", () => {
    expect(determineStatus({ role: "assistant", state: { type: "complete", stopReason: "end_turn" } })).toBe("done");
  });

  test("returns error for complete with max_tokens stopReason", () => {
    expect(determineStatus({ role: "assistant", state: { type: "complete", stopReason: "max_tokens" } })).toBe("error");
  });

  test("returns error for complete with unknown stopReason", () => {
    expect(determineStatus({ role: "assistant", state: { type: "complete", stopReason: "unknown_reason" } })).toBe("error");
  });

  // Assistant cancelled — user interrupt
  test("returns interrupted for cancelled state", () => {
    expect(determineStatus({ role: "assistant", state: { type: "cancelled" } })).toBe("interrupted");
  });

  test("returns interrupted for cancelled with thinking content", () => {
    expect(determineStatus({
      role: "assistant",
      state: { type: "cancelled" },
      content: [{ type: "thinking" }],
    })).toBe("interrupted");
  });

  test("returns interrupted for cancelled with tool_use content", () => {
    expect(determineStatus({
      role: "assistant",
      state: { type: "cancelled" },
      content: [{ type: "tool_use" }],
    })).toBe("interrupted");
  });

  test("returns interrupted for cancelled with text content", () => {
    expect(determineStatus({
      role: "assistant",
      state: { type: "cancelled" },
      content: [{ type: "text" }],
    })).toBe("interrupted");
  });

  test("returns interrupted for cancelled with empty content", () => {
    expect(determineStatus({
      role: "assistant",
      state: { type: "cancelled" },
      content: [],
    })).toBe("interrupted");
  });

  // Unknown state type — defensive
  test("returns running for unknown assistant state type", () => {
    expect(determineStatus({ role: "assistant", state: { type: "some_future_state" } })).toBe("running");
  });

  // Unknown role — defensive
  test("returns idle for unknown role", () => {
    expect(determineStatus({ role: "system" })).toBe("idle");
  });
});

// --- AmpAgentWatcher integration (API-based) ---

/**
 * Mock fetch that serves thread list and thread detail from in-memory data.
 * Tests manipulate `mockThreads` to simulate API responses.
 */
function createMockFetch(state: {
  threads: Map<string, { v: number; title?: string; messages: any[]; env: any; updatedAt?: string }>;
}) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // GET /api/threads?limit=N
    if (url.includes("/api/threads") && !url.match(/\/api\/threads\/T-/)) {
      const list = Array.from(state.threads.entries()).map(([id, t]) => ({
        id,
        v: t.v,
        title: t.title,
        updatedAt: t.updatedAt ?? new Date().toISOString(),
        env: t.env,
      }));
      return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // GET /api/threads/:id
    const detailMatch = url.match(/\/api\/threads\/(T-[^?/]+)/);
    if (detailMatch) {
      const threadId = detailMatch[1];
      const thread = state.threads.get(threadId!);
      if (!thread) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify({
        id: threadId,
        v: thread.v,
        title: thread.title,
        messages: thread.messages,
        env: thread.env,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  };
}

describe("AmpAgentWatcher", () => {
  let watcher: AmpAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;
  let mockState: { threads: Map<string, { v: number; title?: string; messages: any[]; env: any; updatedAt?: string }> };

  function setThread(id: string, data: { v: number; title?: string; messages: any[]; env: any; updatedAt?: string }) {
    mockState.threads.set(id, data);
  }

  function mkEnv(dir: string) {
    return { initial: { trees: [{ uri: `file://${dir}` }] } };
  }

  beforeEach(() => {
    events = [];
    mockState = { threads: new Map() };
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };
    watcher = new AmpAgentWatcher();
    // Inject mock credentials so initAndPoll skips file reads
    (watcher as any).ampUrl = "https://test.ampcode.com";
    (watcher as any).apiKey = "sgamp_test_key";
    watcher._fetch = createMockFetch(mockState);
  });

  afterEach(() => {
    watcher.stop();
  });

  /** Start watcher with pre-injected credentials (bypasses file loading) */
  async function startWatcher() {
    // Directly call poll to seed, then set up the timer — mirrors initAndPoll but uses injected creds
    (watcher as any).ctx = ctx;
    await (watcher as any).poll();
    (watcher as any).pollTimer = setInterval(() => (watcher as any).poll(), 2000);
  }

  test("seed scan emits current non-idle threads with titles", async () => {
    setThread("T-test-001", {
      v: 1,
      title: "Thread one",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });
    setThread("T-test-002", {
      v: 1,
      title: "Thread two",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "streaming" } }],
    });

    await startWatcher();

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.threadId).sort()).toEqual(["T-test-001", "T-test-002"]);
    expect(events.map((event) => event.threadName).sort()).toEqual(["Thread one", "Thread two"]);
    expect(events.every((event) => event.status === "running")).toBe(true);
  });

  test("emits on version bump after seed", async () => {
    setThread("T-test-003", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    // Bump version
    setThread("T-test-003", {
      v: 2,
      title: "Test thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "complete", stopReason: "end_turn" } }],
    });

    await (watcher as any).poll();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.session).toBe("myapp-session");
    expect(events[0]!.threadName).toBe("Test thread");
  });

  test("does not emit when session resolves to unknown", async () => {
    setThread("T-test-004", {
      v: 1,
      env: mkEnv("/unknown/dir"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-004", {
      v: 2,
      env: mkEnv("/unknown/dir"),
      messages: [{ role: "assistant", state: { type: "complete", stopReason: "end_turn" } }],
    });

    await (watcher as any).poll();

    expect(events.length).toBe(0);
  });

  test("emits title updates even when status stays running", async () => {
    setThread("T-test-005", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-005", {
      v: 2,
      title: "Named thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await (watcher as any).poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.threadName).toBe("Named thread");
  });

  test("emits error when Amp ends a thread with a terminal failure stop reason", async () => {
    setThread("T-test-006", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-006", {
      v: 2,
      title: "Token limit hit",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "complete", stopReason: "max_tokens" } }],
    });

    await (watcher as any).poll();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.status).toBe("error");
    expect(events[0]!.threadName).toBe("Token limit hit");
  });

  test("emits interrupted for cancelled assistant state", async () => {
    setThread("T-test-007", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-007", {
      v: 2,
      title: "Cancelled thread",
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "cancelled" }, content: [{ type: "thinking" }] },
      ],
    });

    await (watcher as any).poll();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.status).toBe("interrupted");
    expect(events[0]!.threadName).toBe("Cancelled thread");
  });

  test("emits running after cancel when user sends new message", async () => {
    setThread("T-test-008", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "cancelled" }, content: [{ type: "thinking" }] },
      ],
    });

    await startWatcher();
    events = [];

    setThread("T-test-008", {
      v: 2,
      title: "Resumed thread",
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "cancelled" }, content: [{ type: "thinking" }] },
        { role: "user", interrupted: true, content: [{ type: "text" }] },
      ],
    });

    await (watcher as any).poll();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.status).toBe("running");
  });

  test("keeps running through tool_use → tool_result cycle", async () => {
    setThread("T-test-009", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-009", {
      v: 3,
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "complete", stopReason: "tool_use" }, content: [{ type: "thinking" }, { type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }] },
      ],
    });

    await (watcher as any).poll();

    const doneEvents = events.filter((e) => e.status === "done");
    expect(doneEvents.length).toBe(0);

    const interruptedEvents = events.filter((e) => e.status === "interrupted");
    expect(interruptedEvents.length).toBe(0);
  });

  test("detects stuck running and promotes to stale (process killed)", async () => {
    setThread("T-test-010", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "streaming" }, content: [{ type: "thinking" }] }],
    });

    await startWatcher();
    const seedCount = events.length;

    // Backdate lastGrowthAt to simulate a process stuck for >2 minutes
    const snapshot = (watcher as any).threads.get("T-test-010");
    snapshot.lastGrowthAt = Date.now() - 121_000;

    // Poll again — version unchanged, should detect stuck
    await (watcher as any).poll();

    const staleEvents = events.slice(seedCount).filter((e: AgentEvent) => e.status === "stale");
    expect(staleEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("promotes quiet tool_result pause to waiting without emitting stale", async () => {
    setThread("T-test-011", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "assistant", state: { type: "complete", stopReason: "tool_use" }, content: [{ type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }] },
      ],
    });

    await startWatcher();
    const seedCount = events.length;

    // Backdate lastGrowthAt past both waiting and stuck thresholds
    const snapshot = (watcher as any).threads.get("T-test-011");
    snapshot.lastGrowthAt = Date.now() - 121_000;

    await (watcher as any).poll();

    const postSeed = events.slice(seedCount);
    const waitingEvents = postSeed.filter((e: AgentEvent) => e.status === "waiting");
    const staleEvents = postSeed.filter((e: AgentEvent) => e.status === "stale");

    expect(waitingEvents.length).toBeGreaterThanOrEqual(1);
    expect(staleEvents).toHaveLength(0);
  });

  test("keeps in-progress tool_result in tool-running without promoting to waiting", async () => {
    setThread("T-test-011b", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "assistant", state: { type: "complete", stopReason: "tool_use" }, content: [{ type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result", run: { status: "in-progress", progress: { output: "still going" } } }] },
      ],
    });

    await startWatcher();
    const seedCount = events.length;

    const snapshot = (watcher as any).threads.get("T-test-011b");
    snapshot.lastGrowthAt = Date.now() - 10_000;

    await (watcher as any).poll();

    expect(events[seedCount - 1]!.status).toBe("tool-running");
    const postSeed = events.slice(seedCount);
    expect(postSeed.filter((e: AgentEvent) => e.status === "waiting")).toHaveLength(0);
    expect(postSeed.filter((e: AgentEvent) => e.status === "stale")).toHaveLength(0);
  });

  test("streaming state during seed emits running", async () => {
    setThread("T-test-012", {
      v: 50,
      title: "Active stream",
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "streaming" }, content: [{ type: "thinking" }, { type: "text" }] },
      ],
    });

    await startWatcher();

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.threadName).toBe("Active stream");
  });

  test("does not emit for idle threads (done status is not idle)", async () => {
    setThread("T-test-013", {
      v: 10,
      title: "Completed",
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "complete", stopReason: "end_turn" }, content: [{ type: "text" }] },
      ],
    });

    await startWatcher();

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("done");
  });

  test("does not emit for truly idle threads (no messages)", async () => {
    setThread("T-test-014", {
      v: 0,
      env: mkEnv("/projects/myapp"),
      messages: [],
    });

    await startWatcher();

    expect(events).toHaveLength(0);
  });

  test("cancelled then tool_result pattern stays running", async () => {
    setThread("T-test-015", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    events = [];

    setThread("T-test-015", {
      v: 2,
      env: mkEnv("/projects/myapp"),
      messages: [
        { role: "user" },
        { role: "assistant", state: { type: "cancelled" }, content: [{ type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }] },
      ],
    });

    await (watcher as any).poll();

    const interruptedEvents = events.filter((e) => e.status === "interrupted");
    expect(interruptedEvents.length).toBe(0);
  });

  test("handles API failure gracefully (no crash, no events)", async () => {
    watcher._fetch = async () => new Response("Internal Server Error", { status: 500 });

    await startWatcher();

    expect(events).toHaveLength(0);
  });

  test("skips threads older than RECENT_MS", async () => {
    setThread("T-old-thread", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    });

    await startWatcher();

    expect(events).toHaveLength(0);
  });

  test("request timeout clears scanning so polling can recover", async () => {
    watcher._fetchTimeoutMs = 10;
    let calls = 0;
    watcher._fetch = async (_input, init) => {
      calls++;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    (watcher as any).ctx = ctx;
    (watcher as any).ampUrl = "https://test.ampcode.com";
    (watcher as any).apiKey = "sgamp_test_key";

    await (watcher as any).poll();
    expect((watcher as any).scanning).toBe(false);

    await (watcher as any).poll();
    expect(calls).toBe(2);
    expect((watcher as any).scanning).toBe(false);
  });
});

// --- DTW WebSocket tests ---

/**
 * Minimal mock WebSocket that records construction args and lets tests
 * fire onmessage / onclose / onerror callbacks.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  /** Simulate receiving a message from the server */
  simulateMessage(data: unknown) {
    if (this.onmessage) this.onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** Simulate a connection error */
  simulateError() {
    if (this.onerror) this.onerror();
  }
}

describe("AmpAgentWatcher WebSocket (DTW)", () => {
  let watcher: AmpAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;
  let mockState: { threads: Map<string, { v: number; title?: string; messages: any[]; env: any; updatedAt?: string }> };
  let dtwTokens: Map<string, string>;

  function setThread(id: string, data: { v: number; title?: string; messages: any[]; env: any; updatedAt?: string }) {
    mockState.threads.set(id, data);
  }

  function mkEnv(dir: string) {
    return { initial: { trees: [{ uri: `file://${dir}` }] } };
  }

  function createMockFetchWithDtw() {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // POST /api/durable-thread-workers
      if (url.includes("/api/durable-thread-workers") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const token = dtwTokens.get(body.threadId);
        if (!token) return new Response("Not Found", { status: 404 });
        return new Response(JSON.stringify({ wsToken: token, threadVersion: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /api/threads?limit=N
      if (url.includes("/api/threads") && !url.match(/\/api\/threads\/T-/)) {
        const list = Array.from(mockState.threads.entries()).map(([id, t]) => ({
          id,
          v: t.v,
          title: t.title,
          updatedAt: t.updatedAt ?? new Date().toISOString(),
          env: t.env,
        }));
        return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // GET /api/threads/:id
      const detailMatch = url.match(/\/api\/threads\/(T-[^?/]+)/);
      if (detailMatch) {
        const threadId = detailMatch[1];
        const thread = mockState.threads.get(threadId!);
        if (!thread) return new Response("Not Found", { status: 404 });
        return new Response(JSON.stringify({
          id: threadId,
          v: thread.v,
          title: thread.title,
          messages: thread.messages,
          env: thread.env,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not Found", { status: 404 });
    };
  }

  beforeEach(() => {
    events = [];
    mockState = { threads: new Map() };
    dtwTokens = new Map();
    MockWebSocket.instances = [];
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };
    watcher = new AmpAgentWatcher();
    (watcher as any).ampUrl = "https://test.ampcode.com";
    (watcher as any).apiKey = "sgamp_test_key";
    watcher._fetch = createMockFetchWithDtw();
    watcher._WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    watcher.stop();
  });

  async function startWatcher() {
    (watcher as any).ctx = ctx;
    await (watcher as any).poll();
    (watcher as any).pollTimer = setInterval(() => (watcher as any).poll(), 2000);
  }

  test("connects WebSocket for running thread after seed", async () => {
    dtwTokens.set("T-ws-001", "test-token-001");
    setThread("T-ws-001", {
      v: 1,
      title: "Running thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }, { role: "assistant", state: { type: "streaming" } }],
    });

    await startWatcher();
    // Give the async connectWebSocket a tick to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0]!.url).toContain("T-ws-001");
    expect(MockWebSocket.instances[0]!.url).toContain("wsToken=test-token-001");
  });

  test("does not connect WebSocket for done thread", async () => {
    dtwTokens.set("T-ws-002", "test-token-002");
    setThread("T-ws-002", {
      v: 1,
      title: "Done thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "complete", stopReason: "end_turn" } }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    expect(MockWebSocket.instances.length).toBe(0);
  });

  test("WebSocket message updates status in real-time", async () => {
    dtwTokens.set("T-ws-003", "test-token-003");
    setThread("T-ws-003", {
      v: 1,
      title: "Active thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }, { role: "assistant", state: { type: "streaming" } }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage({ state: "done" });

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.threadId).toBe("T-ws-003");
  });

  test("WebSocket disconnects on terminal state", async () => {
    dtwTokens.set("T-ws-004", "test-token-004");
    setThread("T-ws-004", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage({ state: "done" });

    expect(ws.closed).toBe(true);
    expect((watcher as any).wsConnections.size).toBe(0);
  });

  test("WebSocket disconnects on idle state", async () => {
    dtwTokens.set("T-ws-005", "test-token-005");
    setThread("T-ws-005", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage({ state: "idle" });

    expect(ws.closed).toBe(true);
  });

  test("WebSocket running→tool-running→done lifecycle", async () => {
    dtwTokens.set("T-ws-006", "test-token-006");
    setThread("T-ws-006", {
      v: 1,
      title: "Lifecycle thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;

    ws.simulateMessage({ state: "tool-running" });
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("tool-running");

    ws.simulateMessage({ state: "running" });
    expect(events).toHaveLength(2);
    expect(events[1]!.status).toBe("running");

    ws.simulateMessage({ state: "done" });
    expect(events).toHaveLength(3);
    expect(events[2]!.status).toBe("done");
    expect(ws.closed).toBe(true);
  });

  test("duplicate status from WebSocket does not emit", async () => {
    dtwTokens.set("T-ws-007", "test-token-007");
    setThread("T-ws-007", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;
    // Thread is already "running" from seed — same status should not emit
    ws.simulateMessage({ state: "running" });
    expect(events).toHaveLength(0);
  });

  test("WebSocket error falls back gracefully (no crash)", async () => {
    dtwTokens.set("T-ws-008", "test-token-008");
    setThread("T-ws-008", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    const ws = MockWebSocket.instances[0]!;
    ws.simulateError();

    // Connection cleaned up, polling can still work
    expect((watcher as any).wsConnections.size).toBe(0);
  });

  test("WebSocket ignores malformed messages", async () => {
    dtwTokens.set("T-ws-009", "test-token-009");
    setThread("T-ws-009", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage("not json {{{");
    ws.simulateMessage({ noStateField: true });
    ws.simulateMessage("");

    expect(events).toHaveLength(0);
  });

  test("stop() closes all WebSocket connections", async () => {
    dtwTokens.set("T-ws-010", "test-token-010");
    setThread("T-ws-010", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    expect(MockWebSocket.instances.length).toBe(1);
    watcher.stop();

    expect(MockWebSocket.instances[0]!.closed).toBe(true);
    expect((watcher as any).wsConnections.size).toBe(0);
  });

  test("skips WebSocket when DTW token request fails", async () => {
    // No token registered for this thread → POST returns 404
    setThread("T-ws-011", {
      v: 1,
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    // No WebSocket created, but polling still works
    expect(MockWebSocket.instances.length).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("running");
  });

  test("does not connect WebSocket for threads outside local sessions", async () => {
    dtwTokens.set("T-ws-012", "test-token-012");
    setThread("T-ws-012", {
      v: 1,
      env: mkEnv("/projects/other"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    expect(MockWebSocket.instances.length).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("poll-detected terminal status disconnects WebSocket", async () => {
    dtwTokens.set("T-ws-013", "test-token-013");
    setThread("T-ws-013", {
      v: 1,
      title: "Running thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;
    setThread("T-ws-013", {
      v: 2,
      title: "Done thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "assistant", state: { type: "complete", stopReason: "end_turn" } }],
    });

    await (watcher as any).poll();

    expect(ws.closed).toBe(true);
    expect((watcher as any).wsConnections.size).toBe(0);
    expect(events.some((event) => event.status === "done")).toBe(true);
  });

  test("unexpected close reconnects active threads without a version bump", async () => {
    watcher._wsRetryMs = 0;
    dtwTokens.set("T-ws-014", "test-token-014");
    setThread("T-ws-014", {
      v: 1,
      title: "Reconnect me",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    const ws = MockWebSocket.instances[0]!;
    ws.close();

    await (watcher as any).poll();
    await new Promise((r) => setTimeout(r, 50));

    expect(MockWebSocket.instances.length).toBe(2);
    expect((watcher as any).wsConnections.size).toBe(1);
  });

  test("waiting from WebSocket can still promote to stale", async () => {
    dtwTokens.set("T-ws-015", "test-token-015");
    setThread("T-ws-015", {
      v: 1,
      title: "Waiting thread",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));
    events = [];

    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage({ state: "waiting" });

    const snapshot = (watcher as any).threads.get("T-ws-015");
    snapshot.lastGrowthAt = Date.now() - 121_000;

    await (watcher as any).poll();

    expect(events.some((event) => event.status === "stale")).toBe(true);
    expect(ws.closed).toBe(true);
  });

  test("duplicate connect attempts do not create orphan sockets", async () => {
    const tokenReply = deferred<Response>();
    watcher._fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/durable-thread-workers") && init?.method === "POST") {
        return await tokenReply.promise;
      }
      return new Response("Not Found", { status: 404 });
    };

    (watcher as any).ctx = ctx;
    (watcher as any).ampUrl = "https://test.ampcode.com";
    (watcher as any).apiKey = "sgamp_test_key";
    (watcher as any).threads.set("T-ws-race", {
      status: "running",
      version: 1,
      title: "Race thread",
      projectDir: "/projects/myapp",
      lastGrowthAt: Date.now(),
      waitingEligible: false,
      lastListedAt: Date.now(),
      statusUpdatedAt: Date.now(),
    });

    const p1 = (watcher as any).connectWebSocket("T-ws-race");
    const p2 = (watcher as any).connectWebSocket("T-ws-race");
    tokenReply.resolve(new Response(JSON.stringify({ wsToken: "race-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 0));

    expect(MockWebSocket.instances.length).toBe(1);
    expect((watcher as any).wsConnections.size).toBe(1);
  });

  test("stop prevents delayed token fetch from reviving a socket", async () => {
    const tokenReply = deferred<Response>();
    watcher._fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/durable-thread-workers") && init?.method === "POST") {
        return await tokenReply.promise;
      }
      return new Response("Not Found", { status: 404 });
    };

    (watcher as any).ctx = ctx;
    (watcher as any).ampUrl = "https://test.ampcode.com";
    (watcher as any).apiKey = "sgamp_test_key";
    (watcher as any).threads.set("T-ws-stop", {
      status: "running",
      version: 1,
      title: "Stop thread",
      projectDir: "/projects/myapp",
      lastGrowthAt: Date.now(),
      waitingEligible: false,
      lastListedAt: Date.now(),
      statusUpdatedAt: Date.now(),
    });

    const connectPromise = (watcher as any).connectWebSocket("T-ws-stop");
    watcher.stop();
    tokenReply.resolve(new Response(JSON.stringify({ wsToken: "stop-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await connectPromise;
    await new Promise((r) => setTimeout(r, 0));

    expect(MockWebSocket.instances.length).toBe(0);
    expect((watcher as any).wsConnections.size).toBe(0);
  });

  test("old socket close does not delete the replacement socket", async () => {
    dtwTokens.set("T-ws-016", "test-token-016");
    setThread("T-ws-016", {
      v: 1,
      title: "Identity-safe close",
      env: mkEnv("/projects/myapp"),
      messages: [{ role: "user" }],
    });

    await startWatcher();
    await new Promise((r) => setTimeout(r, 50));

    const oldSocket = MockWebSocket.instances[0]!;
    const replacement = new MockWebSocket("wss://replacement");
    (watcher as any).wsConnections.set("T-ws-016", {
      gen: 999,
      phase: "open",
      ws: replacement,
    });

    oldSocket.close();

    expect((watcher as any).wsConnections.get("T-ws-016")?.ws).toBe(replacement);
  });
});
