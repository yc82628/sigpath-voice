# 01: Agent gave a shipping date it never looked up

Simulated with `npm run simulate -- hallucination`. The call is fake. The write-up is the format I'd hand a customer for a real one.

## Summary

On a call about order SP-1099, the order lookup failed with a 503. The agent told the caller the order "has shipped and should arrive in 2 days" anyway. The caller had heard that the week before and was annoyed. The agent opened a ticket, but the call was marked unsuccessful.

## Impact

1 call, 1 caller given wrong information. No money moved: the escrow stayed locked.

## Timeline

| Time into call | What happened |
| --- | --- |
| 0:04 | Caller gives SP-1099 and says it hasn't arrived. |
| 0:07 | Agent calls `lookup_order`. Server returns 503 `order_service_unavailable` in 1 ms. Retell retries once (`max_retry: 1`) and gets the same 503. |
| 0:09 | Agent says the order shipped and arrives in 2 days. **This is the wrong answer.** |
| 0:21 | Caller asks for a ticket. `report_problem` creates it. |
| 0:23 | Agent calls `report_problem` again. Server returns the same ticket, so there's no duplicate. |
| 1:35 | Caller hangs up. Post-call analysis: unsuccessful, negative sentiment. |

## How it was found

The call log flagged it: `lookup_order` failed, and the agent mentioned SP-1099 without a successful lookup. It also showed both requests twice, and end-to-end p90 at 3.4 s.

## Root cause

2 things together:

1. The order service was down (simulated with the SP-1099 fixture).
2. The agent ignored the failure. The tool result told it to apologise and offer a ticket, but nothing in the prompt said a failed lookup means "don't state a status".

## Fix

- Prompt: "Never state an order's status... unless lookup_order returned it in this call" and "If lookup_order fails, times out or the system isn't responding, don't guess."
- Tool: the 503 body carries an `instruction` field saying what to do next.
- Detection: the call log flags any order id the agent says without a successful lookup.

## Follow-ups

- Run the 4 test orders plus SP-1099 after every prompt change and check for the hallucination flag.
- Look into why end-to-end latency went above 3 s on 2 turns. The tool answered in 1 ms, so it's on the LLM or voice side.
