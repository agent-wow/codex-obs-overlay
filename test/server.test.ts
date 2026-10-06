import { afterEach, expect, test } from "bun:test";
import { startServer } from "../src/server";
import type { Snapshot } from "../src/types";
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
    async next(): Promise<Snapshot> {
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
  expect(text).not.toMatch(/PRIVATE_|raw_content|arguments|rolloutPath/);
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
  expect((await a.next()).entries.map((e) => e.text)).toEqual(["First", "Second"]);
  expect((await b.next()).entries).toHaveLength(2);
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
