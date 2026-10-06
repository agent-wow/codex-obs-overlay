import { join } from "node:path";
import { Catalog, projectPath } from "./catalog";
import { FeedHub, type FeedOptions } from "./feed";
import type { Snapshot } from "./types";

const assets: Record<string, { file: string; type: string }> = {
  "/widget": { file: "widget.html", type: "text/html; charset=utf-8" },
  "/widget.css": { file: "widget.css", type: "text/css; charset=utf-8" },
  "/widget.js": { file: "widget.js", type: "text/javascript; charset=utf-8" },
  "/render.js": { file: "render.js", type: "text/javascript; charset=utf-8" },
};
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function startServer(options: { home: string; port: number; feed?: FeedOptions; heartbeatMs?: number }) {
  const catalog = new Catalog(options.home);
  const hub = new FeedHub(catalog, options.feed);
  const streams = new Set<() => void>();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: securityHeaders });
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        return json({ error: "Loopback hostname required" }, 403);
      }
      if (request.method !== "GET") return new Response("Read-only service", {
        status: 405, headers: { ...securityHeaders, Allow: "GET" },
      });
      if (url.pathname === "/healthz") {
        try { catalog.list(); return json({ status: "ok", source: "available" }); }
        catch { return json({ status: "degraded", source: "unavailable" }, 503); }
      }
      if (url.pathname === "/") return new Response(
        "Codex OBS overlay\nUse /widget?project=<URL-encoded absolute directory>\nOBS: 800 × 300, X 1120, Y 780 on a 1920 × 1080 canvas.\n", {
          headers: { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      if (assets[url.pathname]) {
        if (url.pathname === "/widget") {
          try { projectPath(url.searchParams.get("project")); }
          catch (error) { return json({ error: (error as Error).message }, 400); }
        }
        const asset = assets[url.pathname];
        return new Response(Bun.file(join(import.meta.dir, "web", asset.file)), {
          headers: { ...securityHeaders, "Content-Type": asset.type },
        });
      }
      if (!["/api/activity", "/api/activity/stream"].includes(url.pathname)) return json({ error: "Not found" }, 404);
      let project: string;
      try { project = projectPath(url.searchParams.get("project")); }
      catch (error) { return json({ error: (error as Error).message }, 400); }
      // Initial history loading may take longer than Bun's normal HTTP idle timeout.
      server.timeout(request, 0);
      let feed;
      try { feed = await hub.get(project); }
      catch { return json({ error: "Activity service temporarily unavailable" }, 503); }
      if (url.pathname === "/api/activity") return json(feed.snapshot);
      if (streams.size >= 32) return json({ error: "Too many viewers" }, 503);
      const selectedFeed = feed;
      let cleanup = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          let unsubscribe = () => {};
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            streams.delete(cleanup);
            request.signal.removeEventListener("abort", cleanup);
            try { controller.close(); } catch { /* Already cancelled by the browser. */ }
          };
          const send = (text: string) => {
            if (closed) return;
            const bytes = encoder.encode(text);
            if ((controller.desiredSize ?? 0) < bytes.length) { cleanup(); return; }
            try { controller.enqueue(bytes); } catch { cleanup(); }
          };
          const snapshot = (value: Snapshot) => send(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`);
          unsubscribe = selectedFeed.subscribe(snapshot);
          streams.add(cleanup);
          request.signal.addEventListener("abort", cleanup, { once: true });
          if (request.signal.aborted) { cleanup(); return; }
          heartbeat = setInterval(() => send(": heartbeat\n\n"), options.heartbeatMs ?? 15_000);
          snapshot(selectedFeed.snapshot);
        },
        cancel() { cleanup(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: 512 * 1024 }));
      return new Response(body, {
        headers: { ...securityHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
      });
    },
  });
  return {
    server,
    hub,
    async stop() {
      for (const close of streams) close();
      hub.stop();
      await server.stop(true);
    },
  };
}
