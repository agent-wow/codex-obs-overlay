import { Catalog } from "./catalog";
import { SessionReader } from "./reader";
import type { Snapshot } from "./types";

type Listener = (snapshot: Snapshot) => void;
export interface FeedOptions {
  catalogMs?: number;
  pollMs?: number;
  idleMs?: number;
}

export class ProjectFeed {
  readonly readers = new Map<string, SessionReader>();
  readonly listeners = new Set<Listener>();
  lastAccess = Date.now();
  snapshot: Snapshot = { session: null, status: "waiting", lastActivity: null, entries: [], epoch: "", info: {} };
  private signature = "";
  private catalogAvailable = false;
  private stopped = false;
  private busy: Promise<void> | null = null;
  private lastCatalog = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly project: string, private catalog: Catalog, private options: FeedOptions) {}

  async start(): Promise<void> {
    await this.refresh(true);
    if (!this.stopped) this.timer = setInterval(() => { void this.refresh(); }, this.options.pollMs ?? 500);
  }

  refresh(forceCatalog = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.update(forceCatalog).finally(() => { this.busy = null; });
    return this.busy;
  }

  private async update(forceCatalog: boolean): Promise<void> {
    const now = Date.now();
    if (forceCatalog || now - this.lastCatalog >= (this.options.catalogMs ?? 2000)) {
      this.lastCatalog = now;
      try {
        const sessions = this.catalog.list().filter((session) => session.cwd === this.project);
        const found = new Set(sessions.map((session) => session.id));
        for (const id of this.readers.keys()) if (!found.has(id)) this.readers.delete(id);
        for (const session of sessions) {
          const reader = this.readers.get(session.id);
          if (reader && reader.session.rolloutPath === session.rolloutPath) reader.session = session;
          else this.readers.set(session.id, new SessionReader(session, this.catalog));
        }
        this.catalogAvailable = true;
      } catch {
        this.catalogAvailable = false;
      }
    }
    // Serialize file reads to keep initial recovery of large project histories bounded.
    for (const reader of this.readers.values()) {
      if (this.stopped) return;
      await reader.poll();
    }
    if (this.stopped) return;
    const candidates = [...this.readers.values()]
      .filter((reader) => reader.projection.eligible && reader.projection.activity > 0)
      .sort((a, b) => b.projection.activity - a.projection.activity || a.session.id.localeCompare(b.session.id));
    const current = candidates[0];
    const signature = JSON.stringify([this.catalogAvailable, current?.available, current?.session,
      current?.projection.epoch, current?.projection.revision,
      [...this.readers.values()].some((reader) => !reader.available)]);
    if (signature === this.signature) return;
    this.signature = signature;
    const snapshot: Snapshot = current ? {
      session: { id: current.session.id, title: current.session.title },
      status: this.catalogAvailable && current.available ? current.projection.state : "unavailable",
      lastActivity: new Date(current.projection.activity).toISOString(),
      entries: [...current.projection.entries],
      epoch: current.projection.epoch,
      info: current.projection.info,
    } : {
      session: null,
      status: !this.catalogAvailable || [...this.readers.values()].some((reader) => !reader.available) ? "unavailable" : "waiting",
      lastActivity: null,
      entries: [],
      epoch: "",
      info: {},
    };
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: Listener): () => void {
    this.lastAccess = Date.now();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.lastAccess = Date.now();
    };
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.listeners.clear();
    this.readers.clear();
  }
}

export class FeedHub {
  readonly feeds = new Map<string, ProjectFeed>();
  private ready = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(readonly catalog: Catalog, private options: FeedOptions = {}) {
    this.timer = setInterval(() => this.sweep(), 10_000);
  }

  async get(project: string): Promise<ProjectFeed> {
    if (this.stopped) throw new Error("Service stopping");
    let feed = this.feeds.get(project);
    if (!feed) {
      this.sweep();
      if (this.feeds.size >= 16) throw new Error("Too many active projects");
      feed = new ProjectFeed(project, this.catalog, this.options);
      this.feeds.set(project, feed);
      this.ready.set(project, feed.start());
    }
    feed.lastAccess = Date.now();
    await this.ready.get(project);
    return feed;
  }

  sweep(): void {
    for (const [key, feed] of this.feeds) {
      if (!feed.listeners.size && Date.now() - feed.lastAccess > (this.options.idleMs ?? 30_000)) {
        feed.stop();
        this.feeds.delete(key);
        this.ready.delete(key);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const feed of this.feeds.values()) feed.stop();
    this.feeds.clear();
    this.ready.clear();
  }
}
