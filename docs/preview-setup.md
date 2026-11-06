# Preview test wallet setup

Checked on 6 November 2026. Preview is a public test network, separate from the
disposable local chain. Its current support matrix matches this repository:
Compact 0.31.1, runtime 0.16.0, Midnight.js 4.1.1, Wallet SDK 1.2.0, node 1.0.400,
indexer 4.3.5 and proof server 8.1.3. Do not upgrade to a ledger-9 compiler for
this demo. [Official compatibility matrix](https://docs.midnight.network/relnotes/support-matrix).

`services/runner/test-network-config.mjs` pins these server-owned endpoints:

| Service | Endpoint |
| --- | --- |
| Node | `https://rpc.preview.midnight.network` |
| Node subscription | `wss://rpc.preview.midnight.network` |
| Indexer | `https://indexer.preview.midnight.network/api/v4/graphql` |
| Indexer subscription | `wss://indexer.preview.midnight.network/api/v4/graphql/ws` |
| Private prover | `http://127.0.0.1:16300` by default, using this project's existing local prover |
| Faucet | <https://midnight-tmnight-preview.nethermind.dev/> |

Preview's public RPC/indexer need no API token. The config rejects remote proving;
witnesses stay on the local prover. `verifyPreviewNetwork` checked the actual RPC
identity as `Midnight Preview` at `2026-11-06T15:25:35.476Z`. This read-only check
is not wallet funding, contract deployment or payment evidence.
[Official network guide](https://docs.midnight.network/guides/networks-and-environments).

## Funding without importing a user's wallet secret

The demo's local service can create a random test-wallet seed once and retain it
in encrypted local storage. Reopening that storage must reuse the same seed and
wallet identity. Do not use a public genesis seed, generate a replacement on every
start, paste secrets into the browser or return secrets from a status endpoint.
Keep a protected backup of the encryption key and encrypted application state.
The wallet SDK can restore each sub-wallet's saved synchronization state; contract
openings and salts remain separate data that the chain cannot reconstruct.
[Official Node wallet guide](https://docs.midnight.network/guides/node-server-wallet).

The implemented demo keeps `demo.enc`, `key-protection.json`, and an
`identity-public.json` address binding in `.local/demo-preview/`. The public
manifest contains owner/merchant addresses only. Missing encrypted state or key
metadata causes a recovery error rather than a new wallet identity. Preserve the
runner/request stores alongside these files in any backup. Windows DPAPI wrapping
is tied to the current Windows user; copying its wrapped key alone is not a
portable recovery procedure. Non-Windows use requires the configured unlock
password. Neither option should be passed to the browser or model.

The owner funds the displayed **unshielded** address (`mn_addr_preview1…`) through
the official faucet, completing its captcha when requested. Shielded and DUST
addresses are unsuitable for the tNIGHT faucet. Receiving tNIGHT is only the first
step: eligible NIGHT must be registered for DUST generation, then the wallet must
observe enough DUST for deployment and transactions. In Lace, that operation is
labelled **Generate tDUST**. A Node wallet can perform the equivalent operation
with the installed wallet SDK. Only public receiving addresses need to be shared
with the faucet. [Official funding guide](https://docs.midnight.network/guides/acquire-tokens).

## Before accepting a vault deposit

Call the existing maintenance bootstrap with the explicit fourth argument
`{ networkId: 'preview' }`. It checks the SDK's selected network, requires the
vault to be unfunded, signs removal of the default upgrade authority, waits for
complete success, and independently checks the empty committee/threshold one
before deleting the local maintenance key. Mainnet is refused. Serialize setup
and enable funding only after this verification succeeds.

Persist deployment addresses, policy/coin openings, pending transaction bytes
and receipt state across restarts. A timeout is unresolved, and neither a public
RPC response nor an available wallet establishes that a payment finalized. Use
the reviewed network records for demonstrated flows and label the browser's
scripted demonstration separately from a live Preview payment.
