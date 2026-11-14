/**
 * Core crypto + commitment primitives.
 * Everything here runs both in Cloudflare Workers and in plain Node (ESM),
 * so the same code that produces a receipt can be used to verify it offline.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";

// @noble/ed25519 v2 needs a sync sha512 for the sync API; async API works without it.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const enc = new TextEncoder();

export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function sha256Hex(str) {
  return bytesToHex(sha256(enc.encode(str)));
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/* ---------------------------------------------------------------- Merkle */

/** Leaf commits to (wallet, tier, points). Points never leave the server. */
export function leafHash(wallet, tier, points) {
  return sha256Hex(`${String(wallet).toLowerCase()}|${tier}|${points}`);
}

export function buildTree(leaves) {
  const sorted = [...leaves].sort();
  const levels = [sorted];
  let cur = sorted;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = cur[i + 1] ?? cur[i]; // odd tail duplicates itself (Bitcoin-style)
      next.push(sha256Hex(a + b));
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

export function merkleRoot(leaves) {
  const levels = buildTree(leaves);
  return levels[levels.length - 1][0] ?? sha256Hex("");
}

export function merklePath(levels, leafOrIndex) {
  const base = levels[0];
  // buildTree sorts leaves, so the caller's entry index is NOT the tree index.
  // Accept the leaf hash and locate it, or an explicit sorted index.
  let idx = typeof leafOrIndex === "number" ? leafOrIndex : base.indexOf(leafOrIndex);
  if (idx < 0) throw new Error("leaf not in tree");
  const path = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibIdx = sib < level.length ? sib : idx;
    path.push({ position: idx % 2 === 0 ? "right" : "left", hash: level[sibIdx] });
    idx = Math.floor(idx / 2);
  }
  return path;
}

export function verifyPath(leaf, path, root) {
  let h = leaf;
  for (const step of path) {
    if (!step || typeof step.hash !== "string") return false;
    h = step.position === "right" ? sha256Hex(h + step.hash) : sha256Hex(step.hash + h);
  }
  return h === root;
}

/* ------------------------------------------------------------- Ed25519 */

export async function getPublicKey(privHex) {
  return bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privHex)));
}

export async function signBytes(privHex, message) {
  const sig = await ed.signAsync(enc.encode(message), hexToBytes(privHex));
  return bytesToHex(sig);
}

export async function verifySignature(pubHex, message, sigHex) {
  try {
    return await ed.verifyAsync(hexToBytes(sigHex), enc.encode(message), hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/** Short stable id derived from content - no random state needed. */
export function contentId(prefix, payload) {
  return `${prefix}_${sha256Hex(canonical(payload)).slice(0, 24)}`;
}
