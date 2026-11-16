import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Retell from "retell-sdk";
import { createApp } from "../src/app";
import { Store } from "../src/store";

const API_KEY = "key_test_only";
let server: Server;
let base: string;
let store: Store;

beforeAll(async () => {
  store = new Store(null);
  const app = createApp({ apiKey: API_KEY, store, publicKey: "public_key_test", agentId: "agent_test", publicDir: "public" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  // Fresh store per test, swapped into the running app.
  Object.assign(store, new Store(null));
});

async function signedPost(path: string, payload: unknown, opts: { key?: string; tamper?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const signature = await Retell.sign(body, opts.key ?? API_KEY);
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-retell-signature": signature },
    // A different body than the one that was signed.
    body: opts.tamper ? body.replace("1042", "1043") : body,
  });
}

const call = { call_id: "call_abc", agent_id: "agent_test", call_type: "web_call" };

describe("signature check", () => {
  it("rejects a request with no signature", async () => {
    const res = await fetch(`${base}/tools/lookup_order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "lookup_order", call, args: { order_id: "SP-1042" } }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request signed with another key", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "SP-1042" } }, { key: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects a body that changed after signing", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "SP-1042" } }, { tamper: true });
    expect(res.status).toBe(401);
  });

  it("rejects unsigned webhooks too", async () => {
    const res = await fetch(`${base}/webhooks/retell`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-retell-signature": "v=1,d=nope" },
      body: JSON.stringify({ event: "call_started", call }),
    });
    expect(res.status).toBe(401);
  });
});

describe("lookup_order", () => {
  it("finds an order said out loud", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "S P one oh four two" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ found: true, order_id: "SP-1042", status: "shipped", carrier: "DHL" });
  });

  it("says not found without inventing a status", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "SP-7777" } });
    const body = await res.json();
    expect(body).toMatchObject({ found: false, reason: "not_found" });
    expect(body.status).toBeUndefined();
  });

  it("asks again for a garbled id", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "the blue one" } });
    expect(await res.json()).toMatchObject({ found: false, reason: "invalid_order_id" });
  });

  it("returns 503 when the order service fails, and logs it", async () => {
    const res = await signedPost("/tools/lookup_order", { name: "lookup_order", call, args: { order_id: "SP-1099" } });
    expect(res.status).toBe(503);
    const logs = store.toolCallsFor("call_abc");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tool: "lookup_order", status: 503, ok: false });
  });

  it("returns 404 for an unknown tool", async () => {
    const res = await signedPost("/tools/delete_everything", { name: "delete_everything", call, args: {} });
    expect(res.status).toBe(404);
  });
});

describe("report_problem", () => {
  const args = { order_id: "SP-1044", category: "damaged", description: "Screen cracked on arrival." };

  it("creates one ticket even when called twice (Retell retry)", async () => {
    const first = await (await signedPost("/tools/report_problem", { name: "report_problem", call, args })).json();
    const second = await (await signedPost("/tools/report_problem", { name: "report_problem", call, args })).json();
    expect(first).toMatchObject({ created: true, already_existed: false });
    expect(second).toMatchObject({ created: true, already_existed: true, ticket_id: first.ticket_id });
    expect(store.ticketsFor("call_abc")).toHaveLength(1);
  });

  it("rejects an unknown category", async () => {
    const body = await (await signedPost("/tools/report_problem", { name: "report_problem", call, args: { ...args, category: "angry" } })).json();
    expect(body).toMatchObject({ created: false, reason: "invalid_category" });
  });
});

describe("webhooks", () => {
  it("stores each (call, event) once and answers 204 every time", async () => {
    const payload = { event: "call_ended", call: { ...call, transcript: "Agent: hi", disconnection_reason: "user_hangup" } };
    expect((await signedPost("/webhooks/retell", payload)).status).toBe(204);
    expect((await signedPost("/webhooks/retell", payload)).status).toBe(204);
    expect(store.eventsFor("call_abc")).toEqual(["call_ended"]);
  });

  it("shows the analyzed call in the API with flags", async () => {
    await signedPost("/webhooks/retell", { event: "call_started", call });
    await signedPost("/webhooks/retell", {
      event: "call_analyzed",
      call: {
        ...call,
        disconnection_reason: "user_hangup",
        transcript_with_tool_calls: [
          { role: "tool_call_invocation", tool_call_id: "1", name: "lookup_order", arguments: '{"order_id":"SP-1099"}' },
          { role: "tool_call_result", tool_call_id: "1", content: "Error 503", successful: false },
          { role: "agent", content: "Order SP-1099 has shipped." },
        ],
        call_analysis: { call_summary: "Lookup failed.", call_successful: false },
      },
    });
    const view = await (await fetch(`${base}/api/calls/call_abc`)).json();
    const messages = view.flags.map((f: { message: string }) => f.message).join("\n");
    expect(messages).toContain("lookup_order failed");
    expect(messages).toContain("SP-1099 without a successful lookup");
    expect(view.analysis.call_summary).toBe("Lookup failed.");
  });

  it("rejects a webhook without call_id", async () => {
    expect((await signedPost("/webhooks/retell", { event: "call_started", call: {} })).status).toBe(400);
  });
});

describe("config", () => {
  it("exposes only the public key and agent id", async () => {
    const body = await (await fetch(`${base}/config`)).json();
    expect(body).toEqual({ publicKey: "public_key_test", agentId: "agent_test" });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });
});
