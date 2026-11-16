// Browser side of the web call. Bundled to public/build/call.js by
// `npm run build:web`. Uses the public key only; the API key stays on the server.

import { RetellClient, type WebCallSession } from "retell-client-js-sdk";

const button = document.querySelector<HTMLButtonElement>("#call")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const transcriptEl = document.querySelector<HTMLElement>("#transcript")!;
const callLink = document.querySelector<HTMLAnchorElement>("#call-link")!;

let session: WebCallSession | null = null;

function setStatus(text: string, tone: "idle" | "live" | "error" = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function renderTranscript(turns: { role: string; content?: string; name?: string }[]) {
  transcriptEl.replaceChildren(
    ...turns
      .filter((t) => t.role === "agent" || t.role === "user" || t.role === "tool_call_invocation")
      .map((t) => {
        const row = document.createElement("p");
        row.className = `turn turn-${t.role}`;
        const who = document.createElement("strong");
        who.textContent = t.role === "agent" ? "Agent" : t.role === "user" ? "You" : "Tool";
        row.append(who, ` ${t.role === "tool_call_invocation" ? t.name : t.content ?? ""}`);
        return row;
      }),
  );
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function start() {
  const config = (await fetch("/config").then((r) => r.json())) as { publicKey: string | null; agentId: string | null };
  if (!config.publicKey || !config.agentId) {
    setStatus("Set RETELL_PUBLIC_KEY and RETELL_AGENT_ID in .env, then restart the server.", "error");
    return;
  }

  button.disabled = true;
  setStatus("Connecting...");
  callLink.hidden = true;
  transcriptEl.replaceChildren();

  const client = new RetellClient({ key: config.publicKey });
  session = client.createWebCall({
    agent_id: config.agentId,
    transcript: true,
    metadata: { source: "sigpath-voice-web" },
    hooks: {
      onStatus: (status) => {
        if (status === "live") {
          setStatus("On the call. Try order SP-1042.", "live");
          button.textContent = "Hang up";
          button.disabled = false;
        }
      },
      onTranscript: (turns) => renderTranscript(turns),
      onEnd: (event) => {
        setStatus(`Call ended${event.disconnection_reason ? ` (${event.disconnection_reason})` : ""}.`);
        finish();
      },
      onError: (err) => {
        console.error(err);
        setStatus(`Something went wrong: ${err.message}`, "error");
        finish();
      },
    },
  });
}

function finish() {
  if (session?.callId) {
    callLink.href = `/calls.html#${encodeURIComponent(session.callId)}`;
    callLink.hidden = false;
  }
  session = null;
  button.textContent = "Call SigPath support";
  button.disabled = false;
}

button.addEventListener("click", async () => {
  if (session) {
    button.disabled = true;
    await session.end();
    return;
  }
  start().catch((err) => {
    setStatus(`Couldn't start the call: ${err instanceof Error ? err.message : err}`, "error");
    finish();
  });
});
