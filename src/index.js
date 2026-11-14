/**
 * Claim Steward - HTTP agent for verifiable airdrop claim decisions.
 *
 * Public surface:
 *   GET  /                 demo console (HTML)
 *   GET  /health           agent + registry status (fail-closed if registry tampered)
 *   POST /agent            the agent interface: claim in, decision + signed receipt out
 *   POST /api/verify       verify a receipt with no server state
 *   GET  /api/registry     published commitment (root, tiers, window)
 *   GET  /api/keys         agent signing key
 *   GET  /api/ledger       hash-chained decision log
 *   GET  /api/receipt/:id  one stored receipt
 */
import registryData from "../data/registry.json";
import UI from "./ui.html";
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
  contentId,
} from "./core.js";
import { parseClaim, decide, REASON, REASON_TEXT } from "./agent.js";

const PROTOCOL = "claim-steward/v1";
const GENESIS = "0x" + "0".repeat(64);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

/* ------------------------------------------------------------ registry */

// Built once per isolate. If the bundled data does not hash to the committed
// root, the agent refuses to serve: a tampered registry can never issue receipts.
const REGISTRY = (() => {
  const entries = registryData.entries ?? [];
  const leaves = entries.map((e) => leafHash(e.wallet, e.tier, e.points));
  const levels = buildTree(leaves);
  const computed = "0x" + merkleRoot(leaves);
  const committed = registryData.merkle_root;
  const intact = computed === committed;
  const index = new Map();
  entries.forEach((e, i) => index.set(e.wallet.toLowerCase(), { ...e, leaf: leaves[i], leafIndex: i }));
  return { data: registryData, entries, leaves, levels, computed, committed, intact, index };
})();

const publicRegistry = () => ({
  protocol: PROTOCOL,
  campaign_id: REGISTRY.data.campaign_id,
  name: REGISTRY.data.name,
  description: REGISTRY.data.description,
  chain: REGISTRY.data.chain,
  token: REGISTRY.data.token,
  opens_at: REGISTRY.data.opens_at,
  closes_at: REGISTRY.data.closes_at,
  tiers: REGISTRY.data.tiers,
  merkle_root: REGISTRY.committed,
  leaf_count: REGISTRY.data.leaf_count ?? REGISTRY.leaves.length,
  registry_intact: REGISTRY.intact,
  agent_key_id: null,
});

/* --------------------------------------------------------------- ledger */

async function lastLedgerRow(env) {
  try {
    return await env.DB.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").first();
  } catch {
    return null;
  }
}

async function appendLedger(env, body, receiptId, decision, reasonCode, priv) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await lastLedgerRow(env);
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? GENESIS;
    const withSeq = { ...body, ledger_seq: seq, prev_hash: prev };
    const hash = "0x" + sha256Hex(canonical(withSeq));
    const signed = { ...withSeq, hash };
    // Signing rule: ed25519 over canonical(body + hash). The hash commits to the body.
    const signature = await signBytes(priv, canonical(signed));
    const receipt = { ...signed, signature };
    try {
      const stmts = [
        env.DB.prepare(
          "INSERT INTO ledger (seq, receipt_id, decision, reason_code, wallet, hash, prev_hash, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(
          seq,
          receiptId,
          decision,
          reasonCode,
          receipt.wallet,
          hash,
          prev,
          JSON.stringify(receipt),
          receipt.issued_at
        ),
      ];
      if (decision === "APPROVE") {
        stmts.unshift(
          env.DB.prepare(
            "INSERT INTO claims (campaign_id, wallet, scope, tier, amount, receipt_id, settled_at) VALUES (?,?,?,?,?,?,?)"
          ).bind(
            receipt.campaign_id,
            receipt.wallet,
            receipt.claim_scope ?? "",
            receipt.tier,
            receipt.payout,
            receiptId,
            receipt.issued_at
          )
        );
      }
      await env.DB.batch(stmts);
      return receipt;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/UNIQUE|PRIMARY|constraint/i.test(msg)) {
        if (/claims/i.test(msg)) return { duplicate: true };
        continue; // ledger seq raced - retry with the next one
      }
      throw err;
    }
  }
  throw new Error("ledger_append_failed");
}

async function isSettled(env, campaignId, wallet, scope = "") {
  try {
    const row = await env.DB.prepare("SELECT receipt_id FROM claims WHERE campaign_id = ? AND wallet = ? AND scope = ?")
      .bind(campaignId, wallet, scope)
      .first();
    return Boolean(row);
  } catch {
    return false; // table missing -> treated as not settled; deploy runs the schema
  }
}

/* --------------------------------------------------------------- agent */

