# Frontend notices

`styles.css`, `overview.css`, `landing.css` and `network-theme.css` are unmodified copies from Midnight Ballot Lab revision `d22ce6171b5548f70b8360f12709562e9e8051fa` (6 November 2026). They are under PolyForm Noncommercial 1.0.0, retained in `licenses/BallotLab-PolyForm-Noncommercial-1.0.0.txt`. The landing-page organization adapts the same reference. Wallet-specific styles and interactions are separate files.

Source: https://github.com/IBKR-BouncyBot/Midnight-BallotLab

The optional support section adapts the same revision's `src/index.html#support`. `support.mjs` and `assets/support-ada-qr.svg` are unmodified copies under the same PolyForm license. The public Cardano mainnet support address is preserved exactly; the section is separate from Preview test-wallet funding. The QR SVG SHA-256 is `3f2491a3fa1371eddc73bf934fe9f0b32e601a9d2e1a262b9f76b3389f7164ee`.

Outfit fonts are unmodified and separately licensed under SIL OFL, with provenance and the full notice in `fonts/`. No remote font service is used. Neither demo is endorsed by Midnight or Lace.

The browser application includes Midnight SDK/WASM dependencies and retains their upstream legal comments and license notices. The public key-material mapping follows Midnight Wallet SDK prover-client 1.2.3, copyright Midnight Foundation, Apache-2.0; a copy is included in `licenses/Apache-2.0.txt`. Other dependencies retain their own licenses.

The static build mirrors unmodified public built-in circuit keys, ZKIR and SRS parameters from the installed SDK's artifact origin so the browser can fetch them from this site's origin. `scripts/browser-artifacts.json` in the source repository records the 17 files' original URLs, byte sizes and SHA-256 hashes. This records provenance and does not assign the SDK code license to separately distributed artifact data. `browser-build.json` records hashes for the public files served by this build. No wallet seed, private witness or local probe preimage is part of those production artifacts.
