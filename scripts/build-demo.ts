// Builds the static call log demo that GitHub Pages serves.
//
//   npm run build:demo     -> writes site/
//
// It starts the real server code on a random port with an in-memory store,
// plays every simulator scenario against it, then saves what the call log's
// API returns as JSON files next to a copy of calls.html. No Retell account
// or secrets needed: the key below only signs requests to this local server.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createApp } from "../src/app";
import { Store } from "../src/store";
import { runScenario, SCENARIOS } from "./scenarios";

const OUT = join(process.cwd(), "site");
const DEMO_KEY = "demo-key-not-a-secret";

async function main() {
  const app = createApp({ apiKey: DEMO_KEY, store: new Store(null) });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const stamp = Date.now().toString(36);
  for (const s of SCENARIOS) await runScenario({ base, apiKey: DEMO_KEY }, s, stamp);
  // Let the timed-out requests from the slow scenario finish on the server.
  await new Promise((r) => setTimeout(r, 2000));

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "data", "calls"), { recursive: true });

  const list = await fetch(`${base}/api/calls`).then((r) => r.json());
  writeFileSync(join(OUT, "data", "calls.json"), JSON.stringify(list));
  for (const c of list.calls as { callId: string }[]) {
    const view = await fetch(`${base}/api/calls/${encodeURIComponent(c.callId)}`).then((r) => r.json());
    writeFileSync(join(OUT, "data", "calls", `${c.callId}.json`), JSON.stringify(view));
  }
  server.close();

  const page = readFileSync(join(process.cwd(), "public", "calls.html"), "utf8");
  if (!page.includes('<html lang="en">')) throw new Error("calls.html changed: can't switch it to static mode");
  const staticPage = page.replace('<html lang="en">', '<html lang="en" data-mode="static">');
  writeFileSync(join(OUT, "index.html"), staticPage);
  writeFileSync(join(OUT, "calls.html"), staticPage);
  cpSync(join(process.cwd(), "public", "style.css"), join(OUT, "style.css"));
  // Pages runs Jekyll by default, which skips some files. This turns it off.
  writeFileSync(join(OUT, ".nojekyll"), "");

  console.log(`\nWrote ${list.calls.length} calls to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
