#!/usr/bin/env node
/**
 * Builds data/registry.json: assigns deterministic synthetic wallet addresses to
 * the source entries, computes the Merkle root, and writes the committed registry.
 *
 * Run: node scripts/build-registry.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, leafHash, merkleRoot, buildTree } from "../src/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const srcPath = path.join(rootDir, "data", "registry.source.json");
const outPath = path.join(rootDir, "data", "registry.json");

const source = JSON.parse(fs.readFileSync(srcPath, "utf8"));

const entries = source.entries.map((e) => ({
  wallet: /^0x[0-9a-fA-F]{40}$/.test(e.wallet || "")
    ? e.wallet.toLowerCase()
    : "0x" + sha256Hex(`claim-steward:sample:${e.label}`).slice(0, 40),
  tier: e.tier,
  points: e.points,
}));

// label is not part of the commitment, keep it out of the output
const registry = { ...source, entries };
const leaves = entries.map((e) => leafHash(e.wallet, e.tier, e.points));
const root = merkleRoot(leaves);

registry.merkle_root = "0x" + root;
registry.leaf_count = leaves.length;
registry.built_at = new Date().toISOString();

// Public demo cases. Wallets + expected outcome only - points stay server-side.
const byLabel = Object.fromEntries(source.entries.map((e, i) => [e.label, { ...entries[i] }]));
registry.demo_cases = [
  {
    label: "eligible / approve",
    wallet: byLabel["sample-e"].wallet,
    tier: "PROSPECTOR",
    requested_amount: "750",
    expect: "APPROVE",
  },
  {
    label: "tier mismatch",
    wallet: byLabel["sample-a"].wallet,
    tier: "WARDEN",
    requested_amount: "2000",
    expect: "REJECT / TIER_MISMATCH",
  },
  {
    label: "amount over cap",
    wallet: byLabel["sample-g"].wallet,
    tier: "WARDEN",
    requested_amount: "99999",
    expect: "REJECT / AMOUNT_OVER_CAP",
  },
  {
    label: "not in registry",
    wallet: "0x" + sha256Hex("claim-steward:outsider").slice(0, 40),
    tier: "SCOUT",
    requested_amount: "250",
    expect: "REJECT / NOT_ELIGIBLE",
  },
];


fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + "\n");

const levels = buildTree(leaves);
console.log(`entries      : ${entries.length}`);
console.log(`tree levels  : ${levels.length}`);
console.log(`merkle_root  : 0x${root}`);
console.log("");
for (const e of entries) {
  console.log(`${e.wallet}  ${e.tier.padEnd(11)} points=${e.points}`);
}
