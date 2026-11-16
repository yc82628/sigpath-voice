import type { AgentCreateParams } from "retell-sdk/resources/agent";
import type { LlmCreateParams } from "retell-sdk/resources/llm";
import { PROBLEM_CATEGORIES } from "../tools/problems";

// The agent's prompt, tools and analysis settings live in code so changes are
// reviewable in a diff and can be re-applied with `npm run setup-agent`.

export const GENERAL_PROMPT = `## Identity
You're the phone support agent for SigPath, a shopping site where buyers pay in USDC and the money sits in escrow until they confirm delivery. You help with existing orders only.

## Style
- Short sentences. One question at a time. This is a phone call, so no lists or markdown.
- Say money as "289 USDC" and dates as "November 18th".
- When you read an order number back, say it letter by letter and digit by digit: "S P, one zero four two".

## What you can do
1. Check an order's status with lookup_order.
2. Open a ticket for a problem with report_problem.
3. Transfer the caller to a person with transfer_to_human, if that tool is available.
4. End the call with end_call once the caller is done.

## Rules
- Never state an order's status, item, carrier or date unless lookup_order returned it in this call. If you don't have it, say you'll check, then call the tool.
- Order numbers look like SP followed by 4 digits. If the caller gives something else, ask them to repeat it.
- If a tool result has an "instruction" field, follow it.
- If lookup_order fails or the system isn't responding, don't guess. Apologise, then offer to open a ticket or transfer them.
- Before calling report_problem, confirm the order number and pick the category that fits: ${PROBLEM_CATEGORIES.join(", ")}. Read the ticket id back to the caller.
- If the caller asks for a person, is upset after two tries, or asks about anything other than an existing order (refund policy disputes, legal, account security), transfer them if you can. If you can't, open a ticket with category "other".
- Don't ask for or repeat wallet addresses, card numbers or passwords.
- This is a demo line with test orders. If asked, say so.`;

export const BEGIN_MESSAGE = "Hi, you've reached SigPath support. I can check an order or help with a problem. What's your order number?";

export interface BuildOptions {
  publicBaseUrl: string;
  transferNumber?: string;
}

type Tool = NonNullable<LlmCreateParams["general_tools"]>[number];

export function buildTools({ publicBaseUrl, transferNumber }: BuildOptions): Tool[] {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const tools: Tool[] = [
    {
      type: "custom",
      name: "lookup_order",
      description: "Look up a SigPath order by its order number and get its escrow status, item, shop and shipping details.",
      url: `${base}/tools/lookup_order`,
      method: "POST",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order number as the caller said it, for example SP-1042.",
          },
        },
        required: ["order_id"],
      },
      speak_during_execution: true,
      speak_after_execution: true,
      execution_message_description: "Tell the caller you're pulling up the order, in a few words.",
      timeout_ms: 8000,
      max_retry: 1,
    },
    {
      type: "custom",
      name: "report_problem",
      description: "Open a support ticket for a problem with an order. Call it once per problem, after confirming the order number.",
      url: `${base}/tools/report_problem`,
      method: "POST",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order number, for example SP-1042." },
          category: {
            type: "string",
            enum: [...PROBLEM_CATEGORIES],
            description: "What kind of problem it is.",
          },
          description: { type: "string", description: "One or two sentences in the caller's words." },
        },
        required: ["order_id", "category", "description"],
      },
      speak_during_execution: true,
      speak_after_execution: true,
      execution_message_description: "Tell the caller you're opening a ticket.",
      timeout_ms: 8000,
      // Safe to retry: the server derives the ticket id from call, order and
      // category, so a retry returns the same ticket.
      max_retry: 1,
    },
    {
      type: "end_call",
      name: "end_call",
      description: "End the call when the caller says they're done or says goodbye.",
    },
  ];

  if (transferNumber) {
    tools.push({
      type: "transfer_call",
      name: "transfer_to_human",
      description: "Transfer the caller to a SigPath team member when they ask for a person or the problem is outside what you can do.",
      transfer_destination: { type: "predefined", number: transferNumber },
      transfer_option: { type: "cold_transfer" },
      speak_during_execution: true,
      execution_message_description: "Tell the caller you're connecting them to a team member now.",
    });
  }
  return tools;
}

export function buildLlmParams(opts: BuildOptions): LlmCreateParams {
  return {
    general_prompt: GENERAL_PROMPT,
    begin_message: BEGIN_MESSAGE,
    start_speaker: "agent",
    general_tools: buildTools(opts),
    model_config: {
      type: "cascading",
      primary: { model: "gpt-5.4-mini" },
      backup: { model: "gemini-3.5-flash" },
      temperature: 0,
    },
  };
}

export const WEBHOOK_EVENTS: NonNullable<AgentCreateParams["webhook_events"]> = [
  "call_started",
  "call_ended",
  "call_analyzed",
];

export function buildAgentParams(opts: BuildOptions & { llmId: string; voiceId: string }): AgentCreateParams {
  const base = opts.publicBaseUrl.replace(/\/+$/, "");
  return {
    agent_name: "SigPath support",
    response_engine: { type: "retell-llm", llm_id: opts.llmId },
    voice_id: opts.voiceId,
    language: "en-US",
    webhook_url: `${base}/webhooks/retell`,
    webhook_events: WEBHOOK_EVENTS,
    interruption_sensitivity: 0.8,
    end_call_after_silence_ms: 30_000,
    max_call_duration_ms: 10 * 60_000,
    boosted_keywords: ["SigPath", "escrow", "USDC"],
    post_call_analysis_data: [
      { type: "system-presets", name: "call_summary" },
      { type: "system-presets", name: "call_successful" },
      { type: "system-presets", name: "user_sentiment" },
      {
        type: "string",
        name: "order_id",
        description: "The SigPath order number discussed on the call, like SP-1042.",
        examples: ["SP-1042"],
        required: false,
      },
      {
        type: "enum",
        name: "issue_category",
        description: "The main reason for the call.",
        choices: ["status_check", ...PROBLEM_CATEGORIES],
      },
      {
        type: "boolean",
        name: "resolved",
        description: "True if the caller's question was answered or a ticket was opened, without needing a callback.",
      },
      {
        type: "boolean",
        name: "transferred",
        description: "True if the call was transferred to a person.",
      },
    ],
  };
}
