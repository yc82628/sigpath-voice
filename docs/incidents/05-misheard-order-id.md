# 05: Speech-to-text heard "S B" instead of "S P"

Simulated with `npm run simulate -- misheard`. This one shows the call after the fix.

## Summary

In this scenario, callers say "S P one oh four two" and speech-to-text sometimes writes "S B one oh four two". `lookup_order` rejects that as an invalid order number. Before the fix, the agent asked the caller to "repeat the order number", the caller said it the same way, and it got misheard the same way.

## Impact

Before the fix, a caller could go round the same loop 2 or 3 times. After it, it costs one extra question.

## How it was found

The call log flags "lookup_order couldn't read the order number" and shows what was heard. Here: `"S B one oh four two"`.

## Root cause

P and B sound alike on a phone line. Asking someone to repeat the same thing gets you the same mishearing.

## Fix

I thought about making the normaliser accept "SB", "SV", "ESP" and similar as "SP". I decided against it. Every SigPath order starts with SP, so the letters carry no information. Guessing around them could also match a different buyer's order, and reading that out would be a privacy problem.

What I did instead:

- The tool's error now says "Ask the caller for just the 4 digits after SP, one at a time."
- The prompt says the same: if the number is invalid, ask for just the 4 digits, and don't guess them.
- The normaliser already accepts a bare "1042", so the second try works.
- `boosted_keywords` on the agent has "SigPath". Adding "SP" there is worth trying too.

## Follow-ups

- Count rejected order numbers per day. If the rate jumps, check whether a speech-to-text setting changed.
