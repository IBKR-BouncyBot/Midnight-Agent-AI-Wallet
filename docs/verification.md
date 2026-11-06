# Verification record — 6 November 2026

The confidential-custody milestone passed on an isolated **local** Midnight ledger. No Preprod/Mainnet deployment, owner web application or live ChatGPT/Claude integration is claimed. The [acceptance matrix](acceptance-status.md) lists the remaining work.

## Distinct gates

| Gate | Measured result |
| --- | --- |
| Native compilation | Compact 0.31.1 generated contract JavaScript, ZKIR and full prover/verifier artifacts for all seven vault circuits and the test-token circuit. |
| Generated runtime / on-chain VM | 32 tests passed, including limits, authority, replay, stale-state rejection, actual transcript partitioning and maintenance signatures. |
| Protocol, storage and runner | 50 tests passed after candidate-binding and recovery-context review fixes. Mock adapter outcomes are explicitly test doubles. |
| Full local unit/native command | Final `npm test`: 82 passed, zero failed/skipped. |
| MCP subprocess | `node services/mcp/scripted-agent.mjs` passed its real stdio probe; payments unavailable, no model client or settlement exercised. |
| Upstream proof/network baseline | Real `storeMessage` call finalized `SucceedEntirely`; resulting public state independently queried. [Raw record](evidence/upstream-smoke.json). |
| Private vault proof/network | Funded, paid a separate merchant, rejected invalid qualification/overspend/replay, recovered change, and finalized owner withdrawal. All accepted transactions were `SucceedEntirely`. [Raw record](evidence/private-vault-local.json). |
| Staged durable runner/network | Real SDK adapter submitted once, simulated a lost response, reopened encrypted state, reconciled actual finality/receipt/change, and returned the original receipt on retry. [Raw record and source hashes](evidence/durable-vault-local.json). |
| Privacy | Inspected finalized transaction, serialized contract state and actual fallible public transcript for 11 sampled secrets/keys and amount encodings; samples absent. One contract input, one recipient output and one contract change output matched the same segment. |
| GitHub CI / publication | Workflow is configured separately from local evidence. See release summary for actual hosted run status. No frontend publication is configured. |

The proof-provider counter includes deployment and maintenance operations; it is **not** a count of eight independent vault ZK proofs. A [separate read-only inspection](evidence/payment-proof-inspection.json) of the accepted payment found a nonempty **4,508-byte contract proof**. The node's acceptance of that call is distinct from compiler key generation or runtime execution.

## Demonstrated local payment

Network ID: `undeployed`. Docker project: `midnight-agent-wallet-feasibility`, dedicated loopback ports 16300/18088/19944. The other chat's project and existing shared containers were preserved.

Vault: `47b89d9b524980b0161c62f9edd84a4b8f71f85b6e19eaaa09f2dfa0a4ad246d`

| Operation | Evidence |
| --- | --- |
| Disable upgrade authority | `009ecad3b53e6ab2fc82d1ec171a1325a8710183630ea0a57c270a3fc66f3f9c4a`, block 86. Empty committee, threshold 1 independently read before funding. |
| Fund vault | `001e87aa744f12dfeafb3138aea954cca9836af4e5721e87e5b459e2762f8bb3df`, block 93. |
| Agent payment | `00bcefcb70a1af84b8185d15cd27f1eef3c8adce54095a5f7077ac1acac83d7224`, block 98. |
| Payment block hash | `076266d1b709ead4e582d41eda21f0d98e5062da15d30ff3d6beb7b84106a6f2`. |
| Owner withdraws change | `000adb2ad4c2ba4ec4111e5fc50e2c188ec787a1d0415c4db4b999262c2d7caf5d`, block 102. |

All amounts are atomic units of a custom faucet **test token**, with no fiat value or redemption claim:

| Funded | Paid to merchant | Returned to owner | Agent allowance | Per-payment ceiling |
| ---: | ---: | ---: | ---: | ---: |
| 100000000700 | 40000000280 | 60000000420 | 70000000490 | 50000000350 |

The merchant's independent wallet observed the payment. The runner reconstructed its encrypted provider, qualified the private change coin from the indexed transaction, and the owner recovered that entire change. Merchant plus owner balances equal the original funded amount. The test restored provider state in the same process; it is not evidence of recovery after killing a process during submission.

