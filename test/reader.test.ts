import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Catalog, projectPath } from "../src/catalog";
import { SessionReader } from "../src/reader";
import { fixture, message, record } from "./helpers";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { fixtures.splice(0).forEach((f) => f.close()); });

test("catalog reads are read-only, project paths normalize, and internal/archived sessions are excluded", () => {
  const f = setup();
  f.add("normal", "/play/zone/");
  f.add("review", "/play/zone", [], { threadSource: "guardian_review" });
  f.add("child", "/play/zone", [], { source: '{"subagent":{}}' });
  f.add("archive", "/play/zone", [], { archived: true });
  const before = readFileSync(f.database);
  expect(new Catalog(f.home).list().map((s) => [s.id, s.cwd])).toEqual([["normal", "/play/zone"]]);
  expect(readFileSync(f.database).equals(before)).toBe(true);
  expect(projectPath("/play/./zone/../zone/")).toBe("/play/zone");
  for (const path of [null, "", "zone", "/play\u0000"]) expect(() => projectPath(path)).toThrow();
});

test("incremental reader waits for complete UTF-8 records, skips malformed lines, and does not replay", async () => {
  const f = setup();
  const file = f.add("one", "/play", [message("First", 1)]);
  const catalog = new Catalog(f.home);
  const reader = new SessionReader(catalog.list()[0], catalog);
  const before = readFileSync(file);
  await reader.poll();
  expect(reader.projection.entries.map((e) => e.text)).toEqual(["First"]);
  expect(readFileSync(file).equals(before)).toBe(true);
  const next = Buffer.from(JSON.stringify(message("Next 🐉", 2)) + "\n");
  const cut = next.indexOf(Buffer.from("🐉")) + 2;
  appendFileSync(file, next.subarray(0, cut));
  await reader.poll();
  expect(reader.projection.entries).toHaveLength(1);
  appendFileSync(file, next.subarray(cut));
  appendFileSync(file, "{broken}\n");
  f.append(file, [message("Third", 3)]);
  await reader.poll();
  await reader.poll();
  expect(reader.projection.entries.map((e) => e.text)).toEqual(["First", "Next 🐉", "Third"]);
});

test("reader preserves an outage snapshot and resets on replacement or truncation", async () => {
  const f = setup();
  const file = f.add("one", "/play", [message("Original", 1)]);
  const catalog = new Catalog(f.home);
  const reader = new SessionReader(catalog.list()[0], catalog);
  await reader.poll();
  renameSync(file, `${file}.bak`);
  await reader.poll();
  expect(reader.available).toBe(false);
  expect(reader.projection.entries[0].text).toBe("Original");
  writeFileSync(file, [record({ history_mode: "paginated" }, 0, "session_meta"), message("Replacement", 2)]
    .map((row) => JSON.stringify(row)).join("\n") + "\n");
  await reader.poll();
  expect(reader.available).toBe(true);
  expect(reader.projection.entries.map((e) => e.text)).toEqual(["Replacement"]);
  writeFileSync(file, "");
  await reader.poll();
  expect(reader.projection.entries).toEqual([]);
});

test("same-inode rewrite is detected even when file size does not shrink", async () => {
  const f = setup();
  const file = f.add("one", "/play", [message("Old activity", 1)]);
  const catalog = new Catalog(f.home);
  const reader = new SessionReader(catalog.list()[0], catalog);
  await reader.poll();
  writeFileSync(file, readFileSync(file, "utf8").replace("Old activity", "New activity"));
  await reader.poll();
  expect(reader.projection.entries.map((e) => e.text)).toEqual(["New activity"]);
});

test("session symlinks cannot read files outside the Codex sessions directory", async () => {
  const f = setup();
  const file = f.add("one", "/play", [message("PRIVATE", 1)]);
  renameSync(file, join(f.home, "outside.jsonl"));
  symlinkSync(join(f.home, "outside.jsonl"), file);
  const catalog = new Catalog(f.home);
  const reader = new SessionReader(catalog.list()[0], catalog);
  await reader.poll();
  expect(reader.available).toBe(false);
  expect(reader.projection.entries).toEqual([]);
});

test("oversized and interrupted lines cannot block later records", async () => {
  const f = setup();
  const file = f.add("one", "/play", [message("Before", 1)]);
  const catalog = new Catalog(f.home);
  const reader = new SessionReader(catalog.list()[0], catalog);
  await reader.poll();
  appendFileSync(file, "x".repeat(8 * 1024 * 1024 + 1));
  await reader.poll();
  appendFileSync(file, "rest of oversized line\n");
  f.append(file, [message("After", 2)]);
  await reader.poll();
  expect(reader.projection.entries.map((e) => e.text)).toEqual(["Before", "After"]);
});
