import { TOOL_TIMEOUT_MS } from "./agent/config";
import type { Store } from "./store";

// Turns the raw call object from Retell's webhooks plus our own tool logs
// into what you'd look at first when someone says "this call went wrong".

export interface ToolCallView {
  name: string;
  arguments: string;
  result: string | null;
  successful: boolean | null;
}

export interface Flag {
  level: "warn" | "error";
  message: string;
}

const LATENCY_WARN_MS = 2000;

type Utterance = Record<string, unknown>;

export function toolCallsFromTranscript(transcript: unknown): ToolCallView[] {
  if (!Array.isArray(transcript)) return [];
  const calls = new Map<string, ToolCallView>();
  for (const u of transcript as Utterance[]) {
    if (u.role === "tool_call_invocation") {
      calls.set(String(u.tool_call_id), {
        name: String(u.name),
        arguments: String(u.arguments ?? ""),
        result: null,
        successful: null,
      });
    } else if (u.role === "tool_call_result") {
      const call = calls.get(String(u.tool_call_id));
      if (call) {
        call.result = String(u.content ?? "");
        call.successful = typeof u.successful === "boolean" ? u.successful : null;
      }
    }
  }
  return [...calls.values()];
}

/**
 * A rough hallucination check: order ids the agent said out loud that no
 * successful lookup_order returned. It can't catch everything, but it catches
 * the classic one where the agent reads out a status it never looked up.
 */
export function unverifiedOrderMentions(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  const verified = new Set<string>();
  const mentioned = new Set<string>();
  const pending = new Map<string, string>();
  for (const u of transcript as Utterance[]) {
    if (u.role === "tool_call_invocation" && u.name === "lookup_order") {
      pending.set(String(u.tool_call_id), String(u.arguments ?? ""));
    } else if (u.role === "tool_call_result" && pending.has(String(u.tool_call_id))) {
      try {
        const result = JSON.parse(String(u.content ?? "{}"));
        if (result.found && result.order_id) verified.add(result.order_id);
      } catch {
        // Not JSON, so nothing was verified.
      }
    } else if (u.role === "agent" && typeof u.content === "string") {
      for (const m of u.content.matchAll(/\bSP[-\s]?(\d{4})\b/gi)) mentioned.add(`SP-${m[1]}`);
    }
  }
  return [...mentioned].filter((id) => !verified.has(id));
}

const TRANSFER_PROMISE = /\b(transfer(ring)? you|connect(ing)? you|put(ting)? you through)\b/i;

/** True when the agent said it would transfer the caller but never called a transfer tool. */
export function promisedTransferWithoutTool(transcript: unknown): boolean {
  if (!Array.isArray(transcript)) return false;
  const turns = transcript as Utterance[];
  const promised = turns.some((u) => u.role === "agent" && typeof u.content === "string" && TRANSFER_PROMISE.test(u.content));
  const transferred = turns.some((u) => u.role === "tool_call_invocation" && String(u.name).includes("transfer"));
  return promised && !transferred;
}

/** How many times lookup_order couldn't make sense of the order number it was given. */
export function rejectedOrderIds(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  const args = new Map<string, string>();
  const rejected: string[] = [];
  for (const u of transcript as Utterance[]) {
    if (u.role === "tool_call_invocation" && u.name === "lookup_order") {
      args.set(String(u.tool_call_id), String(u.arguments ?? ""));
    } else if (u.role === "tool_call_result" && args.has(String(u.tool_call_id))) {
      try {
        if (JSON.parse(String(u.content ?? "{}")).reason === "invalid_order_id") {
          const heard = JSON.parse(args.get(String(u.tool_call_id)) || "{}").order_id;
          rejected.push(typeof heard === "string" ? heard : "?");
        }
      } catch {
        // Not JSON, so not a rejection we can read.
      }
    }
  }
  return rejected;
}

