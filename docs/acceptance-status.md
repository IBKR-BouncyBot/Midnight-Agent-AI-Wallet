# Handover acceptance status

Reviewed 6 November 2026 against the supplied *Midnight Agent AI Wallet Local
Codex Handover*. This is a coverage audit, not a certification. A passing unit or
generated-runtime test does not establish proof verification or settlement.
The [verification record](verification.md) records the final measured run and
public transaction references; this matrix also identifies evidence still needed
after a successful local custody flow.

## Established local milestone

The counts and transaction records below describe the completed local milestone.
The subsequent Preview/browser changes have separate checks; do not attribute a
previous commit's CI or network result to untested newer changes.

- Full compiler 0.31.1 builds completed for the vault and test token, including
  prover/verifier artifacts. Runtime 0.16.0 loads the generated contracts.
- `node --test tests/native-*.test.mjs`: **32 passed**, zero skipped. This includes
  30 vault/runtime/ledger-VM tests and two maintenance-authority tests.
- `npm run test:unit`: **50 passed**, zero skipped (protocol, private store and
  runner). Boundary tests use explicitly fabricated backend results. Final
  `npm test`: **82 passed**, including the 32 native tests.
- `node services/mcp/scripted-agent.mjs`: passed its inspection probe; reports
  payments unavailable and no AI client, proof or payment exercised.
- The unchanged upstream example's real `storeMessage` call finalized locally
  and its state was independently read from the indexer. Its successful record
  ended at `2026-11-06T14:57:19.712Z`.
- The corrected complete vault run **passed**, ending at
  `2026-11-06T15:06:44.285Z`. Its agent payment finalized at block 98:
  `00bcefcb70a1af84b8185d15cd27f1eef3c8adce54095a5f7077ac1acac83d7224`.
  Independent wallet observations showed payment `40000000280` and recovered
  owner change `60000000420`, summing to funded `100000000700` atomic test units.
  Owner withdrawal finalized at block 102. The public record is
  [committed baseline evidence](evidence/private-vault-local.json).
  An independent follow-up query measured the actual payment contract proof as
  4508 bytes; this is distinct from the record's eight generic proof-provider
  completions.
- The actual payment used one fallible segment, ID 5991. Inspection matched its
  contract input, merchant output and contract change to the transcript and found
  none of 11 sampled private values or tested amount encodings in serialized
  transaction/state and that public transcript. An older human-readable check
  string in the raw run record incorrectly says "guaranteed"; its structured
  phase/surface fields and the actual transaction identify **fallible**. The
  test source wording is corrected. Earlier failed runs are retained as failures.
- The real staged SDK adapter also **passed** its independent local network run.
  It persisted exact signed bytes before one submission, simulated losing that
  response, reopened encrypted storage and recovered finality/recipient/change
  without reproving or resubmitting. The payment finalized at block 186 and
  owner withdrawal at block 190. See [durable evidence](evidence/durable-vault-local.json).
  This is not an OS process-termination or power-loss test.
