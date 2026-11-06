# Midnight Agent AI Wallet

A confidential, contract-controlled allowance for an AI agent on Midnight. The agent proposes a payment through a provider-neutral API; Compact checks authority, recipient, asset, expiry, per-payment limit and cumulative allowance before moving the vault's shielded coins.

![How Midnight Agent AI Wallet works: the owner sets private limits, the agent requests a payment, and the vault checks the rules before a verified network receipt.](docs/images/wallet-explainer.svg)

## Choose your demo

### [Open the app →](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/)

| Mode | What you can try | What you need |
| --- | --- | --- |
| [**Browser demo**](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/browser.html) | Set an allowance, request payments, inspect rejections, and try the owner controls. Balances and receipts are explicitly simulated. | A browser. No wallet, tokens or network transaction. |
| [**Public testnet demo**](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/testnet.html) | Use an encrypted local runner, a real Compact vault, proofs and transactions on Midnight **Preview**. | Node 24, compiled contracts, a local proof server, free Preview test NIGHT and usable DUST. |

```sh
npm ci --ignore-scripts
npm run dev
# Open http://127.0.0.1:17640/
```

The public-testnet page connects to the runner on your own computer. It never asks you to paste a wallet seed. The runner uses its own fresh test wallets and keeps their state locally; the static website does not hold keys or run a prover. Preview funding is a separate step through the official faucet. See [testnet setup](docs/testnet-demo.md).

**Verified on public Preview:** a real vault payment finalized in block **1627157**, with an independently synchronized merchant receipt and verified vault change. The [public transaction evidence](docs/evidence/preview-payment.json) records the actual 4,508-byte contract proof and matching ledger effects.

Read [the verification record](docs/verification.md) for measured results and remaining work. Browser simulation, native execution, proof generation, local settlement and public Preview settlement are separate checks. A working connection is not a settled payment.

## Included

- Compact private vault, test-token faucet and upstream environment smoke contract.
- Private policy/state commitments, separate owner/agent authority, pause/revoke, accounting-preserving policy replacement and owner withdrawal.
- Native tests for limits, privacy, replay and competing-state rejection.
- Local ledger/prover/indexer harness with independently observed recipient balances, private coin qualification and change recovery.
- Encrypted private snapshots, request journal and staged transaction runner; scoped provider-neutral payment schemas and an inspection-only MCP stdio endpoint.
- Current ChatGPT and Claude connection guidance, exact toolchain pins, CI and recovery documentation.
- Browser policy demo and a public Preview transaction demo.

The executable MCP endpoint is currently inspection-only. Authenticated remote MCP, Preprod validation and live ChatGPT/Claude payment tests remain development work. The app's agent request screen lets you exercise the payment boundary; it is not a connected AI model. No mainnet funds are used.

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

The deployment flow disables the SDK-generated maintenance authority before funding and verifies the ledger result. Owner policy administration remains part of the immutable circuit rules. Any deployment path that omits the maintenance step retains a key able to replace those rules; it must not be advertised as immutable.

The runner and local prover see witnesses. Chain observers can see contract calls, timing, commitments, nullifiers, administrative flags and request validity windows. The model sees the payment it proposes. Recovery requires application-specific private openings as well as wallet material.

- [Contract and disclosure specification](docs/contract-design.md)
- [Private recovery and durability](docs/recovery.md)
- [Runner transaction safety](docs/runner-transaction-safety.md)
- [Full handover acceptance status](docs/acceptance-status.md)
- [MCP boundary](services/mcp/README.md)
- [ChatGPT and Claude integration paths](docs/ai-connections.md)
- [Implementation plan](docs/implementation-plan.md)
- [Dependency review](docs/dependencies.md)

See [third-party notices](THIRD_PARTY_NOTICES.md) for upstream licenses.

## Buy me a coffee

If this wallet lab has been useful, you can support IBKR-BouncyBot with a little **NIGHT or ADA on Cardano mainnet**. Tips are optional; the demo is free to use.

Scan the QR code or copy the address below. The [front-page support section](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/#support) also has a copy button.

<img src="web/assets/support-ada-qr.svg" width="220" height="220" alt="QR code for the Cardano mainnet NIGHT or ADA support address">

```text
addr1q85w2v474ywzx868s69pghygek3vrhxm69e7c6ysuf28qhv8kmj5wd059grxl82f8h5mtyzl87cvqj8ldv2e0las7tnsdej9ax
```

Thank you for supporting development.
