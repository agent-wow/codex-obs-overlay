import { afterEach, expect, test } from "bun:test";
import { startServer } from "../src/server";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedUpdate } from "../src/types";
import { eventually, fixture, item, message } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function setup() {
  const f = fixture();
  cleanup.push(() => f.close());
  const app = startServer({ home: f.home, port: 0, feed: { pollMs: 20, catalogMs: 40 }, heartbeatMs: 50 });
  cleanup.push(() => app.stop());
  return { f, app, url: (path: string) => new URL(path, app.server.url) };
}

async function stream(url: URL) {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  cleanup.push(() => { abort.abort(); reader.releaseLock(); });
  return {
    response, abort,
    async next(): Promise<FeedUpdate> {
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split >= 0) {
          const packet = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = packet.split("\n").find((line) => line.startsWith("data: "));
          if (line) return JSON.parse(line.slice(6));
          continue;
        }
        const result = await reader.read();
        if (result.done) throw new Error("Stream ended before snapshot");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
  };
}

test("HTTP validates selection, is read-only, serves local assets and exposes only display fields", async () => {
  const { f, url } = setup();
  f.add("one", "/play", [message('<script>alert("x")</script>', 1),
    item({ type: "Reasoning", id: "r", summary_text: ["Saved summary"], raw_content: ["PRIVATE_RAW"] }, 2),
    item({ type: "McpToolCall", id: "m", server: "wow", tool: "move", arguments: { key: "PRIVATE_KEY" },
      result: { content: "PRIVATE_OUTPUT" }, status: "completed" }, 3)]);
  for (const path of ["/widget", "/api/activity", "/api/activity?project=relative", "/api/activity/stream?project=%00"]) {
    expect((await fetch(url(path))).status).toBe(400);
  }
  expect((await fetch(url("/api/activity?project=/play"), { method: "POST" })).status).toBe(405);
  expect((await fetch(url("/healthz"))).status).toBe(200);
  expect((await fetch(url("/auth.json"))).status).toBe(404);
  expect((await fetch(url("/api/activity?project=/play"), { headers: { Host: "untrusted.example" } })).status).toBe(403);
  const response = await fetch(url("/api/activity?project=/play"));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
  const text = await response.text();
  expect(text).not.toMatch(/PRIVATE_RAW|raw_content|rolloutPath/);
  expect(text).toContain("PRIVATE_KEY");
  expect(text).toContain("PRIVATE_OUTPUT");
  expect(JSON.parse(text).entries[0].text).toStartWith("<script>");
  const html = await fetch(url("/widget?project=/play"));
  expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await html.text()).toContain('src="/widget.js"');
  expect((await fetch(url("/widget.css"))).headers.get("content-type")).toContain("text/css");
  const empty = await (await fetch(url("/api/activity?project=/play/child"))).json();
  expect(empty).toMatchObject({ status: "waiting", entries: [], session: null });
});

test("SSE shares readers, sends changes, reconnects with a fresh snapshot, and cleans up", async () => {
  const { f, app, url } = setup();
  const file = f.add("one", "/play", [message("First", 1)]);
  const a = await stream(url("/api/activity/stream?project=/play"));
  const b = await stream(url("/api/activity/stream?project=/play"));
  expect(a.response.headers.get("content-type")).toBe("text/event-stream");
  expect((await a.next()).entries).toHaveLength(1);
  expect((await b.next()).entries).toHaveLength(1);
  expect(app.hub.feeds.get("/play")?.readers.size).toBe(1);
  expect(app.hub.feeds.get("/play")?.listeners.size).toBe(2);
  f.append(file, [message("Second", 2)]);
  const update = await a.next();
  expect(update.reset).toBe(false);
  expect(update.entries.map((e) => e.text)).toEqual(["Second"]);
  expect((await b.next()).entries).toHaveLength(1);
  a.abort.abort();
  b.abort.abort();
  await eventually(() => app.hub.feeds.get("/play")?.listeners.size === 0);
  const c = await stream(url("/api/activity/stream?project=/play"));
  expect((await c.next()).entries.map((e) => e.text)).toEqual(["First", "Second"]);
});

test("SSE remains connected beyond Bun's default ten-second idle timeout", async () => {
  const f = fixture();
  cleanup.push(() => f.close());
  const file = f.add("one", "/play", [message("First", 1)]);
  const app = startServer({ home: f.home, port: 0, heartbeatMs: 15_000, feed: { pollMs: 50 } });
  cleanup.push(() => app.stop());
  const s = await stream(new URL("/api/activity/stream?project=/play", app.server.url));
  await s.next();
  await Bun.sleep(10_500);
  f.append(file, [message("Still connected", 2)]);
  expect((await s.next()).entries.at(-1)?.text).toBe("Still connected");
});

test("large transcripts cross the former SSE limit, preserve all history and update existing tools", async () => {
  const { f, url } = setup();
  const output = "start\n" + "packet ".repeat(100_000) + "\nend";
  const file = f.add("one", "/play", [
    ...Array.from({ length: 120 }, (_, n) => message(`Message ${n}`, n + 1)),
    item({ type: "CommandExecution", id: "long", command: ["echo", "start"], stdout: output, status: "in_progress" }, 121),
  ]);
  const s = await stream(url("/api/activity/stream?project=/play"));
  const snapshot = await s.next();
  expect(snapshot.reset).toBe(true);
  expect(snapshot.entries).toHaveLength(121);
  expect(snapshot.entries.at(-1)?.sections?.find((section) => section.label === "Output")?.text).toBe(output);
  f.append(file, [item({ type: "CommandExecution", id: "long", command: ["echo", "start"], stdout: output + "\ndone", status: "completed", exit_code: 0 }, 122)]);
  const update = await s.next();
  expect(update.reset).toBe(false);
  expect(update.entries).toHaveLength(1);
  expect(update.entries[0].id).toBe("long");
  expect(update.entries[0].outcome).toBe("completed");
});

test("media is scoped to recorded attachments and cannot serve arbitrary local files or remote images", async () => {
  const { f, url } = setup();
  const local = join(f.home, "screenshot.png");
  writeFileSync(local, Buffer.from("iVBORw0KGgo=", "base64"));
  const fake = join(f.home, "not-an-image.png");
  writeFileSync(fake, "PRIVATE_FILE");
  f.add("one", "/play", [item({ type: "UserMessage", id: "images", content: [
    { type: "local_image", path: local }, { type: "local_image", path: fake },
    { type: "image", image_url: "https://example.com/image.png" },
  ] }, 1)]);
  const snapshot = await (await fetch(url("/api/activity?project=/play"))).json();
  expect(snapshot.entries[0].attachments.map((a: any) => a.kind)).toEqual(["image", "image", "file"]);
  const media = url("/api/media?project=/play&session=one&asset=images:media:0");
  const image = await fetch(media);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect((await image.arrayBuffer()).byteLength).toBe(8);
  expect((await fetch(url("/api/media?project=/play&session=one&asset=images:media:1"))).status).toBe(415);
  expect((await fetch(url("/api/media?project=/play&session=one&asset=images:media:2"))).status).toBe(404);
  expect((await fetch(url("/api/media?project=/other&session=one&asset=images:media:0"))).status).toBe(404);
  expect((await fetch(url("/api/media?project=/play&session=other&asset=images:media:0"))).status).toBe(404);
  expect((await fetch(url("/api/media?project=/play&session=one&asset=/etc/passwd"))).status).toBe(404);
});
