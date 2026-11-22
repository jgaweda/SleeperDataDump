// Headless export using the same modules as the web app.
// Usage: node scripts/export-node.mjs <league_id> [username] [outDir] [--no-history] [--house-rules]
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["sleeper-api.js", "collector.js", "transform.js", "zip-writer.js", "house-rules.js", "house-rules-engine.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "js", f), "utf8"), { filename: f });
}
const JSZip = createRequire(import.meta.url)(path.join(root, "vendor", "jszip.min.js"));
const SD = globalThis.SleeperDump;

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [leagueId, username, outDir = "."] = args;
if (!leagueId) {
  console.error("Usage: node scripts/export-node.mjs <league_id> [username] [outDir] [--no-history] [--house-rules]");
  process.exit(1);
}

const client = new SD.SleeperClient();
let userId = null;
if (username) {
  const u = await client.getUser(username);
  userId = u && u.user_id;
}
let last = 0;
const dataset = await SD.collectLeague(client, {
  leagueId,
  userId,
  username,
  includeHistory: !process.argv.includes("--no-history"),
  onProgress: ({ message, done, total }) => {
    if (message) console.log(`[${done}/${total}] ${message}`);
    else if (done - last >= 50) { last = done; console.log(`[${done}/${total}]`); }
  },
});
const model = SD.buildModel(dataset);
if (process.argv.includes("--house-rules")) model.house = SD.applyHouseRules(dataset, model, SD.HOUSE_RULES);
const { zip, fileName, manifest } = SD.buildZip(dataset, model, JSZip);
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const out = path.join(outDir, fileName);
fs.writeFileSync(out, buf);
console.log(`Wrote ${out} (${(buf.length / 1e6).toFixed(2)} MB)`);
console.log(JSON.stringify(manifest.counts), "requests:", manifest.api_requests);
