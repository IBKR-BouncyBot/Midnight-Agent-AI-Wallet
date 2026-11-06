# Handover acceptance status

Reviewed 6 November 2026 against the supplied *Midnight Agent AI Wallet Local
Codex Handover*. This is a coverage audit, not a certification. A passing unit or
generated-runtime test does not establish proof verification or settlement.
The [verification record](verification.md) records the final measured run and
public transaction references; this matrix also identifies evidence still needed
after a successful local custody flow.

## Measured evidence at this review

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

## Acceptance matrix

| Handover area | Demonstrated or implemented | Remaining evidence / implementation |
| --- | --- | --- |
| Native build | Pinned compiler generates real circuits and proving artifacts; generated runtime tests pass. | Run the checked-in workflow on GitHub; a workflow definition is not a hosted CI result. |
| Proof generation | Local prover/node accepted upstream, vault and staged-runner calls. Finalized agent-payment proofs measured at 4508 bytes. Prover-provider completions are recorded separately. | Deliberately tampered-proof rejection remains untested. |
| Settlement | Complete local flow passed: actual payment, independent merchant wallet receipt, private change qualification, reconstructed provider and owner withdrawal; exact asset/amount conservation checked. | Preprod is untested. The successful baseline directly uses SDK calls, not the new durable runner. |
| Spending limits | Native tests reject per-payment/cumulative excess, zero, insufficient coin value and overflow; exact allowance and uint64 boundaries pass. On the network-backed flow, the second excess payment failed before proof generation; chain commitment and merchant balance remained unchanged. | Pre-proof rejection is not a malicious-proof network test. |
| Recipient, asset, precision | Native tests reject unknown/zero recipient and wrong asset; schemas reject fractions, exponents, leading zeros and values beyond uint64. Independent merchant wallet observed the finalized exact test asset and amount. | Adversarial modifications of an already prepared transaction remain untested. |
| Owner/agent authority | Separate domain-separated credentials; native agent calls cannot fund, administer or withdraw. Changing fee-wallet identity grants no authority. Gateway scopes bind subject, network, deployment, vault and agent. | A real runner must provision separate credential contexts and preserve them across restart. Native tests do not establish a deployed authentication service. |
| Maintenance authority | Native ledger serialization/signature tests pass. The local bootstrap successfully replaced the committee with an empty list and threshold one, verified counter advancement from chain state, then removed its stored key before funding. | Every future deployment path must perform/verify the same unfunded bootstrap or explicitly declare its upgrade authority. Production migration/maintenance policy is not selected. |
| Expiry, pause, revocation | Native validity/expiry checks, permanent revoke, pause/resume and policy-version invalidation pass. Ledger ordering is specified; finalized payments cannot be undone. | Network inclusion race between a prepared payment and an owner action is untested. |
| Proof binding | Native circuit checks bind request network, vault, deployed address, version, asset, recipient, amount, validity, request ID and authenticated agent policy; tampered private openings fail. | Altered serialized proofs/transactions have not been submitted adversarially. Client-selected network labels alone are not ledger network identification. |
| Replay | Native duplicate request rejection survives policy replacement. Network-backed flow rejects the repeated request in generated code. Durable gateway idempotency and changed-payload conflict tests pass with a test backend. | Re-submission of an identical finalized proof and a real MCP retry need separate evidence. |
| Concurrency | Real on-chain VM rejects an independently prepared stale transcript after another payment advances the state. Gateway tests submit identical concurrent requests once. | Simultaneous, separately proven network submissions and crash/restart concurrency are untested. No claim of network-race verification. |
| Atomicity and phases | Real ledger partitioning places the entire payment program and coin effects in one fallible transcript; VM execution produces the same final state. Actual finalized payment inspection confirms all accounting and matched coin effects in segment 5991; mixed segments fail closed. | Deliberately failing a shielded transfer and confirming all allowance/request/coin effects roll back remains untested. See [phase details](contract-design.md#atomicity-and-transaction-phases). |
| Coin qualification/change | Funding/change commitment matching and real Merkle positions succeeded; change was later spent by owner after encrypted provider reconstruction. Impossible index failed with the real ledger's specific sparse-Merkle-tree error before proving, with unchanged chain commitment. No public amount map. | No general mixed-segment insertion-order resolver is claimed. Provider reconstruction in one process is not crash recovery. |
| Crash recovery | Encrypted journal/private snapshot and durable runner retain confirmed/candidate openings and exact signed bytes before submission. Real SDK test recovered an actual submitted payment after an injected lost response and encrypted store reopen, with one submission total. | No actual process termination before/after submission or during persistence, power loss, or operational recovery service has been exercised. |
| Backup | Authenticated export/import, wrong key/context/tamper rejection, exclusive writers and no-overwrite restore tests pass. Restore disables spending. | Restore against a current chain commitment and recover a pending finalized candidate in a fresh process. Stale backups may lack the needed opening; seed-only recovery is not supported. |
| Privacy | Public disclosure map documented. Actual finalized payment/state/transcript inspection finds 11 sampled secrets and tested amount encodings absent. Native storage/privacy tests and MCP allowlisted response projection pass. | Full runner/prover/indexer logs and eventual UI/HTTP responses still need review. Literal absence tests cannot establish anonymity or prevent threshold inference. Test-token mint amount is public. |
| Fee sponsorship | Native tests show the fee payer does not grant agent authority. | Separate sponsor funds fees and cannot alter/authorize payment: no end-to-end demonstration. Sponsorship is optional for initial custody. |
| MCP authentication | Fixed schemas, injected trusted authentication scope, expiry/cross-vault rejection, rate limits, receipt scoping and durable idempotency pass unit tests. Inspection stdio exposes only three agent tools and no owner tools. | Actual credentials/token validation, authenticated remote transport and live backend wiring are absent. Rate limits are process-local; deployment semantics must be defined. |
| AI interoperability | Provider-neutral direct interface, MCP inspection process and separately labelled ChatGPT/Claude connection documentation exist. | No signed-in ChatGPT, Claude Code/Desktop, consumer remote connector or model-provider API has exercised a payment. A scripted client is not a substitute. |
| Owner interface | Current Ballot Lab reference and source revision recorded in [design reference](design-reference.md). | Owner application is absent: setup/funding, agent policy, payment activity, pause/revoke/withdraw, backup/recovery and connection screens, plus mobile/keyboard/disconnected-state tests. |

## Repository and CI consistency

The README correctly describes a feasibility implementation and labels the
operational service, owner UI, remote MCP and AI-client testing unfinished. The
runner core and SDK staging now exist, but require the concrete trusted callbacks,
service lifecycle and network verification. Its immutable-rule
claim is conditional on the verified maintenance-removal bootstrap; the Compact
source alone does not remove the SDK's default upgrade key. The native tests
cover the authority encoding/signature; the independent network query supplies
the distinct on-chain evidence.

`.github/workflows/checks.yml` separates protocol/storage, native compilation and
runtime, and an opt-in full proof/local-settlement job. The full network job does
not substitute a fast build that omits proving keys. Hosted workflow results
must be checked separately for the exact commit; local results do not establish
them. Frontend publication, a type-check job and Preprod tests remain absent.
`npm test` includes the native tests and requires generated artifacts;
`test:unit` selects protocol, private-store and runner tests; CI additionally runs
the actual scripted MCP subprocess. The manual network job includes the baseline
and durable SDK scenarios.

## Smallest next implementation milestone

The custody flow now passes. The durable runner and staged SDK operations are
implemented and exercised with real local integration callbacks. Build an
operational service and general recovery verification before enabling payment
tools or implementing UI success states:

1. Integrate the proven wallet/providers and coin qualification with the staged
   adapter using fixed local endpoints and approved recipient key
   resolution. Keep owner and agent credentials separate. Serialize each vault's
   payment work without relying on this serialization for contract enforcement.
2. Verify the runner's encrypted request journal/private snapshot integration
   against actual chain observations. Persist confirmed **and** candidate openings, request binding,
   exact serialized transaction and transaction reference before submission.
   Reconcile finality, current commitments and coin qualification before choosing
   a state. An ambiguous result stays unresolved; never regenerate/resubmit a
   fresh payment merely because a timeout occurred.
3. Test process termination at preparation/submission/finality/persistence cut
   points, encrypted export/import, stale backup refusal and competing payments
   against the real local chain. Confirm one payment at most, correct balances,
   and a usable matching private opening after restart.
4. Wire this adapter behind the existing scoped gateway and a separately
   authenticated owner API. Test one scripted **real** MCP payment and receipt,
   duplicate/conflicting requests, expired credentials and cross-vault denial.
   Keep the inspection entry point distinct from the live path.
5. Build the owner UI against those real service states using the documented
   Ballot Lab design. Add the chosen authenticated transport for ChatGPT and
   Claude and exercise each available client path. Hosting/account access is a
   material deployment choice; an unauthenticated tunnel is not a shortcut.

The contract's one-agent/asset, four-recipient, one-lifetime-deposit limits are
explicit initial implementation choices. Completing a successful feasibility run
does not imply completion of the handover's owner application, recoverable runner,
Preprod release or live AI integrations.
