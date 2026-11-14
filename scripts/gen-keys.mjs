#!/usr/bin/env node
/**
 * Generates the agent's ed25519 signing key.
 * Writes .dev.vars (gitignored) and prints the public key.
 * The private key is a signing key for receipts - it holds no funds.
 *
 * Run: node scripts/gen-keys.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { getPublicKey } from "../src/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const target = path.join(root, ".dev.vars");

if (fs.existsSync(target) && !process.argv.includes("--force")) {
  console.log(".dev.vars already exists - pass --force to rotate (this invalidates old receipts).");
  process.exit(0);
}

const priv = randomBytes(32).toString("hex");
const pub = await getPublicKey(priv);
const keyId = "cs-2026-11";

fs.writeFileSync(
  target,
  `AGENT_PRIVATE_KEY=${priv}\nAGENT_KEY_ID=${keyId}\n`
);

console.log("key_id      :", keyId);
console.log("public_key  :", pub);
console.log("written to  : .dev.vars (gitignored)");
console.log("");
console.log("Deploy the secret with:");
console.log("  npx wrangler secret put AGENT_PRIVATE_KEY   # paste the hex from .dev.vars");
console.log("  npx wrangler secret put AGENT_KEY_ID");
