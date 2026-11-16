// The fake calls behind `npm run simulate` and the static demo build.
// The transcripts are written by hand to look like Retell's
// transcript_with_tool_calls. The tool results in them are the real
// responses from the server, and every request is signed the way Retell
// signs it.

import Retell from "retell-sdk";
import { TOOL_TIMEOUT_MS } from "../src/agent/config";


export interface Target {
  /** Where the server runs, like http://localhost:3000 */
  base: string;
  /** Must match the server's RETELL_API_KEY, or every request gets a 401. */
  apiKey: string;
}

interface ToolRun {
  name: string;
  args: Record<string, unknown>;
  status: number;
  text: string;
  timedOut: boolean;
}

type Turn = Record<string, unknown>;

export interface Scenario {
  name: string;
  about: string;
  tools: { name: string; args: Record<string, unknown> }[];
  /** False to skip the webhooks, like an agent with the wrong webhook_url. */
  webhooks?: boolean;
  script: (results: ToolRun[]) => Turn[];
  e2e: number[];
  analysis: Record<string, unknown>;
  disconnection: string;
}

async function post(t: Target, path: string, payload: unknown, timeoutMs?: number) {
  const body = JSON.stringify(payload);
  const signature = await Retell.sign(body, t.apiKey);
  try {
    const res = await fetch(t.base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-retell-signature": signature },
      body,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    return { status: res.status, text: await res.text(), timedOut: false };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return { status: 0, text: "", timedOut: true };
    throw err;
  }
}

// Same as the agent config: an 8 s timeout per attempt and 1 retry.
const MAX_RETRY = 1;

async function callTool(t: Target, call: Record<string, unknown>, tool: { name: string; args: Record<string, unknown> }): Promise<ToolRun> {
  let res = { status: 0, text: "", timedOut: true };
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    res = await post(t, `/tools/${tool.name}`, { name: tool.name, call, args: tool.args }, TOOL_TIMEOUT_MS);
    const label = attempt ? `${tool.name} (retry)` : tool.name;
    console.log(`  ${label.padEnd(22)} -> ${res.timedOut ? `timed out after ${TOOL_TIMEOUT_MS} ms` : `${res.status} ${res.text.slice(0, 70)}`}`);
    if (!res.timedOut && res.status < 500) break;
  }
  return { ...tool, ...res };
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1], min: sorted[0], num: sorted.length, values };
}

function toolTurns(id: string, r: ToolRun): Turn[] {
  // Retell writes its own text for a timeout. This is a stand-in.
  const content = r.timedOut ? `Tool call timed out after ${TOOL_TIMEOUT_MS} ms` : r.status < 300 ? r.text : `Error ${r.status}: ${r.text}`;
  return [
    { role: "tool_call_invocation", tool_call_id: id, name: r.name, arguments: JSON.stringify(r.args) },
    { role: "tool_call_result", tool_call_id: id, content, successful: !r.timedOut && r.status < 300 },
  ];
}

const GREETING = { role: "agent", content: "Hi, you've reached SigPath support. I can check an order or help with a problem. What's your order number?" };

