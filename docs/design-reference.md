# Ballot Lab design reference

Inspected on 6 November 2026, before wallet UI implementation. This is a visual reference, not evidence that this wallet can prove or settle a payment.

## Provenance

- Live reference: <https://ibkr-bouncybot.github.io/Midnight-BallotLab/>, displaying **v0.6.1**.
- Source: <https://github.com/IBKR-BouncyBot/Midnight-BallotLab>.
- Observed `main` / `HEAD`: `d22ce6171b5548f70b8360f12709562e9e8051fa`, commit message “Present the testnet flow as five separate screens”.
- Live `index.html`, `styles.css`, `overview.css`, `landing.css`, and `network-theme.css` were compared with the corresponding `src/` files at that revision; all five matched exactly as text.
- The live landing page was also inspected in a browser. It has a thin-rule masthead, large left-aligned heading, restrained black/white surfaces, and two side-by-side choice cards with blue actions.

The handover's v0.3.0 values are superseded by the live CSS cascade: `styles.css` supplies the base, `overview.css` overrides its appearance, and page-specific `landing.css` or `network-theme.css` applies last. The old 16px radius and purple-tinted surfaces are not the current appearance.

## Current visual vocabulary

| Element | Observed current value or pattern |
| --- | --- |
| Main background | `#0a0a0a` on landing/network pages |
| Text | `#ffffff` |
| Primary action | `#0000fe`, white text; hover retains blue and adds a white border |
| Surface | `#101010`; raised network surface `#181818`; soft surface `#202020` |
| Borders | `#303030`; stronger network borders `#666666` |
| Muted/secondary text | `#c1c1c1` / `#aaaaaa` on network page |
| Positive/error text | `#a5e6c0` / `#ffb1b1` retained from base |
| Corners | Panels/cards 4px; buttons/inputs 3px |
| Typeface | Self-hosted variable Outfit, weights 100–900, system sans-serif fallback |
| Layout | 1384px page max-width including 32px side padding; main workspace plus 288px activity sidebar |
| Typography | Regular-weight headings, tight letter spacing; 16px form/body text; small uppercase eyebrows |
| Controls | Blue primary, outlined neutral secondary; minimum base button height 46px |
| Status | Mode/network strip, plain-language inline messages, working/error callouts, separate activity panel |

Use the current black/white/blue style for the wallet and adapt the information hierarchy to vaults, agents, activity, connections and recovery. A connected wallet or available runner must not imply that a payment is finalized. Show proof, submission, finality and unresolved outcomes separately. Keep technical diagnostics behind disclosure controls.

The network page uses separate navigation screens while retaining session state. Its CSS highlights the current screen with a white border/inset rule on blue, and the activity column remains visually distinct. These patterns are suitable for wallet administration; election-specific terminology and voting graphics are not.

## Accessibility and responsive behavior

Retain the visible skip link, labelled controls, explicit disabled states, status live regions, and strong focus outlines. The network theme uses white focus outlines. Do not communicate payment state by color alone. Main responsive breakpoints include 1200px for the five-step network navigation, 960px for shared layout, and 700px for stacked content. Landing cards stack at 700px; very small screens use a single-column sequence. Reduced-motion preferences disable decorative transitions. Test the new wallet independently at desktop and narrow mobile widths.

## Source assets and notices

Useful source files at the pinned revision:

- [Base styles](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/src/styles.css)
- [Shared current theme](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/src/overview.css)
- [Network theme](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/src/network-theme.css)
- [Landing layout](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/src/landing.css)
- [Font provenance](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/src/fonts/README.md)

The reference repository uses [PolyForm Noncommercial 1.0.0](https://github.com/IBKR-BouncyBot/Midnight-BallotLab/blob/d22ce6171b5548f70b8360f12709562e9e8051fa/LICENSE); do not relabel copied application code as permissively licensed. Outfit is separately licensed under the SIL Open Font License, with `OFL-Outfit.txt` beside `Outfit-Latin.woff2` and `Outfit-LatinExt.woff2`. No source assets were copied during the initial inspection.

The subsequent user-requested frontend now vendors the four shared CSS files above, unmodified, and the Outfit fonts in `web/`. Their PolyForm and OFL notices are retained alongside the assets and recorded in `THIRD_PARTY_NOTICES.md`. `web/wallet.css` and the wallet interactions are separate. A fresh fetch on 6 November 2026 confirmed the same reference revision. The wallet has a two-choice landing page, an explicitly simulated browser flow and a public Preview interface backed by an authenticated local runner. Ballot Lab itself uses direct Lace browser providers; the wallet uses a local runner to retain its encrypted durable state and recovery boundary.

The reference repository's own `AGENTS.md` was read as context, not as instructions for the wallet repository. In particular, the reference's election-specific security rules and deployment choices do not establish wallet behavior or authorization.
