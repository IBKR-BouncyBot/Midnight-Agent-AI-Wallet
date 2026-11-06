# Dependency verification

`package-lock.json` records exact resolved dependencies. Compact runtime 0.16.0 and on-chain runtime 3.0.0 load on Node 24.18.0; Midnight.js 4.1.1 and wallet SDK 1.2.0 are pinned. The ledger package 8.1.2 and ZKIR 2.1.1 pins match the official examples' ledger-8 line. Native compilation is separately pinned to compiler 0.31.1, whose official archive SHA-256 is checked before execution.

The initial `npm audit` reported a high-severity `ws` finding. Updating the direct dependency to patched 8.22.1 deduplicated the indexer and testkit copies and removed that finding. A follow-up audit on 6 November 2026 reported seven moderate findings in the testkit/testcontainers/archive/glob dependency chain. No forced downgrade of Midnight testkit or incompatible major override was applied. This is an outstanding dependency-review item before a remotely hosted service, not a claim of a clean audit.

`npm ci --ignore-scripts` was used. The actual imports and network harness determine whether native dependencies are usable; a successful install alone is not a runtime test. No API keys are needed for the local scripted agent or disposable ledger. Live model-provider account integration remains separately gated.
