/**
 * Claim Steward decision engine.
 *
 * Deterministic, ordered, fail-closed. No model in the loop: an LLM may propose,
 * but every rule below is plain code so the same inputs always produce the same
 * reason_code. That is what makes the receipt worth signing.
 */

export const REASON = {
  ELIGIBLE: "ELIGIBLE",
  BAD_REQUEST: "BAD_REQUEST",
  UNKNOWN_CAMPAIGN: "UNKNOWN_CAMPAIGN",
  NOT_OPEN: "NOT_OPEN",
  WINDOW_CLOSED: "WINDOW_CLOSED",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  TIER_MISMATCH: "TIER_MISMATCH",
  AMOUNT_OVER_CAP: "AMOUNT_OVER_CAP",
  ALREADY_SETTLED: "ALREADY_SETTLED",
};

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** Normalise the inbound request. Returns {ok, claim} or {ok:false, reason_code}. */
export function parseClaim(raw) {
  const input = raw && typeof raw === "object" && raw.input && typeof raw.input === "object" ? raw.input : raw;
  if (!input || typeof input !== "object") return { ok: false, reason_code: REASON.BAD_REQUEST };

  const wallet = typeof input.wallet === "string" ? input.wallet.trim() : "";
  const campaign_id = typeof input.campaign_id === "string" ? input.campaign_id.trim() : "";
  const tier = typeof input.tier === "string" ? input.tier.trim().toUpperCase() : "";
  const requested_amount =
    input.requested_amount === undefined || input.requested_amount === null
      ? null
      : String(input.requested_amount).trim();
  const claim_scope = typeof input.claim_scope === "string" ? input.claim_scope.trim() : "";

  if (!campaign_id) return { ok: false, reason_code: REASON.BAD_REQUEST };
  if (!WALLET_RE.test(wallet)) return { ok: false, reason_code: REASON.BAD_REQUEST };
  if (!tier) return { ok: false, reason_code: REASON.BAD_REQUEST };
  if (requested_amount !== null && !/^[0-9]+$/.test(requested_amount)) {
    return { ok: false, reason_code: REASON.BAD_REQUEST };
  }
  if (claim_scope && !/^[a-zA-Z0-9_-]{1,64}$/.test(claim_scope)) {
    return { ok: false, reason_code: REASON.BAD_REQUEST };
  }

  return { ok: true, claim: { wallet: wallet.toLowerCase(), campaign_id, tier, requested_amount, claim_scope } };
}

/**
 * Ordered rules. First failure wins, so a receipt's reason_code is reproducible.
 * @param {object} args
 * @param {object} args.registry   server-side campaign registry
 * @param {object|null} args.entry the private registry row for this wallet
 * @param {number} args.nowMs
 * @param {object} args.claim      output of parseClaim
 * @param {boolean} args.alreadySettled
 */
export function decide({ registry, entry, nowMs, claim, alreadySettled }) {
  if (claim.campaign_id !== registry.campaign_id) {
    return { decision: "REJECT", reason_code: REASON.UNKNOWN_CAMPAIGN };
  }
  if (nowMs < Date.parse(registry.opens_at)) {
    return { decision: "REJECT", reason_code: REASON.NOT_OPEN };
  }
  if (nowMs > Date.parse(registry.closes_at)) {
    return { decision: "REJECT", reason_code: REASON.WINDOW_CLOSED };
  }
  if (!entry) {
    return { decision: "REJECT", reason_code: REASON.NOT_ELIGIBLE };
  }
  if (alreadySettled) {
    return { decision: "REJECT", reason_code: REASON.ALREADY_SETTLED };
  }
  if (entry.tier !== claim.tier) {
    return { decision: "REJECT", reason_code: REASON.TIER_MISMATCH };
  }

  const tier = registry.tiers[entry.tier];
  if (!tier) return { decision: "REJECT", reason_code: REASON.TIER_MISMATCH };

  const cap = BigInt(tier.cap);
  const payout = tier.amount;
  const requested = claim.requested_amount === null ? BigInt(payout) : BigInt(claim.requested_amount);
  if (requested > cap || requested === 0n) {
    return { decision: "REJECT", reason_code: REASON.AMOUNT_OVER_CAP };
  }

  return { decision: "APPROVE", reason_code: REASON.ELIGIBLE, payout: String(requested) };
}

/** Human-readable explanation shown next to the decision in the demo UI. */
export const REASON_TEXT = {
  ELIGIBLE: "Wallet is in the committed eligibility set, on the claimed tier, inside the claim window.",
  BAD_REQUEST: "Malformed request: need campaign_id, a 0x wallet address and a tier.",
  UNKNOWN_CAMPAIGN: "campaign_id does not match this agent's committed registry.",
  NOT_OPEN: "The claim window has not opened yet.",
  WINDOW_CLOSED: "The claim window has closed.",
  NOT_ELIGIBLE: "Wallet is not in the committed eligibility set.",
  TIER_MISMATCH: "Wallet is eligible, but for a different tier than the one claimed.",
  AMOUNT_OVER_CAP: "Requested amount exceeds the tier cap or is zero.",
  ALREADY_SETTLED: "This wallet already has a settled receipt for this campaign.",
};
