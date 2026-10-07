import { open } from "node:fs/promises";
import type { Catalog } from "./catalog";
import { Projection } from "./projection";
import type { Session } from "./types";

const CHUNK_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class SessionReader {
  projection = new Projection();
  available = false;
  private offset = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
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
        this.pending = [];
        this.pendingBytes = 0;
        this.discardLine = false;
        this.anchor = Buffer.alloc(0);
      }
      this.identity = identity;
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        const start = this.offset;
        this.offset += bytesRead;
        const data = buffer.subarray(0, bytesRead);
        let cursor = 0;
        while (cursor < data.length) {
          const newline = data.indexOf(10, cursor);
          const end = newline === -1 ? data.length : newline;
          const lineOffset = start + cursor - this.pendingBytes;
          if (!this.discardLine) {
            if (this.pendingBytes + end - cursor > MAX_LINE_BYTES) {
              this.projection.skipped(lineOffset);
              this.discardLine = true;
              this.pending = [];
              this.pendingBytes = 0;
            } else {
              this.pending.push(Buffer.from(data.subarray(cursor, end)));
              this.pendingBytes += end - cursor;
            }
          }
          if (newline === -1) break;
          if (!this.discardLine) {
            try { this.projection.consume(JSON.parse(Buffer.concat(this.pending, this.pendingBytes).toString("utf8")), lineOffset); }
            catch { /* A complete malformed record must not stall subsequent activity. */ }
          }
          this.pending = [];
          this.pendingBytes = 0;
          this.discardLine = false;
          cursor = end + 1;
        }
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