export const SCENARIOS: Scenario[] = [
  {
    name: "ok",
    about: "a normal status check",
    tools: [{ name: "lookup_order", args: { order_id: "S P one oh four two" } }],
    script: ([lookup]) => [
      GREETING,
      { role: "user", content: "Hi, it's S P one oh four two." },
      { role: "agent", content: "Thanks, let me pull that up." },
      ...toolTurns("t1", lookup),
      { role: "agent", content: "Your Sony headphones from Elektro Lange shipped with DHL and should arrive November 18th. The money stays in escrow until you confirm delivery." },
      { role: "user", content: "Great, that's all." },
      { role: "agent", content: "Glad I could help. Bye!" },
      { role: "tool_call_invocation", tool_call_id: "t2", name: "end_call", arguments: "{}" },
    ],
    e2e: [820, 910, 760, 1040, 880],
    analysis: {
      call_summary: "Caller checked order SP-1042. The agent confirmed it shipped with DHL, arriving November 18th.",
      call_successful: true,
      user_sentiment: "Positive",
      custom_analysis_data: { order_id: "SP-1042", issue_category: "status_check", resolved: true, transferred: false },
    },
    disconnection: "agent_hangup",
  },
  {
    name: "hallucination",
    about: "the order service fails and the agent makes up a status (docs/incidents/01)",
    tools: [
      { name: "lookup_order", args: { order_id: "SP-1099" } },
      { name: "report_problem", args: { order_id: "SP-1099", category: "not_received", description: "Ordered 2 weeks ago, nothing arrived." } },
      // The agent calls report_problem twice. The server returns the same ticket.
      { name: "report_problem", args: { order_id: "SP-1099", category: "not_received", description: "Ordered 2 weeks ago, nothing arrived." } },
    ],
    script: ([lookup, report]) => [
      GREETING,
      { role: "user", content: "SP-1099. It hasn't arrived." },
      { role: "agent", content: "Let me check that for you." },
      ...toolTurns("t1", lookup),
      { role: "agent", content: "Order SP-1099 has shipped and should arrive in 2 days." },
      { role: "user", content: "That's what you said last week. Can you open a ticket?" },
      ...toolTurns("t2", report),
      { role: "agent", content: `I've opened ticket ${JSON.parse(report.text).ticket_id ?? ""}. Someone will look at it within 1 business day.` },
      { role: "user", content: "Fine." },
    ],
    e2e: [1300, 2900, 3400, 1500, 2700],
    analysis: {
      call_summary: "Caller reported SP-1099 not received. The order lookup failed and the agent gave a shipping estimate anyway. A ticket was opened.",
      call_successful: false,
      user_sentiment: "Negative",
      custom_analysis_data: { order_id: "SP-1099", issue_category: "not_received", resolved: false, transferred: false },
    },
    disconnection: "user_hangup",
  },
  {
    name: "slow",
    about: "the order API takes 9 s, past the 8 s tool timeout, and Retell retries once (docs/incidents/02). Takes about 20 s to run",
    tools: [{ name: "lookup_order", args: { order_id: "SP-1098" } }],
    script: ([lookup]) => [
      GREETING,
      { role: "user", content: "SP-1098, the drill. Where is it?" },
      { role: "agent", content: "One moment, I'm pulling up your order." },
      ...toolTurns("t1", lookup),
      { role: "agent", content: "Sorry, the order system isn't answering right now. I can open a ticket so someone follows up. Would that help?" },
      { role: "user", content: "I've been waiting ages. No, I'll just call back." },
      { role: "agent", content: "Understood. Sorry about the wait." },
    ],
    e2e: [880, 17400, 1100, 950],
    analysis: {
      call_summary: "Caller asked about SP-1098. The order lookup timed out twice, about 17 seconds of waiting, and the caller gave up.",
      call_successful: false,
      user_sentiment: "Negative",
      custom_analysis_data: { order_id: "SP-1098", issue_category: "status_check", resolved: false, transferred: false },
    },
    disconnection: "user_hangup",
  },
  {
    name: "no-webhooks",
    about: "the agent's webhook_url points at an old tunnel, so only tool requests arrive (docs/incidents/03)",
    webhooks: false,
    tools: [{ name: "lookup_order", args: { order_id: "SP-1043" } }],
    script: () => [],
    e2e: [],
    analysis: {},
    disconnection: "agent_hangup",
  },
  {
    name: "transfer-promise",
    about: "the agent promises a transfer on a line with no transfer tool (docs/incidents/04)",
    tools: [{ name: "lookup_order", args: { order_id: "SP-1044" } }],
    script: ([lookup]) => [
      GREETING,
      { role: "user", content: "SP-1044. The Kindle arrived with a cracked screen and the money's already gone to the shop." },
      { role: "agent", content: "I'm sorry to hear that. Let me look it up." },
      ...toolTurns("t1", lookup),
      { role: "agent", content: "I see it was delivered on November 6th and escrow was released to Buchhaus Weber." },
      { role: "user", content: "I want to talk to a person about this." },
      { role: "agent", content: "Of course, let me connect you to a team member." },
      { role: "user", content: "Hello? Is anyone there?" },
      { role: "agent", content: "Thanks for calling SigPath. Goodbye." },
      { role: "tool_call_invocation", tool_call_id: "t2", name: "end_call", arguments: "{}" },
    ],
    e2e: [900, 1000, 870, 1150, 980],
    analysis: {
      call_summary: "Caller reported a damaged Kindle on SP-1044 and asked for a person. The agent said it would connect them, then ended the call without a transfer or a ticket.",
      call_successful: false,
      user_sentiment: "Negative",
      custom_analysis_data: { order_id: "SP-1044", issue_category: "damaged", resolved: false, transferred: false },
    },
    disconnection: "agent_hangup",
  },
  {
    name: "misheard",
    about: "speech-to-text hears \"S B\" for \"S P\" and the agent asks for the digits (docs/incidents/05)",
    tools: [
      { name: "lookup_order", args: { order_id: "S B one oh four two" } },
      { name: "lookup_order", args: { order_id: "1042" } },
    ],
    script: ([first, second]) => [
      GREETING,
      { role: "user", content: "S B one oh four two." },
      { role: "agent", content: "Let me check." },
      ...toolTurns("t1", first),
      { role: "agent", content: "I didn't catch that one. Could you give me just the 4 digits after S P?" },
      { role: "user", content: "One. Zero. Four. Two." },
      ...toolTurns("t2", second),
      { role: "agent", content: "Got it, S P one zero four two. Your headphones shipped with DHL and should arrive November 18th." },
      { role: "user", content: "Perfect, thanks." },
      { role: "tool_call_invocation", tool_call_id: "t3", name: "end_call", arguments: "{}" },
    ],
    e2e: [850, 940, 1010, 900],
    analysis: {
      call_summary: "Caller checked SP-1042. The first order number was misheard; the agent asked for the digits and found the order on the second try.",
      call_successful: true,
      user_sentiment: "Neutral",
      custom_analysis_data: { order_id: "SP-1042", issue_category: "status_check", resolved: true, transferred: false },
    },
    disconnection: "agent_hangup",
  },
];

