/**
 * opensessions watcher for Claude Code
 *
 * Watches ~/.claude/projects/ for JSONL file changes and reports
 * agent status to the opensessions server.
 *
 * Run:
 *   bun run integrations/claude-code/watcher.ts
 *
 * Status mapping (from JSONL message entries):
 *   assistant + tool_use content    → running
 *   assistant + text only           → waiting
 *   user + tool_result content      → running
 *   user + text only                → running
 *   otherwise                       → idle
 */

import { appendFileSync, readdirSync, readFileSync, statSync, watch } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const SERVER_URL = process.env.OPENSESSIONS_URL ?? "http://127.0.0.1:7391/event";
const EVENTS_FILE = process.env.OPENSESSIONS_EVENTS_FILE ?? "/tmp/opensessions-events.jsonl";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const POLL_MS = 2000;

// -- Types ------------------------------------------------------------------

type AgentStatus = "idle" | "running" | "done" | "error" | "waiting" | "interrupted";

interface ContentItem {
  type?: string;
  text?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface JournalEntry {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: ContentItem[] | string;
    usage?: unknown;
  };
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  costUSD?: number;
}

interface SessionState {
  status: AgentStatus;
  fileSize: number;
  threadName?: string;
}

// -- State ------------------------------------------------------------------

const sessions = new Map<string, SessionState>();
const sessionName = getSessionName();

// -- Helpers ----------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[claude-code-watcher] ${msg}\n`);
}

function getSessionName(): string {
  if (process.env.TMUX) {
    try {
      const result = Bun.spawnSync(["tmux", "display-message", "-p", "#S"]);
      const name = result.stdout.toString().trim();
      if (name) return name;
    } catch {}
  }
  if (process.env.ZELLIJ_SESSION_NAME) return process.env.ZELLIJ_SESSION_NAME;
  return "unknown";
}

function determineStatus(entry: JournalEntry): AgentStatus {
  const msg = entry.message;
  if (!msg?.role) return "idle";

  const content = msg.content;
  const items: ContentItem[] = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  if (msg.role === "assistant") {
    const hasToolUse = items.some((c) => c.type === "tool_use");
    return hasToolUse ? "running" : "waiting";
  }

  if (msg.role === "user") {
    const hasToolResult = items.some((c) => c.type === "tool_result");
    return hasToolResult ? "running" : "running";
  }

  return "idle";
}

function extractThreadName(entry: JournalEntry): string | undefined {
  const msg = entry.message;
  if (msg?.role !== "user") return undefined;

  const content = msg.content;
  if (typeof content === "string") return content.slice(0, 80);

  if (Array.isArray(content)) {
    const textItem = content.find((c) => c.type === "text" && c.text);
    return textItem?.text?.slice(0, 80);
  }

  return undefined;
}

async function writeEvent(status: AgentStatus, threadId?: string, threadName?: string): Promise<void> {
  const payload = JSON.stringify({
    agent: "claude-code",
    session: sessionName,
    status,
    ts: Date.now(),
    ...(threadId && { threadId }),
    ...(threadName && { threadName }),
  });

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

// -- JSONL parsing ----------------------------------------------------------

function readNewBytes(filePath: string, offset: number, size: number): string | null {
  try {
    const raw = readFileSync(filePath);
    const newBytes = raw.subarray(offset, size);
    return new TextDecoder().decode(newBytes);
  } catch {
    return null;
  }
}

function processFileSync(filePath: string): void {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }

  const threadId = basename(filePath, ".jsonl");
  const prev = sessions.get(threadId);

  if (prev && size === prev.fileSize) return;

  const offset = prev?.fileSize ?? 0;
  if (size <= offset) return;

  const text = readNewBytes(filePath, offset, size);
  if (!text) return;

  processLines(text, threadId, prev);

  const current = sessions.get(threadId);
  if (current) {
    current.fileSize = size;
  } else {
    sessions.set(threadId, { status: "idle", fileSize: size });
  }
}

function processLines(text: string, threadId: string, prev: SessionState | undefined): void {
  const lines = text.split("\n").filter(Boolean);
  let latestStatus: AgentStatus = prev?.status ?? "idle";
  let threadName = prev?.threadName;

  for (const line of lines) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!threadName) {
      const name = extractThreadName(entry);
      if (name) threadName = name;
    }

    latestStatus = determineStatus(entry);
  }

  const prevStatus = prev?.status;
  sessions.set(threadId, { status: latestStatus, fileSize: prev?.fileSize ?? 0, threadName });

  if (latestStatus !== prevStatus) {
    log(`${threadId}: ${prevStatus ?? "new"} → ${latestStatus}`);
    writeEvent(latestStatus, threadId, threadName);
  }
}

// -- Directory scanning -----------------------------------------------------

function scanProjects(): void {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return;
  }

  for (const dir of dirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      processFileSync(join(dirPath, file));
    }
  }
}

// -- Watchers ---------------------------------------------------------------

const watchers: ReturnType<typeof watch>[] = [];

function setupWatchers(): void {
  // Watch each project subdirectory for JSONL changes
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    log(`Cannot read ${PROJECTS_DIR}, falling back to polling only`);
    return;
  }

  for (const dir of dirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const w = watch(dirPath, (_eventType, filename) => {
        if (!filename?.endsWith(".jsonl")) return;
        processFileSync(join(dirPath, filename));
      });
      watchers.push(w);
    } catch {
      // fs.watch can fail on some systems; polling handles it
    }
  }

  // Watch projects dir itself for new project directories
  try {
    const w = watch(PROJECTS_DIR, (eventType, filename) => {
      if (eventType !== "rename" || !filename) return;
      const dirPath = join(PROJECTS_DIR, filename);
      try {
        if (!statSync(dirPath).isDirectory()) return;
      } catch {
        return;
      }
      // Add watcher for new project directory
      try {
        const sub = watch(dirPath, (_et, fn) => {
          if (!fn?.endsWith(".jsonl")) return;
          processFileSync(join(dirPath, fn));
        });
        watchers.push(sub);
        log(`Watching new project dir: ${filename}`);
      } catch {}
    });
    watchers.push(w);
  } catch {}
}

// -- Main -------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down");
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  clearInterval(pollInterval);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`Watching ${PROJECTS_DIR}`);
log(`Session: ${sessionName}`);
log(`Server: ${SERVER_URL}`);

// Initial scan
scanProjects();

// Set up fs.watch for immediate notifications
setupWatchers();

// Poll as fallback (catches missed events, new directories)
const pollInterval = setInterval(scanProjects, POLL_MS);
