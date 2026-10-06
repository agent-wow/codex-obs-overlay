import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE_TIME = Date.parse("2026-10-07T00:00:00Z");
export function record(payload: Record<string, unknown>, second = 0, type = "event_msg") {
  return { timestamp: new Date(BASE_TIME + second * 1000).toISOString(), type, payload };
}
export function item(value: Record<string, unknown>, second = 0) {
  return record({ type: "item_completed", item: value }, second);
}
export function message(text: string, second = 1, id = `message-${second}`) {
  return item({ type: "AgentMessage", id, content: [{ type: "Text", text }] }, second);
}

export function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-obs-test-"));
  mkdirSync(join(home, "sessions"));
  const database = join(home, "state_5.sqlite");
  const db = new Database(database);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, rollout_path TEXT,
    source TEXT, archived INTEGER DEFAULT 0, thread_source TEXT DEFAULT 'user', updated_at INTEGER DEFAULT 0)`);
  function add(id: string, project: string, records: unknown[] = [], options: {
    mode?: string; source?: string; threadSource?: string; archived?: boolean; parent?: string;
  } = {}) {
    const file = join(home, "sessions", `${id}.jsonl`);
    const metadata = record({ id, cwd: project, history_mode: options.mode ?? "paginated",
      parent_thread_id: options.parent }, 0, "session_meta");
    writeFileSync(file, [metadata, ...records].map((row) => JSON.stringify(row)).join("\n") + "\n");
    db.query("INSERT INTO threads (id,name,cwd,rollout_path,source,thread_source,archived) VALUES (?,?,?,?,?,?,?)")
      .run(id, `Session ${id}`, project, file, options.source ?? "vscode", options.threadSource ?? "user", Number(options.archived ?? false));
    return file;
  }
  return {
    home, database, db, add,
    append(file: string, rows: unknown[]) { appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); },
    close() { db.close(); rmSync(home, { recursive: true, force: true }); },
  };
}

export async function eventually(check: () => boolean, timeout = 2500): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}