export function buildCallView(callId: string, store: Store) {
  const call = store.latestCall(callId) ?? {};
  const transcriptWithTools = call.transcript_with_tool_calls;
  const toolCalls = toolCallsFromTranscript(transcriptWithTools);
  const serverToolCalls = store.toolCallsFor(callId);
  const latency = (call.latency ?? {}) as Record<string, Record<string, number> | undefined>;
  const analysis = (call.call_analysis ?? null) as Record<string, unknown> | null;
  // Without webhooks, the first tool request is the best guess at when the call started.
  const start = Number(call.start_timestamp) || store.toolCallsFor(callId)[0]?.at || null;
  const end = Number(call.end_timestamp) || null;
  const disconnection = (call.disconnection_reason as string | undefined) ?? null;

  const flags: Flag[] = [];
  const events = store.eventsFor(callId);
  if (events.length === 0) {
    flags.push({ level: "error", message: "Tool requests arrived but no webhooks did. Check webhook_url on the agent." });
  }
  if (disconnection?.startsWith("error_")) {
    flags.push({ level: "error", message: `Call ended with ${disconnection}.` });
  }
  for (const t of toolCalls) {
    if (t.successful === false) flags.push({ level: "error", message: `Tool ${t.name} failed: ${t.result ?? "no result"}` });
  }
  for (const t of serverToolCalls) {
    if (t.durationMs >= TOOL_TIMEOUT_MS) {
      flags.push({
        level: "error",
        message: `Tool ${t.tool} took ${t.durationMs} ms on our side, past the ${TOOL_TIMEOUT_MS} ms timeout. Retell gave up before the answer arrived.`,
      });
    } else if (t.durationMs > LATENCY_WARN_MS) {
      flags.push({ level: "warn", message: `Tool ${t.tool} took ${t.durationMs} ms on our side.` });
    }
  }
  const repeats = new Map<string, number>();
  for (const t of serverToolCalls) {
    const key = `${t.tool} ${JSON.stringify(t.args)}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  for (const [key, count] of repeats) {
    if (count > 1) {
      flags.push({ level: "warn", message: `Got the same ${key.split(" ")[0]} request ${count} times (a Retell retry, or the agent asked twice).` });
    }
  }
  const rejected = rejectedOrderIds(transcriptWithTools);
  if (rejected.length) {
    flags.push({
      level: "warn",
      message: `lookup_order couldn't read the order number ${rejected.length} time${rejected.length > 1 ? "s" : ""} (heard: ${rejected.map((r) => `"${r}"`).join(", ")}).`,
    });
  }
  if (promisedTransferWithoutTool(transcriptWithTools)) {
    flags.push({ level: "warn", message: "Agent said it would transfer the caller but never called a transfer tool." });
  }
  const e2eP90 = latency.e2e?.p90;
  if (typeof e2eP90 === "number" && e2eP90 > LATENCY_WARN_MS) {
    flags.push({ level: "warn", message: `End-to-end latency p90 is ${Math.round(e2eP90)} ms.` });
  }
  for (const id of unverifiedOrderMentions(transcriptWithTools)) {
    flags.push({ level: "warn", message: `Agent mentioned ${id} without a successful lookup. Possible hallucination.` });
  }
  if (analysis && analysis.call_successful === false) {
    flags.push({ level: "warn", message: "Post-call analysis marked the call as unsuccessful." });
  }

  return {
    callId,
    events,
    agentId: call.agent_id ?? null,
    callType: call.call_type ?? null,
    status: call.call_status ?? null,
    startTimestamp: start,
    durationMs: (call.duration_ms as number | undefined) ?? (start && end ? end - start : null),
    disconnectionReason: disconnection,
    latency: {
      e2e: pickPercentiles(latency.e2e),
      llm: pickPercentiles(latency.llm),
      tts: pickPercentiles(latency.tts),
    },
    toolCalls,
    serverToolCalls,
    tickets: store.ticketsFor(callId),
    transcript: (call.transcript as string | undefined) ?? null,
    analysis,
    publicLogUrl: call.public_log_url ?? null,
    recordingUrl: call.recording_url ?? null,
    flags,
  };
}

function pickPercentiles(stat: Record<string, number> | undefined) {
  if (!stat) return null;
  return { p50: stat.p50 ?? null, p90: stat.p90 ?? null, max: stat.max ?? null, num: stat.num ?? null };
}
