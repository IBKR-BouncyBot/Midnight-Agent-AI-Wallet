# Private vault technical milestone

The initial contract is one vault per deployment, one agent policy, one shielded
test asset and one lifetime funding coin. A policy has four recipient slots,
integer atomic-unit limits, a cumulative allowance and an expiry. Empty recipient
slots are zero and cannot receive payments. All monetary policy fields and
payments are bounded to `Uint<64>`; underlying shielded coin values are `Uint<128>`
but funding rejects values outside the smaller application range.

These are implementation choices for the feasibility milestone, not a claim
that the finished owner application or production recovery system exists. Top-ups,
multiple agents, recurring allowance resets, asset changes, and upgrades are
outside this contract's implemented scope.

## Maintenance authority

The SDK's ordinary deployment creates an additional maintenance signing key
that can replace verifier keys and therefore bypass application rules. It is
distinct from the owner secret checked by the Compact contract. Until removed,
that key is a material trust boundary; `sealed` application fields alone do not
make a deployment immutable.

The local test bootstrap calls `disableMaintenanceBeforeFunding` before policy
initialization or deposits. It signs a ledger-native authority replacement with
an empty committee and threshold one, waits for successful settlement, and
independently checks the on-chain authority and incremented counter before
deleting the old signing key. Ledger 8 explicitly defines a threshold exceeding
committee size as impossible to authorize. Native tests verify actual authority
serialization and the replacement signature. Network confirmation is recorded
separately in the network verification record; it must not be inferred from
these native tests.

There is a temporary deployer maintenance authority between deployment and
removal, while the vault is unfunded. The helper refuses a funded vault and is
restricted to the disposable local network. Production maintenance and migration
policy require a separate decision. The SDK method
`submitReplaceAuthorityTx(undefined)` is deliberately not used: in 4.1.1 it
generates a fresh authority instead of removing one.

## Custody and authorization

`fund` calls the real standard-library `receiveShielded`. The owner wallet must
balance a new shielded output owned by the contract. The trusted runner generates
a fresh coin nonce; it must not copy an existing wallet coin's nonce. Only a
salted commitment to the coin and spending state is written to contract storage.

`pay` authenticates knowledge of a distinct agent secret, reopens the policy and
current state commitments, validates the request, and calls `sendShielded` on the
qualified contract-owned coin. It commits the resulting change coin and the
updated cumulative spending total. The standard library returns change to the
current contract, so neither the agent nor the transaction fee payer selects its
destination. The payment is not a server-issued approval followed by an
unrestricted wallet transfer.

Owner authorization is a separate domain-separated secret hash. Possession of a
wallet address, an owner/agent field supplied by a client, or fee-payer authority
grants no contract authority. Owner and agent credentials must be distinct,
random 32-byte secrets and kept in separate runner credential contexts. The
test harness holds both for setup only. The owner can pause/resume, permanently
revoke, replace policy, or withdraw the entire remaining coin to an owner-chosen
recipient. Revocation does not prevent owner withdrawal and cannot be undone.

The owner policy can change the agent, recipient list, ceiling, allowance and
expiry. It cannot change the asset or reset the spent amount. An allowance below
the amount already spent is rejected. Every administrative change advances the
public version, invalidating requests prepared for the earlier version. After
depletion or withdrawal, funding is still disabled: refilling cannot reset
accounting. Deploy another vault for another funded test allowance.

## Binding, replay and concurrency

Each payment carries the configured network label, vault ID, actual contract
address, expected policy version, random request ID, asset, recipient, amount,
and validity window. Commitments include purpose, network, vault and contract.
The deployment's random vault ID scopes the owner key before a contract address
exists. Reusing owner secrets and vault IDs across deployments is forbidden by
runner provisioning. A contract cannot identify a network by an arbitrary label
alone; the client must additionally select the correct ledger network and bind
its transaction through the SDK.

A public set of domain-separated request hashes prevents reuse of a request ID
across policy versions. The gateway must enforce payload equality for repeated
idempotency keys before reaching the contract. Reading the current state
commitment into the transcript prevents two independently prepared payments from
both applying to an old allowance. Native tests execute the actual on-chain VM
transcript verifier: both prepared transcripts are valid at their original state,
and the competing one fails a read check after the first spend advances state.
This is separate from proof verification and network concurrency testing.

## Coin qualification and persistence

