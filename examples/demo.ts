import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";

// Synthetic data lives in its own temporary Codex home; actual sessions are never touched.
const home = mkdtempSync(join(tmpdir(), "codex-obs-demo-"));
mkdirSync(join(home, "sessions"));
const file = join(home, "sessions", "demo.jsonl");
const db = new Database(join(home, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT, rollout_path TEXT, source TEXT, archived INTEGER, thread_source TEXT)");
db.query("INSERT INTO threads VALUES (?,?,?,?,?,0,'user')").run("demo", "Valley of Trials · Durokar", "/demo/agent-wow", file, "vscode");
db.close();
writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { history_mode: "paginated" } }) + "\n");
const rows = (await Bun.file(join(import.meta.dir, "session.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
let tick = 0;
const append = () => {
  const row = structuredClone(rows[tick % rows.length]);
  row.timestamp = new Date().toISOString();
  if (row.payload.item?.id) row.payload.item.id += `-${Math.floor(tick / rows.length)}`;
  appendFileSync(file, JSON.stringify(row) + "\n");
  tick++;
};
// Immediately populate the panel, then demonstrate live updates.
for (let i = 0; i < rows.length; i++) append();
const app = startServer({ home, port: Number(process.env.CODEX_OBS_PORT ?? 3005) });
const timer = setInterval(append, 2500);
console.error(`Synthetic demo: ${new URL("/widget?project=%2Fdemo%2Fagent-wow", app.server.url)}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
});