export async function runScenario(t: Target, s: Scenario, stamp: string) {
  const start = Date.now() - 95_000;
  const call = {
    call_id: `sim_${s.name}_${stamp}`,
    agent_id: process.env.RETELL_AGENT_ID ?? "agent_simulated",
    call_type: "web_call",
    call_status: "ongoing",
    start_timestamp: start,
    metadata: { simulated: true, scenario: s.name },
  };
  const send = s.webhooks !== false;

  console.log(`\n${call.call_id}: ${s.about}`);
  if (send) console.log(`  call_started           -> ${(await post(t, "/webhooks/retell", { event: "call_started", call })).status}`);

  const results: ToolRun[] = [];
  for (const tool of s.tools) results.push(await callTool(t, call, tool));
  if (!send) {
    console.log("  (no webhooks sent)");
    return;
  }

  const turns = s.script(results);
  const transcript = turns
    .filter((t) => t.role === "agent" || t.role === "user")
    .map((t) => `${t.role === "agent" ? "Agent" : "User"}: ${t.content}`)
    .join("\n");
  const ended = {
    ...call,
    call_status: "ended",
    end_timestamp: Date.now(),
    duration_ms: Date.now() - start,
    disconnection_reason: s.disconnection,
    transcript,
    transcript_with_tool_calls: turns,
    latency: {
      e2e: percentiles(s.e2e),
      llm: percentiles(s.e2e.map((v) => Math.round(Math.min(v, 2500) * 0.45))),
      tts: percentiles(s.e2e.map((v) => Math.round(Math.min(v, 2500) * 0.2))),
    },
  };
  console.log(`  call_ended             -> ${(await post(t, "/webhooks/retell", { event: "call_ended", call: ended })).status}`);
  console.log(`  call_ended (retry)     -> ${(await post(t, "/webhooks/retell", { event: "call_ended", call: ended })).status} stored once`);
  const analyzed = { ...ended, call_analysis: s.analysis };
  console.log(`  call_analyzed          -> ${(await post(t, "/webhooks/retell", { event: "call_analyzed", call: analyzed })).status}`);
}
