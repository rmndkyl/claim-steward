#!/usr/bin/env node
/**
 * Offline self-test: exercises the exact code paths the worker uses
 * (registry commitment, decision order, receipt signing, path verification)
 * without needing a deployed worker or D1.
 *
 * Run: node scripts/selftest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical,
  sha256Hex,
  leafHash,
  buildTree,
  merklePath,
  merkleRoot,
  verifyPath,
  getPublicKey,
  signBytes,
  verifySignature,
} from "../src/core.js";
import { parseClaim, decide } from "../src/agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "data", "registry.json"), "utf8"));

const devVars = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

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

console.log("registry commitment");
const leaves = registry.entries.map((e) => leafHash(e.wallet, e.tier, e.points));
const levels = buildTree(leaves);
const computed = "0x" + merkleRoot(leaves);
check("computed root equals committed root", computed === registry.merkle_root, `${computed} != ${registry.merkle_root}`);

const index = new Map();
registry.entries.forEach((e, i) => index.set(e.wallet.toLowerCase(), { ...e, leaf: leaves[i], leafIndex: i }));

console.log("\ndecision order");
const now = Date.parse("2026-11-15T12:00:00Z");
for (const c of registry.demo_cases) {
  const parsed = parseClaim({ campaign_id: registry.campaign_id, wallet: c.wallet, tier: c.tier, requested_amount: c.requested_amount });
  if (!parsed.ok) {
    check(`${c.label}: parses`, false, parsed.reason_code);
    continue;
  }
  const entry = index.get(parsed.claim.wallet) ?? null;
  const v = decide({ registry, entry, nowMs: now, claim: parsed.claim, alreadySettled: false });
  const got = v.decision === "APPROVE" ? "APPROVE" : `REJECT / ${v.reason_code}`;
  check(`${c.label} -> ${got}`, got === c.expect, `expected ${c.expect}`);
}

console.log("\nreceipt signature");
const pub = await getPublicKey(devVars.AGENT_PRIVATE_KEY);
const goodCase = registry.demo_cases[0];
const entry = index.get(goodCase.wallet.toLowerCase());
const body = {
  protocol: "claim-steward/v1",
  receipt_id: "rcpt_selftest",
  campaign_id: registry.campaign_id,
  wallet: goodCase.wallet,
  tier: entry.tier,
  requested_amount: goodCase.requested_amount,
  decision: "APPROVE",
  reason_code: "ELIGIBLE",
  payout: goodCase.requested_amount,
  registry_root: registry.merkle_root,
  leaf: entry.leaf,
  merkle_path: merklePath(levels, entry.leaf),
  agent_key_id: devVars.AGENT_KEY_ID ?? "cs-2026-11",
  issued_at: new Date(now).toISOString(),
  ledger_seq: 1,
  prev_hash: "0x" + "0".repeat(64),
};
const sig = await signBytes(devVars.AGENT_PRIVATE_KEY, canonical(body));
check("signature verifies", await verifySignature(pub, canonical(body), sig));
check("tampered body fails", !(await verifySignature(pub, canonical({ ...body, payout: "999999" }), sig)));
check("wrong key fails", !(await verifySignature("00".repeat(32), canonical(body), sig)));

console.log("\nmerkle path");
check("path verifies to root", verifyPath(body.leaf, body.merkle_path, registry.merkle_root.replace(/^0x/, "")));
check("foreign leaf fails", !verifyPath(sha256Hex("nope"), body.merkle_path, registry.merkle_root.replace(/^0x/, "")));
check("path length is log2(n)", body.merkle_path.length === Math.ceil(Math.log2(leaves.length)), `got ${body.merkle_path.length}`);

console.log("\nrule edge cases");
const outsider = parseClaim({ campaign_id: registry.campaign_id, wallet: "0x" + "1".repeat(40), tier: "SCOUT", requested_amount: "250" });
const asClaim = (c) =>
  parseClaim({ campaign_id: registry.campaign_id, wallet: c.wallet, tier: c.tier, requested_amount: c.requested_amount }).claim;
check("bad wallet rejected", !parseClaim({ campaign_id: "x", wallet: "0x123", tier: "SCOUT" }).ok);
check("not eligible", decide({ registry, entry: null, nowMs: now, claim: outsider.claim, alreadySettled: false }).reason_code === "NOT_ELIGIBLE");
check("already settled wins over amount", decide({ registry, entry, nowMs: now, claim: asClaim(goodCase), alreadySettled: true }).reason_code === "ALREADY_SETTLED");
check("closed window", decide({ registry, entry, nowMs: Date.parse("2027-01-01T00:00:00Z"), claim: asClaim(goodCase), alreadySettled: false }).reason_code === "WINDOW_CLOSED");
check("not open yet", decide({ registry, entry, nowMs: Date.parse("2026-01-01T00:00:00Z"), claim: asClaim(goodCase), alreadySettled: false }).reason_code === "NOT_OPEN");
check("unknown campaign", decide({ registry, entry, nowMs: now, claim: { ...asClaim(goodCase), campaign_id: "other" }, alreadySettled: false }).reason_code === "UNKNOWN_CAMPAIGN");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
