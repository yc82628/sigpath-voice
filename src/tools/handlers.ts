import type { Store } from "../store";
import { describeStatus, findOrder, normalizeOrderId, SLOW_ORDER_DELAY_MS, SLOW_ORDER_ID, UpstreamError } from "./orders";
import { isProblemCategory, PROBLEM_CATEGORIES, ticketIdFor } from "./problems";

export interface ToolResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ToolContext {
  callId: string;
  store: Store;
  /** How long SP-1098 takes to answer. Tests set this low. */
  slowOrderDelayMs?: number;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

// Everything a handler returns gets read by the LLM. Keep results short and
// literal, and say what the agent should do next when something goes wrong,
// so it doesn't fill the gap with a guess.

const lookupOrder: Handler = async (args, ctx) => {
  const orderId = normalizeOrderId(args.order_id);
  if (!orderId) {
    return {
      status: 200,
      body: {
        found: false,
        reason: "invalid_order_id",
        instruction: "Don't guess the number. Ask the caller for just the 4 digits after SP, one at a time.",
      },
    };
  }

  if (orderId === SLOW_ORDER_ID) {
    await new Promise((r) => setTimeout(r, ctx.slowOrderDelayMs ?? SLOW_ORDER_DELAY_MS));
  }

  try {
    const order = findOrder(orderId);
    if (!order) {
      return {
        status: 200,
        body: {
          found: false,
          order_id: orderId,
          reason: "not_found",
          instruction: "Read the order number back to the caller and ask them to check it. Don't guess a status.",
        },
      };
    }
    return {
      status: 200,
      body: {
        found: true,
        order_id: order.id,
        item: order.item,
        shop: order.shop,
        amount_usdc: order.amountUsdc,
        status: order.status,
        status_explained: describeStatus(order.status),
        placed_on: order.placedOn,
        carrier: order.carrier ?? null,
        tracking_number: order.trackingNumber ?? null,
        estimated_delivery: order.estimatedDelivery ?? null,
        delivered_on: order.deliveredOn ?? null,
        refunded_on: order.refundedOn ?? null,
      },
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      // A non-2xx status marks the tool call as failed in Retell's transcript.
      return {
        status: 503,
        body: {
          error: "order_service_unavailable",
          instruction: "Tell the caller the order system isn't responding right now. Offer to open a ticket. Only offer a transfer if you have the transfer_to_human tool.",
        },
      };
    }
    throw err;
  }
};

const reportProblem: Handler = async (args, { callId, store }) => {
  const orderId = normalizeOrderId(args.order_id);
  const category = args.category;
  const description = typeof args.description === "string" ? args.description.slice(0, 1000) : "";

  if (!orderId) {
    return {
      status: 200,
      body: { created: false, reason: "invalid_order_id", instruction: "Ask for the order number again before opening a ticket." },
    };
  }
  if (!isProblemCategory(category)) {
    return {
      status: 200,
      body: { created: false, reason: "invalid_category", allowed: PROBLEM_CATEGORIES },
    };
  }

  const id = ticketIdFor(callId, orderId, category);
  const { ticket, created } = store.upsertTicket({
    id,
    callId,
    orderId,
    category,
    description,
    createdAt: Date.now(),
  });
  return {
    status: 200,
    body: {
      created: true,
      already_existed: !created,
      ticket_id: ticket.id,
      order_id: ticket.orderId,
      category: ticket.category,
      next_step: "A SigPath team member reviews the ticket within 1 business day. The escrow stays locked until it's resolved.",
    },
  };
};

export const TOOL_HANDLERS: Record<string, Handler> = {
  lookup_order: lookupOrder,
  report_problem: reportProblem,
};
