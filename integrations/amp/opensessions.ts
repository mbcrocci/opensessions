/**
 * opensessions plugin for Amp
 *
 * Reports agent status to the opensessions server.
 *
 * Install:
 *   Copy this file to ~/.config/amp/plugins/opensessions.ts
 *
 * Events mapped:
 *   session.start → idle
 *   agent.start   → running
 *   agent.end     → done/error/interrupted (based on event.status)
 *   tool.call     → running
 *   tool.result   → error (only on tool failure)
 */

// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type { PluginAPI } from "@ampcode/plugin";
import { appendFileSync } from "fs";

const SERVER_URL = process.env.OPENSESSIONS_URL ?? "http://127.0.0.1:7391/event";
const EVENTS_FILE = process.env.OPENSESSIONS_EVENTS_FILE ?? "/tmp/opensessions-events.jsonl";
const THREADS_DIR = `${process.env.HOME}/.local/share/amp/threads`;

async function getTmuxSession($: PluginAPI["$"]): Promise<string> {
  try {
    const result = await $`tmux display-message -p '#S'`;
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
}

async function writeEvent(agent: string, session: string, status: string, threadId?: string, threadName?: string): Promise<void> {
  const payload = JSON.stringify({ agent, session, status, ts: Date.now(), ...(threadId && { threadId }), ...(threadName && { threadName }) });
  try {
    await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } catch {
    try { appendFileSync(EVENTS_FILE, payload + "\n"); } catch {}
  }
}

async function readThreadName($: PluginAPI["$"], threadId: string): Promise<string | null> {
  try {
    const result = await $`jq -r '.title // empty' ${THREADS_DIR}/${threadId}.json`;
    const title = result.stdout.trim();
    return title || null;
  } catch {
    return null;
  }
}

export default function (amp: PluginAPI) {
  let sessionName: string | null = null;
  const threadNames = new Map<string, string>();

  getTmuxSession(amp.$).then((name) => {
    sessionName = name;
  });

  async function resolveThreadName($: PluginAPI["$"], threadId: string | null): Promise<string | null> {
    if (!threadId) return null;
    if (threadNames.has(threadId)) return threadNames.get(threadId)!;
    const name = await readThreadName($, threadId);
    if (name) threadNames.set(threadId, name);
    return name;
  }

  amp.on("session.start", async (_event, ctx) => {
    if (!sessionName) sessionName = await getTmuxSession(ctx.$);
    await writeEvent("amp", sessionName, "idle");
  });

  amp.on("agent.start", async (_event, ctx) => {
    if (!sessionName) sessionName = await getTmuxSession(ctx.$);
    // Debug: dump thread object to find the right property
    const threadObj = ctx.thread;
    ctx.logger.log(`[opensessions] ctx.thread = ${JSON.stringify(threadObj, null, 2)}`);
    ctx.logger.log(`[opensessions] ctx.thread keys = ${threadObj ? Object.keys(threadObj) : 'null'}`);
    const threadId = ctx.thread?.id?.toString() ?? null;
    ctx.logger.log(`[opensessions] threadId = ${threadId}`);
    const threadName = await resolveThreadName(ctx.$, threadId);
    ctx.logger.log(`[opensessions] threadName = ${threadName}`);
    await writeEvent("amp", sessionName, "running", threadId ?? undefined, threadName ?? undefined);
    return {};
  });

  amp.on("agent.end", async (event, ctx) => {
    if (!sessionName) sessionName = await getTmuxSession(ctx.$);
    const threadId = ctx.thread?.id?.toString() ?? null;
    const threadName = await resolveThreadName(ctx.$, threadId);
    await writeEvent("amp", sessionName, event.status, threadId ?? undefined, threadName ?? undefined);
    return undefined;
  });

  amp.on("tool.call", async (_event, ctx) => {
    if (!sessionName) return { action: "allow" as const };
    const threadId = ctx.thread?.id?.toString() ?? null;
    const threadName = await resolveThreadName(ctx.$, threadId);
    await writeEvent("amp", sessionName, "running", threadId ?? undefined, threadName ?? undefined);
    return { action: "allow" as const };
  });

  amp.on("tool.result", async (event, ctx) => {
    if (!sessionName) return;
    const threadId = ctx.thread?.id?.toString() ?? null;
    const threadName = await resolveThreadName(ctx.$, threadId);
    if (event.status === "error") {
      await writeEvent("amp", sessionName, "error", threadId ?? undefined, threadName ?? undefined);
    } else if (event.status === "cancelled") {
      await writeEvent("amp", sessionName, "interrupted", threadId ?? undefined, threadName ?? undefined);
    }
  });
}
