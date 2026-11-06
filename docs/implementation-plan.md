# Implementation plan

The 6 November 2026 handover is the project brief. The repository was empty at inspection. Work is on `codex/private-vault-feasibility`.

1. Inspect the live Ballot Lab and source revision; verify available toolchain and infrastructure.
2. Compile a minimal real Compact vault with private coin openings and committed policy/state. Exercise generated runtime separately from proving and settlement.
3. Demonstrate funding, one authorized transfer, private change recovery, overspend rejection, and inspect actual public data on a local ledger-8 network. Only then proceed to Preprod.
4. Build encrypted runner persistence and reconciliation, preserving unresolved outcomes and durable idempotency.
5. Add provider-neutral scoped tools with explicit ChatGPT and Claude connection instructions.
6. Build the owner interface in the current Ballot Lab style after the custody path is demonstrated.
7. Run adversarial, privacy and recovery checks; prepare CI and factual verification records; push the feature branch when authenticated access works.

Initial engineering choices: one vault/agent/asset, integer atomic units, cumulative allowance and per-payment limit, local trusted prover, test funds only. The SDK creates a maintenance key at deployment; the local bootstrap disables that authority and verifies the impossible threshold on-chain before accepting deposits. Omitting this step retains upgrade authority. These are implementation defaults, not previously confirmed product choices. No mainnet use, remote tunnel, or production hosting is included.

Compilation, generated-runtime execution, ZK proving, local settlement, Preprod settlement, and live AI-client interoperability remain distinct evidence gates. Do not substitute browser simulation or public coin storage for confidential custody.

Completed in this pass: current design/source inspection; pinned native build; real local confidential custody, payment and change recovery; upgrade-authority removal; encrypted storage and staged runner with a real lost-response reconciliation test; scoped MCP inspection/protocol; tests, CI definition and factual verification records. The operational owner service/UI, complete crash recovery, authenticated live AI transport and Preprod remain the next work. See `acceptance-status.md` for each acceptance boundary.
