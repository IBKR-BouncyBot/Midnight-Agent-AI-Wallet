# Developer fallback: local Preview runner

The main [public testnet page](../web/testnet.html) now uses browser proving and
Lace; follow [browser setup](browser-proving.md) for that flow. This document
preserves the separate [local developer page](../web/local.html), which uses a
Node bridge and local proof server. That runner produced the recorded public
Preview payment and owner withdrawal. The policy simulation at `browser.html`
remains separate from both real-network paths.

## Prepare the local tools

Use Node 24.18 or later in the Node 24 series, the pinned dependencies and Compact
compiler, and a local proof server. The verified development host is Windows with
Ubuntu 24.04 under WSL2. See [local setup](local-setup.md) for compiler installation
and Docker requirements. From the repository directory in PowerShell:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run compile
npm.cmd run build:web
wsl -d Ubuntu-24.04 -- bash scripts/local-network.sh prover
npm.cmd run dev
```

Full compilation is required: `compile:fast` skips proving keys. The `prover`
command starts only this project's proof server on `127.0.0.1:16300`; Preview
uses the public RPC/indexer rather than a local node. It preserves other projects'
services and ports. Keep WSL/Docker running. If the local proof server is already
healthy, reuse it. Linux x86-64 uses the Linux compiler installer described in
local setup and ordinary `npm` commands.

`npm run dev` serves the generated `dist/` directory. Run `build:web` before
starting it, and rebuild after changing the frontend. The local developer
fallback remains at `local.html`; the public `testnet.html` entry uses Lace.

In a second terminal run:

```powershell
npm.cmd run demo:testnet
```

Open the private URL printed by the bridge. It points to
`http://127.0.0.1:17640/local.html` and pairs with the API at port `17641`. The page
removes the pairing fragment and keeps the credential in memory. Use this local
developer page for pairing; `testnet.html` uses Lace directly. Do not share the
pairing URL: it grants this demonstration's local owner controls.

Windows uses current-user DPAPI to protect the stored encryption key. On systems
without Windows key protection, set a strong `MIDNIGHT_DEMO_PASSWORD` in the
bridge's environment before its first run and preserve it separately. The bridge
never asks for a Lace seed or private key. It creates and reuses its own random
Preview wallets. The bridge password belongs only in the local environment, not
in a browser field or committed configuration file. It is unrelated to the
browser/Lace flow's separate vault-storage password. Neither flow requests a
Lace seed.

## Fund, prepare and pay

1. Connect and start synchronization. The owner funding address remains the same
   after a clean restart. The UI reports owner NIGHT/DUST and synchronization;
   the paired status API also includes separate shielded, unshielded and DUST
   progress counters for both wallets.
2. Send test NIGHT to the displayed unshielded `mn_addr_preview1…` address using
   the [official Preview faucet](https://midnight-tmnight-preview.nethermind.dev/)
   or an existing Preview wallet. Complete the faucet captcha yourself. Receiving
   NIGHT alone does not supply immediately usable DUST.
3. Register the eligible NIGHT for DUST using the page, then wait for enough DUST.
   Registration is a real signed network transaction. The button is disabled
   until wallet synchronization has completed.
4. Prepare the vault. The bridge deploys its own test token and contract, removes
   the contract's maintenance authority before funding, initializes the private
   policy, and deposits the test asset. Each stage waits for finalized success.
5. Request a payment. The amount is in this demonstration's test-token atomic
   units. The default `40000000280` is below the per-payment `50000000350` limit
   and lifetime `70000000490` allowance. Reusing an idempotency key repeats the
   recorded result; it does not authorize a second spend.
6. Inspect the actual finalized receipt and merchant balance. Owner controls can
   pause/resume, permanently revoke further agent payments, or withdraw the
   remaining test asset to the owner's shielded wallet.

Pending jobs, HTTP 202 responses, proof-provider counters and transaction IDs
alone are not successful payment receipts. The final receipt is shown only after
the exact transaction has finalized successfully, the recipient wallet observes
the balance, and the vault change output and generated commitments match. The
bridge does not use public local-chain genesis seeds on Preview.

After finality, a separate read-only helper can export public evidence without
opening a wallet store or receiving the pairing token:

```powershell
node scripts/export-preview-evidence.mjs <transaction-id> <contract-address>
```

Supply the actual 66-character transaction ID and 64-character vault address.
The helper queries only pinned Preview endpoints, reconstructs the actual native
transaction, checks its IDs/hash, successful finality, `pay` entry point, proof
bytes, matching shielded phase, and vault/recipient output effects. It prints
proof sizes and hashes rather than raw transaction or transcript data. This
public-only inspection cannot decrypt the merchant wallet's receipt; the paired
runner's independent receipt check remains separate. It trusts the official
RPC/indexer for chain observations and does not locally re-verify the proof.

## Restart and recovery

Type `stop` and press Enter in the bridge terminal for a clean shutdown. Ctrl+C
also requests shutdown in ordinary terminals, but some process supervisors kill
the child directly instead of delivering the signal. Encrypted SDK synchronization snapshots are saved
periodically and restored on restart; first synchronization can take longer than
subsequent starts. Reopen the newly printed pairing URL after restarting because
pairing credentials are ephemeral.

Fresh wallets replay the complete private ledger history. The service uses the
SDK's supported bounded event batching, not a fabricated birthday or skipped
cursor. Setup allows 30 minutes before reporting a synchronization timeout;
the running wallet streams and periodic encrypted checkpoints continue. A setup
retry resumes those streams rather than generating a new wallet.

Keep the entire `.local/demo-preview/` state directory private and back it up
together. It contains `key-protection.json`, the public identity manifest,
encrypted wallet identities/snapshots, private contract openings, the durable
runner, and the request journal. A wallet seed alone cannot reconstruct the
contract's private state. DPAPI-encrypted keys depend on the Windows account and
machine credentials; a copied directory is not a universally portable backup.

An uncertain submission blocks new spending. Use Reconcile to observe the saved
transaction; the bridge never automatically re-proves or re-submits it. A crash
before a transaction ID was saved can require manual operator recovery. Writer
locks are intentionally retained after an unclean stop and must not be removed
while the previous process may still be running. Missing identity files or a
missing previously initialized runner are errors, not permission to generate a
replacement wallet. Preserve all encrypted files when seeking recovery.

This is a dedicated single-owner testnet demonstration, not a production wallet
or hosted AI payment service. General backup rollback recovery and OS power-loss
testing remain pending. See the [bridge implementation notes](../services/demo/README.md)
and [Preview network setup](preview-setup.md) for the exact trust boundary.
