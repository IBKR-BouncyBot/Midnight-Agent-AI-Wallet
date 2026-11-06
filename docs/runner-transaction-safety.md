# Durable transaction stages

`services/runner/payment-runner.mjs` implements a single-vault backend for the protocol gateway. It integrates `PrivateStateStore` with durable request records, serialization of vault operations, proposal construction, proof/fee balancing, submission and reconciliation. `tests/runner.test.mjs` tests this integration using explicitly fake adapters. Those tests do not demonstrate Midnight proofs or settlement.

`services/runner/midnight-sdk-adapter.mjs` implements the SDK stages against the installed Midnight.js **4.1.1** and ledger **8.1.2** APIs. A trusted application must still supply payment construction, chain/private-state verification and independent receipt observation callbacks. The inspection MCP CLI is not connected to it.

## Why the SDK convenience submitter is not used

The installed `@midnight-ntwrk/midnight-js-contracts/dist/index.mjs` has `submitTxCore` calling `proofProvider.proveTx`, then `walletProvider.balanceTx`, then `midnightProvider.submitTx` without a durable persistence callback. `submitTx` then waits for `publicDataProvider.watchForTxData`. Its documentation explicitly warns that aborting may leave private state unsaved after a successful network transaction.

The staged adapter uses `createUnprovenCallTxFromInitialStates` and the actual returned `private.nextPrivateState` and `private.unprovenTx` fields. The public-state helper returns contract state, Zswap state and ledger parameters. The supplied payment builder may only construct the fixed `pay` circuit's arguments; the adapter fixes the deployed contract from authenticated scope.

The exact sequence is:

1. Reconcile confirmed private state against the configured deployment and chain.
2. Persist the request record while preserving all confirmed openings.
3. Construct the proposal, then persist the candidate openings and exact serialized unproven transaction under authenticated encryption.
4. Mark proving, call the real proof provider, and ask `walletProvider.balanceTx` to sign/balance/finalize. These stages must not submit anything.
5. Serialize the finalized transaction, verify a deserialize/serialize roundtrip, and persist those exact signed bytes, their SHA-256 integrity digest and all transaction identifiers.
6. Persist the `submitting` marker **before** calling the network submitter. Submit exactly those saved bytes; do not balance or prove again at this stage.
7. Preserve ambiguity on a lost response. Repeated requests and reopened runners only observe existing transaction identifiers; they never implicitly regenerate proofs or resubmit transactions.
8. Independently establish successful finality, recipient receipt and qualified vault change. Commit confirmed replacement openings and the finalized receipt together in one encrypted checkpoint.

The ledger API uses `Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytes)` for the unproven stage and `Transaction.deserialize('signature', 'proof', 'binding', bytes)` for signed final transactions. Its `identifiers()` values are tagged **33-byte / 66-hex-character** transaction identifiers. They are distinct from the 32-byte transaction hash and must not be truncated. Contract addresses and block hashes remain 64 hex characters. The installed ledger declaration documents that identifiers, rather than transaction hashes, should be used to watch transactions that may merge.

The unproven transaction contains private witnesses. It is serialized only for the encrypted private store, never to an API response, ordinary log or observability service. The prover is still trusted with those witnesses; proof generation is not a privacy boundary against the prover itself.

## Recovery and concurrency

The runner keeps one pending request per vault. Any unresolved request blocks new spending. A shared queue serializes even two runner objects that refer to the same open store; the store's exclusive filesystem lock prevents a second cooperating process from opening the same file. The store exposes a frozen public `deploymentContext` taken from its authenticated-encryption binding; the runner compares it with its configured deployment before reading recovery records or passing openings to an adapter, including the pending-request path. Owner administration must use the same serialized authority and reconcile any policy transition with in-flight requests before integrating a live service.

