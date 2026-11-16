# 04: Agent promised a transfer it couldn't make

Simulated with `npm run simulate -- transfer-promise`.

## Summary

A caller with a damaged Kindle (SP-1044) asked to speak to a person. The agent said "let me connect you to a team member". The line had no transfer set up, so nothing happened. The caller said "Hello? Is anyone there?" and the agent ended the call. No transfer, no ticket.

## Impact

1 caller with a real problem (damaged item, escrow already released) left with nothing. This is the worst kind of failure: the agent sounded like it was helping.

## How it was found

The call log flagged "Agent said it would transfer the caller but never called a transfer tool." Post-call analysis said `transferred: false` and `resolved: false`.

## Root cause

I found 2 places telling the agent transfers were an option:

1. The prompt said "transfer them if you can. If you can't, open a ticket." The LLM read "if you can" as "probably can".
2. Tool error messages said "offer to open a ticket or transfer them to a person", whether or not a transfer tool existed.

`TRANSFER_NUMBER` was empty, so `setup-agent` didn't add `transfer_to_human`. The prompt and messages didn't know that.

## Fix

- The prompt is built from the same setting as the tools. With no transfer number it says "You can't transfer calls on this line. Never say you'll connect the caller to a person." and tells the agent to open a ticket instead. See `buildPrompt` in [src/agent/config.ts](../../src/agent/config.ts).
- Tool error messages offer a ticket, and only mention a transfer "if you have the transfer_to_human tool".
- Tests check the prompt for both cases.

## Follow-ups

- Same pattern for any optional tool: if the prompt mentions it, generate that line from the config that adds the tool.
