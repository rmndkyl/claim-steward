# Claim Steward — status & submission record

Updated: 14 Nov 2026

## Live artifacts

| What | Where |
|---|---|
| Agent endpoint | https://claim-steward.lyid.workers.dev/agent |
| Demo console | https://claim-steward.lyid.workers.dev |
| Public repo | https://github.com/rmndkyl/claim-steward |
| Protocol spec | repo `PROTOCOL.md` |
| Submission write-up | repo `SUBMISSION.md` |
| X post draft | repo `docs/x-post.md` |

## Agent Games submission — Wildcard

- Submitted: 14 Nov 2026, from the account handle **@mandayxbt**
- Status on site: **IN REVIEW** (AWAITING 1, PENDING)
- Project title submitted: `Claim Steward`
- Repo submitted: `https://github.com/rmndkyl/claim-steward`
- Endpoint submitted: `https://claim-steward.lyid.workers.dev/agent`
- Statement: composed by the site from endpoint + what-it-does + additional links + message to judges
  (hard limit 2,000 chars total — the site prepends `Endpoint: …` and `What it does:` before counting)
- Additional links submitted: demo console, PROTOCOL.md, docs/sample-receipt.json
- Proof reference: left blank on purpose (no zkVerify proof yet — see PROTOCOL.md §9)

Verified by read-back of the server-rendered entry payload (`statement` contains the endpoint,
the what-it-does text, the additional links, and the judges message) and by the dashboard card
showing `Claim Steward · IN REVIEW · Wildcard · Nov 14`.

## Test state at submission time

- `node scripts/selftest.mjs` — 17/17 PASS
- `node scripts/httptest.mjs https://claim-steward.lyid.workers.dev` — 20/20 PASS
- `node scripts/verify-offline.mjs docs/sample-receipt.json --pub a733e5…1047` — 5/5 PASS, no server involved
- Worker version at deploy: `cc87ecfb-bcfa-473b-89a7-c656bddd6850` (plus a CSS-only redeploy after)

## Remaining (needs the account owner)

1. **Creator Track entry** — the form requires a *published* piece: category (THREAD/VIDEO/ARTICLE/OTHER),
   title, submission links (X/Instagram/YouTube/Medium), optional supporting context (≤1,000 chars).
   Post `docs/x-post.md` from @mandayXBT with `#AgentGames` and `@ZKVProtocol`, then submit that post URL.
2. Prize wallet — confirm the wallet tied to the account is the intended one
   (`0xb7928f704Be4aa917F142f4202c94000f420B1c2`, the `abdulbinjai32` wallet) on whatever screen the
   site exposes for payouts; the dashboard does not show a wallet field.

## Gotchas learned the hard way

- The submissions page composes one `statement` string from four inputs and enforces 2,000 chars on the
  whole thing. A 1,820-char "what it does" plus links plus judges message = 2,959 chars = rejected with
  `fieldErrors.statement = "Statement cannot exceed 2,000 characters."`
- The char counters (`0/2000`, `0/1000`) only cover their own field, so they look fine while the payload
  is over budget. Budget: endpoint (44) + what + links + judges + 57 chars of glue ≤ 2,000.
- React inputs need the native value setter plus `input`/`change` events; setting `.value` alone leaves
  form state empty and the submit silently fails validation.
