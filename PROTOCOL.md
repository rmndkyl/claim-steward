# Claim Steward - Protocol v1

Status: implemented and deployed at `https://claim-steward.lyid.workers.dev`.
Section 9 (zero-knowledge policy proof) is a design, clearly marked as not shipped.

---

## 1. Roles

| Role | Holds | Publishes |
|---|---|---|
| Distributor | the full eligibility registry (wallet, tier, points) | Merkle root, tier table, claim window |
| Agent (this service) | the registry, the ed25519 signing key, the claims table | public key, receipts, hash-chained ledger |
| Claimer | a wallet | nothing |
| Verifier (anyone) | public key + root | nothing |

The claimer never sees the registry, and the verifier never needs the agent to be online.

## 2. Registry commitment

Entries are `(wallet, tier, points)`. Leaves are

```
leaf = sha256( lower(wallet) + "|" + tier + "|" + points )      // hex, no 0x
```

Leaves are sorted lexicographically, then paired upward; an odd tail duplicates itself (Bitcoin-style). The root is published as `0x` + hex.

The worker rebuilds the tree on boot and compares it to `registry.merkle_root`. On mismatch every claim returns HTTP 503 `REGISTRY_TAMPERED`. An edited registry can therefore never issue a receipt that verifies against the published root.

Only the root, the tier table and the claim window are public. `GET /api/registry` never returns `entries` or `points`.

## 3. Request

```
POST /agent
content-type: application/json

{
  "campaign_id":     "lyid-season-01",
  "wallet":          "0x…40 hex…",
  "tier":            "PROSPECTOR",
  "requested_amount":"750",
  "claim_scope":     "optional-8char"     // see §8
}
```

`requested_amount` is optional; when omitted the tier amount is used. `tier` is case-insensitive. Everything else is required.

## 4. Rule order

First failing rule wins. The order is part of the protocol - a receipt's `reason_code` must be reproducible.

| # | Rule | `reason_code` | Decision |
|---|---|---|---|
| 1 | `campaign_id` matches the committed registry | `UNKNOWN_CAMPAIGN` | REJECT |
| 2 | `now >= opens_at` | `NOT_OPEN` | REJECT |
| 3 | `now <= closes_at` | `WINDOW_CLOSED` | REJECT |
| 4 | wallet has a registry entry | `NOT_ELIGIBLE` | REJECT |
| 5 | `(campaign, wallet, scope)` not already settled | `ALREADY_SETTLED` | REJECT |
| 6 | claimed tier equals registry tier | `TIER_MISMATCH` | REJECT |
| 7 | `0 < requested <= tier.cap` | `AMOUNT_OVER_CAP` | REJECT |
| 8 | otherwise | `ELIGIBLE` | APPROVE |

Malformed body returns HTTP 400 `BAD_REQUEST` with no receipt.

## 5. Response

```json
{
  "decision": "APPROVE",
  "reason_code": "ELIGIBLE",
  "explanation": "Wallet is in the committed eligibility set, on the claimed tier, inside the claim window.",
  "receipt": { ...see §6... },
  "verify": { "hint": "...", "checks": ["ed25519 signature", "merkle path to committed root", "hash chain link"] }
}
```

Rejects caused by rules 1-7 also carry a signed receipt (so the reject itself is auditable). Only a malformed request is receiptless.

## 6. Receipt

| Field | Meaning |
|---|---|
| `protocol` | `claim-steward/v1` |
| `receipt_id` | opaque id, `rcpt_` + 24 hex |
| `campaign_id` | registry id |
| `wallet` | lowercase 0x address |
| `claim_scope` | settlement scope, `""` in production |
| `tier` | tier claimed |
| `requested_amount` | as sent, or `null` |
| `decision` | `APPROVE` / `REJECT` |
| `reason_code` | from §4 |
| `payout` | approved amount, `"0"` on reject |
| `registry_root` | root this decision was made against |
| `leaf` | the wallet's leaf, when the wallet is known |
| `merkle_path` | `[{position, hash}]`, empty for unknown wallets |
| `agent_key_id` | signing key id |
| `issued_at` | ISO 8601, agent clock |
| `ledger_seq` | position in the ledger, 1-based |
| `prev_hash` | hash of the previous ledger entry |
| `hash` | `sha256(canonical(body))` |
| `signature` | `ed25519(canonical(body + hash))` |

### Canonical JSON

Keys sorted at every level, arrays in order, no whitespace, `JSON.stringify` string escaping. Values are strings or arrays of objects with string fields - no floating point anywhere, so the encoding is stable across languages.

### Signing rule

```
body      = receipt without {hash, signature}
hash      = "0x" + sha256hex(canonical(body))
signature = hex(ed25519_sign(canonical(body + {hash})))
```

