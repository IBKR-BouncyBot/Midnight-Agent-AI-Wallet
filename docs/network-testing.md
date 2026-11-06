# Local network verification

The network tests use real generated Compact artifacts, the HTTP prover, a Midnight node, an indexer and two independently synchronized SDK wallets. They are separate from `tests/native-vault.test.mjs`, which executes generated code without proving or settlement.

## Isolated services

`compose.yaml` uses project **midnight-agent-wallet-feasibility** and binds only to loopback:

| Component | Host endpoint | Image |
| --- | --- | --- |
| Prover | `http://127.0.0.1:16300` | `midnightntwrk/proof-server:8.1.3` |
| Indexer | `http://127.0.0.1:18088/api/v4/graphql` | `midnightntwrk/indexer-standalone:4.3.5` |
| Node | `ws://127.0.0.1:19944` | `midnightntwrk/midnight-node:1.0.400` |

These dedicated host ports leave existing Midnight services on standard ports untouched. Do not use global Docker or WSL stop/reset commands. Indexer4.3.5 is the available upstream local-example image, not a claim that the unpublished Preprod4.3.302 image exists.

From a Linux/WSL shell at the repository root:

```sh
bash scripts/local-network.sh up
```

The launcher uses the installed Docker Compose plugin, or the verified project-local `.tools/docker-compose` binary. Keep an ordinary WSL process/terminal running while testing; WSL service lifetime can otherwise end when no interactive process remains. The script's `stop` action targets only this compose project.

Compile with proving keys, then run sequentially using Node24:

```sh
npm run compile
node tests/network/upstream-smoke.mjs
node tests/network/private-vault.mjs
node tests/network/durable-vault.mjs
```

`compile:fast` omits proving keys and must not be used as a network preparation step. The tests reject a non-local `MIDNIGHT_NETWORK`. Public development genesis seeds are restricted to the hardcoded loopback configuration; never use them for real or public-network assets. The test token has no fiat value or redemption promise.

## What the harness measures

The upstream smoke test deploys the unchanged upstream `hello-world` contract, proves `storeMessage`, requires `SucceedEntirely` finality and reads the resulting message through the indexer. A generic deployment proof-provider invocation alone is not counted as a demonstrated contract proof.

The vault flow mints test assets, deploys the vault, disables its maintenance authority before funding, initializes a private policy and receives a fresh contract-owned coin. It derives the real coin Merkle position from the finalized transaction's `zswapStartIndex` plus the output position found by cryptographic commitment. It proves a permitted agent payment, checks the merchant wallet's resulting balance, qualifies private change and reconstructs the encrypted private-state provider. It attempts a cumulative overspend and replay, inspects public transaction/state disclosures, and withdraws the remaining change with separate owner authority.

The funding amount, permitted payment, ceiling and allowance use distinctive integer atomic values for binary disclosure checks. They are synthetic fixtures. Their explicit values are recorded in the test evidence, not in ordinary application responses.

The overspend/replay checks deliberately report **generated-contract rejection before proof generation**. The impossible-index check requires the real ledger's specific sparse-Merkle-index rejection while constructing the transaction against indexed chain state. They are not labeled malicious-proof acceptance tests. The privacy helper requires one contract call and its matching shielded input/output effects in the same single execution phase, then scans serialized payment/state and the public transcript for sampled secrets and numeric encodings. Ordinary SDK4.1.1 calls without a checkpoint use a fallible segment; complete-segment success is required before accounting is advanced. Mixed shielded segments are rejected by this qualification harness because their insertion-order mapping has not been verified. Literal absence does not prove anonymity or rule out timing, inference, alternative encodings or third-party indexer disclosure.

The durable variant uses the real staged SDK adapter and encrypted runner store for its agent payment. It verifies that the old confirmed state, exact generated candidate, signed transaction bytes and submission marker are persisted before the one real submission. It deliberately loses that submission response, closes and reopens the store, and requires real indexed finality, independent merchant receipt and qualified vault change before promoting the candidate. A repeated request must return the same final receipt without another preparation, proof or submission. Only the ledger-assigned coin index may differ from the persisted candidate.

This exercises store reconstruction after an ambiguous submission, not an OS process kill or power loss. Its trusted restore callback checks captured transition commitments and real coin membership; it is an integration fixture, not a general production verifier for arbitrary imported private openings. Production crash recovery, concurrent network submission, authenticated clients, Preprod settlement and live ChatGPT/Claude use require their own checks.

## Evidence and private test state

Each run creates an ignored `.local/network-*/verification.json` containing public transaction identifiers, final statuses, block heights and check results. New runs also hash the contract, generated payment verifier and relevant runner/test sources at startup. The nearby LevelDB and durable runner file contain encrypted test-only private openings; their random password/key is intentionally not retained as a production recovery mechanism. Never commit the database, raw witnesses, wallet keys or debug dumps. Copy only reviewed verification records to release evidence.

The network harness and compose configuration adapt Apache-2.0 upstream patterns from `midnightntwrk/midnight-examples` revision `c2f2fe2d4e4fd2008894430cb469d4759d66efe3`. See the repository's third-party notices and `licenses/Apache-2.0.txt`.
