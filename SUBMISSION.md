# Wildcard submission — Claim Steward

**Track:** Wildcard · **Event:** zkVerify Agent Games · **Submitted:** 14 Nov 2026

---

## Agent link

- Repository: https://github.com/rmndkyl/claim-steward
- Live demo console: https://claim-steward.lyid.workers.dev

## Public endpoint

```
POST https://claim-steward.lyid.workers.dev/agent
content-type: application/json

{"campaign_id":"lyid-season-01","wallet":"0xc3be348bf5223218a57e7251fccaf151f27afcb5","tier":"PROSPECTOR","requested_amount":"750"}
```

Supporting endpoints: `/api/verify`, `/api/registry`, `/api/keys`, `/api/ledger`, `/api/receipt/:id`, `/health`.
Full contract: https://github.com/rmndkyl/claim-steward/blob/master/PROTOCOL.md

## Use case

**Who it helps:** anyone who distributes tokens to a list of wallets, and anyone who receives them.

Every airdrop ends with the same sentence: *trust our spreadsheet*. The distributor decided who qualifies, the claimer cannot check the decision, and once the campaign closes nobody can prove the list was not edited mid-flight. Screenshots are not evidence. Today the claimer's only options are believing the operator or opening a support ticket into the void — and the operator's only option is publishing a CSV and hoping people trust it.

Claim Steward is the desk between them. You ask it about one claim; it answers APPROVE or REJECT with a specific reason code, and hands you a receipt that a third party can check with no server, no account, and no access to the eligibility list.

I built it because I run airdrop distributions myself and I was the operator asking to be trusted. The registry of who-gets-what is the part I cannot publish — wallet addresses and point balances are private. The *commitment* to that registry is the part I can, and that turns "trust me" into a check anyone can run.

```
decision: APPROVE / ELIGIBLE
receipt hash   0x36d5…  signed by cs-2026-11
merkle root    0xa638346c8de6…e688  (published before the first claim)
ledger seq     4, prev 0x72f7962ef1…
```

## Build context

The agent is one Cloudflare Worker plus one D1 database — free tier, no idle sleep, no server to babysit. The interesting decisions were about what to leave out.

**No language model in the decision path.** An LLM may propose, but every rule is plain code. Eight rules in a fixed order (unknown campaign → not open → window closed → not eligible → already settled → tier mismatch → amount over cap → eligible), first failure wins. Same input always yields the same reason code, which is what makes a signed receipt worth anything: a decision that changes between runs cannot be attested.

**Three checks that do not need me online.** The ed25519 signature binds the exact decision to the agent's key. The Merkle path proves the eligibility entry sits inside a root that was committed before the first claim. The hash chain names the previous receipt, so a decision cannot be quietly rewritten or deleted later — deleting one breaks every link after it. `scripts/verify-offline.mjs` does all three with only a public key and the committed root; it never contacts the worker. That is the demo I would show a skeptic: the receipt in `docs/sample-receipt.json` verifies with the network unplugged.

**Fail closed everywhere.** The worker rebuilds the Merkle tree at boot and compares it to the published root; if they differ, every claim returns 503 `REGISTRY_TAMPERED` rather than issuing receipts against a root it cannot honour. Missing signing key, unknown campaign, malformed body: all reject.

**Replay protection is a database key, not a check.** `(campaign_id, wallet, scope)` is the primary key on `claims`, so a duplicate claim fails at the storage layer instead of relying on a read-then-write race in application code.

**Tested against reality, not just written.** 17 offline logic checks (commitment, rule order, signature, tamper detection, Merkle path) and 20 live HTTP checks against the deployed worker, including the verifier correctly rejecting a tampered payout, a swapped wallet, and a replayed claim. Two real bugs surfaced this way and were fixed: the Merkle path was computed against unsorted leaf indices while the tree sorted them, and the signature was computed over a different body than the verifier reconstructed. Both are the kind of bug that produces receipts which *look* fine and verify nowhere.

**What it cannot do, stated plainly.** The wallet-to-leaf binding is my attestation, not a proof — I know the points, the verifier does not, and the verifier has to take my word that this leaf belongs to that wallet. The demo registry is synthetic and public; in production only the root is published. Both limits are in PROTOCOL.md §10 rather than hidden in a footnote.

## zkVerify (optional)

Not wired into the decision path today — I would rather describe the exact claim it would make than ship a proof that verifies something uninteresting.

The gap is narrow and specific: **the verifier learns which leaf belongs to the wallet because the agent says so.** A Groth16 circuit closes it while leaking less than the current path does:

```
private: points, salt, merkle path
public:  root, wallet, tierId, threshold, nullifier
leaf      <== Poseidon([wallet, tierId, points, salt]);
root      === MerkleRoot(leaf, path);
points    >= threshold;                       // range-checked
nullifier === keccak([wallet, campaignId]);   // one claim per wallet
```

Three things change. Points stay private — the claimer proves "at least the threshold" instead of disclosing 1,840 points. The wallet-to-leaf link becomes a proof instead of an attestation. And the nullifier replaces the `claims` table for duplicate detection, so one-claim-per-wallet is enforced by the circuit rather than by a database row I control.

Submission path: `snarkjs groth16 prove` locally, then Kurier (`POST /submit-proof/{key}` with `proofType: "groth16"`, `library: "snarkjs"`, `curve: "bn128"`), poll to `Finalized`, write the tx hash into the receipt as `proof_tx`. The Gatekeeper circuit's vk (`0x6b79c601…bd77b0`) is not reusable — it verifies their statement, not this one; a production Claim Steward registers its own vk once.

I am labelling this designed-not-shipped on purpose. The part that is shipped — signed receipts, committed set, hash chain — already replaces "trust our spreadsheet" with a check a claimer can run offline, and that is the claim I can defend today.

## Public share

Post with demo screenshot on X: `#AgentGames @ZKVProtocol`.
