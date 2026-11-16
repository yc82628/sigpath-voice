// Plays fake calls against the local server. Useful for checking the call
// log before you have a Retell account, or offline in an interview.
//
//   npm start                              (in one terminal)
//   npm run simulate                       (all scenarios)
//   npm run simulate -- slow misheard      (just these)

import "dotenv/config";
import { runScenario, SCENARIOS } from "./scenarios";

async function main() {
  const apiKey = process.env.RETELL_API_KEY;
  const base = `http://localhost:${process.env.PORT ?? 3000}`;
  if (!apiKey) {
    console.error("RETELL_API_KEY is missing. Any value works for the simulator, as long as the server uses the same one.");
    process.exit(1);
  }

  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !SCENARIOS.some((s) => s.name === w));
  if (unknown.length) {
    console.error(`Unknown scenario: ${unknown.join(", ")}. Pick from:`);
    for (const s of SCENARIOS) console.error(`  ${s.name.padEnd(17)} ${s.about}`);
    process.exit(1);
  }
  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`No server on ${base}. Start it with npm start first.`);
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  const chosen = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;
  for (const s of chosen) await runScenario({ base, apiKey }, s, stamp);

  // A timed-out tool request keeps running on the server after we stop
  // waiting. Give it time to finish so it shows up in the log.
  if (chosen.some((s) => s.name === "slow")) await new Promise((r) => setTimeout(r, 2000));
  console.log(`\nOpen ${base}/calls.html to see the calls.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
