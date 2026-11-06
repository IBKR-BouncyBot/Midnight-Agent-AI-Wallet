# Third-party material

The upstream smoke contract and any attributed network helpers are adapted from [midnightntwrk/midnight-examples](https://github.com/midnightntwrk/midnight-examples/tree/c2f2fe2d4e4fd2008894430cb469d4759d66efe3), copyright Midnight Foundation, Apache License 2.0. The full license is in `licenses/Apache-2.0.txt`. Original notices are retained in adapted helpers.

The browser's public key-material mapping follows `@midnight-ntwrk/wallet-sdk-prover-client` 1.2.3. That Midnight Wallet SDK code is copyright Midnight Foundation and carries Apache-2.0 notices; the license is also distributed at `web/licenses/Apache-2.0.txt`. Browser bundles retain upstream legal comments. Other bundled dependencies and WASM modules retain their respective upstream notices and licenses.

The production build mirrors 17 public built-in circuit key/ZKIR and structured reference string (SRS) files from the artifact origin configured by the installed SDK. Their source URL, exact byte sizes and SHA-256 hashes are recorded in `scripts/browser-artifacts.json`; build outputs place them under `browser-builtins/`. These are unmodified public proving artifacts, not wallet material or private witnesses. This provenance statement does not infer separate artifact licensing from the SDK code license. The application's generated contract artifacts are copied separately under `browser-contracts/`.

The four shared stylesheets in `web/` (`styles.css`, `overview.css`, `landing.css`, `network-theme.css`) are copied from [Midnight Ballot Lab](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/tree/d22ce6171b5548f70b8360f12709562e9e8051fa), revision `d22ce6171b5548f70b8360f12709562e9e8051fa`, under PolyForm Noncommercial 1.0.0. The copied license is `web/licenses/BallotLab-PolyForm-Noncommercial-1.0.0.txt`. The page structure is adapted to agent vaults; the original application is independent Midnight research. These copied styles are not relicensed as Apache material.

The unmodified Outfit variable fonts in `web/fonts/` are copyright 2021 The Outfit Project Authors, separately licensed under the SIL Open Font License in `web/fonts/OFL-Outfit.txt`. Their original provenance is retained in `web/fonts/README.md`. See also `docs/design-reference.md` and `web/NOTICE.md`.

The front-page support section adapts Ballot Lab's support markup from that same revision. `web/support.mjs` and `web/assets/support-ada-qr.svg` are unmodified copies under its PolyForm Noncommercial 1.0.0 license. The public Cardano mainnet receiving address is preserved exactly, separately from testnet funding.

Dependencies retain their respective upstream licenses. No license choice for the new wallet source is inferred from the handover.
