import "dotenv/config";
import { join } from "node:path";
import { createApp } from "./app";
import { Store } from "./store";

const apiKey = process.env.RETELL_API_KEY;
if (!apiKey) {
  console.error("RETELL_API_KEY is missing. Copy .env.example to .env and paste your key there.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const store = new Store(join(process.cwd(), "data", "store.json"));
const app = createApp({
  apiKey,
  store,
  publicKey: process.env.RETELL_PUBLIC_KEY,
  agentId: process.env.RETELL_AGENT_ID,
  toolDelayMs: Number(process.env.TOOL_DELAY_MS ?? 0) || undefined,
});

app.listen(port, () => {
  console.log(`SigPath Voice on http://localhost:${port}`);
  console.log(`  web call:  http://localhost:${port}/`);
  console.log(`  calls:     http://localhost:${port}/calls.html`);
  if (!process.env.RETELL_PUBLIC_KEY || !process.env.RETELL_AGENT_ID) {
    console.log("  RETELL_PUBLIC_KEY or RETELL_AGENT_ID not set yet, so the web call button stays off.");
  }
});
