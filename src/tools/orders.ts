// Fixture orders standing in for the SigPath order API. The statuses follow
// SigPath's escrow flow: the buyer pays into escrow, the shop ships, and the
// money is released to the shop once the buyer confirms delivery.

export type EscrowStatus =
  | "paid_in_escrow"
  | "shipped"
  | "delivered"
  | "refunded";

export interface Order {
  id: string;
  item: string;
  shop: string;
  amountUsdc: number;
  status: EscrowStatus;
  placedOn: string;
  carrier?: string;
  trackingNumber?: string;
  estimatedDelivery?: string;
  deliveredOn?: string;
  refundedOn?: string;
}

export const ORDERS: Record<string, Order> = {
  "SP-1042": {
    id: "SP-1042",
    item: "Sony WH-1000XM5 headphones",
    shop: "Elektro Lange",
    amountUsdc: 289,
    status: "shipped",
    placedOn: "2026-11-10",
    carrier: "DHL",
    trackingNumber: "JJD000390007",
    estimatedDelivery: "2026-11-18",
  },
  "SP-1043": {
    id: "SP-1043",
    item: "Lego Botanical bonsai tree",
    shop: "Spielwaren Kern",
    amountUsdc: 49,
    status: "paid_in_escrow",
    placedOn: "2026-11-14",
  },
  "SP-1044": {
    id: "SP-1044",
    item: "Kindle Paperwhite",
    shop: "Buchhaus Weber",
    amountUsdc: 159,
    status: "delivered",
    placedOn: "2026-11-02",
    carrier: "Hermes",
    trackingNumber: "H1002345678901",
    deliveredOn: "2026-11-06",
  },
  "SP-1045": {
    id: "SP-1045",
    item: "Philips Hue starter kit",
    shop: "Lichtwerk",
    amountUsdc: 119,
    status: "refunded",
    placedOn: "2026-10-28",
    refundedOn: "2026-11-04",
  },
};

// SP-1099 makes the order lookup fail with a 503, so you can see what a
// failed tool call looks like in the transcript and the dashboard.
export const FAILING_ORDER_ID = "SP-1099";

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4",
  five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

const LETTER_WORDS: Record<string, string> = { es: "s", ess: "s", pee: "p", pea: "p" };

/**
 * Turns an order id the way a caller says it ("S P one oh four two",
 * "double four", "sp-1042", "1042") into the canonical "SP-1042".
 * Returns null when the input doesn't look like an order id.
 */
export function normalizeOrderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const repeat = token === "double" ? 2 : token === "triple" ? 3 : 0;
    if (repeat && i + 1 < tokens.length) {
      const next = NUMBER_WORDS[tokens[i + 1]] ?? tokens[i + 1];
      if (/^\d$/.test(next)) {
        out.push(next.repeat(repeat));
        i++;
        continue;
      }
    }
    out.push(NUMBER_WORDS[token] ?? LETTER_WORDS[token] ?? token);
  }

  const joined = out.join("");
  const match = joined.match(/^(?:sp)?(\d{4})$/);
  return match ? `SP-${match[1]}` : null;
}

export class UpstreamError extends Error {}

export function findOrder(orderId: string): Order | null {
  if (orderId === FAILING_ORDER_ID) {
    throw new UpstreamError("escrow service unavailable");
  }
  return ORDERS[orderId] ?? null;
}

const STATUS_TEXT: Record<EscrowStatus, string> = {
  paid_in_escrow: "Paid. The money is held in escrow and the shop hasn't shipped yet.",
  shipped: "Shipped. The money stays in escrow until the buyer confirms delivery.",
  delivered: "Delivered. Escrow has been released to the shop.",
  refunded: "Refunded. The escrow amount went back to the buyer's wallet.",
};

export function describeStatus(status: EscrowStatus): string {
  return STATUS_TEXT[status];
}
