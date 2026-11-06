# Local Preview bridge

This server connects the repository's testnet page to a local, dedicated Preview
wallet. The separate browser demonstration does not call this server. There is
no hosted signing service, mainnet mode, or AI-accessible owner endpoint.

Run `npm run demo:testnet` and `npm run dev` in separate terminals. Open the
private launch URL printed by the bridge. Its fragment contains a short-lived
pairing token; the page clears the fragment and retains the token only in memory.
Keep the bridge terminal open. The API listens only on `127.0.0.1:17641`, checks
the exact Host and browser Origin, and requires bearer pairing for every state
or action endpoint. Pairing grants local owner controls: do not share the launch
URL or expose this port through a tunnel. Type `stop` and press Enter in the
bridge terminal to save state, release writer locks and shut down cleanly.

The local UI starts wallet synchronization, displays the saved public funding
address, registers received test NIGHT for DUST, and waits for available DUST.
The owner then prepares a vault. Preparation deploys a test token, mints its
private test balance, deploys the vault, permanently removes its maintenance
authority while still unfunded, initializes policy, and deposits the test coin.
Every submitted step must succeed entirely before the next step proceeds.
The service uses the pinned Preview RPC/indexer and a loopback proof server;
`MIDNIGHT_DEMO_PROOF_SERVER` can select another loopback HTTP proof-server port.

The demo policy has one merchant, a `70000000490` atomic lifetime allowance, and a
`50000000350` atomic per-payment limit. Initial funding is `100000000700` test-token
atomic units. These numbers do not represent fiat or the NIGHT used for DUST.
Agent payment uses the durable staged SDK runner and fixed scoped gateway. The
owner's policy secret is zeroed in the runner's private state; owner operations
load the separate owner secret only for their requested circuit. The fee wallet
and both credential contexts remain in this dedicated local owner process.

`GET /api/status` and `GET /api/payments/:id` return explicit public/admin views,
never serialized wallet snapshots, private openings, keys, transaction preimages,
or raw SDK errors. `POST` routes are `/api/setup`, `/api/register-dust`,
`/api/bootstrap`, `/api/payments`, `/api/reconcile`, `/api/owner/pause`,
`/api/owner/revoke`, and `/api/owner/withdraw`. An HTTP 202 acknowledges a job,
not payment finality. Finalized payment receipts require matching transaction
and deployment IDs, indexed successful finality, the merchant wallet's observed
balance, the exact vault change output, and the generated state commitments.

## Persistence and recovery limits

The `.local/demo-preview/` directory contains encrypted state and synchronization
snapshots. On Windows, `key-protection.json` wraps the encryption key using
current-user DPAPI. Back up that file **and** the encrypted demo, runner and
request-journal files together. DPAPI recovery requires the appropriate Windows
account/machine credentials; those files alone are not a portable backup. On
other systems set a strong `MIDNIGHT_DEMO_PASSWORD` before first use and preserve
it separately. `identity-public.json` detects missing or replaced identity files
before a different funding address can be presented.

The runner persists proposed openings and exact signed transaction bytes before
submission. An ambiguous response blocks new spending. Reconciliation observes
the persisted transaction IDs; it never generates or submits a replacement.
Owner/setup transactions retain their recovery record until both private stores
have advanced and exact generated commitments match the chain. Recovery after a
pre-submission crash with no saved transaction ID still requires operator work;
the demo does not automatically discard that candidate. Exclusive writer locks
are never removed automatically after a crash. Preserve all files and establish
that the previous process stopped before manual lock recovery.

This is a single-owner testnet demonstration. General backup rollback handling,
complete independent private-opening reconstruction, multiple concurrent owner
clients, and OS power-loss certification remain outside its tested scope. Local
chain test evidence and public Preview transaction evidence must be reported
separately. Unit tests of adapters are not public-chain settlement evidence.
