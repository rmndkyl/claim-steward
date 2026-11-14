# Claim Steward

A verifiable claim desk for airdrop distributions. You ask it about a claim; it answers with a decision and a receipt that anyone can check without trusting the operator.

```
POST https://claim-steward.lyid.workers.dev/agent
{ "campaign_id": "lyid-season-01", "wallet": "0xc3be...cb5", "tier": "PROSPECTOR", "requested_amount": "750" }
```

```json
{
  "decision": "APPROVE",
  "reason_code": "ELIGIBLE",
  "receipt": {
    "wallet": "0xc3be348bf5223218a57e7251fccaf151f27afcb5",
    "tier": "PROSPECTOR",
    "payout": "750",
    "registry_root": "0xa638346c8de6...e688",
    "leaf": "9b2f...",
    "merkle_path": [{ "position": "left", "hash": "..." }],
    "hash": "0x...",
    "signature": "0x..."
  }
}
```

Live demo console: **https://claim-steward.lyid.workers.dev**

Built for the zkVerify Agent Games, Wildcard track.

## The problem

Every airdrop ends with the same message: *trust our spreadsheet*. The distributor decided who qualifies, the claimer cannot check it, and after the campaign nobody can prove the list was not edited mid-flight. Screenshots are not evidence.

Claim Steward replaces the trust with three checks that need no server:

| Check | What it proves |
|---|---|
| ed25519 signature | this exact decision came from the agent's key, unaltered |
| Merkle path | the eligibility entry is inside a commitment published before the first claim |
| hash chain | each receipt names the previous one, so decisions cannot be rewritten after the fact |

## Features

- **Deterministic decision engine** - ordered rules, first failure wins, no language model in the loop. Same input, same reason code, every time.
- **Signed receipts** - ed25519 over canonical JSON; the receipt carries its own hash and the hash of the previous receipt.
- **Merkle commitment** - the agent rebuilds the tree at boot and refuses to serve (`REGISTRY_TAMPERED`) if the bundled data no longer hashes to the published root.
- **Replay protection** - `(campaign, wallet, scope)` is a primary key; a second claim returns `ALREADY_SETTLED`.
- **Public ledger** - every decision, including rejects, is appended to a hash-chained log exposed at `/api/ledger`.
- **Fail closed** - unknown campaign, malformed body, missing key, tampered registry: all reject.
- **Zero-cost hosting** - one Cloudflare Worker plus one D1 database, both on the free tier. No server to keep alive, no sleep after inactivity.
- **Offline verifier** - `scripts/verify-offline.mjs` re-checks a receipt using only the public key and the committed root.

## Requirements

| Item | Version / note |
|---|---|
| Node.js | 22.x (18+ works for the scripts) |
| Cloudflare account | free plan is enough; `wrangler login` once |
| Wrangler | 4.x, installed as a dev dependency |
| D1 database | created by the deploy steps below |
| Dependencies | `@noble/ed25519`, `@noble/hashes` (pure JS, no native build) |

## Setup

```bash
git clone https://github.com/rmndkyl/claim-steward.git
cd claim-steward
npm install

# 1. build the committed registry (writes data/registry.json + merkle_root)
node scripts/build-registry.mjs

# 2. generate the agent signing key (writes .dev.vars, gitignored)
node scripts/gen-keys.mjs

# 3. create the database and apply the schema
npx wrangler d1 create claim_steward        # copy database_id into wrangler.toml
npx wrangler d1 execute claim_steward --local  --file=schema.sql
npx wrangler d1 execute claim_steward --remote --file=schema.sql

# 4. push the secrets (never into wrangler.toml)
npx wrangler secret put AGENT_PRIVATE_KEY   # hex from .dev.vars
npx wrangler secret put AGENT_KEY_ID

# 5. run locally, then deploy
npx wrangler dev --local
npx wrangler deploy
```

## Usage

```bash
# ask for a decision
curl -s -X POST https://claim-steward.lyid.workers.dev/agent \
  -H 'content-type: application/json' \
  -d '{"campaign_id":"lyid-season-01","wallet":"0xc3be348bf5223218a57e7251fccaf151f27afcb5","tier":"PROSPECTOR","requested_amount":"750"}'

# verify a receipt with the agent
curl -s -X POST https://claim-steward.lyid.workers.dev/api/verify \
  -H 'content-type: application/json' -d @docs/sample-receipt.json

# verify the same receipt with no server involved
node scripts/verify-offline.mjs docs/sample-receipt.json --pub <agent_public_key>
```

Endpoints: `POST /agent`, `POST /api/verify`, `GET /api/registry`, `GET /api/keys`, `GET /api/ledger`, `GET /api/receipt/:id`, `GET /api/protocol`, `GET /health`. Full contract in [PROTOCOL.md](./PROTOCOL.md).

## Tests

```bash
node scripts/selftest.mjs                              # 17 checks, no network
node scripts/httptest.mjs http://127.0.0.1:8788         # 20 checks, local worker
node scripts/httptest.mjs https://claim-steward.lyid.workers.dev
```

`selftest` covers the commitment, the rule order, signature verification, tamper detection and Merkle path verification. `httptest` covers the live HTTP surface, including the verifier rejecting a tampered payout and a swapped wallet, and the duplicate guard.

## Reason codes

`UNKNOWN_CAMPAIGN`, `NOT_OPEN`, `WINDOW_CLOSED`, `NOT_ELIGIBLE`, `ALREADY_SETTLED`, `TIER_MISMATCH`, `AMOUNT_OVER_CAP`, `ELIGIBLE`. Checked in that order - see `src/agent.js`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `REGISTRY_TAMPERED` (503) | `data/registry.json` was edited after the root was committed | re-run `node scripts/build-registry.mjs` and commit the new root |
| `AGENT_KEY_MISSING` (503) | secret not set on the deployed worker | `npx wrangler secret put AGENT_PRIVATE_KEY` |
| `no such table: ledger` | schema never applied to that environment | run the `d1 execute --file=schema.sql` step for `--local` or `--remote` |
| Every claim returns `ALREADY_SETTLED` | the wallet was settled earlier in the same scope | send a different `claim_scope`, or reset the two tables |
| `401`/`10000` from the platform | not applicable - this agent has no platform dependency | - |

## Limits, stated plainly

- The wallet-to-leaf binding is an **agent attestation**, not a zero-knowledge claim. The Merkle path proves the leaf is in the set; it does not prove the leaf was derived from that wallet without revealing the points. Closing that gap is the Groth16 circuit described in PROTOCOL.md.
- The demo registry is synthetic and public. In production the registry lives in a private store and only the root is published.
- Dedupe uses a D1 primary key, which is atomic. The ledger append is a separate statement in the same batch; a crash between them would leave a claim without a ledger row (see PROTOCOL.md, "Durability").

## License

MIT
