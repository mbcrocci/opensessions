import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PiAgentWatcher, determineStatus } from "../src/agents/watchers/pi";
import type { AgentEvent } from "../src/contracts/agent";
import type { AgentWatcherContext } from "../src/contracts/agent-watcher";

describe("Pi determineStatus", () => {
  test("returns running for user messages", () => {
    expect(determineStatus({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Fix the watcher" }] },
    })).toBe("running");
  });

  test("returns running for assistant tool-use turns", () => {
    expect(determineStatus({
      type: "message",
      message: { role: "assistant", stopReason: "toolUse" },
    })).toBe("running");
  });

  test("returns done for assistant stop turns", () => {
    expect(determineStatus({
      type: "message",
      message: { role: "assistant", stopReason: "stop" },
    })).toBe("done");
  });

  test("returns idle for unrelated entries", () => {
    expect(determineStatus({ type: "session" })).toBe("idle");
  });
});

describe("PiAgentWatcher", () => {
  let tmpDir: string;
  let watcher: PiAgentWatcher;
  let events: AgentEvent[];
  let ctx: AgentWatcherContext;
  let sessionFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pi-watcher-test-${Date.now()}`);
    const projectDir = join(tmpDir, "sessions", "--projects-myapp--");
    mkdirSync(projectDir, { recursive: true });

    sessionFile = join(projectDir, "2026-03-27T12-00-00-000Z_12345678-1234-1234-1234-123456789abc.jsonl");
    writeFileSync(sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "12345678-1234-1234-1234-123456789abc",
        timestamp: "2026-03-27T12:00:00.000Z",
        cwd: "/projects/myapp",
      }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-user-1",
        parentId: null,
        timestamp: "2026-03-27T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix the watcher status mapping" }],
          timestamp: 1774612801000,
        },
      }) + "\n",
    );

    events = [];
    ctx = {
      resolveSession: (dir) => dir === "/projects/myapp" ? "myapp-session" : null,
      emit: (event) => events.push(event),
    };

    watcher = new PiAgentWatcher();
    (watcher as any).sessionsDir = join(tmpDir, "sessions");
  });

  afterEach(() => {
    watcher.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("seed scan does not emit events", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(events).toHaveLength(0);
  });

  test("emits done when Pi writes a final assistant turn", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(0);

    appendFileSync(sessionFile,
      JSON.stringify({
        type: "message",
        id: "msg-assistant-1",
        parentId: "msg-user-1",
        timestamp: "2026-03-27T12:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Implemented the watcher." }],
          stopReason: "stop",
          timestamp: 1774612805000,
        },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.agent).toBe("pi");
    expect(events[0]!.session).toBe("myapp-session");
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.threadId).toBe("12345678-1234-1234-1234-123456789abc");
    expect(events[0]!.threadName).toBe("Fix the watcher status mapping");
  });

  test("emits running for a newly created active Pi session", async () => {
    watcher.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    events = [];

    const newSessionFile = join(
      tmpDir,
      "sessions",
      "--projects-myapp--",
      "2026-03-27T12-05-00-000Z_abcdefab-cdef-cdef-cdef-abcdefabcdef.jsonl",
    );

    writeFileSync(newSessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abcdefab-cdef-cdef-cdef-abcdefabcdef",
        timestamp: "2026-03-27T12:05:00.000Z",
        cwd: "/projects/myapp",
      }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-user-2",
        parentId: null,
        timestamp: "2026-03-27T12:05:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Inspect the project" }],
          timestamp: 1774613101000,
        },
      }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "msg-assistant-2",
        parentId: "msg-user-2",
        timestamp: "2026-03-27T12:05:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "read" }],
          stopReason: "toolUse",
          timestamp: 1774613103000,
        },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.threadId).toBe("abcdefab-cdef-cdef-cdef-abcdefabcdef");
  });
});
