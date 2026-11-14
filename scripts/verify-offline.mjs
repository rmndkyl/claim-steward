#!/usr/bin/env node
/**
 * Independent verifier. Uses only the public key, the committed root and the
 * receipt itself - it never talks to the agent.
 *
 *   node scripts/verify-offline.mjs receipt.json
 *   node scripts/verify-offline.mjs receipt.json --pub a733e5b2...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256Hex, verifyPath, verifySignature } from "../src/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-offline.mjs <receipt.json> [--pub <hex>]");
  process.exit(2);
}

const pubArgIdx = process.argv.indexOf("--pub");
const registry = JSON.parse(fs.readFileSync(path.join(root, "data", "registry.json"), "utf8"));
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));

const pub = pubArgIdx > -1 ? process.argv[pubArgIdx + 1] : process.argv[3];
if (!pub) {
  console.error("need the agent public key: --pub <64 hex chars> (GET /api/keys)");
  process.exit(2);
}

const { signature, ...rest } = receipt;
const { hash, ...body } = rest;

const results = [];
results.push(["receipt hash recomputed", "0x" + sha256Hex(canonical(body)) === hash]);
results.push(["ed25519 signature valid", await verifySignature(pub, canonical(rest), signature)]);
results.push(["registry root matches committed file", body.registry_root === registry.merkle_root]);
results.push([
  "merkle path reaches the committed root",
  Array.isArray(body.merkle_path) && body.merkle_path.length > 0
    ? verifyPath(body.leaf, body.merkle_path, registry.merkle_root.replace(/^0x/, ""))
    : false,
]);
results.push([
  "leaf belongs to the receipt wallet (agent attestation)",
  registry.entries.some(
    (e) => e.wallet.toLowerCase() === String(body.wallet).toLowerCase() && body.leaf === sha256Hex(`${e.wallet.toLowerCase()}|${e.tier}|${e.points}`)
  ),
]);

let ok = true;
for (const [name, pass] of results) {
  ok = ok && pass;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
}

console.log("");
console.log(`decision      : ${body.decision} / ${body.reason_code}`);
console.log(`wallet        : ${body.wallet}`);
console.log(`tier / payout : ${body.tier} / ${body.payout}`);
console.log(`ledger seq    : ${body.ledger_seq} (prev ${String(body.prev_hash).slice(0, 12)}…)`);
console.log("");
console.log(ok ? "receipt VERIFIED with no server involved" : "receipt REJECTED");
process.exit(ok ? 0 : 1);
