import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/**
 * Maintains custom session ordering for reorder-session commands.
 * Stores an ordered list of session names. The `apply` method takes
 * the natural session list and returns it sorted by the custom order.
 *
 * When a `persistPath` is provided, the order is loaded from disk on
 * construction and saved after every `reorder()` call.
 */
export class SessionOrder {
  private order: string[] = [];
  private readonly persistPath: string | null;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;
    if (this.persistPath) {
      try {
        if (existsSync(this.persistPath)) {
          const raw = readFileSync(this.persistPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.order = parsed.filter((n): n is string => typeof n === "string");
          }
        }
      } catch {
        // Ignore corrupt file — start fresh
      }
    }
  }

  /** Sync with current session names — adds new ones at end, removes stale ones. */
  sync(names: string[]): void {
    const nameSet = new Set(names);
    // Remove sessions that no longer exist
    this.order = this.order.filter((n) => nameSet.has(n));
    // Add new sessions at the end
    for (const n of names) {
      if (!this.order.includes(n)) {
        this.order.push(n);
      }
    }
  }

  /** Move a session by delta (-1 = up, 1 = down). */
  reorder(name: string, delta: -1 | 1): void {
    const idx = this.order.indexOf(name);
    if (idx === -1) return;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= this.order.length) return;
    // Swap
    [this.order[idx], this.order[newIdx]] = [this.order[newIdx]!, this.order[idx]!];
    this.save();
  }

  /** Apply the custom order to a list of session names. Returns sorted names. */
  apply(names: string[]): string[] {
    const posMap = new Map(this.order.map((n, i) => [n, i]));
    return [...names].sort((a, b) => {
      const pa = posMap.get(a) ?? Infinity;
      const pb = posMap.get(b) ?? Infinity;
      return pa - pb;
    });
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.order) + "\n");
    } catch {
      // Best-effort — don't crash if write fails
    }
  }
}
