/**
 * Bob Costas summarisers. `extractive` runs with no model and is the default
 * (Khaliq's self-host decision: model calls off unless switched on). The model
 * summariser (`model-summarizer.ts`, chosen by BOB_COSTAS_MODEL there in
 * `summarizerFromEnv`) plugs in behind the same interface; its telemetry carries
 * model id and token counts only, never prompts or outputs.
 */
import { scrubText } from "../shared/vendor.ts";

export interface SessionDigest {
  harness: string;
  records: number;
  userTurns: string[];
  assistantTurns: number;
  toolCalls: Record<string, number>;
  models: string[];
  firstTs?: string;
  lastTs?: string;
}

export interface Summary {
  text: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}

/** Who the summary is for: the model summariser's budget and caps key on it. Ids only. */
export interface SummaryContext {
  orgId: string;
  /** The logical session within the org (workspace, harness, session id). */
  sessionKey: string;
  traceId?: string;
}

export interface Summarizer {
  readonly id: string;
  summarize(kind: "short" | "long", digest: SessionDigest, ctx?: SummaryContext): Promise<Summary>;
}

/** Parses scrubbed JSONL transcript records into a digest. Harness-agnostic best effort. */
export function digestRecords(harness: string, lines: string[]): SessionDigest {
  const d: SessionDigest = { harness, records: 0, userTurns: [], assistantTurns: 0, toolCalls: {}, models: [] };
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    d.records += 1;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The delivery envelope a self-hosted client uploads: {kind, operation, payload}. A raw
    // harness line (below) has neither `payload` nor these kinds.
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object" && typeof rec.kind === "string") {
      if (rec.operation === "delete") continue;
      digestEnvelope(d, rec.kind, payload, seen);
      continue;
    }
    const ts = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
    if (ts) {
      d.firstTs ??= ts;
      d.lastTs = ts;
    }
    const msg = rec.message as Record<string, unknown> | undefined;
    const role = (msg?.role ?? rec.role ?? rec.type) as string | undefined;
    const content = msg?.content ?? rec.content;
    if (role === "user") {
      const text = textOf(content);
      if (text) d.userTurns.push(text);
    } else if (role === "assistant") {
      d.assistantTurns += 1;
      if (typeof msg?.model === "string" && !d.models.includes(msg.model)) d.models.push(msg.model);
      if (Array.isArray(content))
        for (const part of content as Record<string, unknown>[])
          if (part?.type === "tool_use" && typeof part.name === "string") d.toolCalls[part.name] = (d.toolCalls[part.name] ?? 0) + 1;
    }
  }
  return d;
}

/**
 * One delivery-envelope record. A `session_event` carries one block of a turn (`role`, block
 * `kind`, `text`); a `tool_call` carries the tool's `name`. A record is uploaded again when it
 * is revised, so each is counted once by its uid. Harness-injected user text (`control_kind`:
 * a system reminder, the Codex context wrapper) is not a user turn.
 */
function digestEnvelope(d: SessionDigest, kind: string, p: Record<string, unknown>, seen: Set<string>): void {
  const uid = kind === "session_event" ? p.event_uid : kind === "tool_call" ? p.tool_use_id ?? p.id : undefined;
  if (typeof uid === "string" || typeof uid === "number") {
    const key = `${kind}:${uid}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  if (kind === "tool_call") {
    if (typeof p.name === "string" && p.name) d.toolCalls[p.name] = (d.toolCalls[p.name] ?? 0) + 1;
    return;
  }
  if (kind !== "session_event") return;
  if (typeof p.ts_ms === "number" && p.ts_ms > 0) {
    const ts = new Date(p.ts_ms).toISOString();
    d.firstTs ??= ts;
    d.lastTs = ts;
  }
  if (p.role === "user") {
    if (p.kind === "text" && !p.control_kind && typeof p.text === "string" && p.text.trim()) d.userTurns.push(p.text);
  } else if (p.role === "assistant") {
    if (p.kind === "text") d.assistantTurns += 1;
    if (typeof p.model === "string" && p.model && !d.models.includes(p.model)) d.models.push(p.model);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = (content as Record<string, unknown>[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string);
    return parts.length ? parts.join(" ") : undefined;
  }
  return undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const extractiveSummarizer: Summarizer = {
  id: "extractive/v1",
  async summarize(kind, d) {
    const first = d.userTurns[0] ? clip(d.userTurns[0].replace(/\s+/g, " ").trim(), 160) : "(no user prompt)";
    const tools = Object.entries(d.toolCalls).sort((a, b) => b[1] - a[1]);
    const toolLine = tools.length ? tools.map(([n, c]) => `${n}×${c}`).join(", ") : "none";
    if (kind === "short") {
      const text = `${d.harness}: "${first}" — ${d.userTurns.length} user turns, ${d.assistantTurns} assistant turns, tools: ${toolLine}.`;
      return { text: scrubText(clip(text, 280)), modelId: this.id, tokensIn: 0, tokensOut: 0 };
    }
    const prompts = d.userTurns.slice(0, 10).map((t, i) => `${i + 1}. ${clip(t.replace(/\s+/g, " ").trim(), 200)}`).join("\n");
    const text = [
      `# Session summary (${d.harness})`,
      "",
      `- Records: ${d.records}`,
      `- User turns: ${d.userTurns.length}; assistant turns: ${d.assistantTurns}`,
      `- Models: ${d.models.length ? d.models.join(", ") : "unknown"}`,
      `- Tools: ${toolLine}`,
      `- Span: ${d.firstTs ?? "?"} → ${d.lastTs ?? "?"}`,
      "",
      "## Prompts",
      prompts || "(none)",
    ].join("\n");
    return { text: scrubText(text), modelId: this.id, tokensIn: 0, tokensOut: 0 };
  },
};
