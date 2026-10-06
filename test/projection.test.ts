import { describe, expect, test } from "bun:test";
import { Projection } from "../src/projection";
import { item, message, record } from "./helpers";

function paginated() {
  const projection = new Projection();
  projection.consume(record({ history_mode: "paginated" }, 0, "session_meta"), 0);
  return projection;
}

describe("display projection", () => {
  test("uses structured paginated items once and never returns raw prompt/tool/reasoning fields", () => {
    const p = paginated();
    const rows = [
      record({ type: "message", role: "developer", content: [{ type: "text", text: "SECRET_DEVELOPER" }] }, 1, "response_item"),
      record({ type: "user_message", message: "DUPLICATE_EVENT" }, 1),
      item({ type: "UserMessage", id: "u", content: [{ type: "text", text: "Find the next quest" }, { type: "image", url: "SECRET_IMAGE" }] }, 1),
      record({ type: "task_started" }, 2),
      message("I’ll check the nearby quest giver.", 3, "a"),
      message("I’ll check the nearby quest giver.", 3, "a"),
      record({ type: "message", role: "assistant", content: [{ type: "text", text: "DUPLICATE_RESPONSE" }] }, 3, "response_item"),
      item({ type: "Reasoning", id: "r", summary_text: ["Check the quest log first."], raw_content: ["SECRET_RAW_REASONING"] }, 4),
      record({ type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "DUPLICATE_SUMMARY" }], encrypted_content: "SECRET_ENCRYPTED" }, 4, "response_item"),
      item({ type: "CommandExecution", id: "c", parsed_cmd: [{ type: "unknown", cmd: "python3 - <<'PY'\nSECRET_SCRIPT\nPY" }], status: "completed", exit_code: 0, stdout: "SECRET_STDOUT", stderr: "SECRET_STDERR" }, 5),
      item({ type: "McpToolCall", id: "m", server: "wow", tool: "move", arguments: { key: "SECRET_ARGUMENT" }, result: { content: "SECRET_RESULT" }, status: "completed" }, 6),
      record({ type: "task_complete", last_agent_message: "DUPLICATE_FINAL" }, 7),
    ];
    rows.forEach((row, i) => p.consume(row, i + 1));
    expect(p.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "reasoning", "action", "action"]);
    expect(p.entries[3].text).toBe("Run python3");
    expect(p.entries[4].text).toBe("Call wow.move");
    expect(p.state).toBe("idle");
    expect(JSON.stringify(p.entries)).not.toMatch(/SECRET|DUPLICATE/);
  });

  test("legacy events pair calls and outputs without duplicate response messages", () => {
    const p = new Projection();
    const rows = [
      record({ type: "user_message", message: "Go to the camp" }, 1),
      record({ type: "message", role: "user", content: [{ type: "input_text", text: "INJECTED_CONTEXT" }] }, 1, "response_item"),
      record({ type: "agent_message", message: "On my way." }, 2),
      record({ type: "reasoning", id: "reason", summary: [{ type: "summary_text", text: "Follow the road." }], encrypted_content: "SECRET" }, 3, "response_item"),
      record({ type: "function_call", name: "wow.move", call_id: "call", arguments: "SECRET" }, 4, "response_item"),
      record({ type: "function_call_output", call_id: "call", output: { isError: true, content: "SECRET" } }, 5, "response_item"),
      record({ type: "turn_aborted" }, 6),
    ];
    rows.forEach((row, i) => p.consume(row, i));
    expect(p.entries).toHaveLength(4);
    expect(p.entries[3].outcome).toBe("failed");
    expect(p.state).toBe("interrupted");
    expect(JSON.stringify(p.entries)).not.toMatch(/SECRET|INJECTED/);
  });

  test("metadata cannot make a session most recent; empty summaries are not fabricated", () => {
    const p = paginated();
    p.consume(message("Actual activity", 2), 1);
    const activity = p.activity;
    p.consume(record({ type: "thread_settings_applied" }, 900), 2);
    p.consume(record({ type: "token_count" }, 901), 3);
    expect(p.activity).toBe(activity);
    p.consume(item({ type: "Reasoning", id: "hidden", summary_text: [], raw_content: ["SECRET"] }, 3), 4);
    expect(p.entries).toHaveLength(1);
  });

  test("history and text are bounded, HTML remains literal, and action failures are visible", () => {
    const p = paginated();
    for (let i = 0; i < 120; i++) p.consume(message(`Message ${i}`, i, `m${i}`), i);
    p.consume(message('<img src=x onerror="alert(1)">' + "x".repeat(1000), 121), 121);
    p.consume(item({ type: "FileChange", id: "files", changes: { "/tmp/route.ts": { diff: "SECRET_DIFF" } }, status: "failed" }, 122), 122);
    expect(p.entries).toHaveLength(100);
    expect(p.entries[98].text).toHaveLength(640);
    expect(p.entries[98].text).toStartWith("<img");
    expect(p.entries[98].text).toEndWith("…");
    expect(p.entries[99]).toMatchObject({ text: "Edit route.ts", outcome: "failed" });
  });

  test("parented sessions and unknown records are excluded", () => {
    const p = new Projection();
    p.consume(record({ history_mode: "paginated", parent_thread_id: "parent" }, 0, "session_meta"), 0);
    p.consume(message("SECRET CHILD", 1), 1);
    p.consume(item({ type: "UnknownFutureItem", content: "SECRET" }, 2), 2);
    expect(p.entries).toEqual([]);
    expect(p.eligible).toBe(false);
  });
});
