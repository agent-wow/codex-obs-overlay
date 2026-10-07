import { basename, extname, isAbsolute } from "node:path";
import type { ActivityState, Attachment, Entry, EntryKind, MediaSource, Section, SessionInfo } from "./types";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const internalFields = new Set(["raw_content", "encrypted_content", "base_instructions", "internal_chat_message_metadata_passthrough"]);
const mediaTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
};
export const supportedMedia = new Set(Object.values(mediaTypes));

/** Preserve line breaks and indentation; remove terminal escape/control sequences only. */
export function displayText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function contentText(content: unknown): string {
  return array(content).filter((part) => ["text", "Text", "input_text", "output_text"].includes(part?.type))
    .map((part) => displayText(part.text)).join("\n");
}

function outcome(item: ObjectValue, fallback: Entry["outcome"] = "completed"): Entry["outcome"] {
  const status = String(item.status ?? "").replaceAll("_", "").toLowerCase();
  if (["failed", "declined", "error", "cancelled", "canceled"].includes(status) ||
      (typeof item.exit_code === "number" && item.exit_code !== 0) || item.isError === true) return "failed";
  if (["inprogress", "running", "started"].includes(status)) return "running";
  return fallback;
}

function resultValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export class Projection {
  readonly epoch = crypto.randomUUID();
  entries: Entry[] = [];
  readonly media = new Map<string, MediaSource>();
  info: SessionInfo = {};
  revision = 0;
  activity = 0;
  state: ActivityState = "idle";
  eligible = true;
  private paginated = false;
  private indices = new Map<string, number>();

  private put(entry: Entry): void {
    const index = this.indices.get(entry.id);
    if (index === undefined) {
      this.indices.set(entry.id, this.entries.length);
      this.entries.push(entry);
    } else {
      if (JSON.stringify(this.entries[index]) === JSON.stringify(entry)) return;
      this.entries[index] = entry;
    }
    this.revision++;
  }

  private setInfo(values: SessionInfo): void {
    const next = { ...this.info, ...values };
    if (JSON.stringify(next) !== JSON.stringify(this.info)) { this.info = next; this.revision++; }
  }

  private attachments(id: string, values: unknown[], markdown = ""): Attachment[] {
    const attachments: Attachment[] = [];
    const sources = new Set<string>();
    const add = (source: unknown, label: string, mime?: string) => {
      if (typeof source !== "string" || !source || sources.has(source)) return;
      if (!isAbsolute(source) && !/^data:|^https?:\/\//.test(source)) return;
      sources.add(source);
      let asset: MediaSource | undefined;
      const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(source);
      if (data && supportedMedia.has(data[1])) {
        asset = { kind: data[1].startsWith("image/") ? "image" : "audio", mime: data[1], data: data[2] };
      } else if (isAbsolute(source)) {
        const type = mime || mediaTypes[extname(source).toLowerCase()];
        if (supportedMedia.has(type)) asset = { kind: type.startsWith("image/") ? "image" : "audio", mime: type, path: source };
      }
      const assetId = `${id}:media:${attachments.length}`;
      if (asset) this.media.set(assetId, asset);
      attachments.push({ id: assetId, kind: asset?.kind ?? "file", label: displayText(label || source) });
    };
    const walk = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (typeof value === "string") { add(value, basename(value)); return; }
      const part = object(value);
      const type = String(part.type ?? "").toLowerCase().replaceAll("_", "");
      if (["image", "inputimage", "localimage", "imageurl"].includes(type)) {
        const mime = part.mimeType || part.mime_type;
        add(part.image_url?.url || part.image_url || part.url || part.path || (part.data ? `data:${mime || "image/png"};base64,${part.data}` : undefined), part.name || part.alt || "Image", mime);
      } else if (["audio", "inputaudio", "localaudio", "audiourl"].includes(type)) {
        const audio = object(part.input_audio);
        const mime = part.mimeType || part.mime_type || (audio.format === "mp3" ? "audio/mpeg" : "audio/wav");
        const data = part.data || audio.data;
        add(part.audio_url?.url || part.audio_url || part.url || part.path || (data ? `data:${mime};base64,${data}` : undefined), part.name || "Audio", mime);
      } else if (["file", "inputfile", "resourcelink"].includes(type)) {
        const source = part.path || part.file_url || part.url || part.uri;
        if (typeof source === "string" && (isAbsolute(source) || /^https?:\/\//.test(source))) add(source, part.filename || part.name || source);
        else if (part.filename || part.name) attachments.push({ id: `${id}:media:${attachments.length}`, kind: "file", label: displayText(part.filename || part.name) });
      }
      for (const key of ["content", "output", "result"]) {
        if (Array.isArray(part[key])) part[key].forEach(walk);
        else if (part[key] && typeof part[key] === "object") walk(part[key]);
      }
    };
    values.forEach(walk);
    for (const match of displayText(markdown).matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g)) add(match[2] || match[3], match[1] || "Image");
    return attachments;
  }

  private printable(value: unknown): unknown {
    if (typeof value === "string") return displayText(value);
    if (Array.isArray(value)) return value.map((part) => this.printable(part));
    if (!value || typeof value !== "object") return value;
    const part = object(value);
    if (["image", "inputimage", "localimage", "imageurl", "audio", "inputaudio", "localaudio", "audiourl", "inputfile", "file"].includes(String(part.type ?? "").toLowerCase().replaceAll("_", ""))) {
      return { type: part.type, name: part.filename || part.name, content: "See attachment" };
    }
    return Object.fromEntries(Object.entries(part).filter(([key]) => !internalFields.has(key))
      .map(([key, val]) => [key, this.printable(val)]));
  }

  private section(label: string, value: unknown, format: Section["format"] = "code"): Section[] {
    if (value === undefined || value === null || value === "") return [];
    const text = typeof value === "string" ? displayText(value) : JSON.stringify(this.printable(value), null, 2);
    return text ? [{ label, text, format }] : [];
  }

  private outputs(item: ObjectValue): Section[] {
    const sections = [...this.section("Output", item.stdout), ...this.section("Errors", item.stderr)];
    if (!sections.length) sections.push(...this.section("Output", item.aggregated_output || item.formatted_output));
    return sections;
  }

  private toolResult(value: unknown): Section[] {
    if (Array.isArray(value)) return this.toolResult({ content: value });
    const result = object(value);
    if (!Array.isArray(result.content)) return this.section("Result", value, "json");
    const sections: Section[] = [];
    for (const part of result.content) {
      if (part?.type === "text") sections.push(...this.section("Result", part.text));
      else if (!["image", "audio"].includes(part?.type)) sections.push(...this.section("Result", part, "json"));
    }
    const { content, isError, ...remaining } = result;
    if (Object.keys(remaining).length) sections.push(...this.section("Structured result", remaining, "json"));
    return sections;
  }

  consume(record: unknown, offset: number): void {
    const row = object(record);
    const p = object(row.payload);
    const parsedTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
    const active = () => { if (Number.isFinite(parsedTime) && parsedTime > this.activity) { this.activity = parsedTime; this.revision++; } };
    const emit = (id: unknown, kind: EntryKind, text: unknown, extras: Partial<Entry> = {}) => {
      const body = displayText(text);
      if (!body && !extras.sections?.length && !extras.attachments?.length) return;
      active();
      this.put({ id: typeof id === "string" && id ? id : `line-${offset}`, kind, text: body, timestamp, ...extras });
    };
    const state = (next: ActivityState) => { active(); if (this.state !== next) { this.state = next; this.revision++; } };

    if (row.type === "session_meta") {
      this.paginated = p.history_mode === "paginated";
      if (p.parent_thread_id || (p.source && typeof p.source !== "string") ||
          (p.thread_source && !["user", "chatgpt_handoff"].includes(p.thread_source))) this.eligible = false;
      return;
    }
    if (!this.eligible) return;
    if (row.type === "turn_context") {
      this.setInfo({ ...(typeof p.model === "string" ? { model: p.model } : {}), ...(typeof p.effort === "string" ? { effort: p.effort } : {}) });
      return;
    }
    if (row.type === "event_msg") {
      switch (p.type) {
        case "task_started":
          state("working");
          if (typeof p.model_context_window === "number") this.setInfo({ contextWindow: p.model_context_window });
          return;
        case "task_complete": state("idle"); return;
        case "turn_aborted": case "task_interrupted": state("interrupted"); return;
        case "token_count": {
          const info = object(p.info);
          const total = object(info.total_token_usage);
          const last = object(info.last_token_usage);
          this.setInfo({
            ...(typeof total.total_tokens === "number" ? { totalTokens: total.total_tokens } : {}),
            ...(typeof last.total_tokens === "number" ? { contextTokens: last.total_tokens } : {}),
            ...(typeof info.model_context_window === "number" ? { contextWindow: info.model_context_window } : {}),
          });
          return;
        }
        case "request_user_input": case "exec_approval_request": case "apply_patch_approval_request":
          state("needs-input");
          emit(p.id, "event", "Waiting for your input", { sections: this.section("Request", p.questions || p.command || p.reason || p.message, "json") });
          return;
        case "error": case "warning":
          emit(p.id, "event", p.message || p.error || p.type, { outcome: p.type === "error" ? "failed" : undefined }); return;
      }
      if (this.paginated && ["item_started", "item_updated", "item_completed"].includes(p.type)) {
        const item = object(p.item);
        const id = typeof item.id === "string" ? item.id : `line-${offset}`;
        const result = outcome(item, p.type === "item_completed" ? "completed" : "running");
        const duration = object(item.duration);
        const details = [
          ...this.section("Exit code", typeof item.exit_code === "number" ? String(item.exit_code) : undefined, "text"),
          ...this.section("Duration", typeof duration.secs === "number" ? `${duration.secs + (duration.nanos || 0) / 1e9}s` : undefined, "text"),
        ];
        switch (item.type) {
          case "UserMessage": case "AgentMessage": {
            const text = contentText(item.content);
            emit(id, item.type === "UserMessage" ? "user" : "assistant", text, {
              phase: item.phase, attachments: this.attachments(id, array(item.content), text),
            });
            break;
          }
          case "Reasoning":
            active();
            emit(id, "reasoning", array(item.summary_text).filter((text) => typeof text === "string").join("\n\n"));
            break;
          case "CommandExecution": {
            const command = array(item.command);
            const shell = command.length >= 3 && /^-[^-]*c/.test(String(command[1]));
            const script = shell ? command[2] : command.map((arg) => JSON.stringify(arg)).join(" ");
            emit(id, "action", "Command", { outcome: result, sections: [
              ...this.section("Working directory", item.cwd, "text"),
              ...this.section("Shell", shell ? `${command[0]} ${command[1]}` : undefined, "text"),
              ...this.section("Command", script || array(item.parsed_cmd).map((cmd) => cmd.cmd).join("\n")),
              ...this.outputs(item), ...details,
            ] });
            break;
          }
          case "FileChange": {
            const sections: Section[] = [];
            for (const [path, value] of Object.entries(object(item.changes))) {
              const change = object(value);
              sections.push(...this.section(`${change.type || "Change"}: ${path}`, change.unified_diff ?? change.diff ?? change.content ?? change, "diff"));
            }
            emit(id, "action", "File changes", { outcome: result, sections: [...sections, ...this.outputs(item)] });
            break;
          }
          case "McpToolCall": case "DynamicToolCall": {
            const output = item.result ?? item.output ?? item.contentItems;
            emit(id, "action", [item.server, item.tool || item.toolName].filter(Boolean).join(".") || "Tool call", {
              outcome: object(output).isError ? "failed" : result,
              sections: [...this.section("Arguments", resultValue(item.arguments), "json"), ...this.toolResult(resultValue(output)), ...details],
              attachments: this.attachments(id, [output]),
            });
            break;
          }
          case "Plan":
            emit(id, "plan", item.text || item.explanation || "Plan", { sections: this.section("Steps", item.plan || item.steps, "json") }); break;
          case "Extension":
            emit(id, "action", item.kind === "web.search" ? "Web search" : item.kind || "Activity", {
              outcome: result, sections: [...this.section("Query", item.query, "text"), ...this.section("Action", item.action, "json"),
                ...this.section("Results", item.results, "json")], attachments: this.attachments(id, array(item.results)),
            });
            break;
          default: {
            // Structured UI items include collaboration, review and compaction events.
            // Never fall back to dumping raw response/system/developer records.
            const { id: ignoredId, type, ...visible } = item;
            if (typeof type === "string" && !["SystemMessage", "DeveloperMessage"].includes(type)) {
              emit(id, "event", type.replace(/([a-z])([A-Z])/g, "$1 $2"), { sections: this.section("Details", visible, "json") });
            }
          }
        }
      } else if (!this.paginated) {
        if (p.type === "user_message" || p.type === "agent_message") {
          const id = p.id || `line-${offset}`;
          emit(id, p.type === "user_message" ? "user" : "assistant", p.message, {
            phase: p.phase,
            attachments: this.attachments(id, [...array(p.images), ...array(p.local_images), ...array(p.audio), ...array(p.local_audio)], p.message),
          });
        }
      }
    }
    if (!this.paginated && row.type === "response_item") {
      if (p.type === "reasoning") {
        active();
        emit(p.id, "reasoning", array(p.summary).filter((part) => part?.type === "summary_text").map((part) => displayText(part.text)).join("\n\n"));
      }
      if (["function_call", "custom_tool_call"].includes(p.type)) {
        emit(p.call_id || p.id, "action", p.name || "Tool call", { outcome: "running",
          sections: this.section(p.type === "custom_tool_call" ? "Input" : "Arguments", resultValue(p.input ?? p.arguments), "json") });
      }
      if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
        const index = this.indices.get(p.call_id);
        const entry = index === undefined ? undefined : this.entries[index];
        const output = resultValue(p.output);
        emit(p.call_id, "action", entry?.text || "Tool result", { outcome: outcome(object(output)),
          sections: [...(entry?.sections ?? []).filter((section) => !["Result", "Structured result"].includes(section.label)), ...this.toolResult(output)],
          attachments: this.attachments(p.call_id, [output]),
        });
      }
    }
  }

  skipped(offset: number): void {
    this.put({ id: `skipped-${offset}`, kind: "event", text: "A session record exceeded the 64 MiB reader limit and could not be displayed.", timestamp: new Date(0).toISOString() });
  }
}
