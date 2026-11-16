import express, { type NextFunction, type Request, type Response } from "express";
import { join } from "node:path";
import Retell from "retell-sdk";
import { buildCallView } from "./analysis";
import type { Store } from "./store";
import { TOOL_HANDLERS } from "./tools/handlers";

export interface AppOptions {
  /** Retell API key. Retell signs every webhook and tool request with it. */
  apiKey: string;
  store: Store;
  /** Safe to send to the browser. */
  publicKey?: string;
  agentId?: string;
  /** Adds a delay to tool responses, to reproduce a slow-API incident. */
  toolDelayMs?: number;
  /** How long the slow fixture order SP-1098 takes. Defaults to 9 s. */
  slowOrderDelayMs?: number;
  publicDir?: string;
}

// Retell's tool responses are capped at about 15,000 characters before they
// reach the LLM. Stay well under that.
const MAX_TOOL_RESULT_CHARS = 12_000;

function parseSignedJson(apiKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-retell-signature");
    // Verify the exact bytes Retell sent. Parsing and re-serialising the JSON
    // first can change whitespace or key order and break the signature.
    const valid = signature ? await Retell.verify(raw, apiKey, signature).catch(() => false) : false;
    if (!valid) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    try {
      res.locals.payload = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: "body is not JSON" });
      return;
    }
    next();
  };
}

export function createApp(opts: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  const signed = [express.raw({ type: "*/*", limit: "5mb" }), parseSignedJson(opts.apiKey)];

  // Custom functions. Retell POSTs { name, call, args }.
  app.post("/tools/:name", ...signed, async (req, res) => {
    const started = Date.now();
    const { call, args } = res.locals.payload as { call?: { call_id?: string }; args?: Record<string, unknown> };
    const toolName = String(req.params.name);
    const callId = call?.call_id ?? "unknown";
    const handler = TOOL_HANDLERS[toolName];

    let status: number;
    let body: Record<string, unknown>;
    if (!handler) {
      status = 404;
      body = { error: `unknown tool ${toolName}` };
    } else {
      if (opts.toolDelayMs) await new Promise((r) => setTimeout(r, opts.toolDelayMs));
      try {
        ({ status, body } = await handler(args ?? {}, { callId, store: opts.store, slowOrderDelayMs: opts.slowOrderDelayMs }));
      } catch (err) {
        console.error(`[tool] ${toolName} crashed`, err);
        status = 500;
        body = { error: "internal_error", instruction: "Apologise and offer to open a ticket." };
      }
    }

    let text = JSON.stringify(body);
    if (text.length > MAX_TOOL_RESULT_CHARS) {
      text = JSON.stringify({ error: "result_too_large", instruction: "Apologise and offer to open a ticket." });
      status = 500;
    }
    const durationMs = Date.now() - started;
    opts.store.recordToolCall({
      callId,
      tool: toolName,
      args: args ?? {},
      status,
      ok: status < 300,
      durationMs,
      result: JSON.parse(text),
      at: started,
    });
    console.log(`[tool] ${toolName} call=${callId} status=${status} ${durationMs}ms`);
    res.status(status).type("application/json").send(text);
  });

  // Call lifecycle webhooks: { event, call }.
  app.post("/webhooks/retell", ...signed, (_req, res) => {
    const { event, call } = res.locals.payload as { event?: string; call?: Record<string, unknown> };
    if (!event || !call?.call_id) {
      res.status(400).json({ error: "expected { event, call.call_id }" });
      return;
    }
    const isNew = opts.store.recordEvent(event, call);
    console.log(`[webhook] ${event} call=${call.call_id}${isNew ? "" : " (duplicate, ignored)"}`);
    // Retell waits about 10 s and retries on failure, so answer right away.
    res.status(204).end();
  });

  app.get("/api/calls", (_req, res) => {
    const calls = opts.store.callIds().map((id) => {
      const view = buildCallView(id, opts.store);
      return {
        callId: id,
        startTimestamp: view.startTimestamp,
        durationMs: view.durationMs,
        disconnectionReason: view.disconnectionReason,
        status: view.status,
        toolCalls: Math.max(view.toolCalls.length, view.serverToolCalls.length),
        summary: (view.analysis?.call_summary as string | undefined) ?? null,
        flags: view.flags.length,
        worstFlag: view.flags.some((f) => f.level === "error") ? "error" : view.flags.length ? "warn" : null,
      };
    });
    res.json({ calls });
  });

  app.get("/api/calls/:id", (req, res) => {
    const id = String(req.params.id);
    if (!opts.store.callIds().includes(id)) {
      res.status(404).json({ error: "unknown call" });
      return;
    }
    res.json(buildCallView(id, opts.store));
  });

  // Only the public key and agent id. The API key never leaves the server.
  app.get("/config", (_req, res) => {
    res.json({ publicKey: opts.publicKey ?? null, agentId: opts.agentId ?? null });
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(opts.publicDir ?? join(process.cwd(), "public")));

  return app;
}
