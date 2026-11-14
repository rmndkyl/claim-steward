#!/usr/bin/env node
/**
 * End-to-end HTTP test. Works against local dev or the deployed worker.
 *
 *   node scripts/httptest.mjs http://127.0.0.1:8788
 *   node scripts/httptest.mjs https://claim-steward.<subdomain>.workers.dev
 */
const base = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};
const jget = async (p) => (await fetch(base + p)).json();
const jpost = async (p, body) =>
  (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

console.log(`target ${base}\n`);

const health = await jget("/health");
check("health ok", health.ok === true, JSON.stringify(health).slice(0, 120));
check("registry intact", health.registry_intact === true);
check("public key present", typeof health.public_key === "string" && health.public_key.length === 64);

const reg = await jget("/api/registry");
check("registry root published", /^0x[0-9a-f]{64}$/.test(reg.merkle_root || ""));
check("registry hides points", !/"points"\s*:/.test(JSON.stringify(reg)) && !("entries" in reg));

const samples = await jget("/api/samples");
check("demo cases published", samples.cases.length >= 4);

console.log("\ndecisions");
let approveReceipt = null;
for (const c of samples.cases) {
  if (c.expect === "APPROVE" && approveReceipt) continue;
  const res = await jpost("/agent", {
    campaign_id: samples.campaign_id,
    wallet: c.wallet,
    tier: c.tier,
    requested_amount: c.requested_amount,
  });
  let got = res.decision === "APPROVE" ? "APPROVE" : `REJECT / ${res.reason_code}`;

  if (got === "REJECT / ALREADY_SETTLED" && c.expect === "APPROVE") {
    // Re-run against an already-used registry: pull the signed receipt this wallet got earlier.
    const led = await jget("/api/ledger?limit=100");
    const row = led.entries.find((e) => e.wallet === c.wallet.toLowerCase() && e.decision === "APPROVE");
    if (row) {
      approveReceipt = await jget("/api/receipt/" + row.receipt_id);
      got = "APPROVE";
      console.log(`  NOTE  ${c.label}: wallet already settled in an earlier run, reusing stored receipt`);
    }
  }

  check(`${c.label} -> ${got}`, got === c.expect, `expected ${c.expect}`);
  if (got === "APPROVE" && res.receipt) approveReceipt = res.receipt;
}

if (approveReceipt) {
  check("approved receipt is signed", typeof approveReceipt.signature === "string" && approveReceipt.signature.length === 128);
  check("approved receipt has a merkle path", Array.isArray(approveReceipt.merkle_path) && approveReceipt.merkle_path.length > 0);

  console.log("\nverifier");
  const v1 = await jpost("/api/verify", { receipt: approveReceipt });
  check("valid receipt verifies", v1.valid === true, JSON.stringify(v1.checks));
  check("all checks true", Object.values(v1.checks).every(Boolean), JSON.stringify(v1.checks));

  const tampered = { ...approveReceipt, payout: "999999" };
  const v2 = await jpost("/api/verify", { receipt: tampered });
  check("tampered payout rejected", v2.valid === false);

  const forgeWallet = { ...approveReceipt, wallet: "0x" + "2".repeat(40) };
  const v3 = await jpost("/api/verify", { receipt: forgeWallet });
  check("swapped wallet rejected", v3.valid === false);

  console.log("\nreplay");
  const again = await jpost("/agent", {
    campaign_id: samples.campaign_id,
    wallet: approveReceipt.wallet,
    tier: approveReceipt.tier,
    requested_amount: approveReceipt.payout,
  });
  check("second claim rejected as ALREADY_SETTLED", again.reason_code === "ALREADY_SETTLED", JSON.stringify(again).slice(0, 160));
} else {
  check("an APPROVE case exists", false);
}

console.log("\nledger chain");
const led = await jget("/api/ledger?limit=100");
check("ledger has entries", led.entries.length > 0);
const asc = [...led.entries].sort((a, b) => a.seq - b.seq);
let chainOk = true;
for (let i = 1; i < asc.length; i++) {
  if (asc[i].seq === asc[i - 1].seq + 1 && asc[i].prev_hash !== asc[i - 1].hash) chainOk = false;
}
check("prev_hash links match", chainOk);

const one = await jget("/api/receipt/" + (approveReceipt ? approveReceipt.receipt_id : "none"));
check("receipt retrievable by id", !one.error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
