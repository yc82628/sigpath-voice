// Creates (or updates) the Retell LLM and agent from src/agent/config.ts.
//
//   npm run setup-agent
//
// First run: creates both and prints RETELL_LLM_ID and RETELL_AGENT_ID for .env.
// Later runs: if those ids are in .env, updates the existing LLM and agent
// instead of making new ones. Run it again whenever the prompt, tools or
// tunnel URL change.

import "dotenv/config";
import Retell from "retell-sdk";
import { buildAgentParams, buildLlmParams } from "../src/agent/config";

const DEFAULT_VOICE_ID = "retell-Cimo";

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is missing in .env. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const apiKey = need("RETELL_API_KEY");
  const publicBaseUrl = need("PUBLIC_BASE_URL");
  if (!/^https:\/\//.test(publicBaseUrl)) {
    console.error("PUBLIC_BASE_URL has to be a public https URL (a cloudflared or ngrok tunnel works). Retell can't reach localhost.");
    process.exit(1);
  }
  const transferNumber = process.env.TRANSFER_NUMBER?.trim() || undefined;
  if (transferNumber && !/^\+\d{8,15}$/.test(transferNumber)) {
    console.error("TRANSFER_NUMBER has to be in E.164 format, like +4930123456.");
    process.exit(1);
  }
  const voiceId = process.env.RETELL_VOICE_ID?.trim() || DEFAULT_VOICE_ID;

  const client = new Retell({ apiKey });

  // Check the voice exists before creating anything, so a typo doesn't
  // leave a half-made setup behind.
  const voices = await client.voice.list();
  const voiceList = Array.isArray(voices) ? voices : [];
  if (voiceList.length && !voiceList.some((v) => v.voice_id === voiceId)) {
    console.error(`Voice "${voiceId}" isn't available on this account. A few that are:`);
    for (const v of voiceList.slice(0, 8)) console.error(`  ${v.voice_id}  (${v.voice_name}, ${v.provider})`);
    console.error("Set RETELL_VOICE_ID in .env and run this again.");
    process.exit(1);
  }

  const llmParams = buildLlmParams({ publicBaseUrl, transferNumber });
  const existingLlmId = process.env.RETELL_LLM_ID?.trim();
  const llm = existingLlmId
    ? await client.llm.update(existingLlmId, llmParams)
    : await client.llm.create(llmParams);
  console.log(`${existingLlmId ? "Updated" : "Created"} LLM ${llm.llm_id}`);

  const agentParams = buildAgentParams({ publicBaseUrl, transferNumber, llmId: llm.llm_id, voiceId });
  const existingAgentId = process.env.RETELL_AGENT_ID?.trim();
  const agent = existingAgentId
    ? await client.agent.update(existingAgentId, agentParams)
    : await client.agent.create(agentParams);
  console.log(`${existingAgentId ? "Updated" : "Created"} agent ${agent.agent_id}`);

  console.log(`\nTools point at ${publicBaseUrl}/tools/...`);
  console.log(`Webhooks go to ${publicBaseUrl}/webhooks/retell`);
  console.log(transferNumber ? `Transfers go to ${transferNumber}` : "No TRANSFER_NUMBER set, so the transfer tool is off.");
  if (!existingLlmId || !existingAgentId) {
    console.log("\nAdd these to .env, then restart the server:");
    console.log(`RETELL_LLM_ID=${llm.llm_id}`);
    console.log(`RETELL_AGENT_ID=${agent.agent_id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Retell.APIError ? `Retell API error ${err.status}: ${err.message}` : err);
  process.exit(1);
});
