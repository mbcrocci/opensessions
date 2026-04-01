/**
 * Pi agent watcher
 *
 * Watches Pi session transcripts under ~/.pi/agent/sessions/ for JSONL changes,
 * determines agent status from appended message entries, and emits events
 * mapped to mux sessions via the working directory captured in the session header.
 *
 * Directory structure: ~/.pi/agent/sessions/<encoded-path>/<timestamp>_<session-id>.jsonl
 * Encoded path: /Users/foo/myproject → --Users-foo-myproject--
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import type { AgentStatus } from "../../contracts/agent";
import type {
  AgentWatcher,
  AgentWatcherContext,
} from "../../contracts/agent-watcher";

interface PiContentItem {
  type?: string;
  text?: string;
}

interface PiEntry {
  type?: string;
  id?: string;
  cwd?: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: PiContentItem[] | string;
  };
}

interface SessionSnapshot {
  status: AgentStatus;
  fileSize: number;
  projectDir?: string;
  threadName?: string;
  sessionId?: string;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
const THREAD_NAME_MAX = 80;

export function determineStatus(entry: PiEntry): AgentStatus {
  if (entry.type !== "message") return "idle";

  const message = entry.message;
  if (!message?.role) return "idle";

  if (message.role === "user") return "running";
  if (message.role !== "assistant") return "idle";

  switch (message.stopReason) {
    case "toolUse":
      return "running";
    case "stop":
      return "done";
    case "error":
      return "error";
    case "cancelled":
    case "aborted":
    case "interrupted":
      return "interrupted";
    default:
      return "waiting";
  }
}

function parseThreadId(filePath: string): string {
  const name = basename(filePath, ".jsonl");
  return name.split("_").at(-1) ?? name;
}

function normalizeThreadName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, THREAD_NAME_MAX) : undefined;
}

function extractThreadName(entry: PiEntry): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user")
    return undefined;

  const content = entry.message.content;
  if (typeof content === "string") return normalizeThreadName(content);
  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");

  return normalizeThreadName(text);
}

function applyEntries(text: string, base: SessionSnapshot): SessionSnapshot {
  let status = base.status;
  let projectDir = base.projectDir;
  let threadName = base.threadName;
  let sessionId = base.sessionId;

  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;

    let entry: PiEntry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (entry.type === "session") {
      if (!projectDir && typeof entry.cwd === "string") projectDir = entry.cwd;
      if (!sessionId && typeof entry.id === "string") sessionId = entry.id;
      continue;
    }

    if (!threadName) {
      threadName = extractThreadName(entry);
    }

    const nextStatus = determineStatus(entry);
    if (nextStatus !== "idle") {
      status = nextStatus;
    }
  }

  return { ...base, status, projectDir, threadName, sessionId };
}

async function collectSessionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

export class PiAgentWatcher implements AgentWatcher {
  readonly name = "pi";

  private sessions = new Map<string, SessionSnapshot>();
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private sessionsDir: string;
  private scanning = false;
  private seeded = false;

  constructor() {
    this.sessionsDir = join(homedir(), ".pi", "agent", "sessions");
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.setupWatch();
    setTimeout(() => this.scan(), 50);
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
  }

  stop(): void {
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {}
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
  }

  private async processFile(filePath: string): Promise<void> {
    if (!this.ctx) return;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }

    const encodedDir = basename(dirname(filePath));
    const threadId = parseThreadId(filePath);
    const prev = this.sessions.get(threadId);

    if (prev && fileStat.size === prev.fileSize) return;

    let nextSnapshot: SessionSnapshot;
    if (prev && fileStat.size > prev.fileSize) {
      let text: string;
      try {
        const buf = await Bun.file(filePath).arrayBuffer();
        text = new TextDecoder().decode(
          new Uint8Array(buf).subarray(prev.fileSize, fileStat.size),
        );
      } catch {
        return;
      }

      nextSnapshot = applyEntries(text, { ...prev, fileSize: fileStat.size });
    } else {
      let text: string;
      try {
        text = await Bun.file(filePath).text();
      } catch {
        return;
      }

      nextSnapshot = applyEntries(text, {
        status: "idle",
        fileSize: fileStat.size,
      });
    }

    if (!nextSnapshot.projectDir) {
      nextSnapshot.projectDir = encodedDir;
    }

    this.sessions.set(threadId, nextSnapshot);

    if (!this.seeded) return;

    const prevStatus = prev?.status;
    if (nextSnapshot.status === prevStatus) return;

    const session = nextSnapshot.projectDir
      ? this.ctx.resolveSession(nextSnapshot.projectDir)
      : null;
    if (!session) return;
    if (!prev && nextSnapshot.status === "idle") return;

    this.ctx.emit({
      agent: "pi",
      session,
      status: nextSnapshot.status,
      ts: Date.now(),
      threadId: threadId,
      ...(nextSnapshot.threadName && { threadName: nextSnapshot.threadName }),
    });
  }

  private async scan(): Promise<void> {
    if (this.scanning || !this.ctx) return;
    this.scanning = true;

    try {
      const files = await collectSessionFiles(this.sessionsDir);
      const now = Date.now();

      for (const filePath of files) {
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch {
          continue;
        }

        if (now - fileStat.mtimeMs > STALE_MS) continue;
        await this.processFile(filePath);
      }
    } finally {
      if (!this.seeded) {
        this.seeded = true;

        for (const [threadId, snapshot] of this.sessions) {
          if (snapshot.status === "idle" || !snapshot.projectDir) continue;

          const session = this.ctx.resolveSession(snapshot.projectDir);
          if (!session) continue;

          this.ctx.emit({
            agent: "pi",
            session,
            status: snapshot.status,
            ts: Date.now(),
            threadId: threadId,
            ...(snapshot.threadName && { threadName: snapshot.threadName }),
          });
        }
      }

      this.scanning = false;
    }
  }

  private setupWatch(): void {
    try {
      this.fsWatcher = watch(
        this.sessionsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename?.endsWith(".jsonl")) return;
          this.processFile(join(this.sessionsDir, filename));
        },
      );
    } catch {}
  }
}
