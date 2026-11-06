# Midnight Agent AI Wallet

A confidential, contract-controlled allowance for an AI agent on Midnight. The agent proposes a payment through a provider-neutral API; Compact checks authority, recipient, asset, expiry, per-payment limit and cumulative allowance before moving the vault's shielded coins.

This repository currently contains the **local feasibility implementation**. Read [the verification record](docs/verification.md) for measured results and remaining work. Compilation, native execution, actual proofs, local settlement and Preprod settlement are separate checks.

## Included

- Compact private vault, test-token faucet and upstream environment smoke contract.
- Private policy/state commitments, separate owner/agent authority, pause/revoke, accounting-preserving policy replacement and owner withdrawal.
- Native tests for limits, privacy, replay and competing-state rejection.
- Local ledger/prover/indexer harness with independently observed recipient balances, private coin qualification and change recovery.
- Encrypted private snapshots, request journal and staged transaction runner; scoped provider-neutral payment schemas and an inspection-only MCP stdio endpoint.
- Current ChatGPT and Claude connection guidance, exact toolchain pins, CI and recovery documentation.

The executable MCP endpoint is currently inspection-only. An operational local service with owner web interface, authenticated remote MCP endpoint, Preprod validation and live ChatGPT/Claude payment tests remain development work. The runner library requires deployment-specific chain and recipient observers before it can serve payments. No browser demonstration is represented as a settled payment. No mainnet funds are used.

## Run

Node 24.18.0, Ubuntu 24.04/WSL2 and Docker are the tested environment. See [local setup](docs/local-setup.md) for installation, checksums and isolated network ports.

```sh
npm ci --ignore-scripts
# Linux: bash scripts/install-compiler.sh
# Windows: powershell -ExecutionPolicy Bypass -File scripts/install-compiler.ps1
npm run compile
npm test
node services/mcp/scripted-agent.mjs
```

Start the isolated network with `scripts/local-network.sh up`, then run:

```sh
node tests/network/upstream-smoke.mjs
node tests/network/private-vault.mjs
node tests/network/durable-vault.mjs
```

Generated keys go in `contracts/managed/`; local private state goes in `.local/`. Both are ignored. Never use the public development genesis seeds on a public network.

## Design and trust

One deployed vault currently supports one agent, one asset, four recipient slots and one lifetime deposit. Monetary values are decimal atomic units bounded to uint64. There are no currency conversion, recurring reset or top-up semantics. The owner chooses policy; the agent never receives owner wallet credentials.

The local deployment test disables the SDK-generated maintenance authority before funding and verifies the ledger result. Owner policy administration remains part of the immutable circuit rules. Any deployment path that omits the maintenance step retains a key able to replace those rules; it must not be advertised as immutable.

The runner and local prover see witnesses. Chain observers can see contract calls, timing, commitments, nullifiers, administrative flags and request validity windows. The model sees the payment it proposes. Recovery requires application-specific private openings as well as wallet material.

- [Contract and disclosure specification](docs/contract-design.md)
- [Private recovery and durability](docs/recovery.md)
- [Runner transaction safety](docs/runner-transaction-safety.md)
- [Full handover acceptance status](docs/acceptance-status.md)
- [MCP boundary](services/mcp/README.md)
- [ChatGPT and Claude integration paths](docs/ai-connections.md)
- [Current Ballot Lab visual reference](docs/design-reference.md)
- [Implementation plan](docs/implementation-plan.md)
- [Dependency review](docs/dependencies.md)

CI defines independent protocol/storage, native-runtime, and manually selected local proof/settlement jobs. Frontend publication is not configured. See [third-party notices](THIRD_PARTY_NOTICES.md) for upstream licenses.
