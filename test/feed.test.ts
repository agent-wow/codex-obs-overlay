import { afterEach, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { Catalog } from "../src/catalog";
import { FeedHub } from "../src/feed";
import { fixture, message, record } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); });
function setup() {
  const f = fixture();
  cleanup.push(() => f.close());
  const hub = new FeedHub(new Catalog(f.home), { pollMs: 100_000, idleMs: 100 });
  cleanup.push(() => hub.stop());
  return { f, hub };
}

test("selects by conversation activity, ignores metadata and isolates exact project directories", async () => {
  const { f, hub } = setup();
  const a = f.add("a", "/play", [message("A", 1)]);
  f.add("b", "/play", [message("B", 3)]);
  f.add("nested", "/play/sub", [message("OTHER PROJECT", 500)]);
  f.add("review", "/play", [message("INTERNAL REVIEW", 900)], { threadSource: "guardian_review" });
  f.add("child", "/play", [message("CHILD", 901)], { parent: "a" });
  const feed = await hub.get("/play");
  expect(feed.snapshot.session?.id).toBe("b");
  f.append(a, [record({ type: "thread_settings_applied" }, 1000)]);
  f.db.query("UPDATE threads SET updated_at = 999999, name = 'Renamed A' WHERE id = 'a'").run();
  await feed.refresh(true);
  expect(feed.snapshot.session?.id).toBe("b");
  f.append(a, [message("A is active again", 4)]);
  await feed.refresh();
  expect(feed.snapshot.session).toEqual({ id: "a", title: "Renamed A" });
  expect(feed.snapshot.entries.map((e) => e.text)).toEqual(["A", "A is active again"]);
  expect(JSON.stringify(feed.snapshot)).not.toMatch(/OTHER PROJECT|INTERNAL REVIEW|CHILD/);
});

test("shares readers, recovers recent history, waits without fallback and evicts unused feeds", async () => {
  const { f, hub } = setup();
  f.add("a", "/play", Array.from({ length: 130 }, (_, i) => message(`Message ${i}`, i + 1)));
  const [feed, same] = await Promise.all([hub.get("/play"), hub.get("/play")]);
  expect(feed).toBe(same);
  expect(feed.readers.size).toBe(1);
  expect(feed.snapshot.entries).toHaveLength(100);
  expect(feed.snapshot.entries[0].text).toBe("Message 30");
  expect((await hub.get("/missing")).snapshot).toMatchObject({ session: null, status: "waiting", entries: [] });
  const unsub = feed.subscribe(() => {});
  feed.lastAccess = 0;
  hub.sweep();
  expect(hub.feeds.has("/play")).toBe(true);
  unsub();
  feed.lastAccess = 0;
  hub.sweep();
  expect(hub.feeds.has("/play")).toBe(false);
  expect(feed.readers.size).toBe(0);
});

test("catalog outages preserve activity; archival removes it and new sessions are discovered", async () => {
  const { f, hub } = setup();
  f.add("a", "/play", [message("Last known", 1)]);
  const feed = await hub.get("/play");
  renameSync(f.database, `${f.database}.bak`);
  await feed.refresh(true);
  expect(feed.snapshot.status).toBe("unavailable");
  expect(feed.snapshot.entries[0].text).toBe("Last known");
  renameSync(`${f.database}.bak`, f.database);
  await feed.refresh(true);
  expect(feed.snapshot.status).toBe("idle");
  f.db.query("UPDATE threads SET archived = 1 WHERE id = 'a'").run();
  await feed.refresh(true);
  expect(feed.snapshot).toMatchObject({ status: "waiting", entries: [], session: null });
  f.add("new", "/play", [record({ type: "task_started" }, 5), message("New run", 6)]);
  await feed.refresh(true);
  expect(feed.snapshot).toMatchObject({ status: "working", session: { id: "new" } });
});
