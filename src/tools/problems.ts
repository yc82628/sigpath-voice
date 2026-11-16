import { createHash } from "node:crypto";

export const PROBLEM_CATEGORIES = [
  "not_received",
  "damaged",
  "wrong_item",
  "refund_request",
  "other",
] as const;

export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === "string" && (PROBLEM_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Ticket ids are derived from the call, order and category, so if Retell
 * retries the request (or the agent calls the tool twice in one call) the
 * caller still gets one ticket instead of two.
 */
export function ticketIdFor(callId: string, orderId: string, category: ProblemCategory): string {
  const hash = createHash("sha256").update(`${callId}|${orderId}|${category}`).digest("hex");
  return `T-${hash.slice(0, 6).toUpperCase()}`;
}
