# Provider-neutral agent boundary

This is a tested protocol and storage foundation. The executable MCP entry point is **inspection-only**: no wallet credentials, payment backend or remote listener are configured. It cannot generate a proof or transfer tokens. A passing gateway unit test is not a Midnight settlement test.

```sh
node --test tests/protocol.test.mjs
node services/mcp/scripted-agent.mjs
node services/mcp/stdio.mjs
```

The scripted probe launches the real stdio entry point, negotiates MCP, lists three tools, checks capabilities, and verifies that a payment is refused. It is explicitly not ChatGPT or Claude.

## Interface

The fixed JSON Schemas are in `packages/protocol/index.mjs`; companion types are in `index.d.mts` and `services/mcp/gateway.d.mts`. Tool arguments use references, a 64-character lowercase token color, decimal strings of positive atomic units up to `18446744073709551615`, and a 16–128 character idempotency key. No owner actions, URLs, seed export, arbitrary signing, private limits or full receipt history are exposed.

`PaymentGateway.call(name, arguments, credential)` authenticates outside the model-supplied arguments. A trusted adapter supplies an authentication callback returning a subject, network (`local` or `preprod`), exact contract address, vault, agent and credential expiry. A production authentication adapter must verify credential signatures, issuer/audience and revocation; it must never parse unverified claims into this scope. Such an adapter is not shipped here.

The gateway limits attempts per authenticated scope, including invalid and rejected attempts. Its in-process limiter resets on restart; persistent/distributed abuse protection is required before remote hosting. Coarse errors limit disclosure but timing and repeated rejection can still reveal policy information.

The disabled stdio CLI has a fixed `local-inspection` identity and all-zero placeholder address. That identity carries no spending authority. It provides protocol inspection only; do not use its authentication callback for a live service.

## Runner contract

A live runner must be supplied explicitly with `ready: true`, an encrypted journal and both methods declared by `PaymentBackend`:

- `requestPayment({ scope, request, fingerprint, paymentId })`: invoked only after durable reservation. Resolve approved recipient aliases from trusted configuration, bind the real deployment and current policy, and persist all proof/coin/transaction recovery material before submission.
- `reconcilePayment({ scope, request, fingerprint, paymentId, transactionId })`: query existing durable records and network evidence. It must never create a second payment, resubmit blindly, or regenerate a state-dependent proof merely because an HTTP call timed out.

Finalized results require the transaction reference plus a matching `settlementEvidence` object: network, contract address, transaction ID, finalized block hash, verified recipient receipt and verified vault change. The gateway only validates this object's shape and scope. **This is a trusted runner attestation, not a proof verified by the gateway.** The runner must obtain the observations from the real chain and recipient wallet; a fabricated object is not settlement evidence. Missing evidence yields `unresolved`. The agent sees only payment ID, status and transaction ID.

The journal protects against duplicated requests and stale terminal-state updates. Contract limits, revocation and concurrent chain state enforcement remain the contract's responsibility. A request's `purpose` is opaque data and never overrides recipient identity, endpoints, rules or authority.

## Persistence and recovery limits

`EncryptedRequestJournal.open(path, key)` takes a 32-byte encryption key from the trusted caller; it never stores that key. AES-256-GCM authenticates a versioned envelope, using fresh 96-bit nonces and fixed purpose-specific AAD. The encrypted records include the exact authenticated scope, normalized request and SHA-256 payload fingerprint. Reusing a key with altered payment data returns `REQUEST_CONFLICT` even after restart. Different subjects, agents and contract deployments have distinct namespaces.

An exclusive `.lock` prevents a second writer. It is never automatically evicted. After a process crash, stop all runner processes, preserve the journal and lock, inspect the recorded process information, and only then remove a verified stale lock. PID reuse means a PID alone is not sufficient evidence. Reopening must use the same key; a wrong key or altered ciphertext fails closed. Never delete the encrypted journal to clear an unresolved payment.

Files are fsynced before atomic rename. On Linux the containing directory is also fsynced. Use a local WSL/Linux filesystem for live durability; Windows tests verify logical behavior but do not establish power-loss durability. Do not use a network share. Filesystem ACLs, disk encryption and keeping the key separate from backups remain operator responsibilities.

The request journal does not provide private coin/state recovery or backup import/export. The runner's private store must supply that, bind recovery to the deployment, and reconcile against chain state before enabling spending. Reopening a journal is not permission to retry: a request reserved before a crash stays unresolved until the runner can establish its outcome. A request may safely remain unresolved even when the crash occurred before submission.

Remote Streamable HTTP, OAuth, browser origin controls, public hosting and live ChatGPT/Claude account tests are not implemented by this package. See `docs/ai-connections.md` for the separately verified connection paths.