A committed coin consists of nonce, asset and value. Its `mt_index` is deliberately
excluded: the ledger assigns the position when the funding/change transaction
lands. The runner must locate the matching contract-owned output commitment in a
finalized transaction and derive its position from the transaction's
`zswapStartIndex`, accounting for preceding wallet change outputs. It then supplies
the qualified coin to the next circuit. The Zswap proof checks membership; the
Compact runtime alone does not verify this index.

`rememberState` captures the next opening and invalidates the index until it is
qualified. The old and proposed state must both be durably encrypted before
submission. A timeout is unresolved; do not replace the current opening or retry
a fresh payment until the ledger verdict has been reconciled. Restore must match
the on-chain commitment and qualify the coin before spending. A wallet seed alone
does not recover policy salts or application coin openings.

## Atomicity and transaction phases

The circuits contain no checkpoint. This does **not** force guaranteed execution:
the real ledger partitioner places the payment's full transcript in one fallible
segment. A native test executes `partitionTranscripts`, checks that the complete
program and all coin effects stay together, and executes that transcript through
the real ledger VM to recover the generated final state. Midnight.js 4.1.1 routes
shielded offers from the transcript's claimed nullifiers and commitments and
randomizes the physical fallible segment ID. The local funding transaction has
also demonstrated this fallible placement.

The network inspector requires a sole payment transcript and sole shielded offer
in the same phase and, when fallible, the same physical segment. It checks the
input nullifier, recipient/change commitments and change receipt against that
transcript. Any split fails the milestone check. Only `SucceedEntirely` is accepted
as successful settlement. The native partition/VM test and a successful payment
do not demonstrate rollback of an intentionally failed shielded transfer or a
network race; those adversarial checks remain separate acceptance requirements.

## Disclosure map

| Surface | Observable data |
| --- | --- |
| Public ledger | Network label, random vault ID, owner hash, initialized/funded/pause/revoke flags, administrative version, policy commitment, state commitment, hashed random request IDs |
| Public transcript/effects | Reads/writes of those fields; shielded commitments and nullifiers; this contract's address; the request's validity bounds |
| Transaction metadata | Circuit called, timing, fees, number of inputs/outputs, contract participation; whether change is produced |
| Private policy | Agent authorization hash, asset, four recipients, limits, cumulative allowance, policy expiry, policy salt |
| Private spending state | Coin nonce/value/asset, accumulated spend, sequence, state salt; required finalized coin position |
| Trusted runner/prover | All witnesses, requested payment and proof preimages; proving is local or explicitly trusted |
| Agent response | Only its scoped request status and minimal receipt; no openings, policy limits or owner secrets |
| Recipient | Its payment, plus ordinary metadata visible through its wallet |

Only the request validity window crosses the time-check boundary. The circuit
privately proves that its end is within the policy expiry. Repeated requests and
generic acceptance/rejection can still reveal thresholds; gateway rate limits and
minimal errors reduce but do not eliminate this inference. The native privacy
test scans generated public ledger data and the public transcript for secret
openings, recipient/asset keys and distinctive encoded amounts. It does not claim
that every eventual network representation or log has been audited.

## Pinned reference evidence

- Official private escrow pattern and qualification helper: `midnight-examples`
  commit `c2f2fe2d4e4fd2008894430cb469d4759d66efe3`,
  `examples/shielded-chips/contract/roulette.compact` and
  `examples/shielded-chips/ui/src/midnight/shielded-chips-api.ts`.
  [Pinned contract source](https://github.com/midnightntwrk/midnight-examples/blob/c2f2fe2d4e4fd2008894430cb469d4759d66efe3/examples/shielded-chips/contract/roulette.compact).
- [Compact 0.31.1 standard library](https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.31.1/compiler/standard-library.compact):
  contract-owned nullifiers, deterministic payout/change nonces and change custody.
- [Midnight.js 4.1.1 Zswap helper](https://github.com/midnightntwrk/midnight-js/blob/v4.1.1/packages/contracts/src/utils/zswap-utils.ts):
  qualified contract input construction, segment routing, and recipient encryption
  key resolution. Supply `additionalCoinEncPublicKeyMappings` for a recipient
  other than the submitting wallet; a coin key alone is insufficient for wallet
  discovery.
- [Transaction semantics](https://docs.midnight.network/concepts/how-midnight-works/semantics):
  guaranteed/fallible phases and validation of claimed coin effects.

The public tip-jar coin map is not used. Its deliberately public amounts do not
meet this wallet's confidentiality requirement.
