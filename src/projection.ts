import { basename } from "node:path";
import type { ActivityState, Entry, EntryKind } from "./types";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];

export function excerpt(value: unknown, limit = 640): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function contentText(content: unknown): string {
  return array(content).filter((part) => ["text", "Text", "input_text", "output_text"].includes(part?.type))
    .map((part) => typeof part.text === "string" ? part.text : "").join("\n");
}

function outcome(item: ObjectValue): Entry["outcome"] {
  if (["failed", "declined", "error"].includes(item.status) ||
      (typeof item.exit_code === "number" && item.exit_code !== 0)) return "failed";
  if (["in_progress", "running"].includes(item.status)) return "running";
  return "completed";
}

// A command's arguments may contain scripts, credentials, or full tool responses.
// Only display structured action metadata and the executable name for unknown commands.
function executable(command: unknown): string {
  if (typeof command !== "string") return "command";
  const words = command.trim().split(/\s+/).filter(Boolean);
  let word = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "command";
  if (["sudo", "env", "command"].includes(word)) word = words[words.indexOf(word) + 1] ?? "command";
  return /^[\w./+-]+$/.test(word) ? basename(word).slice(0, 60) : "command";
}

function commandLabel(item: ObjectValue): string {
  const labels = array(item.parsed_cmd).slice(0, 3).map((raw) => {
    const parsed = object(raw);
    switch (parsed.type) {
      case "read": return `Read ${excerpt(parsed.name || basename(String(parsed.path || "file")), 90)}`;
      case "list_files": return `List files${parsed.path ? ` in ${basename(String(parsed.path))}` : ""}`;
      case "search": return `Search ${excerpt(parsed.query, 100) || "files"}`;
      default: return `Run ${executable(parsed.cmd)}`;
    }
  });
  if (labels.length) return [...new Set(labels)].join(" · ");
  const command = array(item.command);
  const script = command.length >= 3 && /^-[^-]*c/.test(String(command[1])) ? command[2] : command[0];
  return `Run ${executable(script)}`;
}

export class Projection {
  entries: Entry[] = [];
  activity = 0;
  state: ActivityState = "idle";
  eligible = true;
  private paginated = false;
  private seen = new Set<string>();

  consume(record: unknown, offset: number): void {
    const row = object(record);
    const p = object(row.payload);
    const parsedTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date(0).toISOString();
    const active = () => { if (Number.isFinite(parsedTime)) this.activity = Math.max(this.activity, parsedTime); };
    const put = (id: unknown, kind: EntryKind, text: unknown, result?: Entry["outcome"]) => {
      const body = excerpt(text, kind === "action" ? 220 : 640);
      if (!body) return;
      active();
      const key = typeof id === "string" && id ? id : `line-${offset}`;
      const entry: Entry = { id: key, kind, text: body, timestamp, ...(result ? { outcome: result } : {}) };
      const existing = this.entries.findIndex((entry) => entry.id === key);
      if (existing !== -1) this.entries[existing] = entry;
      else if (!this.seen.has(key)) this.entries.push(entry);
      this.seen.add(key);
      while (this.entries.length > 100) this.entries.shift();
      while (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    };

    if (row.type === "session_meta") {
      this.paginated = p.history_mode === "paginated";
      if (p.parent_thread_id || (p.source && typeof p.source !== "string") ||
          (p.thread_source && !["user", "chatgpt_handoff"].includes(p.thread_source))) this.eligible = false;
      return;
    }
    if (!this.eligible) return;
    if (row.type === "event_msg") {
      switch (p.type) {
        case "task_started": active(); this.state = "working"; return;
        case "task_complete": active(); this.state = "idle"; return;
        case "turn_aborted": case "task_interrupted": active(); this.state = "interrupted"; return;
      }
      if (this.paginated && p.type === "item_completed") {
        const item = object(p.item);
        switch (item.type) {
          case "UserMessage": put(item.id, "user", contentText(item.content)); break;
          case "AgentMessage": put(item.id, "assistant", contentText(item.content)); break;
          case "Reasoning":
            active();
            put(item.id, "reasoning", array(item.summary_text).filter((text) => typeof text === "string").join("\n"));
            break;
          case "CommandExecution": put(item.id, "action", commandLabel(item), outcome(item)); break;
          case "FileChange": {
            const names = Object.keys(object(item.changes)).map((path) => basename(path));
            put(item.id, "action", `Edit ${names.slice(0, 3).join(", ") || "files"}${names.length > 3 ? ` (+${names.length - 3})` : ""}`, outcome(item));
            break;
          }
          case "McpToolCall":
            put(item.id, "action", `Call ${excerpt(item.server, 50)}.${excerpt(item.tool, 90)}`,
              object(item.result).isError ? "failed" : outcome(item));
            break;
          case "Extension":
            if (item.kind === "web.search") {
              const query = excerpt(item.query, 160);
              put(item.id, "action", query ? `Search web: ${query}` : "Browse web", "completed");
            }
            break;
        }
      } else if (!this.paginated) {
        // Canonical legacy messages exclude response_item's injected prompt/context messages.
        if (p.type === "user_message") put(p.id, "user", p.message);
        if (p.type === "agent_message") put(p.id, "assistant", p.message);
      }
    }
    if (!this.paginated && row.type === "response_item") {
      if (p.type === "reasoning") {
        active();
        put(p.id, "reasoning", array(p.summary).filter((part) => part?.type === "summary_text")
          .map((part) => typeof part.text === "string" ? part.text : "").join("\n"));
      }
      if (["function_call", "custom_tool_call"].includes(p.type)) {
        put(p.call_id || p.id, "action", `Call ${excerpt(p.name, 120) || "tool"}`, "running");
      }
      if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
        const entry = this.entries.find((entry) => entry.id === p.call_id);
        if (entry) put(entry.id, "action", entry.text, object(p.output).isError ? "failed" : "completed");
      }
    }
  }
}
