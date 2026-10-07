import type { ProjectFeed } from "./feed";
import type { Entry, FeedUpdate, Snapshot } from "./types";

/** One snapshot in flight and one pending state: slow readers never accumulate unbounded updates. */
export function activityStream(feed: ProjectFeed, signal: AbortSignal, heartbeatMs: number,
  register: (close: () => void) => void, unregister: (close: () => void) => void): ReadableStream<Uint8Array> {
  let latest: Snapshot | undefined = feed.snapshot;
  let bytes: Uint8Array | undefined;
  let offset = 0;
  let epoch: string | undefined;
  let session: string | undefined;
  let sent = new Map<string, Entry>();
  let heartbeat = false;
  let closed = false;
  let wake: (() => void) | undefined;
  let close = () => {};
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubscribe = feed.subscribe((value) => { latest = value; wake?.(); });
      const timer = setInterval(() => { heartbeat = true; wake?.(); }, heartbeatMs);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        unregister(close);
        signal.removeEventListener("abort", close);
        latest = undefined;
        bytes = undefined;
        sent.clear();
        wake?.();
        try { controller.close(); } catch { /* Cancelled by the client. */ }
      };
      register(close);
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
    },
    async pull(controller) {
      while (!closed) {
        if (bytes && offset < bytes.length) {
          const end = Math.min(offset + 32 * 1024, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
          if (offset === bytes.length) bytes = undefined;
          return;
        }
        if (latest) {
          const value = latest;
          latest = undefined;
          const reset = value.epoch !== epoch || value.session?.id !== session;
          const entries = reset ? value.entries : value.entries.filter((entry) => sent.get(entry.id) !== entry);
          const update: FeedUpdate = { ...value, entries, reset };
          bytes = encoder.encode(`event: ${reset ? "snapshot" : "update"}\ndata: ${JSON.stringify(update)}\n\n`);
          offset = 0;
          epoch = value.epoch;
          session = value.session?.id;
          sent = new Map(value.entries.map((entry) => [entry.id, entry]));
          heartbeat = false;
        } else if (heartbeat) {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          heartbeat = false;
          return;
        } else {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
      }
    },
    cancel() { close(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
}
