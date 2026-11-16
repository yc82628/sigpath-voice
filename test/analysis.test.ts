import { describe, expect, it } from "vitest";
import { toolCallsFromTranscript, unverifiedOrderMentions } from "../src/analysis";
import { buildAgentParams, buildLlmParams } from "../src/agent/config";

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
