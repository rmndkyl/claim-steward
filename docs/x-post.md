# X post draft (Creator Track + Wildcard public share)

Post from @mandayXBT. Screenshot: `docs/demo.png`. Attach it.

---

every airdrop ends with "trust our spreadsheet".

so i built the thing that replaces the sentence. you ask it about one claim, it answers approve or reject with a reason, and hands you a receipt you can verify with the network unplugged.

no LLM in the decision path — 8 rules, plain code, same answer every time. that's the whole point: a decision that changes between runs can't be signed.

3 checks, no server needed:
· ed25519 signature binds the exact decision
· merkle path proves the entry is in a root published before claim #1
· hash chain names the previous receipt, so nothing gets rewritten later

live: claim-steward.lyid.workers.dev
code: github.com/rmndkyl/claim-steward

it runs on one cloudflare worker + one d1, free tier. 37 tests, including the verifier catching a tampered payout and a replayed claim.

next: groth16 circuit so points stay private and the wallet→leaf link is a proof instead of my word. designed, not shipped — that part's in the protocol doc.

#AgentGames @ZKVProtocol

---

## Shorter variant (if the long one feels heavy)

airdrop claims come with one sentence: "trust our spreadsheet".

claim steward replaces it. ask about one claim → approve/reject + a signed receipt you can verify offline. merkle root committed before the first claim, receipts hash-chained so nothing gets edited later.

no LLM in the decision path. 8 rules, plain code. 37 tests, cloudflare worker + d1 free tier.

live: claim-steward.lyid.workers.dev
code: github.com/rmndkyl/claim-steward

#AgentGames @ZKVProtocol
