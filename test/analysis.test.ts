import { describe, expect, it } from "vitest";
import { buildCallView, promisedTransferWithoutTool, rejectedOrderIds, toolCallsFromTranscript, unverifiedOrderMentions } from "../src/analysis";
import { buildAgentParams, buildLlmParams, buildPrompt } from "../src/agent/config";
import { Store } from "../src/store";

describe("unverifiedOrderMentions", () => {
  it("is empty when the agent only mentions orders it looked up", () => {
    const t = [
      { role: "tool_call_invocation", tool_call_id: "1", name: "lookup_order", arguments: "{}" },
      { role: "tool_call_result", tool_call_id: "1", content: '{"found":true,"order_id":"SP-1042"}', successful: true },
      { role: "agent", content: "SP-1042 shipped with DHL." },
    ];
    expect(unverifiedOrderMentions(t)).toEqual([]);
  });

  it("flags an order the agent described without a successful lookup", () => {
    const t = [
      { role: "tool_call_invocation", tool_call_id: "1", name: "lookup_order", arguments: "{}" },
      { role: "tool_call_result", tool_call_id: "1", content: "Error 503", successful: false },
      { role: "agent", content: "Order SP 1099 is on its way." },
    ];
    expect(unverifiedOrderMentions(t)).toEqual(["SP-1099"]);
  });
});

describe("toolCallsFromTranscript", () => {
  it("pairs invocations with results", () => {
    const calls = toolCallsFromTranscript([
      { role: "tool_call_invocation", tool_call_id: "a", name: "lookup_order", arguments: '{"order_id":"SP-1042"}' },
      { role: "user", content: "hm" },
      { role: "tool_call_result", tool_call_id: "a", content: "{}", successful: true },
      { role: "tool_call_invocation", tool_call_id: "b", name: "end_call", arguments: "{}" },
    ]);
    expect(calls).toEqual([
      { name: "lookup_order", arguments: '{"order_id":"SP-1042"}', result: "{}", successful: true },
      { name: "end_call", arguments: "{}", result: null, successful: null },
    ]);
  });
});

describe("agent config", () => {
  it("points tools and webhooks at the public URL", () => {
    const llm = buildLlmParams({ publicBaseUrl: "https://abc.trycloudflare.com/" });
    const urls = llm.general_tools!.flatMap((t) => ("url" in t ? [t.url] : []));
    expect(urls).toEqual([
      "https://abc.trycloudflare.com/tools/lookup_order",
      "https://abc.trycloudflare.com/tools/report_problem",
    ]);
    const agent = buildAgentParams({ publicBaseUrl: "https://abc.trycloudflare.com", llmId: "llm_1", voiceId: "v" });
    expect(agent.webhook_url).toBe("https://abc.trycloudflare.com/webhooks/retell");
  });

  it("only adds the transfer tool when a number is set", () => {
    const names = (n?: string) => buildLlmParams({ publicBaseUrl: "https://x", transferNumber: n }).general_tools!.map((t) => t.name);
    expect(names()).not.toContain("transfer_to_human");
    expect(names("+4930123456")).toContain("transfer_to_human");
  });
});

describe("promisedTransferWithoutTool", () => {
  it("flags a promised transfer with no transfer tool call", () => {
    expect(promisedTransferWithoutTool([{ role: "agent", content: "Let me connect you to a team member." }])).toBe(true);
  });

  it("is fine when the transfer tool was called", () => {
    expect(
      promisedTransferWithoutTool([
        { role: "agent", content: "I'm transferring you now." },
        { role: "tool_call_invocation", tool_call_id: "1", name: "transfer_to_human", arguments: "{}" },
      ]),
    ).toBe(false);
  });

  it("ignores calls where nobody mentioned a transfer", () => {
    expect(promisedTransferWithoutTool([{ role: "agent", content: "Your order shipped." }])).toBe(false);
  });
});

describe("rejectedOrderIds", () => {
  it("lists what lookup_order couldn't read", () => {
    expect(
      rejectedOrderIds([
        { role: "tool_call_invocation", tool_call_id: "1", name: "lookup_order", arguments: '{"order_id":"S B one oh four two"}' },
        { role: "tool_call_result", tool_call_id: "1", content: '{"found":false,"reason":"invalid_order_id"}', successful: true },
        { role: "tool_call_invocation", tool_call_id: "2", name: "lookup_order", arguments: '{"order_id":"1042"}' },
        { role: "tool_call_result", tool_call_id: "2", content: '{"found":true,"order_id":"SP-1042"}', successful: true },
      ]),
    ).toEqual(["S B one oh four two"]);
  });
});

describe("buildCallView flags from the server log", () => {
  const log = (durationMs: number, at: number) => ({
    callId: "c1", tool: "lookup_order", args: { order_id: "SP-1098" }, status: 200, ok: true, durationMs, result: {}, at,
  });

  it("flags a tool slower than the timeout and a repeated request", () => {
    const store = new Store(null);
    store.recordEvent("call_started", { call_id: "c1" });
    store.recordToolCall(log(9001, 1));
    store.recordToolCall(log(9002, 2));
    const messages = buildCallView("c1", store).flags.map((f) => f.message).join("\n");
    expect(messages).toContain("past the 8000 ms timeout");
    expect(messages).toContain("same lookup_order request 2 times");
  });

  it("flags a call with tool requests but no webhooks", () => {
    const store = new Store(null);
    store.recordToolCall(log(5, 1));
    expect(store.callIds()).toEqual(["c1"]);
    expect(buildCallView("c1", store).flags[0].message).toContain("no webhooks");
  });
});

describe("buildPrompt", () => {
  it("tells the agent it can't transfer when there's no transfer tool", () => {
    const prompt = buildPrompt({ canTransfer: false });
    expect(prompt).toContain("You can't transfer calls");
    expect(prompt).not.toContain("transfer_to_human");
  });

  it("names the transfer tool when there is one", () => {
    expect(buildPrompt({ canTransfer: true })).toContain("transfer_to_human");
  });
});