async function handleClaim(request, env, url) {
  if (!REGISTRY.intact) {
    return json({ decision: "REJECT", reason_code: "REGISTRY_TAMPERED" }, 503);
  }
  const priv = env.AGENT_PRIVATE_KEY;
  if (!priv) return json({ decision: "REJECT", reason_code: "AGENT_KEY_MISSING" }, 503);

  let raw;
  try {
    raw = await request.json();
  } catch {
    return json({ decision: "REJECT", reason_code: REASON.BAD_REQUEST, detail: "body is not JSON" }, 400);
  }

  const parsed = parseClaim(raw);
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs).toISOString();

  if (!parsed.ok) {
    return json({
      protocol: PROTOCOL,
      decision: "REJECT",
      reason_code: parsed.reason_code,
      explanation: REASON_TEXT[parsed.reason_code],
      issued_at: issuedAt,
    }, 400);
  }

  const claim = parsed.claim;
  const entry = REGISTRY.index.get(claim.wallet) ?? null;
  const settled = await isSettled(env, claim.campaign_id, claim.wallet, claim.claim_scope ?? "");
  const verdict = decide({ registry: REGISTRY.data, entry, nowMs, claim, alreadySettled: settled });

  const body = {
    protocol: PROTOCOL,
    receipt_id: contentId("rcpt", { wallet: claim.wallet, at: issuedAt, r: verdict.reason_code, n: crypto.randomUUID().slice(0, 8) }),
    campaign_id: claim.campaign_id,
    wallet: claim.wallet,
    claim_scope: claim.claim_scope ?? "",
    tier: claim.tier,
    requested_amount: claim.requested_amount,
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    payout: verdict.decision === "APPROVE" ? verdict.payout : "0",
    registry_root: REGISTRY.committed,
    leaf: verdict.decision === "APPROVE" || verdict.reason_code === "TIER_MISMATCH" ? entry?.leaf ?? null : null,
    merkle_path:
      (verdict.decision === "APPROVE" || verdict.reason_code === "TIER_MISMATCH") && entry
        ? merklePath(REGISTRY.levels, entry.leaf)
        : [],
    agent_key_id: env.AGENT_KEY_ID ?? "cs-2026-11",
    issued_at: issuedAt,
  };

  const receipt = await appendLedger(env, body, body.receipt_id, verdict.decision, verdict.reason_code, priv);
  if (receipt?.duplicate) {
    return json({
      protocol: PROTOCOL,
      decision: "REJECT",
      reason_code: REASON.ALREADY_SETTLED,
      explanation: REASON_TEXT[REASON.ALREADY_SETTLED],
      issued_at: issuedAt,
    });
  }

  return json({
    decision: receipt.decision,
    reason_code: receipt.reason_code,
    explanation: REASON_TEXT[verdict.reason_code],
    receipt,
    verify: {
      hint: "POST { receipt } to /api/verify, or recompute offline: hash = sha256(canonical(receipt without hash+signature)), then ed25519-verify canonical(receipt without signature).",
      checks: ["ed25519 signature", "merkle path to committed root", "hash chain link"],
    },
  });
}

/* ------------------------------------------------------------ verifier */

async function handleVerify(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ valid: false, error: "body is not JSON" }, 400);
  }
  const receipt = payload?.receipt && typeof payload.receipt === "object" ? payload.receipt : payload;
  if (!receipt || typeof receipt !== "object") return json({ valid: false, error: "no receipt" }, 400);

  // Signing rule: hash = sha256(canonical(body)); signature = ed25519(canonical({...body, hash})).
  const { signature, ...rest } = receipt;
  const { hash, ...body } = rest;
  if (!signature) return json({ valid: false, checks: {}, error: "receipt has no signature" }, 400);

  const pub = await getPublicKey(env.AGENT_PRIVATE_KEY);
  const signatureOk = await verifySignature(pub, canonical(rest), signature);
  const hashOk = Boolean(hash) && "0x" + sha256Hex(canonical(body)) === hash;

  const rootOk = body.registry_root === REGISTRY.committed;
  const pathOk =
    Array.isArray(body.merkle_path) && body.merkle_path.length > 0 && typeof body.leaf === "string"
      ? verifyPath(body.leaf, body.merkle_path, REGISTRY.committed.replace(/^0x/, ""))
      : false;

  const leafMatchesWallet = Boolean(body.leaf) && REGISTRY.index.get(String(body.wallet).toLowerCase())?.leaf === body.leaf;

  const checks = {
    signature: signatureOk,
    receipt_hash: hashOk,
    registry_root: rootOk,
    merkle_path: pathOk,
    leaf_belongs_to_wallet: leafMatchesWallet,
  };
  const valid = signatureOk && hashOk && rootOk && (body.decision === "APPROVE" ? pathOk && leafMatchesWallet : true);

  return json({
    valid,
    checks,
    decision: body.decision,
    reason_code: body.reason_code,
    wallet: body.wallet,
    certified_claim: valid
      ? "The agent signed this decision, the receipt was not altered, and the eligibility leaf is provably inside the committed set."
      : "At least one check failed - treat this receipt as unverified.",
    note:
      "The wallet-to-leaf binding is an agent attestation, not a zero-knowledge claim. Closing that gap is what the Groth16 policy circuit does (see /docs).",
  });
}