The hash is signed alongside the body, so `hash` cannot be swapped without invalidating the signature.

## 7. Offline verification

Five steps, no network:

1. `body = receipt - {hash, signature}`; recompute `sha256(canonical(body))` and compare to `hash`.
2. Verify `signature` over `canonical(body + {hash})` with the agent public key from `GET /api/keys` (or the copy in the release notes).
3. Check `registry_root` equals the root published in the repo's `data/registry.json`.
4. Walk `merkle_path` from `leaf` with `sha256(left + right)` per step; the result must equal the root.
5. Optionally check `(wallet, leaf)` against the registry you hold - if you are the distributor.

`scripts/verify-offline.mjs` does exactly this. If step 5 is skipped, the wallet-to-leaf binding rests on the agent's signature alone - see §10.

## 8. Claims, scopes and replay

`claims(campaign_id, wallet, scope)` is a primary key, so the second insert for the same triple fails at the database and the API returns `ALREADY_SETTLED`. This is the only stateful rule.

`claim_scope` exists so a public demo console stays usable: the browser generates one scope per visitor, so each visitor can see an APPROVE without exhausting the campaign. Protocol users leave it empty and get global deduplication. The scope is inside the signed receipt, so it cannot be changed after the fact.

## 9. Zero-knowledge policy proof (designed, not shipped)

The gap left by §7 is narrow and specific: the verifier learns *which leaf* belongs to the wallet, and learns it **because the agent says so**. The path proves set membership; it does not prove the leaf was derived from that wallet's private data.

The intended circuit lowers to:

```
// claim_policy.circom - Groth16/BN128, Circom 2.x
signal private input points;          // never revealed
signal private input salt;            // per-wallet, from the distributor
signal private input path[8][2];      // Merkle path, sibling + direction
signal input root;                    // public: committed root
signal input wallet;                  // public
signal input tierId;                  // public
signal input threshold;               // public: min points for the tier
signal input nullifier;               // public: keccak(wallet, campaignId)

leaf      <== Poseidon([wallet, tierId, points, salt]);
root      === MerkleRoot(leaf, path);
points    >= threshold;               // 8-bit range check
nullifier === keccak([wallet, campaignId]);
```

What that changes for the verifier:

- **Points stay private.** The claimer proves "at least the threshold" instead of disclosing 1840 points.
- **The wallet-to-leaf link becomes a proof**, not an attestation.
- **The nullifier replaces the claims table** for duplicate detection: one claim per wallet per campaign, enforced by the circuit rather than by a database row.

Submission path once the circuit exists: `snarkjs groth16 prove` locally, then `POST /submit-proof/{KURIER_API_KEY}` on `https://api.kurier.xyz/api/v1` with `proofType: "groth16"`, `proofOptions: {library: "snarkjs", curve: "bn128"}`, and the registered `vk` hash; poll the job to `Finalized` and write the resulting tx hash into the receipt as `proof_tx`.

The zkVerify vk hash used by Agent Games' own Gatekeeper circuit (`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`) is **not** reusable here: it verifies their statement, not this one. A production version of Claim Steward registers its own vk once and reuses that hash for every receipt.

## 10. Threat model

| Attack | Stopped by |
|---|---|
| Operator edits the registry after publishing | root recomputed at boot; mismatch → 503 for every claim |
| Operator flips a decision later | receipt hash + signature; a changed field breaks verification |
| Operator deletes an inconvenient decision | ledger chain: every later `prev_hash` points at it |
| Claimer edits the payout in their receipt | signature over body + hash |
| Claimer replays a receipt for another wallet | `leaf_belongs_to_wallet` check |
| Double claim | primary key on `(campaign, wallet, scope)` |
| Agent says "trust me" about points | **not stopped** - this is the §9 circuit's job |
| Malicious registry holder issuing a wrong leaf | **not stopped** - the distributor is trusted to author the registry; the commitment only makes their edits visible |

## 11. Durability

Claim insert and ledger append run in one D1 batch, claims first. If the batch fails between the two statements, the claim exists without its ledger row; the next claim for that wallet returns `ALREADY_SETTLED` with no receipt to show. Production would run both inside a single transaction (D1 `batch` is atomic per statement, not across them in all cases) or use a queue. Recorded here rather than papered over.

Ledger seq assignment is read-then-insert; concurrent writers can collide on the primary key, in which case the write retries up to three times with the next seq.

## 12. Versioning

`protocol: "claim-steward/v1"`. Adding a rule changes the order in §4 and requires `v2`. Adding a receipt field is backwards compatible if verifiers ignore unknown fields, which `scripts/verify-offline.mjs` does.