The runner also records the authenticated subject/network/contract/vault/agent scope, request fingerprint and idempotency key. The gateway's request journal remains a separate boundary. A completed runner receipt can reconcile a gateway journal write that was lost after chain finality. Backup restoration must preserve both histories and the relevant confirmed/candidate openings. Neither restoring a backup nor changing the client connection resets request identity.

The current core deliberately leaves a request unresolved after a crash even if the last recorded phase was `requested` or `prepared` and no transaction identifier was saved. A valid but stale backup could omit a later signed/submitted transaction. An unchanged current chain state alone does not prove that no transaction can still land. Owner recovery for that case remains unimplemented; a future recovery operation can require a finalized policy-version change/pause and chain reconciliation before deciding whether the old request is safely invalidated. Do not delete history, clear the pending record, or resubmit to make progress.

After submission, a rejection requires a matching finalized transaction reference, a block hash, an explicit no-payment-effect observation and independent reconciliation of the original vault state. Missing data, wrong deployment evidence, exceptions or unverified partial effects remain unresolved. A trusted adapter must inspect ledger segment behavior; `SucceedEntirely`, recipient verification and retained change must be established separately.

`ready` means the backend is configured and can answer reconciliation requests. `canSubmit` additionally reflects the private-state gate and absence of a pending request. This distinction lets the gateway report that new payments are unavailable while still checking the status of an ambiguous payment.

## Trusted callback contract and remaining integration

`buildPaymentCall` must resolve a preconfigured recipient alias to the actual approved coin public key and encryption key, bind the protocol amount/token to the Compact request, use the correct network/vault/contract/policy version, choose a unique request identifier, set chain-based validity bounds and fresh state randomness, and supply only the agent's allowed secret context. It must not accept model-generated endpoints or keys.

`captureCandidate` must save the generated `private.nextPrivateState` together with the expected public commitments/version obtained from `public.nextContractState`, preserving their correspondence to the exact native circuit result. A useful candidate envelope is `{ privateState, expectedStateCommitment, expectedPolicyCommitment, version }`; funded initial state must be captured from independently queried chain state. Do not replace this with handwritten commitment cryptography or merely assert that an arbitrary private snapshot matches.

`observeTransaction` must independently verify finality, the recipient's exact asset/amount and the vault change, then return qualified private state. The runner requires that this state exactly equal its saved native candidate, permitting only the ledger-assigned `coinIndex` to change (`privateState.coinIndex` for an envelope). It rejects substituted amounts, salts, openings, versions or commitments even if an adapter's verification callbacks return true. Refresh `nextStateSalt` only while preparing a later payment, never while reconciling a saved candidate.

The mandatory `verifyCoinQualification` callback independently verifies that permitted index update against the finalized output's commitment and actual indexed tree position. `verifyConfirmed` must compare private openings with current ledger commitments, policy version and maintenance authority. A production backup-restoration verifier must recompute openings using the pinned native contract's supported primitives; comparing an arbitrary stored expected commitment with chain state is not enough. The gateway and runner structurally validate the resulting scoped `settlementEvidence`; they do not turn a fabricated evidence object into a cryptographic proof.

All provider operations need appropriate bounded timeout/cancellation behavior in the eventual service. A proof timeout is supplied to the SDK adapter. Its observation callback must avoid an unbounded `watchForTxData` wait or accumulating abandoned subscriptions. The SDK's global network ID must stay fixed for the lifetime of a runner; use one network per process.

The tests cover simulated interruptions after six durable stages, failure before signed-byte persistence, submission timeouts, repeated/altered requests, conflicting requests, scope/deployment mismatches before callbacks receive openings, candidate substitution, invalid coin qualification, incorrect evidence and the gateway/journal/runner composition. These are process/restart logic tests on a local filesystem, not actual process-termination or power-loss tests. A live staged adapter test must be reported separately from this unit evidence. A finalized historical payment followed by an owner policy/state change can require additional reconciliation; current-state mismatch must not be solved by discarding candidate openings or fabricating a finalized receipt.