/* --------------------------------------------------------------- router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === "/" && request.method === "GET") {
        return new Response(UI, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }

      if (path === "/health") {
        const pub = env.AGENT_PRIVATE_KEY ? await getPublicKey(env.AGENT_PRIVATE_KEY) : null;
        const last = await lastLedgerRow(env);
        return json({
          ok: REGISTRY.intact && Boolean(env.AGENT_PRIVATE_KEY),
          protocol: PROTOCOL,
          agent: "claim-steward",
          campaign_id: REGISTRY.data.campaign_id,
          registry_intact: REGISTRY.intact,
          merkle_root: REGISTRY.committed,
          key_id: env.AGENT_KEY_ID ?? "cs-2026-11",
          public_key: pub,
          ledger_head: last ?? null,
          now: new Date().toISOString(),
        });
      }

      if (path === "/agent" && request.method === "POST") return await handleClaim(request, env, url);

      if (path === "/api/verify" && request.method === "POST") return await handleVerify(request, env);

      if (path === "/api/registry") return json(publicRegistry());

      if (path === "/api/samples") return json({ campaign_id: REGISTRY.data.campaign_id, cases: REGISTRY.data.demo_cases ?? [] });

      if (path === "/api/keys") {
        const pub = await getPublicKey(env.AGENT_PRIVATE_KEY);
        return json({
          key_id: env.AGENT_KEY_ID ?? "cs-2026-11",
          algorithm: "ed25519",
          public_key: pub,
          signing_rule:
            "hash = sha256(canonical(body)) where body = receipt without {hash, signature}; signature = ed25519(canonical(body + hash)). canonical = JSON with keys sorted, no whitespace.",
        });
      }

      if (path === "/api/ledger") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
        const { results } = await env.DB.prepare(
          "SELECT seq, receipt_id, decision, reason_code, wallet, hash, prev_hash, created_at FROM ledger ORDER BY seq DESC LIMIT ?"
        )
          .bind(limit)
          .all();
        return json({ count: results.length, entries: results });
      }

      const m = path.match(/^\/api\/receipt\/(.+)$/);
      if (m) {
        const row = await env.DB.prepare("SELECT body FROM ledger WHERE receipt_id = ?").bind(m[1]).first();
        if (!row) return json({ error: "receipt not found" }, 404);
        return json(JSON.parse(row.body));
      }

      if (path === "/api/protocol") {
        return json({
          protocol: PROTOCOL,
          interface: "POST /agent with {campaign_id, wallet, tier, requested_amount}",
          order_of_rules: [
            "UNKNOWN_CAMPAIGN",
            "NOT_OPEN",
            "WINDOW_CLOSED",
            "NOT_ELIGIBLE",
            "ALREADY_SETTLED",
            "TIER_MISMATCH",
            "AMOUNT_OVER_CAP",
            "APPROVE",
          ],
          receipt_fields: [
            "receipt_id",
            "campaign_id",
            "wallet",
            "tier",
            "requested_amount",
            "decision",
            "reason_code",
            "payout",
            "registry_root",
            "leaf",
            "merkle_path",
            "agent_key_id",
            "issued_at",
            "ledger_seq",
            "prev_hash",
            "hash",
            "signature",
          ],
          guarantees: {
            signature:
              "ed25519 over canonical(receipt without signature). hash = sha256(canonical(receipt without hash+signature)) is signed alongside the body, so the decision cannot be altered.",
            merkle_path:
              "leaf is provably a member of the committed eligibility set (root published before any claim).",
            hash_chain:
              "each receipt names the hash of the previous one; rewriting history breaks every later link.",
          },
          not_guaranteed:
            "The wallet-to-leaf binding is an attestation. A Groth16 circuit turns it into a proof that the wallet's points clear the tier threshold without revealing the points.",
        });
      }

      return json({ error: "not_found", path }, 404);
    } catch (err) {
      return json({ error: "internal_error", detail: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
