# Browser WASM prover

`provider.mjs` exports `createBrowserProver({ workerUrl, contracts, builtinBase?, timeoutMs?, onStage?, hashes? })`. It implements ledger `check(preimage,keyLocation)` / `prove(preimage,keyLocation,binding?)`, Midnight.js `proveTx(transaction)`, and `close()`. No HTTP proving endpoint is accepted. The preimage is copied and transferred to a same-origin module worker; the worker calls the actual installed `@midnight-ntwrk/zkir-v2` check/prove exports. Native diagnostics are replaced with bounded error codes.

Build `worker.mjs` as a separate browser module bundle. Its zkir browser entry statically imports `midnight_zkir_wasm_bg.wasm`, so the build needs the real WASM loader/plugin, not an empty Node shim. Bundle the application provider/probe separately with the actual ledger-v8 WASM. Worker assets must stay same-origin. CSP requires `worker-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, and GET access to the selected public artifact origin.

Example configuration:

```js
const prover = createBrowserProver({
  workerUrl: './browser-prover-worker.mjs',
  builtinBase: './browser-builtins/',
  contracts: {
    'private-vault': './contracts/private-vault/',
    'test-token': './contracts/test-token/',
  },
  onStage: stage => updateStatus(stage),
});
// Pass prover as the Midnight.js proofProvider, or use its low-level methods.
```

The circuit name allowlist maps to the generated `keys/<name>.prover`, `keys/<name>.verifier`, and `zkir/<name>.bzkir` files. Built-in spend/output/sign/DUST keys use the **version 9 artifact directories** and `bls_midnight_2p<k>` SRS URLs from the installed wallet-sdk-prover-client **1.2.3**, whose dependencies are ledger-v8 ^8.1.0 and zkir-v2 ^2.1.0. This is an artifact version, not a node/proof-server version. The default S3 endpoint serves public material only. A same-origin mirror may be supplied. No witnesses or proof preimages enter asset requests. Optional `hashes` maps absolute artifact URLs to expected SHA-256 values. Public downloads are bounded, deduplicated and memory-cached; errors clear failed entries. SRS sizes above k22 are rejected. The current mint fixture is k14; vault pay is k17.

Generate the fresh, intentionally public fixture with `node scripts/browser-prover-fixture.mjs`. It writes only `.local/browser-prover-fixture/`, using the real generated test-token mint circuit and known disposable inputs. It never opens a wallet or reads saved private identities. Serve its `mint.preimage.bin` on the local QA origin, then explicitly call `runBrowserProofProbe({workerUrl,contractBase,fixtureUrl,onStage})` from a bundled `probe.mjs` harness. A successful probe establishes a native constraint check and nonempty actual WASM-generated proof, plus rejection of mismatched circuit selection. It does not independently verify the proof or submit a network transaction; those remain separate gates.

The production build mirrors the official public artifacts on the same static origin, because the S3 host does not return browser CORS headers. `scripts/browser-artifacts.json` pins their SHA-256 digests; the build verifies every cached/downloaded file. The runtime manifest also pins custom contract artifacts. This is static file hosting, not a proving service. No probe fixtures or diagnostic pages are included in the production build.

The architecture follows the installed Midnight Foundation Apache-2.0 wallet SDK worker implementation, with independent message handling, allowlists, cleanup, limits and same-origin policy. Third-party code remains in its installed packages under its own license.
