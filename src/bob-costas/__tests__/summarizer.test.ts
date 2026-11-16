import { describe, expect, test } from "bun:test";
import { digestRecords, extractiveSummarizer } from "../summarizer.ts";

const lines = [
  JSON.stringify({ type: "user", message: { role: "user", content: "Please fix the login bug" }, timestamp: "2026-10-28T10:00:00Z" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "On it" }, { type: "tool_use", name: "Bash", input: {} }] }, timestamp: "2026-10-28T10:00:05Z" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Done" }] }, timestamp: "2026-10-28T10:00:09Z" }),
];

describe("bob costas extractive summariser", () => {
  test("digest counts turns, tools and models", () => {
    const d = digestRecords("claude", lines);
    expect(d.userTurns).toEqual(["Please fix the login bug"]);
    expect(d.assistantTurns).toBe(2);
    expect(d.toolCalls).toEqual({ Bash: 1 });
    expect(d.models).toEqual(["claude-sonnet-4-6"]);
  });
  test("short summary fits and names no model tokens", async () => {
    const s = await extractiveSummarizer.summarize("short", digestRecords("claude", lines));
    expect(s.text.length).toBeLessThanOrEqual(280);
    expect(s.text).toContain("login bug");
    expect(s.modelId).toBe("extractive/v1");
    expect(s.tokensIn + s.tokensOut).toBe(0);
  });
  test("summaries are scrubbed on the way out", async () => {
    const leaky = [JSON.stringify({ type: "user", message: { role: "user", content: "key AKIAIOSFODNN7EXAMPLE and mail a@b.com" } })];
    const s = await extractiveSummarizer.summarize("long", digestRecords("claude", leaky));
    expect(s.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(s.text).not.toContain("a@b.com");
  });
});

const env = (kind: string, payload: Record<string, unknown>, operation = "upsert") => JSON.stringify({ kind, operation, origin_id: "o", record_id: "r", revision: 1, payload });
const envelopeLines = [
  env("presence", { session_id: "s" }),
  env("session_event", { event_uid: "u0:0", role: "user", kind: "text", control_kind: "system_reminder", text: "<system-reminder>context</system-reminder>", ts_ms: 1794724438000 }),
  env("session_event", { event_uid: "u1:0", role: "user", kind: "text", control_kind: null, text: "Please fix the login bug", ts_ms: 1794724438654 }),
  env("session_event", { event_uid: "a1:0", role: "assistant", kind: "thinking", model: "claude-fable-5-2", text: "thinking", ts_ms: 1794724440000 }),
  env("session_event", { event_uid: "a2:0", role: "assistant", kind: "tool_use", model: "claude-fable-5-2", text: "Bash ls", ts_ms: 1794724446048 }),
  env("tool_call", { tool_use_id: "toolu_1", name: "Bash", ts_ms: 0 }),
  env("session_event", { event_uid: "r1:0", role: "tool_result", kind: "tool_result", text: "ok", ts_ms: 1794724446075 }),
  env("session_event", { event_uid: "a3:0", role: "assistant", kind: "text", model: "claude-fable-5-2", text: "Done", ts_ms: 1794724739536 }),
  // The same records again, as a revised upload does.
  env("session_event", { event_uid: "u1:0", role: "user", kind: "text", control_kind: null, text: "Please fix the login bug", ts_ms: 1794724438654 }),
  env("tool_call", { tool_use_id: "toolu_1", name: "Bash", ts_ms: 0 }),
  env("session_event", { event_uid: "u9:0", role: "user", kind: "text", text: "deleted turn", ts_ms: 1794724800000 }, "delete"),
];

describe("bob costas digest of delivery-envelope records", () => {
  test("counts turns, tools and models once, and skips harness text", () => {
    const d = digestRecords("claude", envelopeLines);
    expect(d.records).toBe(envelopeLines.length);
    expect(d.userTurns).toEqual(["Please fix the login bug"]);
    expect(d.assistantTurns).toBe(1);
    expect(d.toolCalls).toEqual({ Bash: 1 });
    expect(d.models).toEqual(["claude-fable-5-2"]);
    expect(d.firstTs).toBe("2026-11-15T06:33:58.000Z");
    expect(d.lastTs).toBe("2026-11-15T06:38:59.536Z");
  });
  test("the short summary names the first prompt", async () => {
    const s = await extractiveSummarizer.summarize("short", digestRecords("claude", envelopeLines));
    expect(s.text).toContain("login bug");
    expect(s.text).toContain("1 user turns");
  });
});
