#!/usr/bin/env node
/**
 * Seeds the public ledger with a handful of decisions and writes
 * docs/sample-receipt.json from the approved one, so the offline verifier
 * has a real receipt to check.
 *
 * Every write uses a demo scope, so the global (unscoped) claim slots stay free.
 *
 *   node scripts/seed-demo.mjs [baseUrl]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] || "https://claim-steward.lyid.workers.dev").replace(/\/$/, "");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const samples = await (await fetch(`${base}/api/samples`)).json();
const post = async (body) =>
  (
    await fetch(`${base}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

let approved = null;
for (const [i, c] of samples.cases.entries()) {
  const res = await post({
    campaign_id: samples.campaign_id,
    wallet: c.wallet,
    tier: c.tier,
    requested_amount: c.requested_amount,
    claim_scope: `seed-${i}`,
  });
  const got = res.decision === "APPROVE" ? "APPROVE" : `REJECT ${res.reason_code}`;
  console.log(`${c.label.padEnd(18)} -> ${got}`);
  if (res.receipt && c.expect === "APPROVE") approved = res.receipt;
}

if (approved) {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "sample-receipt.json"), JSON.stringify(approved, null, 2) + "\n");
  console.log(`\nwrote docs/sample-receipt.json (${approved.receipt_id})`);
} else {
  console.log("\nno APPROVE receipt captured");
}
