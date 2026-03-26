/**
 * opensessions watcher for OpenCode (standalone)
 *
 * Polls the OpenCode SQLite database to determine agent status
 * and reports events to the opensessions server.
 *
 * Usage:
 *   bun run integrations/opencode/watcher.ts
 *
 * Environment:
 *   OPENSESSIONS_URL        — server endpoint (default: http://127.0.0.1:7391/event)
 *   OPENSESSIONS_EVENTS_FILE — JSONL fallback path (default: /tmp/opensessions-events.jsonl)
 *   OPENCODE_DB_PATH        — override DB path (default: ~/.local/share/opencode/opencode.db)
 *   POLL_INTERVAL_MS        — poll interval in ms (default: 3000)
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync } from "fs";

const SERVER_URL = process.env.OPENSESSIONS_URL ?? "http://127.0.0.1:7391/event";
const EVENTS_FILE = process.env.OPENSESSIONS_EVENTS_FILE ?? "/tmp/opensessions-events.jsonl";
const DB_PATH = process.env.OPENCODE_DB_PATH ?? `${process.env.HOME}/.local/share/opencode/opencode.db`;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 3000;

// --- Types ---

type AgentStatus = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

interface AgentEvent {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadId?: string;
  threadName?: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  time_updated: string;
}

interface MessageRow {
  id: string;
  data: string;
}

interface MessageData {
  role?: string;
  finish?: string;
}

interface PartData {
  type?: string;
}

// --- Mux session detection ---

function getMuxSession(): string {
  if (process.env.TMUX) {
    try {
      const result = Bun.spawnSync(["tmux", "display-message", "-p", "#S"], {
        stdout: "pipe", stderr: "pipe",
      });
      return result.stdout.toString().trim() || "unknown";
    } catch {
      return "unknown";
    }
  }
  if (process.env.ZELLIJ_SESSION_NAME) {
    return process.env.ZELLIJ_SESSION_NAME;
  }
  return "unknown";
}

// --- Event posting ---

async function writeEvent(event: AgentEvent): Promise<void> {
  const payload = JSON.stringify(event);
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

// --- Status determination (mirrors lazyagent logic) ---

function determineStatus(msg: MessageData | null, parts: PartData[]): AgentStatus {
  if (!msg) return "idle";

  if (msg.role === "assistant") {
    if (msg.finish === "tool-calls") return "running";
    if (parts.some((p) => p.type === "tool")) return "running";
    return "waiting";
  }

  if (msg.role === "user") return "running";

  return "idle";
}

// --- Polling state ---

const sessionTimestamps = new Map<string, string>();
const sessionStatuses = new Map<string, AgentStatus>();
const muxSession = getMuxSession();
let db: Database | null = null;

function openDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch (err) {
    console.error(`[opensessions:opencode] failed to open DB: ${err}`);
    return null;
  }
}

function poll(): void {
  if (!db) {
    db = openDb();
    if (!db) return;
    console.error(`[opensessions:opencode] connected to ${DB_PATH}`);
  }

  let sessions: SessionRow[];
  try {
    sessions = db.query<SessionRow, []>(
      `SELECT id, title, time_updated FROM session ORDER BY time_updated DESC`
    ).all();
  } catch (err) {
    console.error(`[opensessions:opencode] query error: ${err}`);
    // DB may have been deleted or locked — reopen next cycle
    try { db.close(); } catch {}
    db = null;
    return;
  }

  for (const session of sessions) {
    const prev = sessionTimestamps.get(session.id);
    if (prev === session.time_updated) continue;
    sessionTimestamps.set(session.id, session.time_updated);

    // Only fetch the last message + its parts (avoids scanning entire history)
    let lastMsg: MessageRow | null = null;
    let lastParts: PartData[] = [];
    try {
      lastMsg = db!.query<MessageRow, [string]>(
        `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1`
      ).get(session.id);

      if (lastMsg) {
        const partRows = db!.query<{ data: string }, [string]>(
          `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`
        ).all(lastMsg.id);
        for (const row of partRows) {
          try { lastParts.push(JSON.parse(row.data)); } catch {}
        }
      }
    } catch (err) {
      console.error(`[opensessions:opencode] message query error for session ${session.id}: ${err}`);
      continue;
    }

    let lastMsgData: MessageData | null = null;
    if (lastMsg) {
      try { lastMsgData = JSON.parse(lastMsg.data); } catch {}
    }

    const status = determineStatus(lastMsgData, lastParts);
    const prevStatus = sessionStatuses.get(session.id);
    if (prevStatus === status) continue;
    sessionStatuses.set(session.id, status);

    const event: AgentEvent = {
      agent: "opencode",
      session: muxSession,
      status,
      ts: Date.now(),
      threadId: session.id,
      ...(session.title && { threadName: session.title }),
    };

    console.error(`[opensessions:opencode] ${session.id} → ${status}${session.title ? ` (${session.title})` : ""}`);
    writeEvent(event);
  }
}

// --- Main ---

console.error(`[opensessions:opencode] watching ${DB_PATH} every ${POLL_INTERVAL}ms (session: ${muxSession})`);

const timer = setInterval(poll, POLL_INTERVAL);
poll(); // initial poll

function shutdown(): void {
  console.error("[opensessions:opencode] shutting down");
  clearInterval(timer);
  try { db?.close(); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