A second equal payment exceeds the remaining allowance and was rejected by the generated contract **before proof generation**, leaving the commitment and merchant balance unchanged. Replay was also rejected before proving. An impossible coin index was rejected by the actual ledger's spend-proof construction. These results do not claim that malformed proofs were accepted for on-chain adversarial validation.

## Phase and privacy findings

The SDK placed the entire payment call in fallible segment `5991`, with its accounting update and all shielded effects in that same segment. The network inspector verifies the matching contract input/nullifier, recipient output, contract change commitment and receive claim. Native tests independently run the real ledger partitioner and VM. A deliberately failing transfer followed by a ledger rollback audit remains untested.

The raw successful baseline record contains one stale human-readable phrase, “guaranteed transcript,” from the script loaded before the label was corrected. Its structured `privacy.phase` is `fallible`, and `inspectedSurfaces` correctly identifies the fallible transcript. The record is retained unchanged; the source and this explanation describe the actual observation.

Literal scans are bounded disclosure tests. They do not establish anonymity or absence of timing, amount inference, other encodings, fee linkage, or information seen by the trusted local prover. The faucet mint amount and these deliberately published test-fixture values are public.

## Durable adapter result

The final code was also tested through the staged SDK adapter, using a new local vault `8a0b502b8c0fe2467563b1761a45494e39dd7a3613c6c313e8d2565438ca22b3` and the same test amounts. Payment `0048b39197c561107b1fda7afc34556cafa1243439ba08f9f8f64953fcab45c35a` finalized at block 186, hash `b453b46bd75fad39bc40bf242bea4db8b49452200a24ae69dd650d4facbc0408`. Its contract proof is 4,508 bytes, with accounting and transfers together in fallible segment 39526. Owner withdrawal finalized at block 190.

Before submission, the harness verified that confirmed and candidate openings, exact signed transaction bytes, their digest and identifiers, and the `submitting` marker were already stored. It submitted the transaction to the real node, then deliberately threw away the response. The runner reported `unresolved`. After closing and reopening its encrypted store, it recovered finality, merchant receipt and qualified change from real network evidence. A repeat returned the same finalized receipt. Instrumented counts were exactly one preparation, one proof/balance, one submission and one observation.

This is an injected lost-response and same-process store-reopen test, not an OS process-kill or power-loss test. The application callbacks are local integration fixtures, not a general production verifier for arbitrary restored openings. All eleven recorded source/artifact SHA-256 hashes were checked against the final files and matched. The full structured evidence is retained in [durable-vault-local.json](evidence/durable-vault-local.json).

## Versions and reproducibility

Measured host: Node 24.18.0, npm 11.16.0, Ubuntu 24.04 under WSL2, Docker Engine 29.1.3, standalone Compose 5.7.0. Midnight pins and installation checksums are documented in [local setup](local-setup.md) and the lockfile. Official example source inspected at `c2f2fe2d4e4fd2008894430cb469d4759d66efe3`; design reference at `d22ce6171b5548f70b8360f12709562e9e8051fa`.

Source SHA-256 at the successful custody run:

| Contract | SHA-256 |
| --- | --- |
| `private-vault.compact` | `81ee40325fb6cfd6493a19107d86d12d05b5f4f311a8d0b25acccff4afdaf726` |
| `test-token.compact` | `1f75c30e43e34cf9ae22ab6073a3e48d9e7e1266fbf229728f6d4f13f030948a` |
| `upstream-hello.compact` | `2c34b2ad889499e8ff7b1018727b131885cdb597da04fd02b4926256046737f0` |

Initial setup failures were investigated rather than counted as passes: the compiler installer/wrapper mishandled spaces; a fast compile removed proving keys; shared/short-lived services interrupted early runs; and the inherited coin-qualification assumption searched only guaranteed outputs. Project-local tools, isolated services and a fail-closed single-segment resolver addressed these issues. The first funded test vault was left with disposable test assets when its ephemeral harness state was discarded; that failed run does not demonstrate recovery.

No credentials, private openings, wallet seeds or generated proving keys are included in the evidence files. Application development, live AI clients, owner UI, production recovery and Preprod are unfinished.
