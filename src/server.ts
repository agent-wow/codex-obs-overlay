import { join } from "node:path";
import { Catalog, projectPath } from "./catalog";
import { FeedHub, type FeedOptions } from "./feed";
import { activityStream } from "./stream";
import { mediaResponse } from "./media";

const assets: Record<string, { file: string; type: string }> = {
  "/widget": { file: "widget.html", type: "text/html; charset=utf-8" },
  "/widget.css": { file: "widget.css", type: "text/css; charset=utf-8" },
  "/widget.js": { file: "widget.js", type: "text/javascript; charset=utf-8" },
  "/render.js": { file: "render.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
};
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function startServer(options: { home: string; port: number; feed?: FeedOptions; heartbeatMs?: number }) {
  const catalog = new Catalog(options.home);
  const hub = new FeedHub(catalog, options.feed);
  const streams = new Set<() => void>();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: securityHeaders });
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
      if (!["/api/activity", "/api/activity/stream", "/api/media"].includes(url.pathname)) return json({ error: "Not found" }, 404);
      let project: string;
      try { project = projectPath(url.searchParams.get("project")); }
      catch (error) { return json({ error: (error as Error).message }, 400); }
      // Initial history loading may take longer than Bun's normal HTTP idle timeout.
      server.timeout(request, 0);
      let feed;
      try { feed = await hub.get(project); }
      catch { return json({ error: "Activity service temporarily unavailable" }, 503); }
      if (url.pathname === "/api/media") {
        const session = url.searchParams.get("session");
        const assetId = url.searchParams.get("asset");
        if (!session || !assetId || session !== feed.snapshot.session?.id) return json({ error: "Attachment not found" }, 404);
        const reader = feed.readers.get(session);
        const asset = reader?.projection.media.get(assetId);
        if (!asset || !feed.snapshot.entries.some((entry) => entry.attachments?.some((item) => item.id === assetId))) {
          return json({ error: "Attachment not found" }, 404);
        }
        return mediaResponse(asset, securityHeaders);
      }
      if (url.pathname === "/api/activity") return json(feed.snapshot);
      if (streams.size >= 32) return json({ error: "Too many viewers" }, 503);
      const body = activityStream(feed, request.signal, options.heartbeatMs ?? 15_000,
        (close) => streams.add(close), (close) => streams.delete(close));
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
