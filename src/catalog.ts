import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { Session } from "./types";

export function projectPath(value: string | null): string {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096) {
    throw new Error("Provide an absolute project directory in ?project=…");
  }
  return normalize(value).replace(/\/$/, "") || "/";
}

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export class Catalog {
  constructor(readonly home: string) {}

  list(): Session[] {
    const files = readdirSync(this.home)
      .map((name) => ({ name, version: /^state_(\d+)\.sqlite$/.exec(name)?.[1] }))
      .filter((file) => file.version !== undefined)
      .sort((a, b) => Number(b.version) - Number(a.version));
    if (!files.length) throw new Error("Codex session catalog unavailable");
    // Reopen on every discovery pass so desktop upgrades and atomic replacements are observed.
    const db = new Database(join(this.home, files[0].name), { readonly: true });
    try {
      const columns = new Set((db.query("PRAGMA table_info(threads)").all() as { name: string }[])
        .map((row) => row.name));
      for (const required of ["id", "cwd", "rollout_path", "source", "archived"]) {
        if (!columns.has(required)) throw new Error("Unsupported Codex session catalog");
      }
      const names = this.names();
      const rows = db.query(`SELECT id, cwd, rollout_path, source,
        ${columns.has("name") ? "name" : "NULL"} AS name,
        ${columns.has("thread_source") ? "thread_source" : "NULL"} AS thread_source
        FROM threads WHERE archived = 0`).all() as Record<string, unknown>[];
      return rows.flatMap((row): Session[] => {
        if (!["vscode", "cli", "appServer"].includes(String(row.source))) return [];
        if (row.thread_source != null && !["user", "chatgpt_handoff"].includes(String(row.thread_source))) return [];
        if (typeof row.id !== "string" || typeof row.cwd !== "string" || !isAbsolute(row.cwd) ||
            typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)) return [];
        // Paths originate in Codex's catalog, never from an HTTP filename parameter.
        if (!inside(join(this.home, "sessions"), normalize(row.rollout_path))) return [];
        const title = (typeof row.name === "string" && row.name.trim()) || names.get(row.id) || `Codex ${row.id.slice(0, 8)}`;
        return [{ id: row.id, cwd: projectPath(row.cwd), rolloutPath: row.rollout_path,
          title: title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) }];
      });
    } finally {
      db.close();
    }
  }

  private names(): Map<string, string> {
    const names = new Map<string, string>();
    try {
      for (const line of readFileSync(join(this.home, "session_index.jsonl"), "utf8").split("\n")) {
        try {
          const value = JSON.parse(line);
          if (typeof value.id === "string" && typeof value.thread_name === "string") names.set(value.id, value.thread_name);
        } catch { /* Partial or malformed optional index entry. */ }
      }
    } catch { /* Older installations do not have this optional name index. */ }
    return names;
  }

  checkRollout(path: string): string {
    const root = realpathSync(join(this.home, "sessions"));
    const target = realpathSync(path);
    if (!inside(root, target)) throw new Error("Session file outside Codex sessions");
    return target;
  }
}
