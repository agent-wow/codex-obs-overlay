import { describe, expect, test } from "bun:test";
import { Projection } from "../src/projection";
import { item, message, record } from "./helpers";

function paginated() {
  const projection = new Projection();
  projection.consume(record({ history_mode: "paginated" }, 0, "session_meta"), 0);
  return projection;
}

describe("display projection", () => {
  test("shows full tool details once while excluding injected instructions and raw reasoning", () => {
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
    expect(p.entries[3].text).toBe("Command");
    expect(p.entries[4].text).toBe("wow.move");
    expect(p.state).toBe("idle");
    const view = JSON.stringify(p.entries);
    expect(view).not.toMatch(/SECRET_DEVELOPER|SECRET_RAW_REASONING|SECRET_ENCRYPTED|DUPLICATE/);
    for (const detail of ["SECRET_SCRIPT", "SECRET_STDOUT", "SECRET_STDERR", "SECRET_ARGUMENT", "SECRET_RESULT"]) expect(view).toContain(detail);
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
    expect(JSON.stringify(p.entries)).not.toContain("INJECTED_CONTEXT");
    expect(p.entries[3].sections?.map((section) => section.label)).toEqual(["Arguments", "Result"]);
    expect(p.entries[3].sections?.[1].text).toContain("SECRET");
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

  test("full history, messages, whitespace and diffs are retained without the old caps", () => {
    const p = paginated();
    for (let i = 0; i < 120; i++) p.consume(message(`Message ${i}`, i, `m${i}`), i);
    p.consume(message('<img src=x onerror="alert(1)">' + "x".repeat(1000), 121), 121);
    p.consume(item({ type: "FileChange", id: "files", changes: { "/tmp/route.ts": { diff: "SECRET_DIFF" } }, status: "failed" }, 122), 122);
    expect(p.entries).toHaveLength(122);
    expect(p.entries[0].text).toBe("Message 0");
    expect(p.entries[120].text).toHaveLength('<img src=x onerror="alert(1)">'.length + 1000);
    expect(p.entries[120].text).toStartWith("<img");
    expect(p.entries[121]).toMatchObject({ text: "File changes", outcome: "failed" });
    expect(p.entries[121].sections?.[0]).toMatchObject({ text: "SECRET_DIFF", format: "diff" });
    p.consume(message("line one\n\n  indented line\n", 123), 123);
    expect(p.entries.at(-1)?.text).toBe("line one\n\n  indented line\n");
  });

  test("parented sessions and unknown records are excluded", () => {
    const p = new Projection();
    p.consume(record({ history_mode: "paginated", parent_thread_id: "parent" }, 0, "session_meta"), 0);
    p.consume(message("SECRET CHILD", 1), 1);
    p.consume(item({ type: "UnknownFutureItem", content: "SECRET" }, 2), 2);
    expect(p.entries).toEqual([]);
    expect(p.eligible).toBe(false);
  });

  test("command lifecycle updates one entry with complete command, output, exit code and timing", () => {
    const p = paginated();
    const command = { type: "CommandExecution", id: "cmd", command: ["/bin/bash", "-lc", "python3 - <<'PY'\nprint(1)\nPY"], cwd: "/play" };
    p.consume(record({ type: "item_started", item: command }, 1), 1);
    expect(p.entries[0].outcome).toBe("running");
    const output = "packet " + "x".repeat(700_000) + "\nlast packet\n";
    p.consume(item({ ...command, status: "completed", exit_code: 2, stdout: output, stderr: "Failure details\n", duration: { secs: 1, nanos: 500_000_000 } }, 2), 2);
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0].outcome).toBe("failed");
    expect(p.entries[0].sections?.find((section) => section.label === "Command")?.text).toBe(command.command[2]);
    expect(p.entries[0].sections?.find((section) => section.label === "Output")?.text).toBe(output);
    expect(p.entries[0].sections?.find((section) => section.label === "Exit code")?.text).toBe("2");
    expect(p.entries[0].sections?.find((section) => section.label === "Duration")?.text).toBe("1.5s");
  });

  test("plans, model/usage metadata and recorded collaboration items are represented", () => {
    const p = paginated();
    p.consume(record({ model: "example-model", effort: "high", base_instructions: "PRIVATE_CONTEXT" }, 1, "turn_context"), 1);
    p.consume(item({ type: "Plan", id: "plan", text: "1. Inspect\n2. Act" }, 2), 2);
    p.consume(item({ type: "CollabAgentSpawn", id: "agent", receiverThreadId: "child", prompt: "Inspect the map", raw_content: "PRIVATE_REASONING" }, 3), 3);
    const activity = p.activity;
    p.consume(record({ type: "token_count", info: { total_token_usage: { total_tokens: 1234 }, last_token_usage: { total_tokens: 500 }, model_context_window: 8192 } }, 10), 4);
    expect(p.info).toEqual({ model: "example-model", effort: "high", totalTokens: 1234, contextTokens: 500, contextWindow: 8192 });
    expect(p.activity).toBe(activity);
    expect(p.entries[0]).toMatchObject({ kind: "plan", text: "1. Inspect\n2. Act" });
    expect(JSON.stringify(p.entries[1])).toContain("Inspect the map");
    expect(JSON.stringify(p.entries)).not.toContain("PRIVATE_");
  });

  test("image attachments are registered separately without embedding image bytes in the transcript", () => {
    const p = paginated();
    const image = "data:image/png;base64,iVBORw0KGgo=";
    p.consume(item({ type: "UserMessage", id: "image", content: [{ type: "text", text: "Look here" }, { type: "image", image_url: image }] }, 1), 1);
    expect(p.entries[0].attachments).toEqual([{ id: "image:media:0", kind: "image", label: "Image" }]);
    expect(p.media.get("image:media:0")?.data).toBe("iVBORw0KGgo=");
    expect(JSON.stringify(p.entries)).not.toContain("iVBOR");
    p.consume(item({ type: "McpToolCall", id: "tool-image", server: "browser", tool: "capture", result: { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] } }, 2), 2);
    expect(p.entries[1].attachments?.[0].kind).toBe("image");
    p.consume(item({ type: "DynamicToolCall", id: "dynamic", toolName: "capture", contentItems: [
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "text", text: "Screen captured" },
    ] }, 3), 3);
    expect(p.entries[2].attachments?.[0].kind).toBe("image");
    expect(p.entries[2].sections?.[0].text).toBe("Screen captured");
    expect(JSON.stringify(p.entries[2])).not.toContain("iVBOR");
    p.consume(item({ type: "UserMessage", id: "file", content: [{ type: "input_file", filename: "route.pdf", file_data: "PRIVATE_BINARY" }] }, 4), 4);
    expect(p.entries[3].attachments?.[0]).toMatchObject({ kind: "file", label: "route.pdf" });
    expect(JSON.stringify(p.entries)).not.toContain("PRIVATE_BINARY");
    expect(JSON.stringify(p.entries)).not.toContain("iVBOR");
  });
});
