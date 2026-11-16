# 03: Calls worked but never showed up in the call history

Simulated with `npm run simulate -- no-webhooks`.

## Summary

A test call to the agent worked fine: the caller asked about SP-1043 and got the right answer. But the call never appeared in the call history, and there was no transcript or post-call analysis for it. Only the tool request reached my server.

## Impact

Calls kept working. What broke was everything after the call: no transcripts, no analysis, no record. For a customer who reports on their calls, that's a real gap even though callers didn't notice.

## How it was found

The call log listed the call from the tool request alone, with a red flag: "Tool requests arrived but no webhooks did. Check webhook_url on the agent."

## Root cause

The agent's `webhook_url` pointed at an old tunnel. Quick cloudflared tunnels get a new URL every restart. In this scenario the tunnel was restarted and the new URL went into `.env`, but the agent still had the old one.

The tool URLs live on the LLM and the webhook URL on the agent, so it's possible to update one and not the other. Here the tool URLs had been fixed by hand in the dashboard and the webhook URL hadn't.

## Fix

- Rerun `npm run setup-agent` after every tunnel change. It sets the tool URLs and the webhook URL from the same `PUBLIC_BASE_URL`, so they can't drift apart.
- For anything longer-lived than a demo, use a fixed URL: a named tunnel or a deployed server.

## Follow-ups

- Have the setup script read back the agent and LLM after updating them, and fail if the URLs don't match `PUBLIC_BASE_URL`.
