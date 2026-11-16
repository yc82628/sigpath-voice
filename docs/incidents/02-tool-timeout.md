# 02: Order lookup timed out and the caller waited 17 seconds

Simulated with `npm run simulate -- slow`. SP-1098 is a fixture that takes 9 seconds to answer.

## Summary

A caller asked about SP-1098. The order API took 9 s to answer, but the tool timeout is 8 s, so Retell gave up and retried. The retry timed out too. The caller sat through about 17 seconds of "one moment" before the agent said the system wasn't answering, and then hung up.

## Impact

1 call, no answer given. The caller was told to try again later, so they'll probably call back.

## Timeline

| Time into call | What happened |
| --- | --- |
| 0:05 | Caller gives SP-1098. Agent says it's pulling up the order. |
| 0:06 | `lookup_order` attempt 1. Retell stops waiting at 8.0 s. My server answers at 9.0 s, to nobody. |
| 0:14 | Retell retries (`max_retry: 1`). Same thing: gives up at 8.0 s, server answers at 9.0 s. |
| 0:23 | Agent apologises and offers a ticket. Caller says no and hangs up. |

## How it was found

The call log shows 2 identical `lookup_order` requests, both marked red at about 9,010 ms, past the 8,000 ms timeout. The transcript has the tool call as failed with a timeout. End-to-end p90 was 17.4 s.

The useful detail is that my server logged HTTP 200 both times. Going by the server log alone, nothing was wrong. You only see the problem when you put the server's timing next to the agent's timeout.

## Root cause

The order API was slower than the tool timeout. A retry can't fix a slow upstream; it just doubles the wait (worst case is `timeout_ms × (max_retry + 1)`, so 16 s here).

## Fix options

1. **Make the API faster or cache it.** The real fix. Order status doesn't change every second, so a short cache would do.
2. **Set the timeout from real numbers.** Measure the API's p99 and set `timeout_ms` a bit above it, so slow-but-working answers get through.
3. **Don't retry timeouts on a slow upstream.** `max_retry: 1` makes sense for a flaky API that fails fast, not one that's slow. For this tool I'd drop it to 0 and let the agent offer a ticket after 8 s.
4. **Fill the silence.** `speak_during_execution` is already on. `enable_typing_sound` would help the caller know the line isn't dead.

In this repo I left the slow fixture as is, so the scenario keeps reproducing.

## Follow-ups

- Alert when any tool's p95 on my side goes above half its timeout.
