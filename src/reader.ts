import { open } from "node:fs/promises";
import type { Catalog } from "./catalog";
import { Projection } from "./projection";
import type { Session } from "./types";

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class SessionReader {
  projection = new Projection();
  available = false;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private discardLine = false;
  private identity = "";
  private anchor: Buffer = Buffer.alloc(0);

  constructor(public session: Session, private catalog: Catalog) {}

  async poll(): Promise<void> {
    let file;
    try {
      file = await open(this.catalog.checkRollout(this.session.rolloutPath), "r");
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Not a regular session file");
      const identity = `${stat.dev}:${stat.ino}`;
      let replaced = identity !== this.identity || stat.size < this.offset;
      if (!replaced && this.anchor.length) {
        const previous = Buffer.alloc(this.anchor.length);
        await file.read(previous, 0, previous.length, this.offset - previous.length);
        replaced = !previous.equals(this.anchor);
      }
      if (replaced) {
        this.projection = new Projection();
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.discardLine = false;
        this.anchor = Buffer.alloc(0);
      }
      this.identity = identity;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        const start = this.offset - this.pending.length;
        this.offset += bytesRead;
        const data = this.pending.length ? Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let cursor = 0;
        let end: number;
        while ((end = data.indexOf(10, cursor)) !== -1) {
          if (!this.discardLine && end - cursor <= MAX_LINE_BYTES) {
            try { this.projection.consume(JSON.parse(data.subarray(cursor, end).toString("utf8")), start + cursor); }
            catch { /* A complete malformed record must not stall subsequent activity. */ }
          }
          this.discardLine = false;
          cursor = end + 1;
        }
        if (data.length - cursor > MAX_LINE_BYTES) this.discardLine = true;
        this.pending = this.discardLine ? Buffer.alloc(0) : Buffer.from(data.subarray(cursor));
      }
      this.anchor = Buffer.alloc(Math.min(64, this.offset));
      if (this.anchor.length) await file.read(this.anchor, 0, this.anchor.length, this.offset - this.anchor.length);
      this.available = true;
    } catch {
      // Keep the last valid projection during file/catalog outages.
      this.available = false;
    } finally {
      await file?.close();
    }
  }
}
