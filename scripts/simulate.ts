// Plays 2 fake calls against the local server, signed the same way Retell
// signs real requests. Useful for checking the dashboard and the signature
// code before you have a Retell account, or offline in an interview.
//
//   npm start            (in one terminal)
//   npm run simulate     (in another)
//
// Call 1 is a normal status check. Call 2 is an incident: the order service
// returns 503 and the agent then states a status it never got, which the
// dashboard should flag.

import "dotenv/config";
import Retell from "retell-sdk";

const apiKey = process.env.RETELL_API_KEY;
const base = `http://localhost:${process.env.PORT ?? 3000}`;
if (!apiKey) {
  console.error("RETELL_API_KEY is missing. Any value works for the simulator, as long as the server uses the same one.");
  process.exit(1);
}

async function post(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = await Retell.sign(body, apiKey!);
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-retell-signature": signature },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1], min: sorted[0], num: sorted.length, values };
}

type Turn = Record<string, unknown>;

async function runCall(opts: {
  callId: string;
  tools: { name: string; args: Record<string, unknown> }[];
  script: (results: { name: string; args: Record<string, unknown>; status: number; text: string }[]) => Turn[];
  e2e: number[];
  analysis: Record<string, unknown>;
  disconnection: string;
}) {
  const start = Date.now() - 95_000;
  const call = {
    call_id: opts.callId,
    agent_id: process.env.RETELL_AGENT_ID ?? "agent_simulated",
    call_type: "web_call",
    call_status: "ongoing",
    start_timestamp: start,
    metadata: { simulated: true },
  };

  console.log(`\n${opts.callId}`);
  console.log(`  call_started   -> ${(await post("/webhooks/retell", { event: "call_started", call })).status}`);

  const results = [];
  for (const tool of opts.tools) {
    const res = await post(`/tools/${tool.name}`, { name: tool.name, call, args: tool.args });
    console.log(`  ${tool.name.padEnd(14)} -> ${res.status} ${res.text.slice(0, 80)}`);
    results.push({ ...tool, ...res });
  }

  const turns = opts.script(results);
  const transcript = turns
    .filter((t) => t.role === "agent" || t.role === "user")
    .map((t) => `${t.role === "agent" ? "Agent" : "User"}: ${t.content}`)
    .join("\n");
  const ended = {
    ...call,
    call_status: "ended",
    end_timestamp: Date.now(),
    duration_ms: Date.now() - start,
    disconnection_reason: opts.disconnection,
    transcript,
    transcript_with_tool_calls: turns,
    latency: {
      e2e: percentiles(opts.e2e),
      llm: percentiles(opts.e2e.map((v) => Math.round(v * 0.45))),
      tts: percentiles(opts.e2e.map((v) => Math.round(v * 0.2))),
    },
  };
  console.log(`  call_ended     -> ${(await post("/webhooks/retell", { event: "call_ended", call: ended })).status}`);
  console.log(`  call_ended x2  -> ${(await post("/webhooks/retell", { event: "call_ended", call: ended })).status} (retry, stored once)`);
  const analyzed = { ...ended, call_analysis: opts.analysis };
  console.log(`  call_analyzed  -> ${(await post("/webhooks/retell", { event: "call_analyzed", call: analyzed })).status}`);
}

function toolTurns(id: string, r: { name: string; args: Record<string, unknown>; status: number; text: string }): Turn[] {
  return [
    { role: "tool_call_invocation", tool_call_id: id, name: r.name, arguments: JSON.stringify(r.args) },
    { role: "tool_call_result", tool_call_id: id, content: r.status < 300 ? r.text : `Error ${r.status}: ${r.text}`, successful: r.status < 300 },
  ];
}

async function main() {
  const stamp = Date.now().toString(36);

  await runCall({
    callId: `sim_ok_${stamp}`,
    tools: [{ name: "lookup_order", args: { order_id: "S P one oh four two" } }],
    script: ([lookup]) => [
      { role: "agent", content: "Hi, you've reached SigPath support. I can check an order or help with a problem. What's your order number?" },
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
  });

  await runCall({
    callId: `sim_incident_${stamp}`,
    tools: [
      { name: "lookup_order", args: { order_id: "SP-1099" } },
      { name: "report_problem", args: { order_id: "SP-1099", category: "not_received", description: "Ordered 2 weeks ago, nothing arrived." } },
      // The agent calls report_problem twice. The server returns the same ticket.
      { name: "report_problem", args: { order_id: "SP-1099", category: "not_received", description: "Ordered 2 weeks ago, nothing arrived." } },
    ],
    script: ([lookup, report]) => [
      { role: "agent", content: "Hi, you've reached SigPath support. I can check an order or help with a problem. What's your order number?" },
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
  });

  console.log(`\nOpen ${base}/calls.html to see both calls.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
