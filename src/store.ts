import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProblemCategory } from "./tools/problems";

// A small JSON file store. Good enough for a demo that handles a few calls;
// a real deployment would use a database with a unique key on
// (call_id, event) and on ticket id.

export interface ToolCallLog {
  callId: string;
  tool: string;
  args: unknown;
  status: number;
  ok: boolean;
  durationMs: number;
  result: unknown;
  at: number;
}

export interface Ticket {
  id: string;
  callId: string;
  orderId: string;
  category: ProblemCategory;
  description: string;
  createdAt: number;
}

export interface CallRecord {
  callId: string;
  // Each webhook event is stored once. Retell retries a webhook up to 3 times
  // if it doesn't get a 2xx in time, so the same event can arrive twice.
  events: Record<string, { receivedAt: number; call: Record<string, unknown> }>;
  firstSeenAt: number;
}

interface Data {
  calls: Record<string, CallRecord>;
  toolCalls: ToolCallLog[];
  tickets: Record<string, Ticket>;
}

const EVENT_ORDER = ["call_started", "call_ended", "call_analyzed"];

export class Store {
  private data: Data = { calls: {}, toolCalls: [], tickets: {} };

  /** Pass null to keep everything in memory (used by the tests). */
  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      this.data = { ...this.data, ...JSON.parse(readFileSync(file, "utf8")) };
    }
  }

  /** Returns false if this (call_id, event) pair was already stored. */
  recordEvent(event: string, call: Record<string, unknown>): boolean {
    const callId = String(call.call_id ?? "");
    if (!callId) throw new Error("call.call_id missing");
    const record = (this.data.calls[callId] ??= { callId, events: {}, firstSeenAt: Date.now() });
    if (record.events[event]) return false;
    record.events[event] = { receivedAt: Date.now(), call };
    this.save();
    return true;
  }

  recordToolCall(log: ToolCallLog): void {
    this.data.toolCalls.push(log);
    this.save();
  }

  /** Creates the ticket unless one with this id exists. Returns the stored ticket. */
  upsertTicket(ticket: Ticket): { ticket: Ticket; created: boolean } {
    const existing = this.data.tickets[ticket.id];
    if (existing) return { ticket: existing, created: false };
    this.data.tickets[ticket.id] = ticket;
    this.save();
    return { ticket, created: true };
  }

  /** The most complete call object we have: call_analyzed beats call_ended beats call_started. */
  latestCall(callId: string): Record<string, unknown> | null {
    const record = this.data.calls[callId];
    if (!record) return null;
    const known = EVENT_ORDER.filter((e) => record.events[e]);
    const last = known[known.length - 1];
    if (last) return record.events[last].call;
    const any = Object.values(record.events)[0];
    return any ? any.call : null;
  }

  /**
   * Newest first. Includes calls we only know from tool requests, so a call
   * still shows up when the webhook URL is wrong or the webhook never arrived.
   */
  callIds(): string[] {
    const firstSeen = new Map<string, number>();
    for (const c of Object.values(this.data.calls)) firstSeen.set(c.callId, c.firstSeenAt);
    for (const t of this.data.toolCalls) {
      if (!firstSeen.has(t.callId)) firstSeen.set(t.callId, t.at);
    }
    return [...firstSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  eventsFor(callId: string): string[] {
    return Object.keys(this.data.calls[callId]?.events ?? {});
  }

  toolCallsFor(callId: string): ToolCallLog[] {
    return this.data.toolCalls.filter((t) => t.callId === callId);
  }

  ticketsFor(callId: string): Ticket[] {
    return Object.values(this.data.tickets).filter((t) => t.callId === callId);
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