- Hosted [CI run 42241688658](https://github.com/IBKR-BouncyBot/Midnight-Agent-AI-Wallet/actions/runs/42241688658)
  passed the protocol/storage and native-runtime jobs for commit
  `7640d78d47e1b80e53a36aa12664ed88d0fae25e`. The optional network job was not
  exercised in that run; the actual local proof records remain separate evidence.

## Preview and browser demo follow-up

The repository now contains a Ballot Lab styled browser demonstration and a
separate Preview page backed by `services/demo/`. The browser demonstration is
scripted; it does not prove or settle a payment. The local Preview bridge uses an
owner pairing token, fixed public endpoints and the local prover. Its status
responses are distinct from the restricted agent-tool responses.

The demo creates separate owner/merchant wallet identities once, encrypts their
seeds and application state, saves SDK synchronization snapshots, and checks a
public address manifest on reopen. Missing identity or key files fail closed.
The persistence review caught and fixed a typed-array aliasing bug in decrypted
V8 snapshots; nine identity/storage tests now pass, including exact identity
preservation, safe legacy-manifest creation, corrupted/wrong-key rejection and
missing-file refusal. Five HTTP
boundary tests pass for pairing, Origin/Host checks, strict inputs and truthful
queued responses. The Preview configuration/maintenance tests also pass. The
latest complete `npm test` run reports **102 passed**, zero failed or skipped.

The first real public Preview payment has finalized in vault
`cc892e0ad1479b18621ba172195df419c9ddabf146c1bfbf12586a871fc5a792`:
transaction `007ce1b47a31b92f377673ca49709c635db02d0a61b394114b16b6763c3275dd1c`,
block 1627157. The runner verified the merchant's exact `40000000280` atomic-unit
receipt and qualified private vault change of `60000000420`. Separate
[public transaction inspection](evidence/preview-payment.json) confirms
`SucceedEntirely`, a 4508-byte contract proof and all accounting/coin effects in
one fallible segment, 63752. This public-only inspection does not repeat private
wallet receipt verification or the local fixture's secret/amount literal scan.
The original idempotency key returned the same payment ID and transaction with
unchanged balances. A fresh second `40000000280` request exceeded the remaining
allowance and was rejected without a transaction or balance change. Owner pause
also finalized; a fresh 100-atomic-unit request while paused was rejected with
unchanged balances. Owner withdrawal then finalized while paused at block
1627207; the service waited for the owner's exact `60000000420` receipt. Merchant
plus owner receipts equal the deposit, and final vault balance is zero. Selected
live results are retained in [runner evidence](evidence/preview-runner.json).

Commit `79b031d` passed [CI run 42258652447](https://github.com/IBKR-BouncyBot/Midnight-Agent-AI-Wallet/actions/runs/42258652447)
and [Pages run 42258652640](https://github.com/IBKR-BouncyBot/Midnight-Agent-AI-Wallet/actions/runs/42258652640),
publishing the two-mode web app. Subsequent local changes need their own hosted
result. Browser simulation and a 390px mobile layout were exercised; the paired
Preview browser flow remains untested. The live payment used the authenticated
local bridge and is not evidence of actual AI-client interoperability.

## Acceptance matrix

| Handover area | Demonstrated or implemented | Remaining evidence / implementation |
| --- | --- | --- |
| Native build | Pinned compiler generates real circuits and proving artifacts; generated runtime tests and the prior commit's hosted native CI job pass. | New commits require their own hosted results; the CI run above covers its exact head only. |
| Proof generation | Local prover/node accepted upstream, vault and staged-runner calls. The public Preview node also accepted the actual payment; its contract proof measured 4508 bytes. Prover-provider completions are recorded separately. | Deliberately tampered-proof rejection remains untested. |
| Settlement | Both local flows passed through owner withdrawal. Public Preview payment and owner withdrawal also finalized, with exact independent merchant and owner receipts equal to the deposit, qualified private change and final vault balance zero. | Preprod is untested; the verified run remains a bounded test-token demonstration. |
| Spending limits | Native tests reject per-payment/cumulative excess, zero, insufficient coin value and overflow; exact allowance and uint64 boundaries pass. Local network-backed excess failed before proof generation. Public Preview also rejected a second 40000000280 request above the remaining allowance without a transaction, leaving spent and balance unchanged. | Pre-proof rejection is not a malicious-proof network test. |
| Recipient, asset, precision | Native tests reject unknown/zero recipient and wrong asset; schemas reject fractions, exponents, leading zeros and values beyond uint64. Independent merchant wallet observed the finalized exact test asset and amount. | Adversarial modifications of an already prepared transaction remain untested. |
| Owner/agent authority | Separate domain-separated credentials; native agent calls cannot fund, administer or withdraw. The Preview demo strips owner authority from runner state; actual owner pause and withdrawal while paused finalized. Gateway scopes bind subject, network, deployment, vault and agent. | The loopback owner token is not an agent credential and must not be supplied to an AI client. |
| Maintenance authority | Native ledger serialization/signature tests pass. Local bootstrap verified empty committee/threshold one and counter advancement. Preview maintenance removal finalized at block 1627137; the service verified empty committee/threshold one before funding at block 1627145. | Every future deployment path must perform/verify the same unfunded bootstrap or explicitly declare its upgrade authority. Production migration/maintenance policy is not selected. |
| Expiry, pause, revocation | Native validity/expiry checks, permanent revoke, pause/resume and policy-version invalidation pass. Public Preview owner pause finalized and a later payment request was rejected without changing balances. Ledger ordering is specified; finalized payments cannot be undone. | Public resume/revoke and an inclusion race between a prepared payment and an owner action are untested. |
| Proof binding | Native circuit checks bind request network, vault, deployed address, version, asset, recipient, amount, validity, request ID and authenticated agent policy; tampered private openings fail. | Altered serialized proofs/transactions have not been submitted adversarially. Client-selected network labels alone are not ledger network identification. |
| Replay | Native duplicate request rejection survives policy replacement. Local network-backed flow rejects replay in generated code. A live Preview bridge retry returned the original finalized payment ID and transaction without changing balances. Changed-payload conflict tests pass with a test backend. | Re-submission of an identical finalized proof and a real MCP retry need separate evidence. |
| Concurrency | Real on-chain VM rejects an independently prepared stale transcript after another payment advances the state. Gateway tests submit identical concurrent requests once. | Simultaneous, separately proven network submissions and crash/restart concurrency are untested. No claim of network-race verification. |
| Atomicity and phases | Real ledger partitioning places the entire payment program and coin effects in one fallible transcript; VM execution produces the same final state. Actual finalized payment inspection confirms matching effects in local segment 5991 and Preview segment 63752; mixed segments fail closed. | Deliberately failing a shielded transfer and confirming all allowance/request/coin effects roll back remains untested. See [phase details](contract-design.md#atomicity-and-transaction-phases). |
| Coin qualification/change | Funding/change commitment matching and real Merkle positions succeeded; change was later spent by owner after encrypted provider reconstruction. Impossible index failed with the real ledger's specific sparse-Merkle-tree error before proving, with unchanged chain commitment. No public amount map. | No general mixed-segment insertion-order resolver is claimed. Provider reconstruction in one process is not crash recovery. |
| Crash recovery | Encrypted journal/private snapshot and durable runner retain confirmed/candidate openings and exact signed bytes before submission. Real SDK test recovered an actual submitted payment after an injected lost response and store reopen, with one submission. Preview admin recovery retains its record until both stores advance and binds the exact generated candidate. | The Preview recovery controls need public-network exercise. Actual process termination at persistence/submission cut points and power loss remain untested. |
| Backup | Authenticated export/import, wrong key/context/tamper rejection, exclusive writers and no-overwrite restore tests pass. Restore disables spending. | Restore against a current chain commitment and recover a pending finalized candidate in a fresh process. Stale backups may lack the needed opening; seed-only recovery is not supported. |
| Privacy | Public disclosure map documented. Finalized local payment/state/transcript inspection finds 11 sampled secrets and tested amount encodings absent. Preview public proof/effect inspection confirms its exact transaction shape. Storage/response projection tests pass; the loopback bridge requires owner pairing before exposing policy/activity. | Preview secret/amount literal scans and final UI/runtime log review remain separate gaps. Literal absence does not establish anonymity or prevent inference. Test-token mint amount is public. |
| Fee sponsorship | Native tests show the fee payer does not grant agent authority. | Separate sponsor funds fees and cannot alter/authorize payment: no end-to-end demonstration. Sponsorship is optional for initial custody. |
| MCP authentication | Fixed schemas, trusted scopes, expiry/cross-vault rejection, rate limits, receipt scoping and durable idempotency pass tests. Inspection stdio exposes three agent tools. A separately paired loopback owner bridge invokes the live runner through the same gateway. | The owner bridge is not a remote agent MCP service. Remote MCP authentication, actual model-client payments and deployment-level rate-limit semantics remain outstanding. |
| AI interoperability | Provider-neutral direct interface, MCP inspection process and separately labelled ChatGPT/Claude connection documentation exist. | No signed-in ChatGPT, Claude Code/Desktop, consumer remote connector or model-provider API has exercised a payment. A scripted client is not a substitute. |
| Owner interface | Ballot Lab reference/revision recorded; the published app includes separate scripted-browser and Preview interfaces. Browser simulation exercised payment, excess rejection and pause rejection; a 390px landing layout was checked. The local bridge exposes queued jobs and minimal receipts. | Paired Preview browser execution remains untested; complete keyboard/disconnected-state QA separately. The fixed policy is not a general policy editor; backup/import and live AI connection flows remain limited. |

## Repository and CI consistency

The repository contains a completed local feasibility milestone, an actual public
Preview payment and a published owner interface. Keep each mode's measured evidence
separate from implemented but unverified behavior. The immutable-rule claim is
conditional on the verified maintenance-removal bootstrap; the Compact
source alone does not remove the SDK's default upgrade key. The native tests
cover the authority encoding/signature; the independent network query supplies
the distinct on-chain evidence.

`.github/workflows/checks.yml` separates protocol/storage, native compilation and
runtime, and an opt-in full proof/local-settlement job. The full network job does
not substitute a fast build that omits proving keys. The prior hosted run linked
above passed its protocol/storage and native jobs. Newer hosted results must be
checked for their exact commit; local results do not establish them. A separate
Pages workflow successfully published commit `79b031d` as linked above. Type-check
and Preprod evidence remain outstanding.
`npm test` includes the native tests and requires generated artifacts;
`test:unit` selects protocol, private-store, runner and demo boundary/configuration
tests; CI additionally runs the actual scripted MCP subprocess. The manual network job includes the baseline
and durable SDK scenarios.

## Smallest next implementation milestone

The custody flow and staged runner pass locally, and the first Preview payment
has exact receipt/change evidence. The next evidence gates are:

1. Retain the completed public Preview payment, retry, allowance rejection,
   pause and owner-withdrawal evidence. Perform the separately scoped privacy/log
   inspection without exposing private wallet material; public resume/revoke
   remain distinct follow-up checks.
2. Exercise the Preview runner's encrypted journal, exact prepared candidate,
   finality reconciliation and owner recovery with the live service. General
   backup recovery still needs opening recomputation and current-chain checks;
   an arbitrary private snapshot cannot claim provenance by attaching current
   public commitments. Ambiguous outcomes stay unresolved without a fresh send.
3. Test process termination at preparation/submission/finality/persistence cut
   points, encrypted export/import, stale backup refusal and competing payments
   against the real local chain. Confirm one payment at most, correct balances,
   and a usable matching private opening after restart.
4. Extend the adapter already used by the scoped gateway and authenticated owner
   bridge to an agent transport. Test one scripted **real** MCP payment and receipt,
   duplicate/conflicting requests, expired credentials and cross-vault denial.
   Keep the inspection entry point distinct from the live path.
5. Verify the owner UI against real service states and the documented Ballot Lab
   design. Add the chosen authenticated transport for ChatGPT and
   Claude and exercise each available client path. Hosting/account access is a
   material deployment choice; an unauthenticated tunnel is not a shortcut.

The contract's one-agent/asset, four-recipient, one-lifetime-deposit limits are
explicit initial implementation choices. Completing a successful feasibility run
does not imply completion of the handover's owner application, recoverable runner,
Preprod release or live AI integrations.
