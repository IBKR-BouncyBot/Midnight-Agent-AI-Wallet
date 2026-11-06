# Browser proving with Lace

The public `testnet.html` flow uses the page and Lace to interact with real
Midnight Preview contracts. Visitors do not need a Node runner, Docker or a
separate proof-server process. The `browser.html` policy demonstration remains
an explicitly simulated learning mode. The [local Node runner](testnet-demo.md)
is a separate developer fallback with its own recorded settlement evidence.

## Start a browser session

1. Open the [public testnet page](https://ibkr-bouncybot.github.io/Midnight-Agent-AI-Wallet/testnet.html)
   in the browser where Lace is installed, with Midnight enabled and Preview
   selected. Lace 2.5.0's source includes internal WASM proving. In Midnight
   settings select **On this device → Run in this app (WASM)** and save the setting.
2. Confirm that selection on the page, choose Lace, and create a new vault
   session or unlock an existing one. Choose a separate vault-storage password
   of at least 16 characters. The page never asks for your Lace password or seed.
3. Fund the displayed Lace Preview address through the
   [Preview faucet](https://midnight-tmnight-preview.nethermind.dev/), then enable
   DUST generation in Lace. Complete the faucet verification yourself. NIGHT
   receipt alone does not mean DUST is ready for transaction fees.
4. Synchronize the independent merchant observer, then deploy and fund the
   test vault. Approve the setup transactions in Lace. The app deploys a test
   asset, removes the vault's maintenance authority before funding and verifies
   each finalized setup result.
5. Request a payment and approve its wallet/fee operation in Lace. Keep the page
   open while proofs and finality checks run. The app reports settlement only
   after matching successful finality, independent merchant receipt and the
   vault's generated commitments and qualified change.
6. Save an encrypted backup after setup and completed operations. Owner controls
   pause or revoke the agent and withdraw the remainder to the connected Lace
   account; they still require the app's private vault state and Lace approval.

The setting label is taken from the released
[Lace 2.5.0 English strings](https://github.com/input-output-hk/lace/blob/lace-extension%402.5.0/packages/contract/i18n/src/translations/en.json#L350).
Its [extension worker](https://github.com/input-output-hk/lace/blob/lace-extension%402.5.0/apps/lace-extension/src/offscreen/prover-worker.ts)
loads the real SDK WASM prover. The implementation is enabled for the browser
extension and offered as an explicit option; it is not a claim that every older
Lace installation, browser or device supports this flow. First use downloads
public proving material. Complex proofs can use substantial memory and take
time. Mobile support and a broad device compatibility matrix have not been
validated here.

## What the proving confirmation means

Lace's API4 `getConfiguration()` omits `proverServerUri` in both internal
`in-process` mode and remote `tee-delegated` mode. It exposes no separate mode
field. See the released
[configuration implementation](https://github.com/input-output-hk/lace/blob/lace-extension%402.5.0/packages/module/dapp-connector-midnight/src/store/dependencies/midnight-dapp-connector-api.ts#L415).
An absent URL is therefore insufficient to prove that wallet proving is local.

The page requires your explicit settings confirmation and reports
`modeAssurance: user-confirmed`, with `proverModeApiVerified: false`. It rejects
any reported prover URI, including localhost, and rechecks the network and
account around wallet operations. A disconnect, account change or network
change invalidates the session. A reported external prover clears confirmation.
An internal-to-TEE switch with no reported URL cannot be detected by this API;
keep **Run in this app (WASM)** selected throughout the session. The page does
not change Lace settings or silently select another proving service.

## Where keys, proofs and recovery state live

Lace retains its wallet signing keys and generates the wallet/DUST proofs. The
page receives public account identifiers and uses API4 balancing and submission.
Contract proofs run in a same-origin Web Worker using the pinned ZKIR WASM
implementation. Public circuit keys and proving parameters are downloaded;
contract witness preimages are not sent to a proof server.

The production build mirrors **17 public Midnight built-in circuit/SRS files**
from the SDK's configured artifact origin and verifies their pinned SHA-256
hashes. That origin lacks the CORS headers needed by this page, so production
serves those files from the site's own origin; it does not fetch them from S3
at runtime. The complete static build measured approximately **206.6 MB**.
Circuit material is requested when needed, rather than downloading the complete
site for every visit. The committed [artifact manifest](../scripts/browser-artifacts.json)
records the exact public source, file sizes and hashes.

The app's separate owner/agent contract secrets, private policy and coin openings,
merchant observer seed, signed transaction bytes and idempotency history live in
password-encrypted IndexedDB. WebCrypto uses PBKDF2-SHA256 and AES-GCM with public
network/account context authenticated as additional data. A Web Lock permits one
writer per stored identity. Strict IndexedDB transactions commit prepared
candidates and exact signed bytes before broadcast. The original contract
actions and coin effects are checked against Lace's balanced response before it
can be saved for submission.

The merchant observer is a separate browser SDK shielded wallet used to verify
receipt; it has no owner signing key or DUST wallet. This is still a single-device
research demonstration, not an independently hosted agent or audited wallet.
Private browser storage protects data at rest, not against malicious code running
in the same unlocked page or a compromised extension/device.

An encrypted backup contains the private application snapshot, including pending
transactions and candidate openings. Restore authenticates it before creating a
new store and refuses to overwrite an existing identity. Unlock using the same
Lace Preview account. Keep the password separately; neither the site nor the
Lace seed can reconstruct a lost app password or missing contract openings.
Origin-local storage can be removed by browser data clearing, private-browsing
cleanup or storage eviction. Moving between localhost and the published site
requires the encrypted backup, not a shared browser database.

Backup authentication does not prove freshness: an older valid backup may be
behind a submitted transaction or owner action. Restored state must reconcile
with the chain before spending. An uncertain outcome blocks new payments and
does not automatically regenerate or resend a transaction. A crash before saved
transaction identifiers, stale backups and some browser/OS termination cases
still need manual recovery; do not discard the saved state to force a retry.
Creating a store can also fail after its database schema exists but before its
first snapshot commits. The app refuses silent identity replacement in that
case.

## Verification boundary

An actual Chromium Web Worker ran the pinned ZKIR WASM implementation against a
synthetic `mint` fixture: constraint checking passed for **28 public inputs**,
and proving returned **4,501 bytes in 21,971 ms**. A wrong circuit key was
rejected. No proof server, wallet or network submission was used. The probe did
not independently verify the generated proof cryptographically or obtain chain
acceptance. [Measured browser proof](evidence/browser-proving.json).

Actual browser IndexedDB, WebCrypto and Web Locks also passed the storage probe:
exact integers/bytes reopened, a second writer and wrong password were rejected,
an aborted transaction rolled back, and encrypted backup restore preserved the
synthetic state. A valid older backup was accepted only into a fresh store,
demonstrating why authentication does not establish chain freshness. This was a
browser API exercise with synthetic data, not a process-kill, power-loss or
cross-origin migration test. [Measured browser storage](evidence/browser-storage.json).

The larger `pay` circuit also completed in the same real browser worker: 125
checked inputs and a 4,501-byte proof in 202,453 ms (about 3 minutes 22 seconds).
Its fixture uses deliberately public openings and a synthetic coin index; this
does not establish Zswap membership, wallet/DUST proving or settlement.
[Measured payment proof](evidence/browser-payment-proving.json).

The actual browser recipient observer connected to Preview and processed 2,409
events before the diagnostic stopped it. This checks SDK/network integration;
it does not establish full synchronization or a payment receipt.
[Measured observer connection](evidence/browser-observer.json).

`npm run test:browser` passed **56 tests**, with zero failures or skips. The suite
additionally covers account/network changes, proving
mode confirmation, substituted signed transactions, native serialization,
checkpoint ordering and encrypted recovery. Its wallet responses and some
IndexedDB events are controlled doubles; see the current counts in the
[verification record](verification.md).

The existing [public Preview payment](evidence/preview-payment.json) and
[owner/retry evidence](evidence/preview-runner.json) were produced by the Node
runner and local prover. They remain valid for that execution. They do not
establish that the new browser/Lace path has completed a real payment. Live Lace
approvals, its internal DUST proving, full browser settlement and actual browser
termination recovery must be measured separately. See the
[verification record](verification.md) for the previous network results.

## Build the static page locally

Developers need Node 24.18 or later in the Node 24 series and the pinned Compact
compiler. Install the compiler using [local setup](local-setup.md):
`bash scripts/install-compiler.sh` on Linux, or
`powershell -ExecutionPolicy Bypass -File scripts/install-compiler.ps1` on Windows.
From the repository directory:

```sh
npm ci --ignore-scripts
npm run compile
npm run build:web
npm run dev
```

Open `http://127.0.0.1:17640/`. Full compilation is required because
`compile:fast` omits proving keys. The build downloads and verifies public
artifacts when its local cache is missing, bundles the browser application and
WASM, and excludes local probe preimages from production. `npm run dev` serves
the built `dist/` directory, so rebuild after source changes. This development
static server is unrelated to a transaction runner or proof server.
