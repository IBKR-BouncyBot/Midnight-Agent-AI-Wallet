# Verification record — 6 November 2026

The confidential-custody milestone passed on an isolated **local** Midnight ledger, and the Node runner finalized a real public **Preview** payment with its merchant receipt and private vault change verified. The new browser path has separately produced actual WASM `mint` and `pay` proofs, passed an actual browser encrypted-storage probe, and connected its recipient observer to Preview. A complete browser/Lace payment remains untested. No Preprod/Mainnet deployment or live ChatGPT/Claude integration is claimed. The [acceptance matrix](acceptance-status.md) lists the remaining work.

## Distinct gates

| Gate | Measured result |
| --- | --- |
| Native compilation | Compact 0.31.1 generated contract JavaScript, ZKIR and full prover/verifier artifacts for all seven vault circuits and the test-token circuit. |
| Generated runtime / on-chain VM | The original local milestone passed 32 tests, including limits, authority, replay, stale-state rejection, actual transcript partitioning and maintenance signatures. |
| Protocol, storage and runner | The original local milestone passed 50 tests after candidate-binding and recovery-context review fixes. Mock adapter outcomes are explicitly test doubles. |
| Full unit/native command | Latest `npm test`: **155 passed**, zero failed/skipped. The earlier Preview/Node milestone passed 102; the original local milestone passed 82. |
| Browser automated suite | `npm run test:browser`: **56 passed**, zero failed/skipped. Controlled wallet/worker/storage doubles and native structural/constraint checks; not live Lace settlement. |
| Browser WASM proof | Actual Chromium Web Worker: synthetic `mint` constraint check passed, 28 public inputs, 4,501-byte proof in 21,971 ms; wrong key rejected. No proof server or network submission. [Measured result](evidence/browser-proving.json). |
| Browser payment circuit | Actual Chromium Web Worker: synthetic `pay` constraint check passed, 125 inputs, 4,501-byte proof in 202,453 ms; wrong key rejected. The fixture does not exercise actual Zswap membership or wallet/DUST proofs. [Measured result](evidence/browser-payment-proving.json). |
| Browser Preview observer | Actual SDK WebSocket connection processed 2,409 events before stopping; partial history only, no receipt or full-sync claim. [Measured result](evidence/browser-observer.json). |
| Browser encrypted storage | Actual Chromium IndexedDB/WebCrypto/Web Locks: reopen, writer exclusion, wrong password, strict commit/abort, tamper/context rejection and encrypted backup restore passed with synthetic state. [Measured result](evidence/browser-storage.json). |
| MCP subprocess | `node services/mcp/scripted-agent.mjs` passed its real stdio probe; payments unavailable, no model client or settlement exercised. |
| Upstream proof/network baseline | Real `storeMessage` call finalized `SucceedEntirely`; resulting public state independently queried. [Raw record](evidence/upstream-smoke.json). |
| Private vault proof/network | Funded, paid a separate merchant, rejected invalid qualification/overspend/replay, recovered change, and finalized owner withdrawal. All accepted transactions were `SucceedEntirely`. [Raw record](evidence/private-vault-local.json). |
| Staged durable runner/network | Real SDK adapter submitted once, simulated a lost response, reopened encrypted state, reconciled actual finality/receipt/change, and returned the original receipt on retry. [Raw record and source hashes](evidence/durable-vault-local.json). |
| Public Preview settlement | Real agent payment and owner withdrawal finalized; independent merchant and owner receipts account for the entire deposit. Retry, allowance rejection and pause enforcement also passed. A separate [public inspection](evidence/preview-payment.json) confirms the payment's successful finality, 4,508-byte proof and matching effects in one fallible segment. |
| Privacy | Inspected finalized transaction, serialized contract state and actual fallible public transcript for 11 sampled secrets/keys and amount encodings; samples absent. One contract input, one recipient output and one contract change output matched the same segment. |
| GitHub CI / publication | Commit `79b031d` passed [CI run 42258652447](https://github.com/IBKR-BouncyBot/Midnight-Agent-AI-Wallet/actions/runs/42258652447) and [Pages run 42258652640](https://github.com/IBKR-BouncyBot/Midnight-Agent-AI-Wallet/actions/runs/42258652640). These hosted results cover that commit, not subsequent changes or public payment execution. |

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

No credentials, private openings, wallet seeds or generated proving keys are included in the evidence files. Live AI clients, production recovery and Preprod remain unfinished.

## Two-mode app and public Preview integration

The original v0.2 app added a two-choice landing page, browser policy simulation
and a five-screen Preview interface backed by an authenticated local runner.
The primary testnet entry now targets browser contract proving and Lace wallet
operations; the earlier runner interface remains at `local.html`.
The shared Ballot Lab CSS and Outfit files retain their source licenses. The
README infographic was rendered and visually checked; its SVG contains outlined
Outfit letterforms and has an editable text source.

Browser checks exercised creation of a 100-unit practice vault with a 70-unit
allowance and 50-unit ceiling, a successful simulated 40-unit payment, a rejected
second 40-unit request with the balance unchanged, and owner pause rejection.
The landing page was checked at 390px width with stacked choices and no horizontal
overflow. A cramped panel heading found during mobile inspection was corrected.
These are JavaScript simulation checks, not Compact proofs or network payments.

The earlier frontend syntax, local links, element IDs and content-security-policy
checks passed. At that milestone **102 tests** passed, including HTTP
pairing/origin/host/input boundaries, encrypted identity restoration, manifest
migration and missing-file fail-closed behavior. Those results remain separate
from the new browser proof and storage measurements below.

The real Preview RPC identified itself as `Midnight Preview`. A fresh random
wallet was saved under AES-GCM with Windows current-user DPAPI key protection.
After the user requested faucet funds, a separate unshielded SDK observer
reported a fully synchronized balance of `10000000000` atomic NIGHT units and
two available coins at the same saved address. Reopening encrypted storage
preserved that identity. Subsequent DUST registration and contract setup enabled
the actual public payment recorded below; the faucet balance alone was never
treated as settlement evidence.

The [two-mode app](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/) was
published by successful Pages run 42258652640 for commit `79b031d`. The paired
Preview browser flow has not yet been exercised end to end. The successful live
payment below used the authenticated local bridge; it does not establish that
browser pairing or a real AI client has been tested. Use
[the local developer guide](testnet-demo.md) for that runner's setup and recovery
boundaries, or [browser proving](browser-proving.md) for the new Lace flow.

## Measured browser proving and storage

An actual Codex in-app Chromium browser on Windows ran the pinned ZKIR WASM
implementation in a Web Worker, using a loopback static asset host and a
synthetic `mint` preimage. The constraint check returned **28 public inputs**;
the proof measured **4,501 bytes**, with a recorded elapsed time of **21,971 ms**.
Its SHA-256 is
`c22e464cadac6056b22c4f72f44003d4bf937d56cc374a9ac9f4ea3922f88267`.
A wrong circuit key was rejected. The [record](evidence/browser-proving.json)
reports no proof-server use, wallet connection or network submission. The
standalone probe did not independently verify the proof cryptographically or
establish network acceptance. This measurement is for `mint`, not `pay` or
Lace's internal wallet/DUST proofs.

The separate [storage record](evidence/browser-storage.json) used actual browser
IndexedDB, WebCrypto and Web Locks with synthetic state. Exact bigint/byte state
reopened; a competing writer and a wrong password were rejected; a successful
request followed by an aborted transaction rolled back; encrypted backup restore
retained the saved state. Corrupt backups and wrong account context were rejected
before identity creation. An existing store was protected against an older
backup, while an authentic older backup could restore into a fresh store. This
last result demonstrates that backup authentication does not establish chain
freshness. The probe did not use a real wallet or submit a transaction, kill a
browser process, simulate power loss or migrate through a different origin's UI.

The production static build mirrors **17 hash-pinned public built-in circuit/SRS
files** from the SDK's configured artifact origin because that origin does not
provide the browser CORS access required here. Runtime proving fetches these
public files from the site's own origin, with no S3 runtime dependency. The
complete assembled site measured approximately **206.6 MB**; circuit keys and
parameters are requested on use. [Source hashes and sizes](../scripts/browser-artifacts.json)
and `browser-build.json` identify the mirrored artifacts. Production excludes
probe pages and synthetic witness-preimage files.

The public Preview RPC/indexer also accepted read-only HTTP preflight/query
requests and indexer GraphQL WebSocket handshakes with both the GitHub Pages and
localhost origins. This checks endpoint availability and CORS behavior; it does
not establish a browser wallet connection, proof or settlement. Full Lace
approval, internal fee proving, browser payment and actual termination recovery
remain separate validation steps.

## Demonstrated public Preview payment

The actual Preview runner reported the first agent payment as finalized, with
`recipientReceiptVerified: true` and `vaultChangeVerified: true`. These checks
wait for the independent merchant wallet's exact receipt and qualify the
contract's private change from the finalized transaction.

| Evidence | Value |
| --- | --- |
| Network | `preview` — public Midnight Preview |
| Vault | `cc892e0ad1479b18621ba172195df419c9ddabf146c1bfbf12586a871fc5a792` |
| Payment transaction | `007ce1b47a31b92f377673ca49709c635db02d0a61b394114b16b6763c3275dd1c` |
| Finalized block height | `1627157` |
| Finalized block hash | `63f63c884850a28579da12b38b4c50851dfa692a4d8ffe10d18493742f34a722` |

Before funding, maintenance removal finalized in block 1627137 as
`009c7faefd10181cd6e60e0b48db43932381e9d0b67c75aa88e12313331cf0553e`.
The service checked an empty maintenance committee with threshold one before
enabling the deposit, which finalized in block 1627145. The selected runner
record retains that sequence; the public payment exporter has a narrower scope.

| Funded | Merchant receipt / spent | Remaining private vault coin | Agent allowance | Per-payment ceiling |
| ---: | ---: | ---: | ---: | ---: |
| 100000000700 | 40000000280 | 60000000420 | 70000000490 | 50000000350 |

Amounts are atomic units of the custom test token. This table records the state
immediately after payment. The remaining private coin was subsequently withdrawn
to the owner as recorded below.

The separate [public Preview inspection](evidence/preview-payment.json) read the
actual accepted `SucceedEntirely` transaction, measured its 24,735 serialized
bytes and 4,508-byte contract proof, and matched the one vault input/nullifier,
recipient output and vault change output to its sole `pay` call in fallible
segment 63752. Its source hashes and exact verification boundary are retained.
The public-only exporter does not perform the private recipient-wallet receipt
check; that evidence comes from the live runner above. It also does not repeat
the local fixture's secret/amount literal scans or independently reverify the
proof locally.

A retry with the original idempotency key returned the same finalized payment
ID `81b40ef2-5c0e-423a-b137-7ca0c48d6aae` and transaction, with spent value
`40000000280` and remaining balance `60000000420` unchanged. A second request
for `40000000280` under a fresh key would exceed the `70000000490` cumulative
allowance; it was rejected without a transaction and left both values unchanged.
These are live bridge/gateway checks, not replay of a finalized proof on chain.

Owner pause finalized as transaction
`00ca95daaf7a069014d83d9356801e0c7871bd6ccca8f72d918f84fb18887a70b9`.
Its block was 1627196, hash
`9c74880764476c251d78a468648e0215f6dbe710bfbdd133c6020e85f8b735a3`.
The runner reported `paused: true` with the same spent and remaining values;
the independently synchronized merchant wallet still held `40000000280`.
A new request for 100 atomic units while paused was rejected, again without
changing those balances.

Owner withdrawal succeeded while the agent was paused, as transaction
`004918ae556a045d3c14d6a59a0970dd6cd2f0a6a6bd8341894d6a9dcaba0bf7cc`,
block 1627207, hash
`3130fc804bba8d7c7da9d73e3903db9f90a81f80c35dca651615e45a899f24e3`.
The service waited for the independent owner wallet's exact `60000000420`
receipt before reporting completion. The merchant retained `40000000280`; these
receipts sum to the original `100000000700` deposit. Final vault balance was zero,
spent remained `40000000280`, with `paused: true` and `revoked: false`. Selected live
receipts, retry/rejection results and public activity are retained in
[the runner evidence](evidence/preview-runner.json).

Public resume/revoke, process-kill/power-loss recovery, paired browser execution
and live ChatGPT/Claude clients remain untested.
