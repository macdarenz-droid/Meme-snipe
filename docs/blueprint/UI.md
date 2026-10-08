# Dashboard design and UX

Edited in Meme-snipe from 2026-10-07 (card Z0D); source commit `74e7258` of `macdarenz-droid/Snipe-solana` `main`.

Operator dashboard for the Solana meme-coin trading bot: design system, screens, view-model contract, front-end stack and UI build tickets.

- Author role: product designer and front-end architect (fact-ID prefix `UI`).
- Research date: 2026-10-06. Every outside-world claim below carries a fact ID (`UI-Fnn`) that points to a URL read in this session, or is labelled **UNVERIFIED**.
- Scope: design and build specifications only. No production code. Code-like fragments in this document are specifications (type shapes, token names), not implementations.
- Not financial advice. Nothing in this document implies the bot will be profitable. The dashboard exists to make the bot's real, after-cost results visible, to make losses bounded and obvious, and to make it hard to put real funds at risk by accident.

### Reading guide and labels

| Label | Meaning |
|---|---|
| `UI-Fnn` | A fact verified in this session. The URL and the date read are given in the fact table. |
| **OBSERVATION** | Judged visually or inferred from page structure. Not a measured value. |
| **COMPUTED** | Calculated in this session (for example, WCAG contrast ratios from the WCAG 2.2 relative-luminance formula, or palette checks with a colour-vision-deficiency simulator). The method is stated. |
| **DECISION D-UI-nn** | A design choice between options that conflict. Each lists the options, the recommendation and the reason. |
| **PROPOSED** | A design proposal for this project (for example, an internal API path or a threshold). It is not a claim that such a thing exists anywhere already. |
| **UNVERIFIED** | Could not be confirmed in this session. Do not rely on it without checking. |

### Summary of key decisions

| ID | Decision | Recommendation (short) |
|---|---|---|
| D-UI-01 | Typeface | Inter (UI) + JetBrains Mono (addresses, hashes). Both SIL OFL 1.1, self-hosted. Geist is a licensed alternative, but its strong Vercel association argues against it. |
| D-UI-02 | Profit/loss colours | Green/red by default, always paired with a sign, a glyph and baseline position, because green/red fails the CVD check. One-click blue/orange "CVD-safe polarity" setting. |
| D-UI-03 | Live-mode hue | A reserved orchid/magenta, used nowhere else, not red. Red already means loss and danger. |
| D-UI-04 | App framework | React 19 + TypeScript + Vite 8 as a static single-page app served by the bot backend. No Next.js server. |
| D-UI-05 | Charts | uPlot (MIT) for all metric time series. TradingView Lightweight Charts (Apache-2.0 + attribution) only for token price candles. |
| D-UI-06 | Styling | CSS custom properties + CSS Modules. No runtime CSS-in-JS. |
| D-UI-07 | Kill-switch semantics | Primary HALT = stop new entries and cancel queued entries; protective exits stay armed. FLATTEN ALL is a separate, confirmed action. |
| D-UI-08 | Unrealised PnL mark | Exit-quote mark (what selling the full size would return now, after estimated exit costs), not the mid price. |
| D-UI-09 | Network exposure | Never public. Bind to loopback or a private tailnet/WireGuard interface. Passkey login with step-up re-authentication for risky actions. |
| D-UI-10 | Live transport | One multiplexed Server-Sent Events stream + REST snapshots + REST commands. |
| D-UI-11 | Mobile | Read-only monitoring + HALT + alert acknowledgement. No risk-increasing actions on mobile. |
| D-UI-12 | Number encoding | All u64/i64 money and token quantities as decimal strings with the unit in the field name. Never as JSON numbers. |
| D-UI-13 | Raising limits / going live | Typed confirmation + passkey step-up + readiness gates + a 60-second cancellable delay before the change takes effect. Lowering risk is immediate. |

## Reference research

### Method

1. On 2026-10-06 I fetched each homepage with `curl` (desktop Chrome user-agent), downloaded every stylesheet linked from the HTML (plus inline `<style>` blocks), and extracted `@font-face` rules, CSS custom properties, `border-radius`, `transition` durations, `cubic-bezier` curves, `font-size`, `letter-spacing`, `font-weight`, `tabular-nums`, `box-shadow`, `backdrop-filter`, `prefers-reduced-motion` and `prefers-color-scheme` usage. Counts are occurrences in the shipped CSS on that date. They show where a design system leans, not how often each rule renders.
2. I read the official design-system pages and design write-ups the companies published (Vercel Geist docs, Vercel Web Interface Guidelines, Linear's redesign write-up, Linear's navigation guide).
3. Font licences were checked against the font projects' own licence files, the Google Fonts repository metadata, or the foundry's site.
4. Anything judged by eye is labelled **OBSERVATION**. Marketing sites are not product UIs. Traits taken from a marketing page are evidence of the brand's design language, not of how its logged-in app behaves.

### Live status (checked 2026-10-06)

| Site | URL | Status | Evidence |
|---|---|---|---|
| Linear | https://linear.app | **Live** | HTTP 200. `<title>Linear – The system for product development</title>`. `<html lang="en" data-theme="dark">` (UI-F01) |
| Vercel | https://vercel.com | **Live** | HTTP 200. `<title>Agentic Infrastructure - Vercel</title>` (UI-F10) |
| Height | https://height.app | **Not live** | TLS handshake reset on HTTPS. Plain HTTP returned `503 Service Unavailable` ("upstream connect error ... connection termination"). WebFetch also got HTTP 503 (UI-F18) |
| Raycast | https://www.raycast.com | **Live** | HTTP 200. `<title>Raycast - Your shortcut to everything</title>` (UI-F19) |
| Resend | https://resend.com | **Live** | HTTP 200. `<title>Resend · Email for developers</title>` (UI-F20) |
| Stripe | https://stripe.com | **Live** | HTTP 200. `<title>Stripe \| Financial Infrastructure to Grow Your Revenue</title>` (UI-F21) |
| Mercury | https://mercury.com | **Live** | HTTP 200. `<title>Online Business Banking For Startups, Small Businesses & Scaling Companies</title>` (UI-F22) |
| Railway | https://railway.com | **Live** | HTTP 200. `<title>Railway \| The all-in-one intelligent cloud provider</title>` (UI-F23) |
| Attio | https://attio.com | **Live** | HTTP 200. `<title>Attio: The CRM for agentic revenue</title>` (UI-F24) |

### Linear (linear.app)

- **Theme default.** The homepage ships `data-theme="dark"`. The CSS defines `[data-theme=dark]`, `[data-theme=light]` and `[data-theme=glass]` token sets (UI-F01, UI-F04).
- **Fonts.** Self-hosted `Inter Variable` (`InterVariable.woff2?v=4.1`, weight axis 100–900) and `Berkeley Mono` (variable). A `--font-serif-display` stack names "Tiempos Headline" (UI-F02). Inter is SIL OFL 1.1 (UI-F25). Berkeley Mono and Tiempos are commercial typefaces; see the licence table below.
- **Weights.** Custom variable-font weights: `--font-weight-normal:400`, `--font-weight-medium:510`, `--font-weight-semibold:590`, `--font-weight-bold:680` (UI-F02).
- **Type scale tokens.** `--text-regular-size:.9375rem` (15px) with line-height 1.6 and letter-spacing -0.011em. `--text-small-size:.875rem` (14px), `--text-mini-size:.8125rem` (13px, line-height 1.5), `--text-micro-size:.75rem` (12px), `--text-tiny-size:.625rem` (10px). Titles run `1.0625rem` up to `4.5rem`, with letter-spacing tightening from -0.012em to -0.022em. The most common literal `font-size` in the CSS is 13px (32 occurrences), then 12px (23) (UI-F03).
- **Dark colour tokens.** `--color-bg-primary:#08090a`. Level ramp `#08090a / #0f1011 / #141516 / #191a1b`. Borders `--color-border-primary:#23252a`, `--color-border-secondary:#34343a`. Text `#f7f8f8 / #d0d6e0 / #8a8f98 / #62666d`. Accent `--color-accent:#7170ff`, brand `#5e6ad2` (UI-F04). **COMPUTED:** the primary border on the primary background is only 1.30:1, and the bg level-1 step against level-0 is 1.05:1. Linear separates surfaces with near-invisible steps rather than strong lines.
- **Radius tokens.** `--radius-4/6/8/12/16/24/32`, `--radius-rounded:9999px`, `--border-hairline:1px`. The most used literal radii are 8px (39) and 6px (24) (UI-F05).
- **Motion.** `--speed-quickTransition:.1s`, `--speed-regularTransition:.25s`, `--speed-highlightFadeOut:.15s`, `--speed-highlightFadeIn:0s`. There is a full named set of Penner-style easing tokens (`--ease-out-quad` and others). The most frequent duration in transitions is `.16s` (43). The most frequent custom curve is `cubic-bezier(.32,.72,0,1)`. `prefers-reduced-motion` appears 37 times (UI-F06).
- **Elevation and layering.** At `:root`, `--shadow-*` defaults to none. The dark theme defines low shadow `0px 2px 4px #0000001a`, medium `0px 4px 24px #0003` and high `0px 7px 32px #00000059`. Named z-index layers include `--layer-command-menu:650`, `--layer-dialog:700`, `--layer-toasts:800`, `--layer-tooltip:1100` and `--layer-context-menu:1200`. Focus ring: `2px solid` indigo, offset 2px. `--min-tap-size:44px`. Scrollbar 6px (UI-F07).
- **Published design reasoning.** "How we redesigned the Linear UI (part Ⅱ)", dated March 28, 2024. It describes moving theme generation to LCH, cutting each theme to three inputs (base colour, accent colour, contrast), using Inter Display for headings, "limiting how much chrome (blue in our case) was used", and focusing on the "inverted L-shape" (sidebar + top bar) (UI-F08).
- **Keyboard-first.** Linear's navigation guide: `Cmd/Ctrl + K` command menu, `/` search (including by identifier), two-key sequences such as `G` then `I`, and `?` for the full shortcut list (UI-F09).

### Vercel (vercel.com) and the Geist design system

- **Fonts.** Geist Sans (variable, `font-display:swap`) and Geist Mono (`font-display:block`, split by `unicode-range`), plus decorative "Geist Pixel" variants on the marketing page. A metric-matched fallback `@font-face` (`GeistSans Fallback`, `src:local(Arial)` with `ascent-override`, `descent-override` and `size-adjust`) prevents layout shift (UI-F10). The Geist licence is SIL OFL 1.1 (UI-F17).
- **Colour system (official docs).** Ten scales (backgrounds, gray, gray-alpha, blue, red, amber, green, teal, purple, pink), each in steps 100–1000. Steps 100–300 are component backgrounds (default/hover/active), 400–600 borders (default/hover/active), 700–800 high-contrast backgrounds, and 900–1000 text and icons. The docs recommend Background 1 in most cases and note P3 colour support (UI-F11). In the CSS, the dark `--ds-background-100` is `#000`, and gray ramps such as `--ds-gray-100:#1a1a1a` are expressed as HSL, hex and `lab()` (UI-F11).
- **Materials (elevation) docs.** Surface materials `material-base` and `material-small` use radius 6px, `material-medium` and `material-large` 12px. Floating materials: tooltip 6px (the only floating element with a stem), menu 12px, modal 12px, fullscreen 16px (UI-F12).
- **Typography docs.** Named classes by role and pixel size: `text-heading-72…14`, `text-label-20…12` (with mono variants), `text-copy-24…13`, `text-button-16/14/12`. Label 14 is described as the "most common text style of all", and Copy 13 is "for secondary text and views where space is a premium" (UI-F13).
- **Tokens in shipped CSS.** `--geist-space:4px` base unit, `--geist-space-gap:24px`, `--geist-radius:6px`. The most frequent transition durations are `.15s` (33) and `.2s` (28), and the most frequent curve is `cubic-bezier(.4,0,.2,1)`. Headings use negative pixel letter-spacing (for example `-.96px`, `-2.88px`) (UI-F14).
- **Command Menu docs.** "Bind ⌘K on macOS and Ctrl+K elsewhere". Arrows move the highlight, Enter activates, Escape closes, and Backspace on an empty input pops the page stack. Focus is trapped and returned on close. Recent or default items show when the input is empty (UI-F15).
- **Web Interface Guidelines (official write-up).** Rules adopted directly in this spec: every flow keyboard-operable per WAI-ARIA patterns; visible `:focus-visible` rings; a reduced-motion variant; loading indicators with a ~150–300 ms show-delay and ~300–500 ms minimum visible time; `tabular-nums` for compared numbers; confirmation or Undo for destructive actions; state persisted in the URL; `color-scheme: dark` on `<html>`; never pre-disabling submit buttons. The guidelines also recommend optimistic updates and APCA contrast. This spec deliberately departs from both: no optimistic updates for money-affecting actions, and WCAG 2.2 ratios as the conformance bar, because WCAG is the stated requirement (UI-F16).

### Height (height.app)

- **Status today:** not reachable. HTTPS reset, HTTP 503 (UI-F18).
- **Shutdown evidence (secondary sources only).** A Shortcut blog post (a competitor's marketing page, so weak evidence) states that Height announced in March 2025 it was sunsetting the product and would shut down operations on September 24, 2025. A web-search summary of an AlternativeTo news item said the same, but the AlternativeTo page returned HTTP 403 to direct fetch, so I could not read it. I found no first-party announcement I could read (UI-F18).
- **Internet Archive.** The archive.org availability API reports a capture of `https://height.app/` at **2025-03-08 14:19:46 UTC** (`20250308141946`) and another at **2025-10-08 18:27:22 UTC** (`20251008182722`, after the reported shutdown), both with archived status 200. The snapshot content could not be retrieved from this environment: connections to `web.archive.org` were reset on every attempt, `archive.ph` was also reset, and the WebFetch tool refuses `web.archive.org`. The availability API then rate-limited further queries (HTTP 429).
- **Consequence:** **no Height design trait is verified in this document.** Commonly repeated descriptions (keyboard-driven navigation, bulk editing, a built-in AI assistant) appear only in a search-engine summary of third-party listicles and are **UNVERIFIED**. Height contributes nothing to the design decisions below. A future pass with archive access should use the 2025-03-08 snapshot, which predates the shutdown.

### Additional premium references (all live on 2026-10-06)

Selection criteria: (a) dark or neutral restrained aesthetic comparable to Linear and Vercel; (b) product depth relevant to an operator console: dense data, money, logs, keyboard-first use; (c) a shipped, inspectable site.

| Site | Why it was chosen | Verified traits (UI-F19 to UI-F24) |
|---|---|---|
| **Raycast** (raycast.com) | Keyboard-launcher product; the closest match to the command-palette interaction model the dashboard needs | `color-scheme:dark`. Grey ramp `--grey-50:#e6e6e6` … `--grey-900:#07080a`, with `--background:var(--grey-900)`. Fonts Inter, JetBrains Mono, Geist Mono (variable reference), Instrument Serif, VT323. Rounding tokens `xs 4 / sm 6 / normal 8 / md 12 / lg 16 / xl 20 / xxl 24px`. Most frequent durations `.3s` (114) and `.2s` (84). Most frequent curve `cubic-bezier(.23,1,.32,1)`. Heavy `backdrop-filter` use (118). Small positive letter-spacing `.2px` is the most common (122). **COMPUTED:** `--grey-500` on `--grey-900` is 1.52:1, hairline-level separation |
| **Resend** (resend.com) | Developer product with a dark, typographic, high-craft marketing site; a good benchmark for tone and restraint | `theme-color #000000`. CSS `--background` is `#000` (dark) and `#fdfdfd` (light). Fonts Inter, ABC Favorit, Domaine, Commit Mono. Radius scale `--radius-xs .125rem` … `--radius-4xl 2rem`. Durations dominated by `.15s` (60). Curve `cubic-bezier(.4, 0, .2, 1)` (62) |
| **Stripe** (stripe.com) | The money-product reference; dense financial UI fragments rendered on the homepage | Fonts `sohne-var` (Söhne) and `SourceCodePro`. Radius tokens `--hds-space-core-radius-xs 2px / sm 4px / md 6px / lg 16px / xl 32px`. Dominant curve `cubic-bezier(.25,1,.5,1)` (41) and duration `.3s`. `prefers-reduced-motion` appears 84 times, the most of any site checked. Many 8–12px font sizes from its miniature UI illustrations |
| **Mercury** (mercury.com) | Banking product: trust cues for money, clear numerals | Fonts Arcadia, Arcadia Display, Tiempos (Headline/Fine), IBM Plex Mono. Fine-grained variable weights (`--font-weight-360/420/480`). Background tokens over neutral/beige/blue/green scales from 50 to 950. Radius `.25rem`–`2.5rem` |
| **Railway** (railway.com) | Infrastructure console with live deploy logs and metrics, close to the health screen | `theme-color #13111C`. Dark `--background: hsl(250, 24%, 9%)` and light `hsl(0, 0%, 100%)`. Fonts Inter, Inter Tight, JetBrains Mono, IBM Plex Serif. `--inkwell-radius:6px`. Durations dominated by `.15s` (26). Curve `cubic-bezier(.4,0,.2,1)` (31) |
| **Attio** (attio.com) | Data-dense CRM; tables, records and command menus close to the journal and signal feed | Fonts Inter, Inter Display, JetBrains Mono, Tiempos Text. `tabular-nums` used 12 times. Heading letter-spacing `-.015em` (17) |

### Font licences relevant to this project

| Typeface | Licence | Where verified | Usable here? |
|---|---|---|---|
| Inter | SIL OFL 1.1 | `rsms/inter` LICENSE.txt. Google Fonts `ofl/inter/METADATA.pb` license "OFL". Axes `opsz` 14–32 and `wght` 100–900 (UI-F25) | **Yes** (chosen) |
| JetBrains Mono | OFL | Google Fonts `ofl/jetbrainsmono/METADATA.pb` license "OFL", `wght` 100–800. npm `@fontsource-variable/jetbrains-mono` 5.3.0 licence `OFL-1.1` (UI-F26) | **Yes** (chosen) |
| Geist / Geist Mono | SIL OFL 1.1 | `vercel/geist-font` LICENSE.txt ("Copyright (c) 2023 Vercel, in collaboration with basement.studio … SIL Open Font License, Version 1.1"). Google Fonts METADATA license "OFL"; Geist added 2024-10-02, Geist Mono 2024-10-03 (UI-F17) | Legally yes. Not chosen (D-UI-01) |
| Commit Mono | SIL OFL 1.1 | commitmono.com text "SIL Open Font License 1.1" (UI-F27) | Yes (not chosen) |
| Söhne, Tiempos | Commercial (sold by Klim Type Foundry) | klim.co.nz product pages show "Buy" links (UI-F27) | No (cost, licence) |
| ABC Favorit | Commercial (Dinamo) | abcdinamo.com shows "Buy Favorit" (UI-F27) | No |
| Berkeley Mono | **UNVERIFIED** | usgraphics.com returned HTTP 403 | No |
| Domaine, Arcadia | **UNVERIFIED** | Not checked | No |

### Cross-site synthesis

| Trait | Linear | Vercel/Geist | Raycast | Stripe | Railway | Our choice |
|---|---|---|---|---|---|---|
| Default theme | Dark | Light and dark tokens | Dark | Not determined from CSS (no theme token found) | Dark (theme-color) | Dark default + full light theme |
| UI sans | Inter Variable | Geist Sans | Inter | Söhne | Inter | Inter (OFL) |
| Mono | Berkeley Mono | Geist Mono | JetBrains Mono / Geist Mono | Source Code Pro | JetBrains Mono | JetBrains Mono (OFL) |
| Base UI text | 13–15px | Label 14 / Copy 13 | 14px most frequent | 11–12px illustrations | 14px | 13px tables, 14px forms |
| Radius cluster | 4/6/8/12 | 6 (surfaces), 12 (floating) | 4/6/8/12/16 | 2/4/6/16 | 6 | 4 / 6 / 8 / 12 |
| Typical duration | 100–250ms (.16s most common) | 150–200ms | 200–300ms | 300ms | 150ms | 100 / 160 / 240ms |
| Dominant curve | `(.32,.72,0,1)` | `(.4,0,.2,1)` | `(.23,1,.32,1)` | `(.25,1,.5,1)` | `(.4,0,.2,1)` | `(.2,0,0,1)` enter, `(.4,0,.2,1)` standard (original values) |
| Surface separation | Near-invisible steps (1.05:1) + 1.3:1 hairlines | 10-step gray, 100–300 surfaces | 1.5:1 hairlines | 51 `box-shadow` rules (count only; not inspected visually) | n/a | 4 surface steps + 1.2–1.6:1 hairlines; controls at ≥3:1 |
| Reduced motion | 37 rules | 15 rules | 8 rules | 84 rules | 2 rules | Every animation has a reduced variant |
| Keyboard-first | ⌘K, G-sequences, ? (docs) | ⌘K command menu (docs) | Product is a launcher | n/a | n/a | ⌘K + G-sequences + ? + row keys |

### What makes these feel premium, compared with a generic template

Concrete, checkable differences:

1. **Many quiet neutral steps instead of a few loud ones.** Linear ships four background levels and four line levels whose neighbours differ by about 1.05:1 to 1.3:1 (computed above). Vercel ships ten-step grays with fixed jobs per step (UI-F11). Templates typically use one background, one card colour and a mid-gray border.
2. **Hairline 1px borders at very low contrast, used for structure.** Interactive edges still meet 3:1. Templates use either heavy borders or heavy drop shadows.
3. **Colour is rationed.** Linear's write-up explicitly reduced chrome colour (UI-F08). Accent appears on focus, selection and the one primary action. Templates paint every button and icon with the brand colour.
4. **Typography tuned past defaults.** Variable-font weights such as 510/590 (Linear) and 360/420/480 (Mercury), negative tracking on headings (-0.011em to -0.022em Linear; -0.96px and tighter at large sizes, Vercel), and dense 12–14px UI text. Templates use 400/700 at 16px everywhere.
5. **A small, consistent radius scale (4–12px)** instead of large 16–24px rounding on everything.
6. **Short, custom-eased motion** (100–250ms) with reduced-motion variants. Templates use slow default `ease` (often 300–500ms) or no motion.
7. **Monospace and tabular figures for data** (Linear, Vercel, Raycast, Attio all ship a mono face; `tabular-nums` appears in Linear's and Attio's CSS).
8. **Systematised layering** (named z-index layers, materials by elevation) instead of ad-hoc `z-index: 9999`.
9. **Keyboard-first operation** (command menu, sequences, shortcut help), documented as product features (UI-F09, UI-F15).
10. **Metric-matched font fallbacks** (Vercel's `size-adjust` fallback) that prevent text reflow on font load. Templates jump.

What we take: the principles above. What we **do not** take: any logo, product name, illustration, icon set, proprietary font, exact brand colour (for example Linear's `#5e6ad2`/`#7170ff` indigo or Vercel's pure black-and-white brand pairing), or page layout. Our palette below is original and was derived from first principles and contrast calculations.

### Fact register (all read on 2026-10-06)

**Integration note.** The UI-F facts below were read by the UI writer and are **not** in the project's verified fact register used by `ARCH.md`. Facts that drive a build decision (npm package versions and licences UI-F32, release dates of React and Vite, the WebAuthn Level 3 status, Tailscale plan terms UI-F41, Solana fee figures UI-F30) are to be treated as **VERIFY** at the time of the owning ticket (UI-T01 for packages and licences; UI-T09 for WebAuthn; UI-T32 for Tailscale; the cost ledger B-M23-01 for fees). Design-reference facts (UI-F01..UI-F29) carry no build risk.

| ID | Fact (short) | Source URL(s) |
|---|---|---|
| UI-F01 | Linear homepage live; title; `data-theme="dark"` | https://linear.app |
| UI-F02 | Linear fonts (Inter Variable, Berkeley Mono; Tiempos Headline in a stack) and weight tokens 400/510/590/680 | Stylesheets linked from https://linear.app (e.g. https://static.linear.app/web/_next/static/css/pcGZUK31.css; 49 files) |
| UI-F03 | Linear type-scale tokens and most frequent font sizes | Same stylesheets |
| UI-F04 | Linear dark/light/glass colour tokens | Same stylesheets |
| UI-F05 | Linear radius tokens and frequencies | Same stylesheets |
| UI-F06 | Linear motion tokens, durations, easing, reduced-motion count | Same stylesheets |
| UI-F07 | Linear shadows, z-index layers, focus ring, min tap size | Same stylesheets |
| UI-F08 | "How we redesigned the Linear UI (part Ⅱ)", March 28, 2024: LCH, 3 theme variables, Inter Display, less chrome, inverted L-shape | https://linear.app/now/how-we-redesigned-the-linear-ui |
| UI-F09 | Linear keyboard navigation: Cmd/Ctrl+K, `/`, G-sequences, `?` | https://linear.app/enablement/guides/navigating-linear |
| UI-F10 | Vercel homepage live; Geist Sans/Mono/Pixel fonts; metric-matched fallback | https://vercel.com and its stylesheets under https://vercel.com/vc-ap-vercel-marketing/_next/static/immutable/chunks/ |
| UI-F11 | Geist colour scales and step roles; P3 | https://vercel.com/geist/colors ; Vercel stylesheets |
| UI-F12 | Geist materials and radii | https://vercel.com/geist/materials |
| UI-F13 | Geist typography classes and stated uses | https://vercel.com/geist/typography |
| UI-F14 | Vercel CSS tokens (`--geist-space:4px`, radius 6px), durations, easing, letter-spacing | Vercel stylesheets (as UI-F10) |
| UI-F15 | Geist Command Menu behaviour and keys | https://vercel.com/geist/command-menu |
| UI-F16 | Vercel Web Interface Guidelines (keyboard, focus, motion, loading timings, tabular nums, optimistic updates, destructive confirm, URL state, color-scheme, forms, APCA) | https://vercel.com/design/guidelines |
| UI-F17 | Geist fonts licensed SIL OFL 1.1; on Google Fonts (added 2024-10-02 / 2024-10-03) | https://raw.githubusercontent.com/vercel/geist-font/main/LICENSE.txt ; https://raw.githubusercontent.com/google/fonts/main/ofl/geist/METADATA.pb ; https://raw.githubusercontent.com/google/fonts/main/ofl/geistmono/METADATA.pb |
| UI-F18 | Height not live (TLS reset; HTTP 503); archive snapshot timestamps; shutdown reported by secondary sources | https://height.app ; http://height.app ; https://archive.org/wayback/available?url=height.app&timestamp=20250301 ; https://archive.org/wayback/available?url=height.app&timestamp=20251015 ; https://www.shortcut.com/blog/alternatives-to-height-app/ (competitor blog) ; https://alternativeto.net/news/2025/3/height-project-management-tool-to-shut-down-by-september-2025/ (HTTP 403; seen only via search summary) |
| UI-F19 | Raycast live; fonts; grey ramp; rounding tokens; motion; backdrop-filter | https://www.raycast.com and its stylesheets |
| UI-F20 | Resend live; theme-color; fonts; radius scale; motion | https://resend.com and its stylesheets |
| UI-F21 | Stripe live; Söhne + Source Code Pro; radius tokens; easing; reduced-motion count | https://stripe.com and its stylesheets |
| UI-F22 | Mercury live; Arcadia, Tiempos, IBM Plex Mono; weight tokens; background scales | https://mercury.com and its stylesheets |
| UI-F23 | Railway live; theme-color; background HSL; Inter/JetBrains Mono; radius; motion | https://railway.com and its stylesheets |
| UI-F24 | Attio live; Inter/Inter Display/JetBrains Mono/Tiempos Text; tabular-nums; tracking | https://attio.com and its stylesheets |
| UI-F25 | Inter: SIL OFL 1.1; `tnum`, `zero`, `ss02`, `cv11`; axes `opsz` 14–32, `wght` 100–900 | https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt ; https://rsms.me/inter/ ; https://raw.githubusercontent.com/google/fonts/main/ofl/inter/METADATA.pb |
| UI-F26 | JetBrains Mono: OFL; `wght` 100–800 | https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/METADATA.pb ; https://registry.npmjs.org/@fontsource-variable/jetbrains-mono |
| UI-F27 | Söhne and Tiempos sold by Klim; ABC Favorit sold by Dinamo; Commit Mono OFL; Berkeley Mono page 403 | https://klim.co.nz/fonts/soehne/ ; https://klim.co.nz/fonts/tiempos-headline/ ; https://abcdinamo.com/typefaces/favorit ; https://commitmono.com/ ; https://usgraphics.com/products/berkeley-mono (403) |
| UI-F28 | WCAG 2.2 success criteria quoted (1.4.1, 1.4.3, 1.4.4, 1.4.10, 1.4.11, 2.1.4, 2.2.2, 2.3.1, 2.4.7, 2.4.11, 2.5.7, 2.5.8, 3.3.4, 3.3.8, 4.1.3), large-scale text and relative-luminance definitions | https://www.w3.org/TR/WCAG22/ |
| UI-F29 | Radix Colors 12-step scale roles (method reference only) | https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale |
| UI-F30 | Lamport = 0.000000001 SOL; 1,000,000 micro-lamports = 1 lamport; 5,000 lamports per signature; priority fee formula; CU limits; token `amount`/`supply` u64, `decimals` u8; commitment levels; `getBalance` returns lamports at a requested commitment | https://solana.com/docs/terminology ; https://solana.com/docs/core/fees ; https://solana.com/docs/tokens ; https://solana.com/docs/rpc ; https://solana.com/docs/rpc/http/getbalance |
| UI-F31 | `Number.MAX_SAFE_INTEGER` = 9007199254740991; `JSON.stringify` throws on BigInt | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER ; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt |
| UI-F32 | npm versions, licences, peer ranges and publish dates listed in Front-end stack | https://registry.npmjs.org/<package> and https://registry.npmjs.org/<package>/latest |
| UI-F33 | React 19.3.0 released September 9, 2026 | https://react.dev/versions |
| UI-F34 | Vite supported-versions policy; latest major 8 | https://vite.dev/releases |
| UI-F35 | Lightweight Charts Apache-2.0 + attribution requirement; `attributionLogo`; series types; custom series | https://raw.githubusercontent.com/tradingview/lightweight-charts/master/README.md ; https://tradingview.github.io/lightweight-charts/docs/series-types |
| UI-F36 | uPlot MIT; ~50 KB; author-reported benchmarks | https://raw.githubusercontent.com/leeoniya/uPlot/master/LICENSE ; https://raw.githubusercontent.com/leeoniya/uPlot/master/README.md |
| UI-F37 | SSE: 6-connection limit per browser+domain without HTTP/2; `id`/`retry`; comment keep-alive | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events |
| UI-F38 | OWASP session guidance: cookie attributes, `__Host-`, SameSite, idle 2–5 min (high value) / 15–30 min (low risk), absolute 4–8 h, renew ID on privilege change | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html |
| UI-F39 | OWASP CSRF defences: synchronizer token, Fetch Metadata (`Sec-Fetch-Site`), custom headers, SameSite | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html |
| UI-F40 | WebAuthn Level 3 is a W3C Recommendation dated 25 August 2026 | https://www.w3.org/TR/webauthn-3/ |
| UI-F41 | Tailscale Personal: "$0 Free forever", "Up to 6 users", "Unlimited user devices" (vendor claim) | https://tailscale.com/pricing |
| UI-F42 | WAI-ARIA APG alert dialog roles/properties; combobox keyboard and `aria-activedescendant` | https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/ ; https://www.w3.org/WAI/ARIA/apg/patterns/combobox/ |
| UI-F43 | `localhost` / `127.0.0.0/8` are potentially trustworthy (secure context); WebAuthn requires a secure context | https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts ; https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API |
| UI-F44 | Documentation pages exist (HTTP 200) for `useSyncExternalStore`, `BroadcastChannel`, the Web Locks API and TanStack Router search params | https://react.dev/reference/react/useSyncExternalStore ; https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel ; https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API ; https://tanstack.com/router/latest/docs/framework/react/guide/search-params |

## Design system

The system is called **"Console"** in this document. It is an original design language for the operator dashboard. Token names use the `--c-` prefix.

### Principles

1. **Truth before beauty.** Every number shows its unit, its freshness and whether it is simulated. An unknown value is shown as unknown (`—` with a reason), never as `0`.
2. **The mode is unmistakable.** Paper and live must never be confused at a glance, by colour-blind users, in a screenshot, in a background tab or on a phone. The mode is encoded by colour, pattern, text, document title, favicon and screen-reader announcement, never by colour alone.
3. **Asymmetric friction.** Reducing risk (halt, lower a limit, go to paper) is fast. Increasing risk (resume, raise a limit, go live) is deliberate: typed confirmation, re-authentication, readiness gates and a delay.
4. **After-cost by default.** PnL, expectancy and win rates are shown after all costs (network fees, priority fees, tips, venue fees, slippage). Gross figures appear only on demand and are labelled "gross".
5. **Quiet chrome, loud exceptions.** Neutral surfaces and hairlines. Colour is reserved for state (profit, loss, warning, danger, mode). If everything is coloured, nothing is.
6. **Keyboard-first, pointer-complete, screen-reader-correct.** Every action is reachable by keyboard and the command palette, by mouse, and with assistive technology.
7. **Density with legibility.** 13px tabular figures in tables, 14px in forms, generous line height. Information density is a feature for an operator, but never below WCAG AA contrast.
8. **The UI is not a security boundary.** The server enforces every limit, permission and confirmation. The UI makes the server's decisions visible and makes mistakes hard. It never decides on its own.

### Colour

#### Method

- Each neutral step has exactly one job, a pattern documented by Geist (UI-F11) and Radix Colors (UI-F29); the values here are original.
- Neutrals: a cool near-black ramp with four surface steps and three line steps. The steps are deliberately close (hairline separation, as in the references), but every **interactive** boundary uses `--c-border-control`, which clears 3:1 (WCAG 1.4.11).
- Semantics: profit, loss, warning, danger, info, accent, paper, live. Each comes as a foreground (text and icons), a tint (subtle background), a mark (chart fill and stroke) and, where needed, a fill with an `on-` text colour.
- **COMPUTED** contrast: WCAG 2.2 contrast ratio `(L1 + 0.05) / (L2 + 0.05)`, with sRGB relative luminance `L = 0.2126 R + 0.7152 G + 0.0722 B` after linearisation (formula from WCAG 2.2, UI-F28). Requirements: 4.5:1 for normal text and 3:1 for large text (SC 1.4.3), 3:1 for UI component boundaries, focus indicators and meaningful graphics (SC 1.4.11) (UI-F28). Disabled controls are exempt under SC 1.4.3 ("part of an inactive user interface component").
- **COMPUTED** colour-vision checks: a palette validator that simulates protanopia, deuteranopia and tritanopia (Machado–Oliveira–Fernandes 2009 at severity 1.0) and reports Euclidean distance in OKLab ×100 (ΔE). Target ΔE ≥ 8, floor 6, normal-vision floor 15. The validator is the bundled data-viz skill script `validate_palette.js`, run in this session.

#### Neutral and surface tokens

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--c-bg-canvas` | `#0b0c0e` | `#f7f8fa` | Page background behind panels |
| `--c-bg-surface-1` | `#111317` | `#ffffff` | Panels, tables, cards (elevation e1) |
| `--c-bg-surface-2` | `#181b20` | `#f1f3f6` | Hover rows, raised inputs, offline mode bar |
| `--c-bg-surface-3` | `#1f232a` | `#ffffff` | Popovers, menus, dialogs (e3, e4; light uses shadow for lift) |
| `--c-bg-hover` | `#15181c` | `#f0f2f5` | Row and item hover wash |
| `--c-bg-selected` | `#1b2333` | `#e8eefc` | Selected row or item (accent-tinted) |
| `--c-border-subtle` | `#23272e` | `#e6e8ec` | Hairline dividers inside panels (decorative, no contrast requirement) |
| `--c-border-default` | `#323740` | `#d5d9df` | Panel outlines, popover outlines |
| `--c-border-control` | `#666d78` | `#7d8490` | Input, checkbox, select and toggle boundaries (≥3:1) |
| `--c-border-strong` | `#4a505b` | `#8f96a1` | Emphasised separators, table header underline |
| `--c-fg-primary` | `#eceef1` | `#16181d` | Primary text, values |
| `--c-fg-secondary` | `#b3b9c3` | `#454b55` | Labels, secondary text |
| `--c-fg-tertiary` | `#8d939e` | `#5f6672` | Metadata, axis ticks, timestamps |
| `--c-fg-disabled` | `#5d636d` | `#9aa0a9` | Disabled controls only (WCAG-exempt). Never for information |
| `--c-scrim` | `rgba(0,0,0,0.62)` | `rgba(16,18,22,0.36)` | Dialog overlay |

#### Semantic tokens

| Role | Token family | Dark fg / tint / mark | Light fg / tint / mark | Meaning (reserved) |
|---|---|---|---|---|
| Accent | `--c-accent`, `--c-accent-tint`, `--c-on-accent` | `#7aa7ff` / `#152038` / on `#0a1020` | `#2f5fd0` / `#e5ecfb` / on `#ffffff` | Focus, selection, primary non-destructive action, links |
| Profit | `--c-pos`, `--c-pos-tint`, `--c-pos-mark` | `#3fcf8e` / `#0f2a1e` / `#22a06b` | `#137a48` / `#e3f4ea` / `#1e8f57` | Positive after-cost PnL, gate passed |
| Loss | `--c-neg`, `--c-neg-tint`, `--c-neg-mark` | `#ff7a7a` / `#2e1416` / `#e5545a` | `#c42b34` / `#fbe7e8` / `#d6363f` | Negative after-cost PnL, gate failed |
| Warning | `--c-warn`, `--c-warn-tint`, `--c-warn-fill`, `--c-on-warn` | `#f2b84b` / `#2b220f` / fill `#f2b84b` on `#1a1203` | `#8a5a00` / `#fbf0d9` / fill `#f2b84b` on `#1a1203` | Stale data, approaching a limit, degraded health |
| Danger | `--c-danger`, `--c-danger-fill`, `--c-on-danger` | `#ff6b6b` / fill `#ff6b6b` on `#1a0505` | `#c0262e` / fill `#c0262e` on `#ffffff` | Kill switch, breached limit, critical alert, destructive action |
| Info | `--c-info` | `#6cb6ff` | `#1f62b8` | Neutral notices |
| Paper mode | `--c-paper`, `--c-paper-tint`, `--c-paper-fill`, `--c-on-paper` | `#4fd1e0` / `#0d2629` / fill `#4fd1e0` on `#05181b` | `#0b7285` / `#e0f3f6` / fill `#0b7285` on `#ffffff` | Simulated trading only. Always with the hatch pattern |
| Live mode | `--c-live`, `--c-live-tint`, `--c-live-fill`, `--c-on-live` | `#e05cf0` / `#2a0f2e` / fill `#e05cf0` on `#16061a` | `#a21caf` / `#f8e4fb` / fill `#a21caf` on `#ffffff` | Real funds (live-small and live). Used nowhere else |
| Offline mode | (uses neutrals) | outline `#666d78`, bar `#181b20` | outline `#7d8490`, bar `#f1f3f6` | Backtest and replay. Outline style, no fill colour |

**CVD-safe polarity alternative** (setting `polarity = blue-orange`, D-UI-02): profit fg `#6cb6ff` (dark) / `#1f62b8` (light), mark `#3987e5` / `#2a78d6`; loss fg `#ff9e5c` / `#b54708`, mark `#d95926` / `#eb6834`. **COMPUTED** text contrast: dark profit 8.65:1 and loss 9.12:1 on surface-1; light profit 6.00:1 and loss 5.43:1 on surface-1. Chart marks: dark 5.11:1 and 4.79:1, light 4.42:1 and 3.20:1 on surface-1.

#### Contrast results (COMPUTED, WCAG 2.2 formula)


**Dark - text and semantic foregrounds**

| Token | Hex | canvas `#0b0c0e` | s1 `#111317` | s2 `#181b20` | s3 `#1f232a` | AA text (4.5:1)? |
|---|---|---|---|---|---|---|
| fg-primary | `#eceef1` | 16.83 | 16.00 | 14.85 | 13.56 | yes |
| fg-secondary | `#b3b9c3` | 9.92 | 9.43 | 8.75 | 7.99 | yes |
| fg-tertiary | `#8d939e` | 6.34 | 6.02 | 5.59 | 5.10 | yes |
| fg-disabled | `#5d636d` | 3.23 | 3.07 | 2.85 | 2.61 | n/a (disabled, WCAG-exempt) |
| accent | `#7aa7ff` | 8.20 | 7.79 | 7.23 | 6.61 | yes |
| pos | `#3fcf8e` | 9.81 | 9.32 | 8.65 | 7.90 | yes |
| neg | `#ff7a7a` | 7.75 | 7.36 | 6.84 | 6.24 | yes |
| warn | `#f2b84b` | 10.93 | 10.39 | 9.65 | 8.81 | yes |
| danger | `#ff6b6b` | 7.05 | 6.70 | 6.22 | 5.68 | yes |
| info | `#6cb6ff` | 9.11 | 8.65 | 8.03 | 7.34 | yes |
| paper | `#4fd1e0` | 10.74 | 10.21 | 9.48 | 8.65 | yes |
| live | `#e05cf0` | 6.48 | 6.16 | 5.72 | 5.22 | yes |

**Light - text and semantic foregrounds**

| Token | Hex | canvas `#f7f8fa` | s1 `#ffffff` | s2 `#f1f3f6` | s3 `#ffffff` | AA text (4.5:1)? |
|---|---|---|---|---|---|---|
| fg-primary | `#16181d` | 16.71 | 17.76 | 15.98 | 17.76 | yes |
| fg-secondary | `#454b55` | 8.27 | 8.78 | 7.90 | 8.78 | yes |
| fg-tertiary | `#5f6672` | 5.44 | 5.78 | 5.20 | 5.78 | yes |
| fg-disabled | `#9aa0a9` | 2.48 | 2.63 | 2.37 | 2.63 | n/a (disabled, WCAG-exempt) |
| accent | `#2f5fd0` | 5.39 | 5.72 | 5.15 | 5.72 | yes |
| pos | `#137a48` | 5.06 | 5.38 | 4.84 | 5.38 | yes |
| neg | `#c42b34` | 5.28 | 5.61 | 5.05 | 5.61 | yes |
| warn | `#8a5a00` | 5.58 | 5.93 | 5.33 | 5.93 | yes |
| danger | `#c0262e` | 5.55 | 5.90 | 5.31 | 5.90 | yes |
| info | `#1f62b8` | 5.65 | 6.00 | 5.40 | 6.00 | yes |
| paper | `#0b7285` | 5.26 | 5.59 | 5.02 | 5.59 | yes |
| live | `#a21caf` | 5.95 | 6.32 | 5.69 | 6.32 | yes |

**Dark - text on filled and tinted backgrounds**

| Pair | Foreground | Background | Ratio | Requirement | Pass |
|---|---|---|---|---|---|
| on-live (mode bar text) | `#16061a` | `#e05cf0` | 6.47 | 4.5:1 | yes |
| on-paper (mode bar text) | `#05181b` | `#4fd1e0` | 10.00 | 4.5:1 | yes |
| on-danger (kill button text) | `#1a0505` | `#ff6b6b` | 7.09 | 4.5:1 | yes |
| on-accent (primary button text) | `#0a1020` | `#7aa7ff` | 7.94 | 4.5:1 | yes |
| on-warn (badge text) | `#1a1203` | `#f2b84b` | 10.37 | 4.5:1 | yes |
| pos on pos-tint | `#3fcf8e` | `#0f2a1e` | 7.68 | 4.5:1 | yes |
| neg on neg-tint | `#ff7a7a` | `#2e1416` | 6.77 | 4.5:1 | yes |
| warn on warn-tint | `#f2b84b` | `#2b220f` | 8.77 | 4.5:1 | yes |
| paper on paper-tint | `#4fd1e0` | `#0d2629` | 8.69 | 4.5:1 | yes |
| live on live-tint | `#e05cf0` | `#2a0f2e` | 5.77 | 4.5:1 | yes |
| accent on selected row | `#7aa7ff` | `#1b2333` | 6.59 | 4.5:1 | yes |
| fg-primary on selected row | `#eceef1` | `#1b2333` | 13.53 | 4.5:1 | yes |
| fg-primary on offline bar (surface-2) | `#eceef1` | `#181b20` | 14.85 | 4.5:1 | yes |

**Light - text on filled and tinted backgrounds**

| Pair | Foreground | Background | Ratio | Requirement | Pass |
|---|---|---|---|---|---|
| on-live (mode bar text) | `#ffffff` | `#a21caf` | 6.32 | 4.5:1 | yes |
| on-paper (mode bar text) | `#ffffff` | `#0b7285` | 5.59 | 4.5:1 | yes |
| on-danger | `#ffffff` | `#c0262e` | 5.90 | 4.5:1 | yes |
| on-accent | `#ffffff` | `#2f5fd0` | 5.72 | 4.5:1 | yes |
| on-warn (badge text) | `#1a1203` | `#f2b84b` | 10.37 | 4.5:1 | yes |
| pos on pos-tint | `#137a48` | `#e3f4ea` | 4.71 | 4.5:1 | yes |
| neg on neg-tint | `#c42b34` | `#fbe7e8` | 4.73 | 4.5:1 | yes |
| warn on warn-tint | `#8a5a00` | `#fbf0d9` | 5.24 | 4.5:1 | yes |
| paper on paper-tint | `#0b7285` | `#e0f3f6` | 4.87 | 4.5:1 | yes |
| live on live-tint | `#a21caf` | `#f8e4fb` | 5.26 | 4.5:1 | yes |
| accent on selected row | `#2f5fd0` | `#e8eefc` | 4.92 | 4.5:1 | yes |
| fg-primary on selected row | `#16181d` | `#e8eefc` | 15.28 | 4.5:1 | yes |
| fg-primary on offline bar (surface-2) | `#16181d` | `#f1f3f6` | 15.98 | 4.5:1 | yes |

**Non-text (WCAG 1.4.11, 3:1) - dark**

| Pair | Foreground | Background | Ratio | Requirement | Pass |
|---|---|---|---|---|---|
| border-control vs surface-1 | `#666d78` | `#111317` | 3.56 | 3:1 | yes |
| border-control vs surface-2 | `#666d78` | `#181b20` | 3.31 | 3:1 | yes |
| focus-ring vs canvas | `#7aa7ff` | `#0b0c0e` | 8.20 | 3:1 | yes |
| focus-ring vs surface-3 | `#7aa7ff` | `#1f232a` | 6.61 | 3:1 | yes |
| live frame vs canvas | `#e05cf0` | `#0b0c0e` | 6.48 | 3:1 | yes |
| paper frame vs canvas | `#4fd1e0` | `#0b0c0e` | 10.74 | 3:1 | yes |
| pos-mark vs surface-1 | `#22a06b` | `#111317` | 5.59 | 3:1 | yes |
| neg-mark vs surface-1 | `#e5545a` | `#111317` | 5.09 | 3:1 | yes |
| meter warn fill vs track | `#f2b84b` | `#23272e` | 8.37 | 3:1 | yes |
| meter danger fill vs track | `#ff6b6b` | `#23272e` | 5.40 | 3:1 | yes |

**Non-text (WCAG 1.4.11, 3:1) - light**

| Pair | Foreground | Background | Ratio | Requirement | Pass |
|---|---|---|---|---|---|
| border-control vs surface-1 | `#7d8490` | `#ffffff` | 3.77 | 3:1 | yes |
| border-control vs canvas | `#7d8490` | `#f7f8fa` | 3.54 | 3:1 | yes |
| focus-ring vs surface-1 | `#2f5fd0` | `#ffffff` | 5.72 | 3:1 | yes |
| live frame vs canvas | `#a21caf` | `#f7f8fa` | 5.95 | 3:1 | yes |
| paper frame vs canvas | `#0b7285` | `#f7f8fa` | 5.26 | 3:1 | yes |
| pos-mark vs surface-1 | `#1e8f57` | `#ffffff` | 4.10 | 3:1 | yes |
| neg-mark vs surface-1 | `#d6363f` | `#ffffff` | 4.71 | 3:1 | yes |
| meter warn fill (light) vs track | `#b07400` | `#e6e8ec` | 3.20 | 3:1 | yes |
| meter danger fill vs track | `#c0262e` | `#e6e8ec` | 4.81 | 3:1 | yes |

Notes:
- The light-theme `pos on pos-tint` (4.71) and `neg on neg-tint` (4.73) pairs pass AA, but with little margin. Do not lighten those foregrounds or darken those tints without re-running the check. UI-T02 automates this check.
- `--c-fg-disabled` is below 4.5:1 on purpose and is used **only** on disabled controls, which WCAG 1.4.3 exempts. A disabled control always has a tooltip or adjacent text explaining *why* it is disabled, and that text uses `--c-fg-secondary`.
- The warning tone in light meters uses `#b07400` (3.20:1 against its track) because the text-weight `#8a5a00` is too dark to read as amber in a bar.

#### Colour-vision results (COMPUTED with the validator)

| Pair or palette | Mode | Worst simulated ΔE (CVD) | Normal-vision ΔE | Verdict |
|---|---|---|---|---|
| Profit `#3fcf8e` vs loss `#ff7a7a` (text) | dark | 3.3 (deutan) | 29.6 | **Fails CVD.** Redundant encoding is mandatory |
| Profit mark `#22a06b` vs loss mark `#e5545a` | dark | 5.1 (deutan) | 29.3 | **Fails CVD** (as above) |
| Profit mark `#1e8f57` vs loss mark `#d6363f` | light | 5.1 (deutan) | 30.0 | **Fails CVD** (as above) |
| Blue `#3987e5` vs orange `#d95926` (alt marks) | dark | 26.8 (protan) | 31.8 | Pass |
| Blue `#2a78d6` vs orange `#eb6834` (alt marks) | light | 24.7 (protan) | 33.6 | Pass |
| Live `#e05cf0` vs paper `#4fd1e0` | dark | 12.1 (deutan) | 32.1 | Pass |
| Live `#e05cf0` vs loss/danger `#ff6b6b` | dark | 21.6 (deutan) | 21.4 | Pass |
| Rejected candidate: live magenta-pink `#ff5fb4` vs loss `#ff7a7a` | dark | 9.2 | **11.2** | Rejected: too close for normal vision |
| Rejected candidate: live `#ff5fb4` vs offline gray `#a3a9b3` | dark | **0.8** (deutan) | 12.2 | Rejected: invisible to deuteranopes. This is why offline is outline-only |
| Live `#a21caf` vs paper `#0b7285` | light | 6.7 (deutan, warn band) | 26.7 | Pass with mandatory secondary encoding (hatch + text), which the mode bar always has |
| Categorical 8 slots (dark steps) on `#111317` | dark | 8.4 adjacent | 19.3 adjacent | Pass (adjacent pairs) |
| Categorical 8 slots (light steps) on `#ffffff` | light | 9.1 adjacent | 19.6 adjacent | Pass; 3 slots below 3:1 contrast, so labels or a table view are required |
| First 3 categorical slots, all pairs | both | 9.4 dark / 9.2 light | 20.9 / 24.0 | Pass. Scatter and small multiples are capped at 3 series |

**DECISION D-UI-02 — profit/loss colours.**
- Option A: green/red (convention in trading UIs). Fails CVD separation (ΔE 3.3–5.1), so it is only legal with secondary encoding.
- Option B: blue/orange. Passes CVD (ΔE ≥ 24), but is unconventional, and some operators read orange as "warning".
- **Recommendation:** A by default, with **mandatory** secondary encoding everywhere (sign character `+`/`−` using U+2212 MINUS SIGN, a ▲/▼ glyph in tiles, and bars above or below a zero baseline in charts), plus a persistent per-operator setting that switches to B. Colour is never the only carrier of polarity (WCAG 1.4.1 Use of Color, UI-F28).

**DECISION D-UI-03 — live-mode hue.**
- Option A: red (the "recording" convention). It collides with loss and danger, so a red live bar beside red losses dilutes both signals.
- Option B: a reserved orchid/magenta, `#e05cf0` dark / `#a21caf` light, used for nothing else in the product. It separates from loss/danger (ΔE 21) and from paper (ΔE 32).
- **Recommendation:** B. The hue is learned once and means only "real funds".

#### Data-visualisation palette

| Job | Tokens | Rule |
|---|---|---|
| Polarity (PnL bars, baseline area) | `--c-pos-mark` / `--c-neg-mark` (or the alt blue/orange) | Bars grow from a zero baseline. Positive above, negative below. Area fills at 10% opacity of the mark |
| Equity curve (single series) | `--c-fg-primary` line, 2px | A single series needs no legend; the panel title names it. The baseline (starting equity) is a solid 1px `--c-border-strong` line |
| Drawdown | `--c-neg-mark` area at 10% + 1.5px stroke | Plotted on its own panel below equity (never a second y-axis) |
| Categorical (strategies, venues, cost types) | Slots 1–8: dark `#3987e5, #d95926, #199e70, #c98500, #d55181, #008300, #9085e9, #e66767`; light `#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #4a3aa7, #e34948` | Fixed order, assigned by entity ID (a stable hash to a slot, persisted), never by rank. Past 8 series, fold into "Other". Scatter and small multiples use ≤ 3 series. These are the validated neutral reference slots of the data-viz method, checked here against Console surfaces |
| Sequential (heat maps such as PnL by hour) | Single hue ramp from `--c-bg-surface-2` to the slot-1 blue | Lightness must be monotonic; UI-T15 checks it automatically |
| Diverging (PnL heat maps) | `--c-neg-mark` ← neutral `--c-bg-surface-2` → `--c-pos-mark`, 3 steps per arm, interpolated in OKLCH | Neutral midpoint means zero. Equal steps per arm |
| Status in charts (latency above SLO, etc.) | `--c-warn`, `--c-danger` | Only when the series *means* good or bad; always with an icon + label |
| Gridlines / axis | dark `#1d2127` / `#3a3f48`; light `#eceef1` / `#c4c9d1` | Solid 1px hairlines, never dashed. Axis text uses `--c-fg-tertiary` |
| Thresholds (stop, target, limit) | 1px lines in `--c-neg-mark` (stop), `--c-pos-mark` (target), `--c-warn` (limit), with an end label | Labels name the threshold and its value; colour is never the only identifier |

Mark specs: lines 2px with round joins; bars at most 24px thick with 4px rounded data ends and square baseline ends; 2px surface gap between adjacent bars; markers ≥ 8px with a 2px surface ring; hover hit area ≥ 24px. Text never takes the series colour; values and labels use text tokens. Every chart has a "View as table" toggle (UI-T15).

### Typography

**DECISION D-UI-01 — typefaces.**
- Option A: **Inter** (UI) + **JetBrains Mono** (identifiers). Both OFL (UI-F25, UI-F26). Inter has `tnum` tabular figures, `zero` slashed zero, `ss02` disambiguation and an `opsz` axis (14–32) for display sizes (UI-F25).
- Option B: Geist + Geist Mono (OFL, UI-F17). High quality, but a dashboard set in Vercel's house face reads as Vercel-derived, against the brief's "inspiration, not copying".
- Option C: system UI fonts. Zero bytes to download, but inconsistent figures across operating systems and no guaranteed tabular or slashed-zero features.
- **Recommendation: A.** Self-host the variable WOFF2 files from the `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` packages (npm licence field `OFL-1.1`, UI-F32). Include the OFL text in `/licenses`. Do not load fonts from a third-party CDN at runtime: the dashboard must work on an isolated network and must not leak usage to third parties.

Font features: tables, tickers and all numeric cells use `font-variant-numeric: tabular-nums slashed-zero` (`tnum`, `zero`). Large stat values use proportional figures. Addresses, signatures and mints use JetBrains Mono.

Metric-matched fallback: define `Inter Fallback` from `local("Arial")` with `size-adjust`, `ascent-override` and `descent-override` values measured during UI-T03, to avoid layout shift (technique observed in Vercel's CSS, UI-F10).

| Token | Size / line height | Weight | Tracking | Family | Use |
|---|---|---|---|---|---|
| `--t-micro` | 11 / 16px | 500 | +0.01em | Inter | Badges, column group labels, chart axis ticks |
| `--t-mini` | 12 / 16px | 400 | 0 | Inter | Metadata, timestamps, helper text |
| `--t-small` | 13 / 20px | 400 (500 for emphasis) | -0.003em | Inter, tnum | **Default** for tables, lists and panels |
| `--t-body` | 14 / 20px | 400 | -0.006em | Inter | Forms, dialogs, prose |
| `--t-label` | 13 / 20px | 500 | -0.003em | Inter | Field labels, nav items, buttons |
| `--t-title-sm` | 15 / 22px | 600 | -0.01em | Inter | Panel titles |
| `--t-title` | 18 / 24px | 600 | -0.012em | Inter (opsz auto) | Page titles |
| `--t-heading` | 24 / 32px | 600 | -0.018em | Inter (opsz auto) | Dialog headline for A3 actions, mobile header |
| `--t-stat` | 28 / 36px | 600 | -0.02em | Inter, proportional figures | Stat-tile value |
| `--t-hero` | 40 / 48px | 600 | -0.022em | Inter, proportional | One hero number per view (total equity) |
| `--t-mono-sm` | 12 / 16px | 400 | 0 | JetBrains Mono | Addresses, signatures, IDs, log lines |
| `--t-mono` | 13 / 20px | 400 | 0 | JetBrains Mono | Config keys, JSON views |

Rules: sentence case everywhere; no all-caps except the mode bar label (a deliberate exception, 11px with +0.06em tracking); never below 11px; text resizes to 200% without loss (WCAG 1.4.4, UI-F28).

### Number, unit and identifier formatting

These rules are part of the contract. The backend sends exact integers; the UI formats them (see the View-model contract).

| Quantity | Wire form (from VM) | Display rule | Exact value |
|---|---|---|---|
| SOL amount | `*_lamports` decimal string (1 lamport = 0.000000001 SOL, UI-F30) | Convert with integer arithmetic (BigInt), never floating point. Default 4 decimals for balances and positions, 6 for fees. If a non-zero value would round to zero, show `<0.0001 SOL`. Thousands separators. Suffix ` SOL` | Tooltip and copy give the exact lamports and the exact 9-decimal SOL |
| Fee per signature, priority fee | `*_lamports`; compute-unit price as `*_micro_lamports_per_cu` (1,000,000 micro-lamports = 1 lamport, UI-F30) | Lamports for per-transaction fees under 0.001 SOL (for example `5,000 lamports`), SOL above that | Tooltip shows both |
| Token amount | `*_base` (u64 base units, UI-F30) + `decimals` (u8) from the mint | `base / 10^decimals` with BigInt. Compact `12.4M` above 1,000,000. Never show more than 6 significant decimals in tables | Tooltip: exact display amount + base units + decimals |
| Token price | `price_sol_per_token` and `price_usd_per_token`, decimal strings | 4 significant digits. For values below 0.001, use zero-compressed notation `0.0₅4321` (subscript = count of zeros after the point), with `aria-label="0.000004321"` | Tooltip: full decimal string |
| USD | `*_usd_e6` (integer micro-USD as string) | `$1,234.56`. Under one cent: `<$0.01`. Always prefixed `≈` when derived from a SOL/USD rate, with the rate's `as_of` in the tooltip | Tooltip: rate used, source, as-of |
| Fees, slippage, price impact, cost ratios | `*_bps` integer (1 bps = 0.01%) | Show in **bps** with suffix (`35 bps`) | Tooltip: `0.35%` |
| Returns, win rate, drawdown, limit usage, CI bounds | `*_bps` integer | Show in **%** with up to 2 decimals (`52.34%`) | Tooltip: bps value |
| PnL | `*_lamports` signed string | Always signed: `+0.0123 SOL` / `−0.0045 SOL` (U+2212). Exactly zero shows `±0`. Colour from polarity tokens + ▲/▼ in tiles | — |
| Time | `*_at` RFC 3339 UTC with milliseconds and `Z` | Tables: `14:02:11` with a `UTC` column header; a setting switches to local time. Ages: `4m 12s`, `2h 03m`, `3d 4h` | Tooltip: full ISO 8601 |
| Slot | `*_slot` decimal string | Plain digits in mono, no separators | — |
| Durations / latency | `*_ms` number | `<1 ms`, `85 ms`, `1.2 s` | — |
| Addresses, mints, signatures | base58 strings | Mono, middle-truncated: first 4 + `…` + last 4. Copy button. Always shown next to any token symbol | Tooltip: full string |
| Token symbol and name | untrusted strings | Rendered as text only; Unicode bidi controls and zero-width characters stripped; length capped at 12 (symbol) and 32 (name) characters with ellipsis; a "?" badge when the name contains non-Latin or mixed scripts | The mint address is the identity, never the symbol |

### Spacing, layout and density

- Base unit 4px. Scale: `--s-0 0`, `--s-1 2px`, `--s-2 4px`, `--s-3 6px`, `--s-4 8px`, `--s-5 12px`, `--s-6 16px`, `--s-7 20px`, `--s-8 24px`, `--s-9 32px`, `--s-10 40px`, `--s-11 48px`, `--s-12 64px`. (A 4px base is also Vercel's `--geist-space`, UI-F14. It is a common convention, not a borrowed asset.)
- Desktop frame (≥ 1280px wide): sidebar 232px (collapsible to 56px), header 48px, mode bar 32px, status bar 28px, content padding 24px, panel gap 16px, 12-column grid with 16px gutters. Inspector drawer 440px from the right.
- Tablet (768–1279px): sidebar collapses to icons; the inspector becomes a full-height overlay.
- Mobile (< 768px): the dedicated monitor layout (S-14).
- Density setting: **Compact** (table row 28px), **Standard** (32px, default), **Comfortable** (40px). Pointer targets are never below 24×24px (WCAG 2.5.8, UI-F28); on mobile, ≥ 44×44px.
- Reflow: every screen works at 320 CSS px wide (WCAG 1.4.10, UI-F28). Data tables may scroll horizontally, which WCAG allows for two-dimensional data.

### Radius, borders and elevation

| Token | Value | Use |
|---|---|---|
| `--r-1` | 4px | Badges, kbd, checkboxes, chart bar ends |
| `--r-2` | 6px | Buttons, inputs, menu items, table row focus |
| `--r-3` | 8px | Panels, cards, stat tiles |
| `--r-4` | 12px | Popovers, dialogs, command palette, drawers (leading edge) |
| `--r-pill` | 9999px | Mode pill, status pills, toggles |
| `--b-hair` | 1px | All borders. No 2px borders except focus and mode frame |

| Level | Name | Dark | Light | Use |
|---|---|---|---|---|
| e0 | Canvas | `--c-bg-canvas` | `--c-bg-canvas` | Page |
| e1 | Panel | `--c-bg-surface-1` + 1px `--c-border-subtle` | `#ffffff` + 1px `--c-border-subtle` | Panels, tables |
| e2 | Raised | `--c-bg-surface-2` | `--c-bg-surface-2` | Hover, inline editors |
| e3 | Floating | `--c-bg-surface-3` + 1px `--c-border-default` + `0 8px 24px rgba(0,0,0,.40)` | `#fff` + 1px `--c-border-default` + `0 8px 24px rgba(16,18,22,.10)` | Menus, popovers, tooltips, command palette |
| e4 | Modal | as e3 + `0 16px 48px rgba(0,0,0,.55)` + scrim | as e3 + `0 16px 48px rgba(16,18,22,.16)` + scrim | Dialogs, drawers |

Z-index layers (named, never ad hoc): `--z-sticky 10`, `--z-header 100`, `--z-drawer 400`, `--z-popover 600`, `--z-command 650`, `--z-dialog 700`, `--z-toast 800`, `--z-tooltip 1100`, `--z-mode-frame 1300`. The mode frame sits above everything, including dialogs, so the live or paper frame stays visible while a confirmation dialog is open. It is `pointer-events: none`.

### Motion

| Token | Value | Use |
|---|---|---|
| `--d-instant` | 0ms | Highlight-in on hover (no lag) |
| `--d-fast` | 100ms | Colour and opacity changes, hover-out |
| `--d-base` | 160ms | Popover, menu, tooltip, tab indicator |
| `--d-slow` | 240ms | Drawer, dialog, command palette enter |
| `--d-value-flash` | 800ms | Background tint fade when a table cell value changes |
| `--e-standard` | `cubic-bezier(.4,0,.2,1)` | Most transitions |
| `--e-enter` | `cubic-bezier(.2,0,0,1)` | Elements entering (decelerate) |
| `--e-exit` | `cubic-bezier(.4,0,1,1)` | Elements leaving (accelerate) |
| `--hold-to-confirm` | 1000ms | Hold duration for the HALT hold gesture |

Rules:
- Exits are 30% faster than entries. Animations are interruptible by user input.
- **Reduced motion** (`prefers-reduced-motion: reduce` or the in-app setting): all transforms and slides become 0ms opacity fades of `--d-fast`; value flashes become a static 2px left marker that clears after 2s; skeleton shimmer becomes static.
- **No flashing:** a cell's value flash can fire at most once per 1000ms. Flash rate stays well below WCAG 2.3.1's three-flashes-per-second ceiling (UI-F28). Live prices never blink.
- Numbers never animate (no count-up tweening). A changing value is replaced instantly; only the tint fades.
- Loading indicators appear after a 200ms delay and stay at least 400ms once shown (within the ranges of Vercel's guidelines, UI-F16).

### Iconography

- **Lucide** icons (npm `lucide-react` 1.52.0, licence ISC per npm metadata, UI-F32; built with 1.47.0, the audited version, see U-04), 16px in tables and buttons, 20px in empty states, 1.5px stroke, `currentColor`.
- Icons never stand alone for state: each status icon has a text label or an accessible name.
- Reserved state icons: profit `trending-up`, loss `trending-down`, warning `triangle-alert`, danger `octagon-alert`, halt `octagon-x` (or a stop glyph), paper `flask-conical`, live `radio` (broadcast), offline `history`, stale `clock-alert`, disconnected `unplug`, locked/step-up `lock-keyhole`. Exact icon names must be confirmed against the installed Lucide version during UI-T04 (**UNVERIFIED** that each of these names exists in 1.52.0).
- Token images: **never load remote token logos** from token metadata URIs (they are attacker-controlled, can track the operator's IP, and can carry malicious SVG). Show a deterministic identicon generated locally from the mint address.

### Focus, selection, scrollbars

- Focus: 2px `--c-accent` outline, 2px offset, on `:focus-visible` only. In live mode the focus ring stays accent blue, not live orchid. Focused elements are never covered by sticky headers (WCAG 2.4.11 Focus Not Obscured, UI-F28): use `scroll-margin-top` equal to the sticky header height.
- Text selection: `--c-accent` at 30% alpha.
- Scrollbars: 8px, `--c-border-default` thumb, transparent track; `color-scheme` set on `<html>` so native controls match the theme.

### Mode treatment (how paper and live are unmistakable)

| Channel | Offline (backtest, replay) | Paper | Live-small and live |
|---|---|---|---|
| Mode bar (32px, top, full width, cannot be hidden) | `--c-bg-surface-2`, 1px `--c-border-control` underline, icon `history`, text `REPLAY · simulated clock 2026-09-30 14:02:11 · 10×` or `BACKTEST · run #42` | `--c-paper-fill` with a 45° hatch (8px period, 15% darker stripe), text `PAPER · simulated fills · no real funds` | `--c-live-fill` solid, text `LIVE-SMALL · REAL FUNDS · max 0.25 SOL per trade` or `LIVE · REAL FUNDS` (numbers illustrative; real caps come from VM-03) |
| Viewport frame | none | 2px inset frame `--c-paper` (dashed 6/4) | 2px inset frame `--c-live` (solid) |
| Document title prefix | `[REPLAY]` / `[BACKTEST]` | `[PAPER]` | `[LIVE]` |
| Favicon | gray outline | cyan with hatch | orchid filled dot |
| Money values | suffix tag `SIM` in tooltips | Inline `SIM` micro-badge on PnL tiles and in table headers ("PnL (sim)") | No badge; the primary action buttons carry a sublabel "real funds" |
| Confirmation dialogs | Title prefix "Replay:" | Title prefix "Paper:" | Title prefix "LIVE:" + orchid top border on the dialog |
| Screen reader | On load and on change: polite live region "Mode: replay" | "Mode: paper trading, simulated" | Assertive live region: "Mode: live, real funds" |
| Mode unknown (disconnected) | Mode bar turns `--c-bg-surface-2` with `--c-warn` text: `MODE UNKNOWN · last known LIVE at 14:02:11 UTC · reconnecting` | same | same; the frame keeps the last known style, plus a warning stripe |

### Component inventory

Each component lists its variants and **every** state. Universal states apply to every interactive component unless marked otherwise: `default`, `hover`, `active/pressed`, `focus-visible`, `disabled` (with a reason tooltip). "Money-affecting" components add `pending` (the server has not answered), `confirmed` (the server acknowledged) and `failed` (the server rejected, or the request timed out with an unknown outcome).

| # | Component | Variants | States (beyond universal) | Notes |
|---|---|---|---|---|
| C01 | Button | primary (accent), secondary (outline), ghost, danger (filled danger), live-confirm (orchid outline; only inside LIVE dialogs) | `loading` (spinner left of the unchanged label, width locked), `pending`, `confirmed` (check icon for 1.2s), `failed` (inline error below) | Heights 28 / 32 / 40px. Never pre-disabled to block a form (validate on submit instead) |
| C02 | IconButton | ghost, outline | `loading`, `toggled-on` | Always has `aria-label` and a tooltip with its shortcut |
| C03 | HoldButton (HALT) | danger | `idle`, `holding` (progress ring fills over 1000ms), `released-early` (ring rewinds over 160ms, no action), `sending`, `acked` (server confirmed), `unconfirmed` (no response in 5s), `failed` | The keyboard alternative is focus + Enter, which opens the HALT dialog. No hold gesture is required for keyboard users |
| C04 | KillSwitch panel | header compact, Risk page full | `running`, `halt-requested`, `halted` (with reason + actor + time), `halt-partial` (some components unacknowledged; lists them), `auto-halted` (tripped by the risk engine; shows the breaker), `resume-requested`, `exits-only` (VM-03 `trading_state = exits_only`; entries blocked, exits managed; UC-07), `sentinel-managing` (VM-03 `signer.exit_lease_holder = sentinel`; the engine has stopped exit work for leased mints; UC-07), `unknown` (disconnected) | Always visible in the header. See Safety UX |
| C05 | ModeBar | offline-backtest, offline-replay, paper, live-small, live | `steady`, `transition-pending` (striped progress + "switching to PAPER…"), `scheduled` (countdown "LIVE-SMALL in 0:42 · Cancel"), `unknown` | Cannot be dismissed, collapsed or scrolled away |
| C06 | ModePill | as C05 | as C05 | Compact version for the mobile header and dialog titles |
| C07 | TextInput | default, with unit adornment (`SOL`, `bps`, `%`, `ms`), search | `filled`, `invalid` (message + icon), `warning` (valid but risky; amber message), `read-only`, `dirty` (changed from saved; 2px left marker) | Labels always visible (no placeholder-only labels) |
| C08 | AmountInput | SOL, token, bps, percent | as C07 + `out-of-range` (shows min/max), `exceeds-limit` (shows the limit and a link to it) | Parses exactly: a SOL value with more than 9 decimals is invalid; it is never rounded silently. Stores lamports as a string |
| C09 | Select / Combobox | single, multi, searchable | `open`, `no-results`, `loading-options`, `option-disabled` (with reason) | Follows the WAI-ARIA combobox pattern: arrows, Enter, Escape, `aria-activedescendant` (UI-F42) |
| C10 | Switch | — | `on`, `off`, `pending` (server-backed switches), `failed` | Never used for money-affecting toggles that need confirmation; those open a dialog |
| C11 | Checkbox, Radio, SegmentedControl | — | `checked`, `unchecked`, `indeterminate` (checkbox) | SegmentedControl is used for time ranges and density |
| C12 | Tabs | underline | `selected`, `has-alert-dot` | URL-synced |
| C13 | Tooltip | text, rich (value + exact value + source) | `open` (after 400ms hover or immediately on focus), `closed` | Never holds the only copy of information needed to act; it carries exact values and sources |
| C14 | Popover / Menu / ContextMenu | — | `open`, `submenu-open`, `item-disabled` | Roving focus; Escape closes; focus returns to the trigger |
| C15 | Dialog | standard, alertdialog (destructive and money-affecting) | `open`, `submitting`, `error`, `closing` | `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby` for alert dialogs (UI-F42). Initial focus on the least destructive action |
| C16 | TypedConfirmDialog | A2, A3 | `empty`, `mismatch` (live hint: characters entered so far), `match` (confirm button becomes active), `step-up-required`, `submitting`, `scheduled` (countdown), `cancelled`, `executed`, `rejected` (server reason), `unknown-outcome` | Paste is **not** blocked, because blocking paste harms assistive-technology users. Instead the phrase contains a dynamic part (target mode + new value, e.g. `LIVE-SMALL 0.25`), so a stale clipboard does not match. Matching is exact and case-sensitive after trimming whitespace |
| C17 | StepUpAuth | passkey | `prompting`, `success`, `cancelled`, `failed`, `unsupported` (no WebAuthn; shows a recovery path) | Uses WebAuthn (W3C Recommendation, Level 3 published 2026-08-25, UI-F40) |
| C18 | Drawer (Inspector) | right, 440px | `open`, `loading`, `error`, `pinned` | Esc closes; URL-synced (`?inspect=<mint>`) |
| C19 | Toast | info, success, warning, danger | `entering`, `visible`, `paused-on-hover`, `exiting` | `role="status"` (polite); danger toasts use `role="alert"`. Money-affecting results are **never** toast-only; they also land in the Alerts or Audit page |
| C20 | Banner (inline) | info, warning, danger, stale, disconnected, paper, live | `visible`, `dismissed` (only info), `persisted` (danger, stale and disconnected cannot be dismissed while true) | Sits above page content, below the header |
| C21 | Badge / StatusPill | neutral, pos, neg, warn, danger, info, paper, live, sim | static | Icon + text, never colour only |
| C22 | Kbd | single key, sequence | static | `⌘K` on macOS, `Ctrl K` elsewhere (platform-detected) |
| C23 | DataTable | standard, dense, grouped | `loading` (skeleton rows after 200ms), `empty` (reason + next step), `error` (keeps last data, shows banner), `stale` (header badge), `filtered-empty`; row: `hover`, `selected`, `focused`, `new` (2s accent left marker), `updated` (cell tint fade), `closing` (strike-through until confirmed), `disabled`; column: `sort-asc`, `sort-desc`, `unsorted`, `resizing`, `pinned` | Virtualised above 200 rows; sticky header; keyboard J/K/Enter; "Copy row as JSON" |
| C24 | StatTile | default, with delta, with sparkline | `loading`, `value`, `stale` (value + "as of" + warning tint border), `error`, `unknown` (`—` + reason), `sim` (badge) | Label, value, delta vs a named period, optional 12-point sparkline |
| C25 | Sparkline | line, bar | `loading`, `empty`, `value`, `stale` | Decorative only when the same data appears in text nearby (`aria-hidden`); otherwise has an `aria-label` summary |
| C26 | TimeSeriesChart | line, area, baseline, bars, candles (Inspector only) | `loading` (previous frame at 50% opacity, or skeleton on first load), `empty`, `error`, `stale`, `gap` (missing data drawn as a break, never interpolated), `hover` (crosshair + one tooltip for all series), `keyboard-focus` (arrow keys step through points), `table-view` | One y-axis per chart; never dual-axis |
| C27 | RiskCheckList | compact (feed row), full (detail) | per check: `pass`, `fail`, `warn`, `skipped` (with reason), `error` (the check could not run, which is treated as a block) | Shows observed vs threshold with units, e.g. `liquidity 182.4 SOL ≥ 50 SOL ✓` |
| C28 | LimitMeter | horizontal bar, compact ring (mobile) | `normal` (< 70%), `elevated` (70–90%), `near` (≥ 90%), `breached` (≥ 100%), `disabled` (limit off; shown as a warning) | Track and fill from the same ramp; label `0.42 / 0.60 SOL (70%)` |
| C29 | FreshnessIndicator | dot + age, text | `live` (age ≤ expected interval), `delayed` (≤ stale threshold), `stale` (> stale threshold), `disconnected`, `paused` (operator paused updates) | Pulse disabled under reduced motion |
| C30 | ConnectionStatus | status bar item | `connected`, `reconnecting (attempt n, next in s)`, `disconnected`, `auth-expired` | — |
| C31 | AddressChip | mint, wallet, signature, program | `default`, `hover`, `copied` (1.2s), `flagged` (known-bad list hit) | External explorer links open with `rel="noopener noreferrer"` and a confirmation the first time (they leak the address to a third party) |
| C32 | StateView | loading, empty, error, stale, disconnected, unauthorised, not-found | — | One component renders every non-happy state consistently (UI-T05) |
| C33 | Skeleton | text line, row, tile, chart | `shimmer`, `static` (reduced motion) | Only for first load; refetches keep the previous frame |
| C34 | CommandPalette | root, nested page | `closed`, `open-empty` (recent + suggested), `filtering`, `no-results`, `page` (nested), `executing` (for actions), `item-disabled` (with reason), `requires-confirmation` (opens the dialog) | ⌘K / Ctrl K; arrows, Enter, Escape; Backspace on an empty input pops the page (behaviour aligned with Geist docs, UI-F15) |
| C35 | ShortcutHelp | overlay | `open`, `filtered` | `?` opens it |
| C36 | FilterBar | date range presets, chips | `default`, `applied` (chip count), `invalid-range` | One row above the content it scopes; URL-synced |
| C37 | ConfigField | number, bool, enum, duration, amount, list | `pristine`, `dirty`, `invalid`, `risk-increasing` (orchid/amber "raises risk" tag), `requires-restart`, `locked` (needs A3), `pending-apply`, `applied`, `rejected` | Generated from the backend schema (VM-15) |
| C38 | DiffView | config, limits | `no-changes`, `changes` (old → new with risk direction), `conflict` (server version changed) | Each line shows the unit |
| C39 | AuditEntry | — | `default`, `expanded` (before/after JSON), `linked` (deep link to the affected entity) | — |
| C40 | ReadinessGate row | — | `pass`, `fail`, `pending-data` (insufficient sample), `waived` (not allowed for live; shown as fail) | Shows metric, required, actual, window, as-of |
| C41 | IntervalBar (CI) | horizontal | `ci-excludes-zero-positive`, `ci-includes-zero`, `ci-excludes-zero-negative`, `insufficient-sample` | Point estimate dot + interval line + zero line |
| C42 | Pagination / LoadMore | cursor | `idle`, `loading`, `end`, `error` | Journal and audit use cursor pagination |
| C43 | NavItem | sidebar | `default`, `hover`, `active`, `with-count`, `with-alert-dot` (warn or danger), `collapsed` (icon + tooltip) | — |
| C44 | Countdown | scheduled action | `running`, `cancelled`, `elapsed`, `server-confirmed` | Shows server-authoritative effective time |
| C45 | EmptyIdenticon | token avatar | static | Generated locally from the mint (no remote images) |

## Screens

### Information architecture

```
/login                         S-00 Sign in (passkey)
/                              S-01 Overview
/positions                     S-02 Open positions          (?inspect=<mint>)
/journal                       S-03 Closed-trade journal    (?from&to&strategy&mint&outcome&exit_reason&mode)
/signals                       S-04 Candidate / signal feed (?decision&strategy&check=<check_id>)
/tokens/:mint                  S-05 Token inspector (also opens as a drawer from any table)
/performance                   S-06 Strategy performance    (?strategy&mode&window)
/risk                          S-07 Risk limits and kill switch
/health                        S-08 System health
/costs                         S-09 Cost tracker            (?period)
/config                        S-10 Configuration
/alerts                        S-11 Alerts
/audit                         S-12 Audit log
/mode                          S-13 Mode control and go-live readiness
/m                             S-14 Mobile monitor (auto-redirect below 768px; link to the full app)
/settings                      S-15 Operator preferences (theme, density, polarity, time zone, shortcuts)
Overlays: ⌘K command palette · ? shortcut help · HALT dialog · step-up dialog · inspector drawer
```

Sidebar order (grouped): **Monitor**: Overview, Positions, Signals, Journal · **Analyse**: Performance, Costs, Token inspector (recent) · **Control**: Risk & kill switch, Mode, Config · **System**: Health, Alerts (count badge), Audit · Settings at the bottom. Every list filter and sort lives in the URL (UI-F16 guideline).

### Global frame (every desktop screen)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│▓ LIVE-SMALL · REAL FUNDS · max 0.25 SOL/trade · since 14:02 UTC          [Mode ▸]  ▓│ ModeBar 32px (C05)
├─────────────┬────────────────────────────────────────────────────────────────────────┤
│ ◆ Console   │ Overview          [Today ▾]      ● Live 0.4s   ⌘K   ( ■ HALT  ⇧H )     │ Header 48px
│ Monitor     ├────────────────────────────────────────────────────────────────────────┤
│  Overview   │ [stale / disconnected / auto-halt banners appear here — C20]            │
│  Positions 3│                                                                        │
│  Signals    │                         page content                                   │
│  Journal    │                                                                        │
│ Analyse     │                                                                        │
│  …          │                                                                        │
├─────────────┴────────────────────────────────────────────────────────────────────────┤
│ Stream ● 0.4s · RPC p50 85 ms · Landing 96.2% (15m) · Errors 0.3/min · 14:02:11 UTC · v0.9.3 │ StatusBar 28px
└──────────────────────────────────────────────────────────────────────────────────────┘
  + 2px inset frame in the mode colour around the whole viewport (above every layer)
```

Values shown in wireframes are illustrative only.

- **ModeBar** (VM-03): `mode`, `mode_since`, `live_caps.max_trade_lamports`, `scheduled_change`, `sim_clock`. Click (or `G M`) opens S-13.
- **Header**: page title, page-scoped filters, the global FreshnessIndicator (worst freshness among the VMs the page uses), the ⌘K hint, and the **HALT** control (C03/C04, VM-03 `trading_state`). When halted, the HALT button is replaced by `HALTED · Resume…` (Resume opens the A2 flow).
- **StatusBar** (VM-13 summary + VM-01 heartbeat): stream state and lag, RPC p50, landing rate, error rate, server UTC time, bot version. Each item links to S-08.
- **Banners** (C20), in priority order with at most 2 visible and the rest collapsed into "+n": `disconnected` > `auto-halted` > `mode unknown` > `stale (page data)` > `scheduled risk increase pending` > `config drift` > info.

### Data freshness model

**DECISION D-UI-10 — live transport.** Option A (**recommended**): Server-Sent Events for server→browser pushes + plain REST for snapshots and commands. Commands never travel over the stream, so a broken stream cannot swallow a HALT. Option B: WebSocket for everything. Bidirectional, but needs custom reconnect and resume logic, and mixing commands into the socket couples the kill switch to stream health. Option C: polling only. Simplest, but adds latency and load for the 1 Hz position marks.

Transport (D-UI-10, Option A): one authenticated **SSE** stream (PROPOSED path `GET /api/v1/stream?topics=…`) carries all push updates as typed envelopes (VM-01). REST GET endpoints return snapshots for first paint and after any gap (PROPOSED `GET /api/v1/vm/{vm}`). Commands are REST POSTs (VM-19). Why SSE: the browser reconnects automatically and resumes with `Last-Event-ID` when each event has an `id`, the server controls the retry delay with `retry`, and comment lines keep idle connections alive (MDN, UI-F37). Because browsers limit SSE to 6 connections per browser and domain without HTTP/2 (UI-F37), the dashboard uses exactly **one** multiplexed stream per tab, serves over HTTP/2 where TLS is used, and a leader election (Web Locks API) plus a `BroadcastChannel` lets extra tabs share the leader tab's stream (UI-T08, UI-F44).

| VM | Mechanism | Expected cadence (PROPOSED) | "Delayed" after | "Stale" after | What stale means for controls |
|---|---|---|---|---|---|
| VM-01 heartbeat | push | every 2s | 4s | 10s → **disconnected** | All money-affecting controls disabled except HALT (sent by direct POST) |
| VM-03 system state | push on change + `state_version` in each heartbeat | on change | — | follows stream | Mode shows "unknown" when disconnected |
| VM-04 balances | push on change; server reconciles with chain at `confirmed` | on change; reconcile every 30s | 45s | 90s | Warning banner; values marked "as of" |
| VM-05 positions | push on change; marks coalesced to ≤ 1 Hz per position | 1s while open | 5s | 10s | Close buttons stay enabled (risk-reducing) but show "mark stale" in the confirmation |
| VM-06 journal | REST pages + push `upsert` on close | on close | — | not applicable (history) | — |
| VM-07 signal feed | push per decision, ≤ 10 events/s coalesced | event-driven | — | follows stream | No events is normal; shows "last candidate 3m ago" |
| VM-08 token inspector | REST on open + push topic `token:<mint>` ≤ 1 Hz | 1s | 5s | 10s | — |
| VM-09 performance | poll REST every 60s + invalidate on trade close | 60s | 120s | 180s | — |
| VM-10 series | REST per range; live tail via push ≤ 1 point / 5s | 5s | 15s | 30s | — |
| VM-11 PnL summary | push, coalesced 1 Hz | 1s | 5s | 10s | — |
| VM-12 risk limits | push on change; usage ≤ 1 Hz | 1s | 3s | 5s | **Danger** banner "Risk status unknown". Raise-limit actions disabled |
| VM-13 health | push every 2s | 2s | 4s | 6s | — |
| VM-14 costs | poll REST every 60s | 60s | 120s | 180s | — |
| VM-15 config | REST on open + push `config.changed` (version only) | on change | — | — | Saving against an old `config_version` → conflict view |
| VM-16 alerts | push create/update + REST list | event-driven | — | follows stream | — |
| VM-17 audit | REST pages + push new entries | event-driven | — | follows stream | — |
| VM-18 readiness | REST on open + poll 30s | 30s | 60s | 90s | Promotion disabled while stale |
| VM-19 command results | POST response + push `command.updated` | event-driven | — | — | An unknown outcome is shown as unknown, never as success |
| VM-20 mobile digest | push every 2s (one combined event) | 2s | 4s | 10s | — |

Clock rules: the server sends `emitted_at` (server wall clock) on every envelope and `server_time` in each heartbeat. The UI estimates `offset = server_time − local_receive_time` (median of the last 10 heartbeats) and computes every age as `now_local + offset − as_of`, so a wrong laptop clock cannot make stale data look fresh. In **replay/backtest**, data timestamps are simulated (`clock: "sim"`). Ages of simulated data are computed against `sim_clock.sim_time`, while connection health always uses the wall clock.

### Universal states

| State | Trigger | Presentation | Rule |
|---|---|---|---|
| Loading (first) | No snapshot yet | Skeleton shaped like the final layout, after a 200ms delay, visible for at least 400ms | Never show zeros or empty tables while loading |
| Refetching | New range or filter | Keep the previous frame + a thin progress line in the panel header. Chart plot areas may fade to 60% opacity; text never fades below AA contrast | No layout jump |
| Empty | Snapshot has zero items | StateView: icon, one-sentence reason, and context (e.g. "No open positions · bot RUNNING in PAPER · last candidate 2m ago"), with a next step if one exists | An empty panel always says *why* it is empty |
| Filtered-empty | Filters exclude everything | "No trades match these filters" + Clear filters | — |
| Error | REST 4xx/5xx or schema validation failure | Inline error with code and message, a Retry button, a "Copy diagnostics" button (no secrets), and the last good data kept at full contrast and marked "as of" | A schema mismatch is an error, never silently ignored |
| Stale | age > stale threshold | Amber `Stale · 12s` badge on the panel, values keep full contrast and show "as of 14:02:11 UTC" | Never hide stale data; label it |
| Disconnected | No heartbeat for 10s | Danger banner across all pages: "Disconnected from bot · showing data as of 14:02:11 UTC · reconnecting (attempt 3, next in 4s)". All money-affecting controls are disabled except HALT. The FreshnessIndicator turns red | The bot keeps running autonomously; the banner says so: "Trading continues on the server under its own risk limits" |
| Unauthorised | 401 / session expired | Redirect to `/login?next=…`, preserving the URL | The stream is closed on 401 |
| Forbidden | 403 (viewer role) | Controls hidden; read-only badge in the header | — |
| Unknown value | Field is null or missing | `—` with tooltip "Not available: <reason code>" | Never coerce to 0 |

### Screen specifications

Each screen lists purpose, layout, fields (with the VM field names they bind to), update mechanism, actions, screen-specific states and keys. The global frame, freshness model and universal states above apply to all of them.

#### S-00 Sign in and step-up

- **Purpose:** authenticate the single operator (or a read-only viewer) with a passkey. Elevate to "control" for money-affecting actions.
- **Layout:** centred 400px card on the canvas: product mark (a plain wordmark "Console", no borrowed logos), the "Sign in with passkey" primary button, a recovery link (a server-side CLI-issued one-time code; never email or SMS, which would send data to third parties), and the environment line `bot-host · tailnet` (from VM-02 `environment_label`).
- **Fields:** VM-02 `webauthn_available`, `environment_label`, `login_rate_limited_until`.
- **Step-up dialog (C17):** opens when a command needs `elevated_until > now`. It shows the action being authorised ("Authorise: raise max position size to 0.30 SOL") and the passkey prompt. On success the server refreshes `elevated_until` (PROPOSED 5 minutes, at the high-value end of OWASP's 2–5 minute idle-timeout range, UI-F38) and rotates the session ID (OWASP: renew the session ID on a privilege change, UI-F38).
- **States:** `idle`, `prompting`, `success → redirect`, `cancelled`, `failed (n attempts left)`, `rate-limited (until)`, `unsupported browser`.
- **Session timing (PROPOSED):** view session idle timeout 30 minutes (read-only monitoring sits in OWASP's low-risk 15–30 minute band; the control privilege is separate and short-lived), absolute timeout 8 hours (the OWASP 4–8 hour example), elevation 5 minutes (UI-F38). A 60-second warning dialog appears before the view session expires.

#### S-01 Overview

```
┌ Equity ────────────────────┐┌ Today (UTC) net PnL ┐┌ Open PnL (net) ┐┌ Costs today ───┐
│ 3.4120 SOL   ≈ $… (as of)  ││ ▲ +0.0412 SOL  sim  ││ ▼ −0.0031 SOL  ││ 0.0042 SOL     │
│ +1.22% vs 00:00 UTC        ││ 14 trades · 57% win ││ 3 positions    ││ 21 bps of vol. │
└────────────────────────────┘└─────────────────────┘└────────────────┘└────────────────┘
┌ Equity & drawdown · 7d ─────────────────────────────┐┌ Risk limits ──────────────────┐
│ equity line (2px)                                    ││ Daily loss  ███░░  42%        │
│ ─────────────── baseline                             ││ Exposure    █░░░░  18%        │
│ drawdown area (separate panel below, same x)         ││ Open pos.   ██░░░  3 / 5      │
└──────────────────────────────────────────────────────┘│ Breakers    0 tripped         │
┌ Open positions (top 5 by |net PnL|) ────────────────┐└───────────────────────────────┘
│ token · size · entry · mark · net PnL · stop · age  │┌ Alerts · open ────────────────┐
└──────────────────────────────────────────────────────┘│ ▲ 2 warning  ● 0 critical    │
┌ Latest candidates ──────────────────────────────────┐└───────────────────────────────┘
│ time · token · strategy · decision · first failed check│┌ Health ───────────────────┐
└──────────────────────────────────────────────────────┘│ RPC ok · stream 0.4s · 96% │
                                                        └───────────────────────────────┘
```

| Panel | Fields (VM) | Update |
|---|---|---|
| Equity (hero, one per view) | VM-04 `totals.equity_lamports`, `totals.equity_usd_e6`, `totals.sol_usd_as_of`, `totals.sol_usd_source`; VM-11 `periods.today_utc.equity_change_bps`; VM-04 `source` (`chain` / `paper_ledger`) → `sim` badge | push |
| Today net PnL | VM-11 `periods.today_utc.net_pnl_lamports`, `.trade_count`, `.win_rate_bps`, `.costs_lamports` | push 1 Hz |
| Open PnL | VM-11 `unrealized_net_lamports`, VM-05 count | push |
| Costs today | VM-11 `periods.today_utc.costs_lamports`, `periods.today_utc.cost_bps_of_volume`; VM-14 `fixed_cost_bps_of_equity_per_month` in the tooltip | push / 60s poll |
| Equity & drawdown | VM-10 `series=equity` and `series=drawdown`, `resolution=1h` for 7d | REST + push tail |
| Risk limits | VM-12 top 4 limits by `usage_bps`, `breakers[].tripped` count | push |
| Open positions | VM-05, top 5 by absolute `unrealized_pnl_net_lamports` | push |
| Alerts | VM-16 counts by severity where `state=open` | push |
| Latest candidates | VM-07, last 10 | push |
| Health | VM-13 `overall_status`, `streams[0].lag_ms`, `tx.landing_rate_bps` | push 2s |

- Period selector (`Today UTC`, `7d`, `30d`, `Since live start`) scopes every tile (FilterBar rule).
- **Empty:** a fresh install shows "No trades yet · mode PAPER · strategies enabled: 2". (The earlier backtest empty-state sentence is removed: backtests never run on the live host, UC-12; imported runs are listed read-only on S-13.)

#### S-02 Open positions

- **Purpose:** see and manage every open position and its after-cost unrealised PnL.
- **Layout:** FilterBar (strategy, token search, state) → DataTable (C23) → Inspector drawer on row Enter.

| Column | Field (VM-05) | Format |
|---|---|---|
| Token | `symbol`, `name`, `mint` | identicon + symbol (sanitised) + mint chip |
| Strategy | `strategy_id` → `name` from VM-03 `strategies[]` | text |
| State | `state` (`opening`, `open`, `partially_closed`, `closing`, `close_failed`); an `opening` row may already show armed stops (UC-03); `stuck` and `orphan` arrive as `close_failed` + reason and `open` + flag `orphan` (B-M28-03) | StatusPill |
| Size | `size_base`, `decimals` | token amount |
| Entry cost | `entry_cost_lamports` (all-in, including entry fees) | SOL, 4 dp |
| Entry price | `entry_price_sol_per_token` | price notation |
| Mark | `mark_price_sol_per_token`, `mark_method`, `mark_as_of` | price + freshness dot; tooltip states the method ("exit quote for full size") |
| Exit value (est.) | `exit_value_est_lamports` (after `exit_cost_est_lamports`) | SOL |
| Unrealised PnL (net) | `unrealized_pnl_net_lamports`, `unrealized_pnl_net_bps`, `unrealized_pnl_net_usd_e6` | signed SOL + % + ▲/▼ |
| Exit impact | `price_impact_exit_bps` | bps; warn when ≥ 300 bps (PROPOSED default, configurable) |
| Stop | `stops[]` (`type`, `trigger_price_sol_per_token`, `trigger_pnl_bps`, `trailing_distance_bps`, `armed`) | nearest trigger, e.g. "−12.0% · 0.0₅3810", plus a "+n" tooltip listing the others (UC-02); red outline if any is disarmed |
| Target | `targets[]` (same fields) | nearest trigger, e.g. "+6.0%", plus "+n" tooltip (UC-02) |
| Time stop | `time_stop_at` | countdown |
| Age | `opened_at` (client-computed with clock offset) | `4m 12s` |
| Flags | `risk_flags[]` (`code`, `severity`, `message`) | icons with labels |

- **Wallet tokens that are not positions (UC-13):** below the table, a collapsed "Other tokens in the wallet" list from VM-04 `wallets[].tokens[]` where `token_class` is `unsolicited` or `written_off`, shown greyed with "received, not traded; not sold automatically" (unsolicited) or "written off" and, for unsolicited mints, an A1 "Close account…" action (VM-19 `close_unsolicited { mint }`). A `close_failed` position (which includes M20 `stuck`) offers an A2 "Write off…" action (VM-19 `write_off_position { position_id }`, UC-14).
- **DECISION D-UI-08 — how open positions are marked.** Option A (**recommended**): `exit_quote`, the estimated net proceeds of selling the **full** size now, after estimated exit fees and price impact. Option B: `mid` price × size, which overstates what an illiquid meme-coin position would actually return. Option C: `last_trade`, which can be stale or manipulated by a single small trade. The UI shows whichever `mark_method` the backend sends and labels B and C with a warning tooltip; whether A is affordable at ≤ 1 Hz is open question Q-02.
- **Actions:** `Close position` (A1, C15 confirm dialog showing estimated proceeds `exit_value_est_lamports`, estimated impact, mark age, and the mode; for live, the "LIVE:" title). `Close all` = FLATTEN ALL (A2, see Safety UX). There is **no** "add to position" or "open position" button in the dashboard; entries come only from strategies (scope decision; this keeps manual discretionary trading out of the operator console).
- **Row states:** `closing` shows a strike-through and spinner until VM-05 reports `closed` or `close_failed`. `close_failed` shows a danger pill with the reason and a "Retry close" button (new `command_id`).
- **Edge cases:** mark stale beyond 10s → the PnL cell shows a stale icon and the confirmation dialog warns that "estimated proceeds may be wrong". A token with `decimals` missing → amount `—` (never assume 6 or 9).
- **Keys:** `J/K` move, `Enter` inspect, `C` close (opens the dialog), `⇧C` close-all dialog, `/` focus search.

#### S-03 Closed-trade journal

- **Layout:** FilterBar (date range presets first, strategy, token, outcome win/loss, exit reason, mode) → totals strip (for the filter: count, net PnL, win rate, total costs) → DataTable with cursor pagination (C42) → row expand.

| Column | Field (VM-06) |
|---|---|
| Closed (UTC) | `closed_at` |
| Token | `symbol`, `mint` |
| Strategy | `strategy_id` |
| Mode | `mode` (paper rows carry the `SIM` badge) |
| Hold | `hold_ms` |
| Entry → exit price | `entry_price_sol_per_token`, `exit_price_sol_per_token` |
| Gross PnL | `gross_pnl_lamports` |
| Costs | `total_costs_lamports` (expand: `costs.network_base_lamports`, `costs.priority_lamports`, `costs.tips_lamports`, `costs.venue_fees_lamports`, `costs.failed_tx_lamports`; plus `implicit_slippage_lamports` shown as information, already inside gross) |
| Net PnL | `net_pnl_lamports`, `net_pnl_bps` |
| Exit reason | `exit_reason` (full UC-01 enum; the S-03 filter lists every value) plus `source` and `shadow` badges (UC-01) |
| Transactions | `entry_signatures[]`, `exit_signatures[]` (AddressChips) |

- Totals: VM-06 `totals.count`, `totals.net_pnl_lamports`, `totals.win_rate_bps`, `totals.total_costs_lamports`, `totals.gross_pnl_lamports`.
- Export: "Download CSV" of the current filter, generated server-side (PROPOSED `GET /api/v1/journal.csv?...`). Amounts are exported as exact integers with the unit in the header (`net_pnl_lamports`).
- Journal rows are immutable. Corrections appear as new audit events, never as edits.

#### S-04 Candidate and signal feed

- **Purpose:** show every candidate the bot considered, with **every** risk-check result and the rejection reason, so the operator can see why it did or did not trade.
- **Layout:** two-pane. Left: a streaming DataTable (newest first, max 500 rows in memory, older rows via "Load earlier" from REST). Right: the selected candidate's detail with the full RiskCheckList (C27). A "Pause stream" toggle freezes the list (new rows counted in a "12 new" pill) so rows do not move while the operator reads. A paused feed must not look live: the FreshnessIndicator shows `paused`.

| Column | Field (VM-07) |
|---|---|
| Time | `detected_at` (+ `decision_latency_ms` in tooltip) |
| Token | `symbol`, `mint` |
| Source | `source` |
| Strategy | `strategy_id` |
| Score | `score`, `score_unit` |
| Decision | `decision` (`accepted`, `rejected`, `expired`, `error`, `pending`) StatusPill |
| First failing check | first `risk_checks[]` with `status in (fail, error)` → `label` + observed vs threshold |
| Checks | compact summary `11 ✓ · 1 ✗ · 1 skipped` |
| Size / cost (intended) | `intended_size_lamports`, `expected_cost_bps`, `expected_price_impact_bps` |
| Quote age | `quote_age_ms` |
| Position | `linked_position_id` (link) |

- **Detail pane:** `rejection_reasons[]` (`code`, `message`) at the top, then every `risk_checks[]` row: label, status icon + word, `observed` and `threshold` formatted by `unit`, `comparator` rendered as `≥`, `≤`, `=`, `≠`, and `message`. A check with status `error` is styled as a block ("could not evaluate → treated as fail"), so an evaluation error is never mistaken for a pass.
- **Filters:** decision, strategy, "failed check = X" (from a check row's context menu: "Show all candidates failing this check").
- **Edge cases:** a burst of more than 10 events/s → rows are batched per animation frame and the pill shows "+37 in the last second". Untrusted token names are rendered as plain text (see formatting rules).

#### S-05 Token inspector

- **Purpose:** everything known about one mint, in one place.
- **Layout:** drawer (440px) or full page. Header: identicon, sanitised symbol and name, full mint with copy, `token_program`, a flags row. Tabs: **Overview** · **Price** · **Our history** · **Checks**.
- **Overview fields (VM-08):** `decimals`, `supply_base`, `mint_authority` (or "none"), `freeze_authority` (or "none"), `token_2022_extensions[]`, `first_seen_at`, `pools[]` (venue, quote, `liquidity_lamports`, `price_sol_per_token`), `holders_top[]` (if provided: owner chip, amount, `pct_bps`), `flags[]` (`code`, `severity`, `message`). Which of these matter for risk is owned by the risk/backend research; the UI shows what the backend sends and does not editorialise.
- **Price tab:** a candle chart (Lightweight Charts, D-UI-05) from VM-10 (`series=price_ohlc&mint=…`), with horizontal lines for our entry, stop and target if a position is open, and markers for our fills. TradingView attribution is shown as required (UI-F35).
- **Our history:** VM-08 `our_history.candidates_count`, `trades_count`, `net_pnl_lamports`, plus links to the filtered journal and signals.
- **Checks:** the latest `risk_checks[]` for this mint.
- **Update:** REST snapshot on open + push topic `token:<mint>` (≤ 1 Hz). Unsubscribe on close.
- **Edge cases:** an unknown mint → not-found state. Tokens with the same symbol show a "symbol shared by n mints" warning.

#### S-06 Strategy performance

```
┌ Strategy [All ▾]  Mode [Paper ▾]  Window [30d ▾] ─────────────────────────────────────┐
│ Edge status: UNPROVEN — 95% CI of expectancy includes zero (n = 64, need ≥ 100)       │  Banner (C20) from edge_status
├───────────────┬───────────────┬────────────────┬──────────────┬───────────────────────┤
│ Net PnL       │ Expectancy    │ Win rate       │ Max drawdown │ Trades                │
│ +0.214 SOL    │ +0.0033 SOL   │ 54.7%          │ −8.2%        │ 64 (W35 / L29)        │
│ gross +0.301  │ CI [−0.0011,  │ CI [42.1, 66.8]│ current −2.1%│ avg hold 6m 40s       │
│ costs 0.087   │      +0.0078] │                │              │                       │
├───────────────┴───────────────┴────────────────┴──────────────┴───────────────────────┤
│ Expectancy CI by strategy (IntervalBar, zero line)                                     │
│ Equity curve (net) · Drawdown (separate panel) · PnL per trade (bars ±, chronological) │
│ Cost breakdown (stacked bar by category, per day)                                      │
│ Table: strategy × mode with all metrics                                                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| Metric | Field (VM-09) | Note |
|---|---|---|
| Net PnL after all costs | `net_pnl_lamports` (+ `gross_pnl_lamports`, `total_costs_lamports`) | Gross is secondary text |
| Expectancy (per trade, net) | `expectancy_net_lamports`, `expectancy_net_bps` | Primary performance number |
| Confidence interval | `expectancy_ci.low_lamports`, `.high_lamports`, `.level_bps` (e.g. 9500), `.method` | Displayed as an interval, never hidden |
| Win rate | `win_rate_bps` (+ `win_rate_ci.low_bps`, `.high_bps` if provided) | — |
| Avg win / avg loss | `avg_win_lamports`, `avg_loss_lamports` | — |
| Profit factor | `profit_factor` (Decimal string, null when no losses) | "∞" is never shown; show "n/a (no losses)" |
| Max / current drawdown | `max_drawdown_lamports`, `max_drawdown_bps`, `current_drawdown_bps` | — |
| Trade count | `trade_count`, `win_count`, `loss_count` | — |
| Sample sufficiency | `sample_sufficient`, `min_trades_required` | — |
| Edge status | `edge_status` (`unproven`, `positive`, `negative`) | Computed by the backend from the CI. The UI never computes it |

- **After fixed costs (UC-19):** a secondary line under the expectancy tile reads "after fixed costs: ±x SOL/month (CI …)", taken from VM-18 gate P-2b (paper) or LS-3b (live-small) `actual_value`; hidden when those gates are absent. Win-rate CI is Wilson 95% (ARCH 14.5 Q-04).
- **Rule:** a strategy whose `edge_status` is not `positive` shows the banner "No proven after-cost edge" in amber (unproven) or danger (negative). The Mode screen links to it. The UI never labels a strategy "profitable" from point estimates.
- **Update:** poll 60s + invalidate on the `trade.closed` event.
- Backtest results show `mode = backtest` with a "historical simulation" note. Backtest, paper and live are never mixed in one aggregate unless the operator explicitly selects "All modes", and then each series is labelled.

#### S-07 Risk limits and kill switch

```
┌ Kill switch ───────────────────────────────────────────────────────────────────────────┐
│ State: RUNNING since 09:14 UTC                         [■ HALT (hold 1s)]  [Flatten all…]│
│ Halt = stop new entries + cancel queued entries. Open positions keep their stops/targets.│
├ Circuit breakers ───────────────────────────────────────────────────────────────────────┤
│ Daily loss breaker   ○ armed          Consecutive losses ○ armed   RPC failure ○ armed   │
├ Limits ─────────────────────────────────────────────────────────────────────────────────┤
│ Limit               Scope     Usage                 Limit       On breach      [Edit]   │
│ Max daily loss      global    0.084 / 0.200 SOL 42% 0.200 SOL   block entry    [Edit]   │
│ Max position size   global    —                     0.250 SOL   block entry    [Edit]   │
│ Max open positions  global    3 / 5             60% 5           block entry    [Edit]   │
│ Max slippage        global    —                     300 bps     block entry    [Edit]   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Note (integration):** the daily loss stop (`DAYLOSS`) blocks entries (ARCH 8.2), so its "On breach" cell reads "block entry", not "halt". Amounts in the mock-up are illustrative.
- **Fields:** VM-03 `trading_state`, `kill.*`; VM-12 `limits[]` (`label`, `scope`, `scope_id`, `kind`, `unit`, `display_unit`, `limit_value`, `limit_value_display`, `usage_value`, `usage_bps`, `state`, `action_on_breach`, `last_breach_at`, `editable`, `pending_change`), `breakers[]` (`label`, `tripped`, `tripped_at`, `reason`, `auto_reset_at`, `requires_manual_reset`), `daily_loss.used_lamports`, `daily_loss.limit_lamports`, `daily_loss.resets_at`.
- **Actions:** HALT (A1), RESUME (A2), FLATTEN ALL (A2), lower a limit (A1, immediate), raise a limit (A3, delayed), reset a tripped breaker (A2), disable a limit (A3; shown as risk-increasing).
- **Edit limit:** inline AmountInput with unit → DiffView "0.200 SOL → 0.300 SOL (raises risk)" → the A3 flow (Safety UX). Lowering shows "lowers risk · takes effect immediately".
- **States:** `pending_change` shows a Countdown (C44) row under the limit: "Raise to 0.300 SOL at 14:05:42 UTC · Cancel". Breached limits pin to the top with a danger tint.

#### S-08 System health

- **Layout:** status summary row (overall, RPC, streams, transaction landing, errors, clock) → four panels: **RPC endpoints** table, **Streams** table, **Transactions** (landing rate, confirmation latency, fees), **Errors** table by category; time-series charts (latency p50/p95, landing rate) below.

| Panel | Fields (VM-13) |
|---|---|
| RPC endpoints | `rpc[].label` (never the URL, which may embed an API key), `role` (`read`, `send`, `stream`), `latency_ms_p50`, `latency_ms_p95`, `latency_ms_p99`, `error_rate_bps`, `requests_per_min`, `slot`, `slot_lag`, `last_ok_at`, `status` |
| Streams | `streams[].label`, `lag_ms`, `last_event_at`, `reconnects_1h`, `status` |
| Transactions | `tx.window_s`, `tx.sent_count`, `tx.landed_count`, `tx.landing_rate_bps`, `tx.failed_count`, `tx.expired_count`, `tx.confirm_latency_ms_p50`, `tx.confirm_latency_ms_p95`, `tx.avg_priority_fee_micro_lamports_per_cu`, `tx.avg_tip_lamports`, `tx.landing_definition` (shown as tooltip text) |
| Errors | `errors[].category`, `count_5m`, `count_1h`, `rate_per_min`, `last_message` (server-sanitised), `last_at` |
| Process / clock | `process.uptime_s`, `process.rss_bytes`, `process.queue_depths[]`, `clock.server_time`, `clock.ntp_offset_ms` |
| Safety net (UC-17) | `safety[]` (`name`, `status`, `detail`, `at`): sentinel heartbeat, notifier last test, watcher last poll, signer lock, exit lease |
| Monthly allowance (UC-17) | `rpc[].projected_month_end_bps` shown in the RPC endpoints table as "projected month-end use" |

- Thresholds for ok/degraded/down are computed by the backend (`status` fields). The UI never re-derives them, so the colours always match the bot's own view.

#### S-09 Cost tracker

- **Purpose:** show every cost and whether fixed costs are justified against a bankroll under US$1,000.
- **Layout:** period SegmentedControl (Today, 7d, 30d, Month-to-date) → summary tiles → stacked bar by day per category → cost table → fixed-costs editor link (to Config).

| Tile / row | Field (VM-14) |
|---|---|
| Variable costs | `variable_lamports`, `variable_usd_e6` |
| Network base fees | `network_base_lamports` |
| Priority fees | `priority_lamports` |
| Tips | `tips_lamports` |
| Venue / DEX fees | `venue_fees_lamports` |
| Slippage (implicit) | `slippage_lamports` (labelled "implicit: vs decision price; already inside fill prices, not added to totals") |
| Failed-transaction fees | `failed_tx_lamports` |
| Rent deposits (refundable, not a cost) | `rent_deposits_lamports` (shown separately, excluded from totals) |
| Fixed infrastructure | `fixed_items[]` (`label`, `monthly_usd_e6`, `prorated_period_usd_e6`, `source`) |
| Totals | `total_usd_e6`, `cost_per_trade_lamports`, `cost_bps_of_volume`, `traded_volume_lamports` |
| **Fixed-cost burden** | `fixed_cost_bps_of_equity_per_month` → "Fixed costs = 4.1% of equity per month" (example) |
| Break-even | `break_even_monthly_return_bps` → "Strategies must return ≥ 4.1%/month after variable costs just to cover fixed costs" (example) |

- When the fixed-cost burden is ≥ 200 bps of equity per month (PROPOSED default, configurable), the tile turns amber with the text "Fixed costs are a large share of the bankroll". The thresholds and economics are the backend/cost agents' to confirm; the UI only displays them.

#### S-10 Configuration

- **Layout:** left section list (from schema) → right form of ConfigFields (C37) generated from VM-15 → sticky footer "n changes · Review & apply".
- **Fields:** VM-15 `config_version`, `applied_at`, `applied_by`, `sections[].fields[]` (`key`, `label`, `description`, `type`, `unit`, `min`, `max`, `step`, `enum_values`, `default`, `current`, `is_set` (secrets), `secret`, `requires_restart`, `risk_direction_on_increase`, `mode_scope`).
- **Validation:** client-side type, range and step checks (instant, non-blocking) **plus** a server validation call (PROPOSED `POST /api/v1/config/validate`) before review. Server errors map to fields by `key`. Warnings (valid but risky) are amber.
- **Review & apply:** DiffView (C38) with per-line risk direction. The action class is the **highest** class of any changed line, as computed by the server (`derived_action_class`): all lowering → A1; neutral → A2; any raising → A3.
- **Conflict:** if `config_version` changed since load, show a 3-way view ("yours", "server now", "base") and require re-review.
- **Secrets:** never displayed or editable here ("set / not set" only). Secrets are managed on the host, outside the dashboard (keeps keys out of the browser entirely).

#### S-11 Alerts

- **Layout:** tabs Open / Acknowledged / Resolved → list grouped by severity → detail pane.
- **Fields:** VM-16 `alert_id`, `severity`, `category`, `title`, `body`, `created_at`, `updated_at`, `state`, `acked_by`, `acked_at`, `snoozed_until`, `occurrences`, `entity.type`, `entity.id`, `requires_ack`.
- **Actions:** Acknowledge (A0), Snooze 15m/1h/until resolved (A0; critical alerts cannot be snoozed), open entity.
- **Out-of-band channel (UC-20):** a read-only line "Out-of-band channel: <status> · last test <time>" from VM-13 `safety[]` (`notifier_last_test`, `watcher_last_poll`); phone delivery is ARCH D27 (operator-side watcher by default).
- **Notification:** in-tab toasts for `warning` and `critical`; optional sound for critical (off by default, setting); the document title shows `(2)` open critical alerts. Desktop notifications via the browser Notification API are opt-in; **UNVERIFIED** delivery behaviour when the tab is in the background on each browser.

#### S-12 Audit log

- **Layout:** FilterBar (actor, action class, action, target type, result, date) → append-only table → expand for before/after JSON.
- **Fields:** VM-17 `event_id`, `at`, `actor.type`, `actor.id`, `actor.display`, `action`, `action_class`, `target.type`, `target.id`, `before`, `after`, `reason_text`, `command_id`, `result`, `hash`, `prev_hash`.
- A "Verify chain" button asks the server to verify the hash chain (PROPOSED) and shows the result. The UI does not compute hashes.

#### S-13 Mode control and go-live readiness

```
┌ Current mode: PAPER since 2026-09-21 08:00 UTC (15d 6h) ───────────────────────────────┐
│ ● Paper   ○ Live-small   ○ Live          (imported backtest/replay runs: see list below) │
├ Readiness for LIVE-SMALL ───────────────────────────────────────────────────────────────┤
│ Gate                                      Required        Actual         Window   Result │
│ Paper trades (net of costs)               ≥ (backend)     64             30d      ✗     │
│ Expectancy 95% CI lower bound (net)       > 0 SOL         −0.0011 SOL    30d      ✗     │
│ Max drawdown in paper                     ≤ (backend)     8.2%           30d      ✓     │
│ Data-stream lag p95 during paper          ≤ (backend)     410 ms         7d       ✓     │
│ Kill-switch drill completed               within 7d       2026-10-02     —        ✓     │
│ Minimum dwell in paper                    ≥ (backend)     15d            —        ✓     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 2 gates failing · Promotion to LIVE-SMALL is blocked by the server                       │
│ [Switch to LIVE-SMALL…] (disabled, with reason)                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Fields:** VM-03 `mode`, `mode_since`, `scheduled_change`; VM-18 `target_mode`, `gates[]` (`gate_id`, `label`, `metric`, `unit`, `comparator`, `required_value`, `actual_value`, `window.from`, `window.to`, `sample_size`, `pass`, `as_of`, `evidence_route`), `all_pass`, `blocking_reasons[]`, `cooldown_until`, `min_dwell_until`, `caps_after_promotion`.
- The gate list, thresholds and pass/fail are **owned and enforced by the backend**. Values shown are illustrative. The UI displays them and disables the promote button when `all_pass` is false; the server also rejects the command.
- **Demotion** (live → live-small → paper, or anything → paper) is A1: one confirmation that asks what to do with open live positions: "Keep managing them until closed (recommended)" or "Flatten now (A2)".
- **Promotion** (paper → live-small, live-small → live) is A3: see Safety UX.
- **Imported runs (UC-12):** the Backtest and Replay options are removed from the mode selector; the run launcher is removed. A read-only "Imported runs" table (VM-21: `run_id`, `mode`, `strategy_id`, `trial_key`, `from`, `to`, `imported_at`, `bundle_signature_ok`, `trades_count`, `low_coverage`, `gate_ids_evaluated[]`) links each row to the journal filtered by `run_id`. A freshness row shows VM-21 `as_of`.
- **Strategy stage (UC-09):** the readiness header shows VM-18 `strategy_id`, `strategy_stage`, `stage_entered_at` and `trial_key`.

#### S-14 Mobile monitor

See "Mobile monitoring view" below.

#### S-15 Operator preferences

- Theme (System / Dark / Light), density, polarity colours (green-red / blue-orange), time zone display (UTC / local), reduced motion (System / On), sound for critical alerts, character-key shortcuts (On / Off / remap) per WCAG 2.1.4 (UI-F28), default landing page.
- Stored server-side per operator (PROPOSED `GET/PUT /api/v1/me/preferences`), with `localStorage` as a cache only.

### Keyboard shortcuts and command palette

Design basis: the command menu and navigation patterns documented by Linear (UI-F09) and Geist (UI-F15). Character-key shortcuts can be turned off or remapped in S-15 (WCAG 2.1.4, UI-F28). Shortcuts are inactive while focus is in a text field, except `Esc` and `⌘K`/`Ctrl K`.

| Keys | Action | Class |
|---|---|---|
| `⌘K` / `Ctrl K` | Open the command palette | — |
| `/` | Focus the page search or filter | — |
| `?` | Shortcut help overlay | — |
| `G` then `O` / `P` / `S` / `J` / `F` / `C` / `R` / `M` / `N` / `H` / `A` / `L` | Go to Overview / Positions / Signals / Journal / Performance / Costs / Risk / Mode / Config / Health / Alerts / Audit log | — |
| `J` / `K` (or ↓ / ↑) | Next / previous row | — |
| `Enter` | Open the inspector for the row | — |
| `Esc` | Close the drawer, dialog or palette; clear the selection | — |
| `[` / `]` | Previous / next tab | — |
| `T` | Toggle table view on the focused chart | — |
| `.` | Pause / resume the signal feed stream | — |
| `C` | Close the selected position (opens the confirmation) | A1 |
| `⇧H` | Open the HALT dialog with focus on "Halt now". `Enter` confirms | A1 |
| `⇧C` | Open the FLATTEN ALL dialog | A2 |
| `⌘.` / `Ctrl .` | Acknowledge the focused alert | A0 |

No single keystroke executes a money-affecting action. Every A1–A3 shortcut opens a dialog, and the dialog requires its own confirmation.

**Command palette (C34) contents:**
- **Navigate:** every route, recent tokens ("Inspect BONK… 7xKX…9fQa"), recent positions.
- **Search:** mint address or prefix (exact base58 match first), symbol (all matches listed with mints, never auto-picked), position ID, trade ID, signature.
- **Actions:** "Halt trading" (A1), "Resume trading…" (A2), "Flatten all positions…" (A2), "Close position…" (A1, picks a position), "Switch to paper" (A1), "Promote to live-small…" (A3), "Edit limit…" (A1/A3 by direction), "Acknowledge all warnings" (A0), "Toggle theme", "Toggle density", "Copy diagnostics".
- Actions show their class as a right-aligned badge (`A3 · typed confirm`). Disabled actions remain listed with the reason ("Disconnected", "Gates failing: 2", "Viewer role").
- Empty input shows Recent, then Suggested (e.g. "3 positions near stop").
- Executing an action from the palette closes the palette and opens the same dialog the screen uses. There is one implementation of each flow.

### Safety UX for money-affecting actions

#### Action classes

| Class | Definition | Examples | Friction |
|---|---|---|---|
| **A0** | No effect on trading | Acknowledge or snooze an alert, preferences | None. Undo toast where applicable |
| **A1** | Reduces risk or exposure | HALT; close one position; lower a limit; demote mode (live → paper); disable a strategy | One confirmation (alertdialog). HALT also supports hold-to-confirm in the header. No step-up auth, because blocking risk reduction behind authentication is itself a risk |
| **A2** | Changes money state without raising risk limits, or resumes trading | RESUME after a halt; FLATTEN ALL; reset a tripped breaker; apply a neutral config change | Confirmation dialog with a consequences summary + step-up auth if `elevated_until` has passed + a required reason (≥ 10 characters) |
| **A3** | Increases risk | Promote to live-small or live; raise any limit; disable a limit; enable a strategy in a live mode; raise slippage tolerance; widen a stop | Readiness gates (server) + typed confirmation (dynamic phrase) + step-up auth (always fresh, ≤ 60s old) + required reason + **60-second cancellable delay** before the server applies it (D-UI-13) + audit |

**DECISION D-UI-13 — delay on risk increases.** Option A: apply immediately after the typed confirmation. Option B: schedule the change 60 seconds ahead (server-side), shown as a Countdown in the mode bar and on the Risk page, cancellable in one click (cancelling is A1). **Recommendation: B.** It gives the operator a moment to notice a typo such as `3.0` instead of `0.30`. The server, not the browser, owns the timer, so closing the tab does not cancel or accelerate it.

#### Command lifecycle (all classes)

1. The user opens the flow. The dialog fetches a **fresh** preview from the server (PROPOSED `POST /api/v1/commands/preview`): current state, the exact change, estimated consequences (e.g. estimated proceeds and impact for FLATTEN ALL), the action class, and the required phrase.
2. The UI generates `command_id` (a ULID) once when the dialog opens. Retries reuse it, so the server can de-duplicate (idempotency).
3. Submit sends `expected_state_version`. If the state changed in the meantime, the server returns `409 state_changed` and the dialog shows the new state and requires re-confirmation.
4. **No optimistic UI** for A1–A3 (a deliberate departure from UI-F16's optimistic-update guidance). The button shows `pending` until the server answers. The screen changes only when VM data reflects the new state.
5. Results: `executed` → success state + audit link; `scheduled` → Countdown; `rejected` → the server's reason, verbatim; network error or timeout → **"Outcome unknown"** state: "We could not confirm whether HALT was applied. Checking…". The UI polls the command status (PROPOSED `GET /api/v1/commands/{command_id}`) and never auto-retries a non-idempotent call with a new ID.
6. Every command, including rejected ones, produces an audit event (VM-17) with actor, before/after, reason and result.

#### HALT (kill switch)

**DECISION D-UI-07 — HALT semantics** (the backend owns the final definition):
- Option A (recommended): **HALT = stop opening new positions + cancel queued, unsent entry intents.** Exits, stops, targets and time stops stay armed. Halting does not strand open positions without protection.
- Option B: halt everything, including exits. Open positions are then unmanaged, which can turn a halt into a loss.
- FLATTEN ALL is a **separate** A2 action (sell every open position now, subject to the slippage cap). It can realise losses in illiquid tokens, so it shows estimated proceeds and price impact per position first.

HALT flow:
- Header HoldButton: press and hold 1000ms (ring fills; release early to cancel). On completion it sends HALT. Keyboard and assistive-technology path: focus + `Enter`, or `⇧H`, opens the HALT alertdialog with initial focus on **Halt now**, and `Enter` confirms. One step, no typing, no step-up.
- The dialog states, in the current mode: "Stop new entries and cancel queued entries. Open positions (3) keep their stops and targets. This does not sell anything." with the secondary action "Halt and flatten all…" (goes to the A2 flow).
- While pending: the header shows `Halting…`. Confirmed: header `HALTED · 14:02:11 UTC by you`. Partial: `HALT PARTIAL — 1 component has not confirmed (executor)`, with a danger banner and guidance: "Use the host CLI kill command if this persists" (the out-of-band path is defined by the backend; **UNVERIFIED** until it exists).
- **When disconnected:** the HALT button remains enabled. It sends a direct `POST` (not through the stream) with three attempts at 1s, 2s and 4s backoff, reusing the same `command_id`. If all fail: "HALT NOT CONFIRMED. The dashboard cannot reach the bot." with the out-of-band instructions.
- **Auto-halt** (the risk engine tripped a breaker): the danger banner shows breaker, reason and time; RESUME requires A2 and, if the breaker `requires_manual_reset`, a breaker reset first.

#### RESUME (A2)

Shows why trading was halted, the current risk-limit usage, open alerts and edge status. It requires a reason and step-up auth. RESUME into a live mode adds the line "Resuming with REAL FUNDS" in the live colour.

**Signer latch set by the sentinel or the host CLI (UC-08, ARCH D28).** When VM-03 `kill.latch_clear_requires = host_cli`, the RESUME dialog states: "The signer latch was set by the sentinel or the host CLI. Clear it on the host first with `botctl resume-latch --reason \"<text>\"`, then RESUME here." The RESUME button stays disabled with that reason until `kill.latch_clear_requires` becomes `null`.

#### Switching to live (A3)

1. S-13 shows all gates passing (VM-18 `all_pass = true`) and no cooldown. Otherwise the button is disabled with reasons, and the server rejects the command anyway.
2. The dialog has an orchid top border, title "LIVE: switch to LIVE-SMALL", and a summary of real funds at risk: wallet balance, caps after promotion (`caps_after_promotion`), active strategies and their edge status.
3. A checklist the operator must tick (each item is a server-provided string): e.g. "I have checked the wallet balance", "The kill switch drill passed on 2026-10-02".
4. Typed phrase: `LIVE-SMALL <max_trade_sol>` (e.g. `LIVE-SMALL 0.25`), case-sensitive.
5. Reason (≥ 10 characters).
6. Passkey step-up (fresh).
7. Submit → `scheduled` with a 60s Countdown in the mode bar ("LIVE-SMALL in 0:42 · Cancel"). Cancel is A1.
8. At effective time the server switches mode. The UI waits for VM-03 to report the new mode before showing it, then announces "Mode: live, real funds" assertively.

#### Raising a limit (A3) and lowering a limit (A1)

- The edit field shows the old value, the new value, the unit and the direction ("raises risk").
- A3 path: DiffView, typed phrase `RAISE <short_code> <new_value>` using VM-12 `short_code` with `<new_value>` in VM-12 `display_unit` (e.g. `RAISE MAXPOS 0.30` for 0.30 SOL; UC-05). The server parses the phrase in the display unit; the preview's `consequences[]` shows the typed value and the exact stored value ("0.30 SOL = 300000000 lamports"). Reason, step-up, 60s delay, audit.
- **Magnitude guard:** a raise of more than 2× the current value (PROPOSED) shows a second warning line: "This is 12× the current value". Values above the server's hard ceiling are rejected server-side and shown as field errors.
- Lowering: one confirmation, immediate effect, audit.

#### Apply configuration

The class is derived by the server from the diff (highest class wins). It reuses the A1/A2/A3 dialogs. `requires_restart` fields warn: "This change needs an engine restart. It can only be applied when there are no open positions or orders; it will be refused otherwise." (UC-15; the server returns blocking reason `book_not_flat`.)

#### Audit trail requirements (UI side)

- Every dialog's text, as shown to the operator, is sent with the command (`dialog_text_hash` + `dialog_version`, PROPOSED). The audit log can then prove what the operator saw.
- The audit log is read-only in the UI. No delete or edit.
- Paper and live events share one log, with the mode recorded on each event.

### Mobile monitoring view (S-14)

**DECISION D-UI-11.** Option A: read-only + HALT + acknowledge (recommended). Option B: full control on mobile. Small screens make typed confirmations and diffs error-prone, and phones are more often lost or shoulder-surfed. **Recommendation: A.** Risk-increasing (A3) and A2 actions are not rendered on mobile at all; the server also rejects them from sessions with VM-02 `client_kind = mobile` (PROPOSED). Closing a single position is allowed (A1).

```
┌──────────────────────────────┐
│▓ LIVE-SMALL · REAL FUNDS    ▓│  mode bar (sticky, 40px)
│ ● Live 0.6s        14:02 UTC │
├──────────────────────────────┤
│ Equity      3.4120 SOL       │
│ Today net   ▲ +0.0412 SOL    │
│ Open PnL    ▼ −0.0031 SOL (3)│
├──────────────────────────────┤
│ ⚠ 2 warnings   ● 0 critical  │  → alert list, swipe-free "Ack" buttons
│ Limits: daily loss 42%       │
│ Health: ok · landing 96%     │
├──────────────────────────────┤
│ Positions                    │
│  BONK… ▼ −4.1%  4m   [Close] │
│  …                           │
├──────────────────────────────┤
│ [ ■ HALT TRADING  (hold) ]   │  sticky bottom, 56px, thumb zone
└──────────────────────────────┘
```

- Data: VM-20 digest (one push event every 2s) + VM-16 open alerts + VM-05 positions (compact projection).
- HALT: a full-width hold button (1000ms hold) plus a screen-reader path (double-tap opens the dialog). Minimum 44px targets.
- No charts except a 24-point equity sparkline. Reflow at 320px.
- PWA install: optional; no push notifications unless a self-hosted push path is designed (open question).

### Accessibility

Target: **WCAG 2.2 Level AA** (UI-F28).

- **Contrast:** all text tokens ≥ 4.5:1 on every surface they use; controls, focus rings, chart marks and meter fills ≥ 3:1 (tables above). Automated in UI-T02.
- **Colour independence (1.4.1):** PnL has a sign + glyph; status has icon + text; mode has text + pattern + frame style; charts have labels and a table view.
- **Keyboard (2.1.1, 2.1.4):** everything operable; character shortcuts can be turned off or remapped; no keyboard traps except modal dialogs, which trap and restore focus.
- **Focus (2.4.7, 2.4.11):** visible 2px ring; never hidden under sticky headers or the mode bar.
- **Target size (2.5.8):** ≥ 24×24 CSS px; ≥ 44px on mobile. **Dragging (2.5.7):** no drag-only interactions; chart zoom has buttons and keyboard steps.
- **Status messages (4.1.3):** toasts and stream state use `role="status"`; critical alerts, HALT results and mode changes to live use `role="alert"`. Live-region announcements are rate-limited (at most 1 per 2s per region) so a busy feed does not flood screen readers. The signal feed itself is **not** a live region; it announces a summary ("12 new candidates") only when paused/resumed or on request.
- **Pause, stop, hide (2.2.2):** the signal feed and any auto-updating list can be paused.
- **Flashes (2.3.1):** at most 1 value flash per cell per second; no blinking.
- **Error prevention, financial (3.3.4):** all money-affecting submissions are reviewed and confirmed before finalising, and can be cancelled during the delay window (UI-F28).
- **Accessible authentication (3.3.8):** passkeys avoid cognitive function tests (UI-F28, UI-F40). The typed confirmation is not authentication and shows the exact phrase to type.
- **Reflow and resize (1.4.10, 1.4.4):** 320px reflow; 200% text resize.
- **Charts:** canvas charts have an `aria-label` summary (e.g. "Equity, 7 days, from 3.37 to 3.41 SOL, max drawdown 2.1%") and a "View as table" toggle with the same data.
- **Forced colours / high contrast:** `@media (forced-colors: active)` keeps borders and focus visible; the mode bar uses system colours plus its text label.
- **Language and numbers:** numbers are exposed to assistive technology unabbreviated (`aria-label` "minus 0.0031 SOL"); the U+2212 minus is read correctly (**UNVERIFIED** for every screen reader; test in UI-T31).

## View-model contract

This is the contract the backend must serve, exactly. Paths, topic names and source-of-truth component names are **PROPOSED** for this project; the backend architect maps each "source of truth" to a real component and may rename internal components, but must not change field names, types or units without a versioned contract change (`schema_version`).

### Conventions (normative)

1. **Encoding.** JSON, UTF-8. Field names are `snake_case`. The unit is part of the field name for every quantity.
2. **Big integers are strings (DECISION D-UI-12; Option A, recommended: decimal strings; Option B: JSON numbers, rejected because they silently lose precision above 2^53; Option C: a `{ $bigint }` wrapper object as MDN suggests for custom serialisation, rejected as noisier with no benefit over plain strings).** JavaScript numbers represent integers exactly only up to `Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991 (UI-F31). Solana amounts are u64: token `amount` and `supply` are `u64` and `decimals` is `u8` (UI-F30). `JSON.stringify` throws on BigInt (UI-F31). Therefore every lamport, base-unit, micro-lamport, micro-USD and slot value is a **decimal string** of digits with an optional leading `-`, no exponent, no leading `+`, and no leading zeros (except `"0"`). The UI parses them with BigInt.
3. **Exception:** VM-10 chart series values are JSON numbers, because they are display-only, must be plotted as floats, and are bounded (the backend asserts `|v| < 2^53`). They are never used for accounting.
4. **Units (suffix → meaning):**

| Suffix / type | Meaning | Wire type |
|---|---|---|
| `_lamports` | SOL amount in lamports; 1 lamport = 0.000000001 SOL (UI-F30). Signed where noted | `LamportsStr` |
| `_micro_lamports_per_cu` | Compute-unit price; 1,000,000 micro-lamports = 1 lamport (UI-F30) | `U64Str` |
| `_cu` | Compute units | integer |
| `_base` | Token amount in base units (u64 raw amount) | `U64Str` (or `I128Str` when signed) |
| `decimals` | Mint decimals (u8) | integer 0–255 |
| `_usd_e6` | US dollars × 1,000,000 (micro-USD), signed | `I64Str` |
| `_sol_per_token`, `_usd_per_token` | Price per **whole** token (display units), exact decimal | `DecimalStr` |
| `_bps` | Basis points, 1 bps = 0.01%. Ratios (win rate, usage) in 0–10000; returns and changes are signed and may exceed ±10000 | integer (int32) |
| `_ms` | Milliseconds, may be fractional for latencies | number ≥ 0 |
| `_s` | Seconds | integer |
| `_at` | Timestamp, RFC 3339 UTC with milliseconds, e.g. `2026-10-06T14:02:11.123Z` | string |
| `_slot` | Solana slot | `U64Str` |
| `_count` | Count | integer ≥ 0 |
| `_bytes` | Bytes | integer ≥ 0 |

5. **Shared scalar types:**

| Type | Rule |
|---|---|
| `U64Str` | `^(0\|[1-9][0-9]{0,19})$` and ≤ 18446744073709551615 |
| `I64Str` | `^-?(0\|[1-9][0-9]{0,18})$` within i64 |
| `LamportsStr` | `U64Str` for balances; `I64Str` for PnL and deltas (field docs say which) |
| `I128Str` | `^-?(0\|[1-9][0-9]{0,38})$` (signed token deltas) |
| `DecimalStr` | `^-?(0\|[1-9][0-9]*)(\.[0-9]{1,30})?$` (no exponent) |
| `Pubkey` | base58, 32–44 characters |
| `Signature` | base58, 64–88 characters |
| `Id` | ULID, 26 characters, Crockford base32 (PROPOSED) |
| `Mode` | `backtest` \| `replay` \| `paper` \| `live_small` \| `live` |
| `Commitment` | `processed` \| `confirmed` \| `finalized` (definitions per Solana RPC docs, UI-F30) |
| `Severity` | `info` \| `warning` \| `critical` |
| `ActionClass` | `A0` \| `A1` \| `A2` \| `A3` |
| `Untrusted<string>` | Attacker-controllable text (token symbol and name). Max length enforced server-side (symbol 32, name 64 bytes); the UI sanitises again |

6. **Nullability.** A field is `null` only when the value is unknown or not applicable, and each nullable field has a sibling `*_unavailable_reason` code or a documented meaning. The UI shows `—` for null and never coerces null to 0.
7. **Paper vs live.** Every VM that carries money values includes `mode` and `simulated: boolean` (true for backtest, replay and paper). The UI shows the `SIM` badge from `simulated`, never by inferring it from mode strings.
8. **Signs.** PnL: positive = profit. Costs and fees: **non-negative** numbers meaning money spent (a refund or rebate is a separate field). `*_change_bps`: signed.
9. **Versioning.** Each VM has `schema_version` (integer). The UI declares the versions it supports (VM-01 `ui_supported`). On mismatch the server sends `incompatible` and the UI shows a blocking "Update the dashboard" state rather than rendering wrong data.
10. **Validation.** The UI validates every payload with a schema (zod, UI-T08). A failure is an error state with the VM ID and field path, plus a diagnostic event posted back (PROPOSED `POST /api/v1/ui-diagnostics`; no PII, no secrets).
11. **Secrets.** No VM ever carries RPC URLs, API keys, private keys, seed phrases or auth tokens. Endpoints are referred to by operator-chosen `label` only.

### VM-01 — Stream envelope, heartbeat and clock

Transport: SSE (`text/event-stream`). Each event has `id: <seq>` and `event: <kind>`; `data` is the JSON envelope. On reconnect the browser sends `Last-Event-ID` (UI-F37). The server replays from a buffer (PROPOSED: the last 120s) or sends `event: reset`, after which the UI refetches all snapshots.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `vm` | string (`VM-01` … `VM-21`; VM-21 added by ARCH UC-12) | — | API gateway | every event |
| `schema_version` | integer | — | API gateway | every event |
| `seq` | `U64Str` | — | API gateway (monotonic per stream connection lineage) | every event |
| `kind` | `snapshot` \| `upsert` \| `remove` \| `replace` \| `heartbeat` \| `reset` \| `incompatible` | — | API gateway | every event |
| `key` | string \| null | entity ID for `upsert`/`remove` | producing service | per event |
| `emitted_at` | string | `_at` (server wall clock) | API gateway | every event |
| `as_of` | string | `_at` (data time; sim time when `clock = sim`) | producing service | every event |
| `clock` | `wall` \| `sim` | — | mode controller (always `wall` on the live host: backtests and replays run off-host and are imported, ARCH D29 / UC-12; `sim` is kept in the enum for fixtures only) | every event |
| `mode` | `Mode` | — | mode controller | every event |
| `run_id` | `Id` | — | mode controller (changes per backtest/replay/paper/live run) | every event |
| `data` | object (the VM payload or patch) | — | producing service | per event |
| **heartbeat only:** `server_time` | string | `_at` | API gateway | every 2s |
| `state_version` | `U64Str` | — | system-state service (VM-03) | every 2s |
| `topics` | string[] | — | API gateway (echo of subscribed topics) | every 2s |
| `ui_supported` | object `{ "VM-05": [1,2], … }` | — | API gateway | on connect |

Patch semantics: `snapshot` replaces the VM; `upsert` inserts or replaces the entity with `key`; `remove` deletes it; `replace` replaces a singleton VM. If the UI detects a `seq` gap (not +1 within a connection), it requests snapshots for every subscribed VM.

### VM-02 — Session and operator

REST `GET /api/v1/me` (PROPOSED). Pushed on change through topic `session`.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `operator_id` | `Id` | — | auth service | on login |
| `display_name` | string | — | auth service (an operator-chosen handle; no legal name required) | on change |
| `role` | `viewer` \| `operator` | — | auth service | on change |
| `session_expires_at` | string | `_at` (absolute timeout) | auth service | on login / refresh |
| `idle_timeout_s` | integer | `_s` | auth config | on login |
| `elevated_until` | string \| null | `_at` | auth service (step-up) | on step-up |
| `webauthn_available` | boolean | — | auth service | on load |
| `environment_label` | string | — | host config (e.g. "bot-host · tailnet") | on load |
| `client_kind` | `desktop` \| `mobile` | — | auth service (from login flow) | on login |
| `csrf_token` | string | — | auth service (synchronizer token, UI-F39) | per session |
| `login_rate_limited_until` | string \| null | `_at` | auth service | on failure |
| `preferences` | object (theme, density, polarity, tz, shortcuts, sound, reduced_motion) | — | preferences store | on change |

### VM-03 — System state (mode, trading state, kill switch)

Topic `system`. Push on change; `state_version` also in every heartbeat.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `state_version` | `U64Str` | — | system-state service | on change |
| `mode` | `Mode` | — | mode controller | on change |
| `simulated` | boolean | — | mode controller | on change |
| `mode_since` | string | `_at` | mode controller | on change |
| `run_id` | `Id` | — | mode controller | on change |
| `trading_state` | `starting` \| `running` \| `halt_requested` \| `halted` \| `halt_partial` \| `resume_requested` \| `exits_only` \| `stopped` (`exits_only` = engine running with entries blocked because its database or config could not be trusted; UC-07) | — | execution supervisor (M26) | on change |
| `trading_state_changed_at` | string | `_at` | execution supervisor | on change |
| `kill.halted_by` | `{ type: operator \| risk_engine \| system \| scheduler \| sentinel \| cli, id: string, display: string }` \| null (`scheduler` matches ARCH 5.0a `Actor`; `sentinel` and `cli` added by UC-06) | — | execution supervisor | on change |
| `kill.latch_set_by` | `engine` \| `sentinel` \| `cli` \| `system` \| null | — | signer status via M26 (UC-07; ARCH `latchSetBy` value `operator_cli` is projected as `cli`) | on change |
| `kill.latch_clear_requires` | `dashboard` \| `host_cli` \| null | — | M26 from the signer latch setter (UC-07, D28) | on change |
| `signer.lock` | `locked` \| `unlocked` \| `exits_only` | — | signer status (M17 via M26) (UC-07) | on change |
| `signer.exit_lease_holder` | `engine` \| `sentinel` \| null | — | signer status (M17 via M26) (UC-07, CA-13) | on change |
| `kill.reason_code` | string \| null | — | execution supervisor / risk engine | on change |
| `kill.reason_text` | string \| null | — | as above | on change |
| `kill.components[]` | `{ name: string, acked: boolean, acked_at: string \| null }` | — | each engine component | on change |
| `live_caps.max_trade_lamports` | `U64Str` \| null | lamports | risk engine (null when not live) | on change |
| `live_caps.max_open_positions` | integer \| null | count | risk engine | on change |
| `live_caps.max_daily_loss_lamports` | `U64Str` \| null | lamports | risk engine | on change |
| `scheduled_change` | `{ command_id: Id, kind: set_mode \| update_limit \| apply_config, summary: string, effective_at: string, cancellable: boolean }` \| null | — | command scheduler | on change |
| `strategies[]` | `{ strategy_id: string, name: string, enabled: boolean, modes: Mode[] }` | — | strategy registry | on change |
| `sim_clock` | `{ sim_time: string, speed_x: number, paused: boolean }` \| null | — | always `null` on the live host (UC-12, D29); kept for schema compatibility | never set on the live host |
| `versions.bot` | string | — | build info | on start |
| `versions.config` | string | — | config service | on change |
| `trading_wallet_pubkey` | `Pubkey` \| null | — | wallet registry (public key only) | on change |

### VM-04 — Wallet balances

Topic `balances`. Push on change; the server reconciles the ledger with chain reads at `confirmed` commitment every 30s (PROPOSED).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `source` | `chain` \| `paper_ledger` \| `sim_ledger` | — | wallet tracker | on change |
| `simulated` | boolean | — | wallet tracker | on change |
| `wallets[].wallet_id` | string | — | wallet registry | static |
| `wallets[].label` | string | — | wallet registry | static |
| `wallets[].pubkey` | `Pubkey` | — | wallet registry | static |
| `wallets[].role` | `trading` \| `fee_payer` \| `reserve` (the simulation payer and the optional cold wallet appear as `reserve` with their labels; UC-13) | — | wallet registry | static |
| `wallets[].sol_lamports` | `U64Str` | lamports | chain read via the RPC `getBalance` method, which "Returns the lamport balance for a single account address at the requested commitment" (https://solana.com/docs/rpc/http/getbalance, read 2026-10-06) (live) / paper ledger | on change |
| `wallets[].sol_commitment` | `Commitment` | — | wallet tracker | on change |
| `wallets[].sol_as_of_slot` | `U64Str` | slot | wallet tracker | on change |
| `wallets[].reserved_lamports` | `U64Str` | lamports (held for in-flight orders and fees; includes the exit fee float, UC-13) | execution engine | on change |
| `wallets[].available_lamports` | `U64Str` | lamports (= sol − reserved, floored at 0) | execution engine | on change |
| `wallets[].tokens[]` | `{ mint: Pubkey, symbol: Untrusted<string>, decimals: integer \| null, amount_base: U64Str, token_class: ours \| unsolicited \| written_off, value_est_lamports: U64Str \| null, value_as_of: string \| null }` (`token_class` added by UC-13; `decimals` nullable to match ARCH 5.0a `WalletBalances`) | base units / lamports | wallet tracker (M22) + pricing | on change |
| `totals.sol_lamports` | `U64Str` | lamports | wallet tracker | on change |
| `totals.positions_value_lamports` | `U64Str` | lamports (sum of exit-value estimates, D-UI-08) | position service | ≤ 1 Hz |
| `totals.equity_lamports` | `U64Str` | lamports (= `E` as defined in ARCH 1.5: includes the simulation payer and the cold balance if configured; UC-13) | M22 / position service | ≤ 1 Hz |
| `totals.equity_usd_e6` | `I64Str` \| null | micro-USD | pricing service | ≤ 1 Hz |
| `totals.sol_usd_price_e6` | `I64Str` \| null | micro-USD per SOL | pricing service | ≤ 1 Hz |
| `totals.sol_usd_as_of` | string \| null | `_at` | pricing service | ≤ 1 Hz |
| `totals.sol_usd_source` | string \| null | — | pricing service (label of the price source) | on change |
| `reconciled_at` | string | `_at` | wallet tracker | every 30s |
| `reconcile_diff_lamports` | `I64Str` | lamports (ledger minus chain; non-zero triggers an alert) | wallet tracker | every 30s |

### VM-05 — Open positions

Topic `positions`. Entities keyed by `position_id`. Marks are coalesced to ≤ 1 Hz per position.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `position_id` | `Id` | — | position service | static |
| `simulated` | boolean | — | position service | static |
| `mode` | `Mode` | — | position service | static |
| `strategy_id` | string | — | strategy registry | static |
| `mint` | `Pubkey` | — | position service | static |
| `symbol`, `name` | `Untrusted<string>` | — | token metadata cache | static |
| `decimals` | integer \| null | — | mint account | static |
| `venue` | string | — | execution engine | static |
| `state` | `opening` \| `open` \| `partially_closed` \| `closing` \| `close_failed` \| `closed` (backend mapping, B-M28-03: M20 `stuck` → `close_failed` with `close_failed_reason`; `orphan` → `open` with risk flag `orphan`; a position in `opening` may already have armed stops, UC-03) | — | position service (M20) | on change |
| `opened_at` / `opened_slot` | string / `U64Str` | `_at` / slot | execution engine (first fill) | static |
| `entry_signatures[]` | `Signature[]` | — | execution engine | on fill |
| `entry_size_base` | `U64Str` | base units | fills ledger | on fill |
| `size_base` | `U64Str` | base units (currently held) | fills ledger | on change |
| `entry_price_sol_per_token` | `DecimalStr` | SOL per whole token (volume-weighted) | fills ledger | on fill |
| `entry_cost_lamports` | `U64Str` | lamports (all-in: amount paid + all entry fees) | fills ledger + cost ledger | on fill |
| `entry_fees.base_fee_lamports` | `U64Str` | lamports | cost ledger | on fill |
| `entry_fees.priority_fee_lamports` | `U64Str` | lamports | cost ledger | on fill |
| `entry_fees.tip_lamports` | `U64Str` | lamports | cost ledger | on fill |
| `entry_fees.venue_fee_lamports` | `U64Str` | lamports (equivalent) | cost ledger | on fill |
| `mark_price_sol_per_token` | `DecimalStr` \| null | SOL per whole token | pricing service | ≤ 1 Hz |
| `mark_method` | `exit_quote` \| `mid` \| `last_trade` | — | pricing service (D-UI-08: `exit_quote` preferred) | on change |
| `mark_as_of` / `mark_slot` | string / `U64Str` | `_at` / slot | pricing service | ≤ 1 Hz |
| `exit_cost_est_lamports` | `U64Str` \| null | lamports (estimated fees + tip + venue fee to exit fully) | cost model | ≤ 1 Hz |
| `exit_value_est_lamports` | `U64Str` \| null | lamports (estimated net proceeds of a full exit now) | pricing + cost model | ≤ 1 Hz |
| `price_impact_exit_bps` | integer \| null | bps | pricing service | ≤ 1 Hz |
| `unrealized_pnl_net_lamports` | `I64Str` \| null | lamports (= exit_value_est − entry_cost + realised partial proceeds) | position service | ≤ 1 Hz |
| `unrealized_pnl_net_bps` | integer \| null | bps of `entry_cost_lamports` | position service | ≤ 1 Hz |
| `unrealized_pnl_net_usd_e6` | `I64Str` \| null | micro-USD | position service | ≤ 1 Hz |
| `realized_partial_lamports` | `I64Str` | lamports (net proceeds already realised from partial exits) | fills ledger | on fill |
| `stops[]` | `{ type: price \| pnl_pct \| trailing \| time, trigger_price_sol_per_token: DecimalStr \| null, trigger_pnl_bps: integer \| null, trailing_distance_bps: integer \| null, armed: boolean }[]` (replaces the single `stop` object, UC-02; PM has a fixed and a trailing stop at once) | — | exit manager (M20) | on change |
| `targets[]` | same item shape as `stops[]` (replaces the single `target` object, UC-02; MR has two targets) | — | exit manager (M20) | on change |
| `time_stop_at` | string \| null | `_at` | exit manager | on change |
| `pending_close` | `{ command_id: Id, requested_at: string, reason: string }` \| null | — | command service | on change |
| `close_failed_reason` | string \| null | — | execution engine | on change |
| `risk_flags[]` | `{ code: string, severity: Severity, message: string }` (documented code `entry_unconfirmed`: exits armed on first evidence of landing while the entry is not yet confirmed, UC-03) | — | risk engine | on change |

### VM-06 — Closed-trade journal

REST `GET /api/v1/journal?from&to&strategy_id&mint&outcome&exit_reason&mode&cursor&limit` (PROPOSED; `limit` ≤ 200). Push `upsert` on topic `journal` when a trade closes.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `items[].trade_id` | `Id` | — | trade ledger | immutable |
| `items[].position_id` | `Id` | — | trade ledger | immutable |
| `items[].mode` / `simulated` | `Mode` / boolean | — | trade ledger | immutable |
| `items[].strategy_id` | string | — | trade ledger | immutable |
| `items[].mint`, `symbol`, `decimals` | `Pubkey`, `Untrusted<string>`, integer | — | trade ledger | immutable |
| `items[].opened_at`, `closed_at` | string | `_at` | trade ledger | immutable |
| `items[].hold_ms` | number | ms | trade ledger | immutable |
| `items[].size_base` | `U64Str` | base units | trade ledger | immutable |
| `items[].entry_price_sol_per_token`, `exit_price_sol_per_token` | `DecimalStr` | SOL per whole token (VWAP) | trade ledger | immutable |
| `items[].gross_pnl_lamports` | `I64Str` | lamports (from actual fill amounts, before explicit fees; slippage is therefore already inside it) | trade ledger | immutable |
| `items[].costs.network_base_lamports` | `U64Str` | lamports | cost ledger | immutable |
| `items[].costs.priority_lamports` | `U64Str` | lamports | cost ledger | immutable |
| `items[].costs.tips_lamports` | `U64Str` | lamports | cost ledger | immutable |
| `items[].costs.venue_fees_lamports` | `U64Str` | lamports | cost ledger | immutable |
| `items[].costs.failed_tx_lamports` | `U64Str` | lamports (fees of failed attempts for this trade) | cost ledger | immutable |
| `items[].total_costs_lamports` | `U64Str` | lamports (sum of the explicit `costs.*` fields above) | cost ledger | immutable |
| `items[].implicit_slippage_lamports` | `I64Str` \| null | lamports (fills vs decision price; negative = price improvement). **Informational only:** already reflected in `gross_pnl_lamports`, never subtracted again | cost ledger | immutable |
| `items[].net_pnl_lamports` | `I64Str` | lamports (= gross − total costs) | trade ledger | immutable |
| `items[].net_pnl_bps` | integer | bps of entry cost | trade ledger | immutable |
| `items[].net_pnl_usd_e6` | `I64Str` \| null | micro-USD at close | trade ledger | immutable |
| `items[].exit_reason` | `stop` \| `target` \| `trailing_stop` \| `time_stop` \| `manual_close` \| `flatten_all` \| `risk_breach` \| `halt_flatten` \| `liquidity_collapse` \| `authority_change` \| `venue_disabled` \| `sentinel_flatten` \| `orphan_close` \| `written_off` \| `other` (UC-01; contract test asserts equality with the backend `ExitReason` union, B-M19-01 / B-M28-01) | — | exit manager | immutable |
| `items[].source` | `live` \| `paper` \| `sentinel` \| `recovered` \| `backtest` \| `replay` (UC-01) | — | trade ledger (M23) | immutable |
| `items[].shadow` | boolean (UC-01) | — | trade ledger (M23) | immutable |
| `items[].entry_signatures[]`, `exit_signatures[]` | `Signature[]` (empty in paper) | — | execution engine | immutable |
| `next_cursor` | string \| null | — | API | per page |
| `totals.count`, `win_count`, `loss_count` | integer | — | trade ledger (for the whole filter, not the page) | per query |
| `totals.gross_pnl_lamports`, `net_pnl_lamports`, `total_costs_lamports` | `I64Str` | lamports | trade ledger | per query |
| `totals.win_rate_bps` | integer | bps | trade ledger | per query |

Invariant (tested by UI-T18 contract tests): `net_pnl_lamports = gross_pnl_lamports − total_costs_lamports` exactly, for every row.

### VM-07 — Candidate / signal feed

Topic `signals` (push per decision, ≤ 10/s coalesced). REST `GET /api/v1/signals?before&decision&strategy_id&check_id&limit` for history.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `candidate_id` | `Id` | — | signal service | static |
| `simulated`, `mode` | boolean, `Mode` | — | signal service | static |
| `detected_at` / `detected_slot` | string / `U64Str` | `_at` / slot | signal service | static |
| `mint`, `symbol`, `name`, `decimals` | `Pubkey`, `Untrusted<string>` ×2, integer \| null | — | signal service + metadata cache | static |
| `source` | string (backend-defined code) | — | signal service | static |
| `strategy_id` | string | — | strategy registry | static |
| `score` | `DecimalStr` \| null | `score_unit` | strategy | static |
| `score_unit` | string (e.g. `probability_bps`, `zscore`) | — | strategy | static |
| `decision` | `pending` \| `accepted` \| `rejected` \| `expired` \| `error` | — | risk engine | on change |
| `decided_at` | string \| null | `_at` | risk engine | on change |
| `decision_latency_ms` | number \| null | ms (detected → decided) | risk engine | on change |
| `rejection_reasons[]` | `{ code: string, message: string }` | — | risk engine | on change |
| `risk_checks[]` | `{ check_id: string, label: string, status: pass \| fail \| warn \| skipped \| error, observed: DecimalStr \| null, threshold: DecimalStr \| null, unit: lamports \| base_units \| bps \| ms \| count \| slot \| bool \| usd_e6 \| sol_per_token, comparator: gte \| gt \| lte \| lt \| eq \| neq \| is_true \| is_false, message: string, skipped_reason: string \| null }` | per `unit` | risk engine | on change |
| `intended_size_lamports` | `U64Str` \| null | lamports | strategy sizing | static |
| `expected_entry_price_sol_per_token` | `DecimalStr` \| null | SOL per whole token | quote service | static |
| `expected_cost_bps` | integer \| null | bps (all-in estimated round-trip cost) | cost model | static |
| `expected_price_impact_bps` | integer \| null | bps | quote service | static |
| `quote_age_ms` | number \| null | ms (age of the quote at decision) | quote service | static |
| `liquidity_lamports` | `U64Str` \| null | lamports (SOL side of the best pool) | pool tracker | static |
| `linked_position_id` | `Id` \| null | — | position service | on change |

Rules: `risk_checks[]` contains **every** check that applies to this strategy, including skipped ones (with `skipped_reason`). A check that could not be evaluated is `error`, and an `error` check blocks entry.

### VM-08 — Token inspector

REST `GET /api/v1/tokens/{mint}`; topic `token:{mint}` for price and pool updates (≤ 1 Hz).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `mint` | `Pubkey` | — | — | static |
| `symbol`, `name` | `Untrusted<string>` | — | metadata cache | on change |
| `symbol_collision_count` | integer | count (other mints seen with the same symbol) | metadata cache | on change |
| `decimals` | integer | — | mint account | static |
| `supply_base` | `U64Str` | base units | mint account | on change |
| `token_program` | `spl_token` \| `token_2022` \| `unknown` | — | mint account owner | static |
| `token_2022_extensions[]` | string[] | — | mint account | on change |
| `mint_authority`, `freeze_authority` | `Pubkey` \| null (null = none) | — | mint account | on change |
| `first_seen_at` | string | `_at` | signal service | static |
| `pools[]` | `{ pool_id: Pubkey, venue: string, quote_mint: Pubkey, liquidity_lamports: U64Str \| null, price_sol_per_token: DecimalStr \| null, as_of: string }` | — | pool tracker | ≤ 1 Hz |
| `holders_top[]` | `{ owner: Pubkey, amount_base: U64Str, pct_bps: integer }` \| null | — | holder snapshot (optional) | ≤ 1/min |
| `flags[]` | `{ code: string, severity: Severity, message: string }` | — | risk engine | on change |
| `latest_risk_checks[]` | same shape as VM-07 `risk_checks[]` | — | risk engine | on change |
| `our_history.candidates_count`, `trades_count` | integer | — | signal service, trade ledger | on change |
| `our_history.net_pnl_lamports` | `I64Str` | lamports | trade ledger | on change |
| `current_position_id` | `Id` \| null | — | position service | on change |
| `as_of` | string | `_at` | — | per update |

### VM-09 — Strategy performance

REST `GET /api/v1/performance?strategy_id&mode&from&to` (PROPOSED); polled every 60s and invalidated on `trade.closed`.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `rows[].strategy_id`, `name` | string | — | strategy registry | per query |
| `rows[].mode`, `simulated` | `Mode`, boolean | — | analytics service | per query |
| `rows[].window.from`, `window.to` | string | `_at` | analytics service | per query |
| `rows[].trade_count`, `win_count`, `loss_count` | integer | count | analytics (from trade ledger) | per query |
| `rows[].win_rate_bps` | integer | bps | analytics | per query |
| `rows[].win_rate_ci` | `{ low_bps, high_bps, level_bps, method: wilson }` \| null (Wilson 95%, ARCH 14.5 Q-04) | bps | analytics (M13) | per query |
| `rows[].gross_pnl_lamports`, `total_costs_lamports`, `net_pnl_lamports` | `I64Str` | lamports | analytics | per query |
| `rows[].expectancy_net_lamports` | `I64Str` | lamports per trade (mean net PnL) | analytics | per query |
| `rows[].expectancy_net_bps` | integer | bps of entry cost (mean) | analytics | per query |
| `rows[].expectancy_ci` | `{ low_lamports: I64Str, high_lamports: I64Str, level_bps: integer, method: bootstrap \| t_dist \| other, resamples: integer \| null }` \| null | lamports | analytics | per query |
| `rows[].avg_win_lamports`, `avg_loss_lamports` | `I64Str` \| null | lamports | analytics | per query |
| `rows[].profit_factor` | `DecimalStr` \| null (null when no losing trades) | ratio | analytics | per query |
| `rows[].max_drawdown_lamports` | `I64Str` | lamports (≤ 0) | analytics | per query |
| `rows[].max_drawdown_bps`, `current_drawdown_bps` | integer | bps of peak equity (≤ 0) | analytics | per query |
| `rows[].avg_hold_ms` | number | ms | analytics | per query |
| `rows[].sample_sufficient` | boolean | — | analytics | per query |
| `rows[].min_trades_required` | integer | count | risk policy | per query |
| `rows[].edge_status` | `unproven` \| `positive` \| `negative` | — | analytics (positive only when the CI lower bound > 0 after costs) | per query |
| `as_of` | string | `_at` | analytics | per query |

### VM-10 — Time series (charts)

REST `GET /api/v1/series?series&from&to&resolution&strategy_id&mint&mode` (PROPOSED). Live tail via topic `series:{series}` (≤ 1 point per 5s). Columnar for chart efficiency.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `series` | `equity` \| `drawdown` \| `pnl_per_trade` \| `pnl_daily` \| `cost_daily` \| `rpc_latency` \| `landing_rate` \| `stream_lag` \| `price_ohlc` | — | analytics / health / pricing | per query |
| `unit` | `sol` \| `bps` \| `ms` \| `sol_per_token` | — | as above | per query |
| `resolution` | `trade` \| `1m` \| `5m` \| `1h` \| `1d` (served from persisted 1-minute bars; the UI never requests 15 s bars; `equity` and `drawdown` are flow-adjusted so sweeps and refills do not move them; UC-18) | — | as above | per query |
| `t[]` | number[] | epoch milliseconds UTC | as above | per query / tail |
| `v[]` | number[] (one series) **or** `o[] h[] l[] c[]` for `price_ohlc` | per `unit` (**display-only JSON numbers**, see the convention exception) | as above | per query / tail |
| `v_by_category` | `{ [category: string]: number[] }` \| null (for stacked cost bars) | per `unit` | cost ledger | per query |
| `gaps[]` | `{ from_ms: number, to_ms: number, reason: string }` | epoch ms | as above | per query |
| `baseline` | number \| null | per `unit` (e.g. starting equity) | analytics | per query |
| `simulated` | boolean | — | as above | per query |
| `as_of` | string | `_at` | as above | per query |

### VM-11 — PnL summary

Topic `pnl_summary` (push, coalesced 1 Hz).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `simulated`, `mode` | boolean, `Mode` | — | analytics | on change |
| `periods.{today_utc,d7,d30,since_live_start,all}.net_pnl_lamports` | `I64Str` | lamports | analytics | ≤ 1 Hz |
| `periods.*.net_pnl_usd_e6` | `I64Str` \| null | micro-USD | analytics + pricing | ≤ 1 Hz |
| `periods.*.trade_count` | integer | count | analytics | on change |
| `periods.*.win_rate_bps` | integer \| null | bps | analytics | on change |
| `periods.*.costs_lamports` | `U64Str` | lamports (variable costs) | cost ledger | on change |
| `periods.*.cost_bps_of_volume` | integer \| null | bps | cost ledger | on change |
| `periods.*.fixed_costs_usd_e6` | `I64Str` | micro-USD (prorated) | cost ledger (manual fixed items) | on change |
| `periods.*.net_after_fixed_usd_e6` | `I64Str` \| null | micro-USD | analytics | on change |
| `periods.*.equity_change_bps` | integer \| null | bps | analytics | ≤ 1 Hz |
| `unrealized_net_lamports` | `I64Str` | lamports (sum of VM-05) | position service | ≤ 1 Hz |
| `open_positions_count` | integer | count | position service | on change |

### VM-12 — Risk limits and breakers

Topic `risk` (push on change; usage ≤ 1 Hz).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `limits[].limit_id` | string | — | risk engine | static |
| `limits[].label` | string | — | risk engine | static |
| `limits[].short_code` | string (e.g. `MAXPOS`, used in typed phrases) | — | risk engine | static |
| `limits[].scope` | `global` \| `strategy` \| `token` \| `position` | — | risk engine | static |
| `limits[].scope_id` | string \| null | — | risk engine | static |
| `limits[].kind` | string (backend-defined, e.g. `max_position_size`, `max_daily_loss`) | — | risk engine | static |
| `limits[].unit` | `lamports` \| `bps` \| `count` \| `ms` | — | risk engine | static |
| `limits[].display_unit` | `sol` \| `bps` \| `pct` \| `count` \| `minutes` (the unit the operator types in; UC-05) | — | risk config (M25 `ConfigFieldSchema.displayUnit`) | static |
| `limits[].limit_value_display` | `DecimalStr` (the limit in `display_unit`; UC-05) | per `display_unit` | risk config | on change |
| `limits[].limit_value` | string (`U64Str` or integer as string) | per `unit` | risk config | on change |
| `limits[].usage_value` | string \| null | per `unit` | risk engine | ≤ 1 Hz |
| `limits[].usage_bps` | integer \| null | bps of limit (may exceed 10000 when breached) | risk engine | ≤ 1 Hz |
| `limits[].state` | `normal` \| `elevated` \| `near` \| `breached` \| `disabled` (server-computed by M21 / B-M21-01 with the thresholds normal < 70%, elevated 70-90%, near ≥ 90%, breached ≥ 100% of the limit; the UI never re-derives it; integration decision) | — | risk engine | on change |
| `limits[].action_on_breach` | `block_entries` \| `pause_entries` \| `reduce_size` \| `halt` \| `flatten` \| `demote` \| `alert_only` (UC-04: LOSSRUN and the execution and landing breakers pause; DDHALF reduces size; DDKILL demotes) | — | risk config | on change |
| `limits[].last_breach_at` | string \| null | `_at` | risk engine | on change |
| `limits[].editable` | boolean | — | risk config | on change |
| `limits[].hard_ceiling` | string \| null | per `unit` (server maximum; values above it are rejected) | risk config | on change |
| `limits[].pending_change` | `{ command_id: Id, new_value: string, effective_at: string }` \| null | — | command scheduler | on change |
| `breakers[]` | `{ breaker_id, label, tripped: boolean, tripped_at: string \| null, reason: string \| null, auto_reset_at: string \| null, requires_manual_reset: boolean }` | — | risk engine | on change |
| `daily_loss.used_lamports` | `U64Str` | lamports (net realised + unrealised loss today, per the risk engine's definition) | risk engine | ≤ 1 Hz |
| `daily_loss.limit_lamports` | `U64Str` | lamports | risk config | on change |
| `daily_loss.resets_at` | string | `_at` | risk engine | daily |
| `as_of` | string | `_at` | risk engine | ≤ 1 Hz |

### VM-13 — System health

Topic `health` (push every 2s).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `overall_status` | `ok` \| `degraded` \| `down` | — | health monitor | 2s |
| `rpc[].endpoint_id`, `label` | string | — | health monitor (labels only; never URLs) | static |
| `rpc[].role` | `read` \| `send` \| `stream` | — | health monitor | static |
| `rpc[].latency_ms_p50`, `_p95`, `_p99` | number | ms (rolling 60s) | health monitor | 2s |
| `rpc[].error_rate_bps` | integer | bps of requests (rolling 5 min) | health monitor | 2s |
| `rpc[].requests_per_min` | number | per minute | health monitor | 2s |
| `rpc[].slot`, `slot_lag` | `U64Str`, integer | slot, slots behind the highest seen | health monitor | 2s |
| `rpc[].last_ok_at` | string | `_at` | health monitor | 2s |
| `rpc[].status` | `ok` \| `degraded` \| `down` | — | health monitor | 2s |
| `rpc[].projected_month_end_bps` | integer \| null | bps of the provider's monthly allowance projected for month end from the last 24 h rate (null for unmetered providers; UC-17, CB-05) | M14 burn-rate projection | 2s |
| `streams[]` | `{ stream_id, label, lag_ms: number, last_event_at: string, reconnects_1h: integer, status }` | ms | health monitor | 2s |
| `tx.window_s` | integer | s | execution engine | 2s |
| `tx.sent_count`, `landed_count`, `failed_count`, `expired_count` | integer | count in window | execution engine | 2s |
| `tx.landing_rate_bps` | integer \| null | bps (landed / sent in window) | execution engine | 2s |
| `tx.landing_definition` | string (e.g. "confirmed within N slots of send") | — | execution engine | static |
| `tx.confirm_latency_ms_p50`, `_p95` | number \| null | ms (send → confirmed) | execution engine | 2s |
| `tx.avg_priority_fee_micro_lamports_per_cu` | `U64Str` \| null | micro-lamports per CU | execution engine | 2s |
| `tx.avg_tip_lamports` | `U64Str` \| null | lamports | execution engine | 2s |
| `errors[]` | `{ category: string, count_5m: integer, count_1h: integer, rate_per_min: number, last_message: string, last_at: string \| null }` | — | log aggregator (messages sanitised server-side) | 2s |
| `process.uptime_s` | integer | s | supervisor | 2s |
| `process.rss_bytes` | integer | bytes | supervisor | 2s |
| `process.queue_depths[]` | `{ name: string, depth: integer }` | count | supervisor | 2s |
| `clock.server_time` | string | `_at` | supervisor | 2s |
| `clock.ntp_offset_ms` | number \| null | ms | supervisor (if available) | 60s |
| `safety[]` | `{ name: sentinel_heartbeat \| notifier_last_test \| watcher_last_poll \| signer_lock \| exit_lease, status: ok \| degraded \| down, detail: string, at: string \| null }` (UC-17) | — | M26/M29 safety net | 2s |

### VM-14 — Cost tracker

REST `GET /api/v1/costs?period=today|d7|d30|mtd` (poll 60s).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `period`, `from`, `to` | string | `_at` | cost ledger | per query |
| `simulated` | boolean | — | cost ledger | per query |
| `network_base_lamports` | `U64Str` | lamports (signature fees; 5,000 lamports per signature at the time of research, UI-F30) | cost ledger (from transaction meta) | per query |
| `priority_lamports` | `U64Str` | lamports | cost ledger | per query |
| `tips_lamports` | `U64Str` | lamports | cost ledger | per query |
| `venue_fees_lamports` | `U64Str` | lamports (equivalent) | cost ledger | per query |
| `slippage_lamports` | `I64Str` | lamports (implicit, vs decision price; informational, excluded from totals because it is already inside fill prices) | cost ledger | per query |
| `failed_tx_lamports` | `U64Str` | lamports | cost ledger | per query |
| `rent_deposits_lamports` | `I64Str` | lamports (refundable deposits, net; excluded from totals) | cost ledger | per query |
| `variable_lamports` | `U64Str` | lamports (sum of the explicit costs; slippage reported separately) | cost ledger | per query |
| `variable_usd_e6` | `I64Str` \| null | micro-USD | cost ledger + pricing | per query |
| `fixed_items[]` | `{ item_id, label, monthly_usd_e6: I64Str, prorated_period_usd_e6: I64Str, source: manual \| invoice }` | micro-USD | cost config (operator-entered) | on change |
| `fixed_usd_e6` | `I64Str` | micro-USD (prorated) | cost ledger | per query |
| `total_usd_e6` | `I64Str` \| null | micro-USD | cost ledger | per query |
| `traded_volume_lamports` | `U64Str` | lamports | trade ledger | per query |
| `cost_per_trade_lamports` | `U64Str` \| null | lamports | cost ledger | per query |
| `cost_bps_of_volume` | integer \| null | bps | cost ledger | per query |
| `fixed_cost_bps_of_equity_per_month` | integer \| null | bps | analytics (monthly fixed ÷ current equity) | per query |
| `break_even_monthly_return_bps` | integer \| null | bps | analytics | per query |

### VM-15 — Configuration

REST `GET /api/v1/config`; `POST /api/v1/config/validate`; apply through VM-19. Topic `config` pushes `{config_version}` only.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `config_version` | string (opaque ETag) | — | config service | on change |
| `applied_at`, `applied_by` | string, string | `_at`, operator display | config service | on change |
| `sections[].section_id`, `label` | string | — | config schema | static |
| `sections[].fields[].key` | string (dot path) | — | config schema | static |
| `…fields[].label`, `description` | string | — | config schema | static |
| `…fields[].type` | `int` \| `decimal` \| `bool` \| `enum` \| `duration_ms` \| `lamports` \| `bps` \| `base_units` \| `string` \| `list` | — | config schema | static |
| `…fields[].unit` | string \| null | — | config schema | static |
| `…fields[].min`, `max`, `step` | string \| null | per `type` | config schema | static |
| `…fields[].enum_values` | string[] \| null | — | config schema | static |
| `…fields[].default`, `current` | JSON value per `type` (big integers as strings) \| null | per `type` | config service | on change |
| `…fields[].secret` | boolean | — | config schema | static |
| `…fields[].is_set` | boolean (secrets only; the value is never sent) | — | config service | on change |
| `…fields[].requires_restart` | boolean | — | config schema | static |
| `…fields[].risk_direction_on_increase` | `increases_risk` \| `decreases_risk` \| `neutral` | — | config schema (risk owner) | static |
| `…fields[].mode_scope` | `Mode[]` | — | config schema | static |
| **validate response:** `errors[]` | `{ key, code, message }` | — | config service | per call |
| `warnings[]` | `{ key, code, message }` | — | config service | per call |
| `diff[]` | `{ key, old, new, direction: increases_risk \| decreases_risk \| neutral }` | — | config service | per call |
| `derived_action_class` | `ActionClass` | — | config service | per call |

### VM-16 — Alerts

Topic `alerts`; REST `GET /api/v1/alerts?state&severity&cursor`.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `alert_id` | `Id` | — | alert service | static |
| `severity` | `Severity` | — | alert service | on change |
| `category` | `risk` \| `execution` \| `health` \| `cost` \| `config` \| `security` \| `mode` \| `reconciliation` | — | alert service | static |
| `title`, `body` | string (server-composed; no secrets) | — | alert service | on change |
| `created_at`, `updated_at` | string | `_at` | alert service | on change |
| `state` | `open` \| `acknowledged` \| `snoozed` \| `resolved` | — | alert service | on change |
| `acked_by`, `acked_at` | string \| null, string \| null | — | alert service | on change |
| `snoozed_until` | string \| null | `_at` | alert service | on change |
| `occurrences` | integer | count (deduplicated by `dedupe_key`) | alert service | on change |
| `dedupe_key` | string | — | alert service | static |
| `entity` | `{ type: position \| token \| limit \| breaker \| rpc \| command \| config, id: string }` \| null | — | alert service | static |
| `requires_ack` | boolean | — | alert service | static |
| `snoozable` | boolean (false for critical) | — | alert service | static |

### VM-17 — Audit log

REST `GET /api/v1/audit?actor&action_class&action&target_type&result&from&to&cursor`; topic `audit` for new events. Append-only.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `event_id` | `Id` | — | audit store | immutable |
| `at` | string | `_at` | audit store | immutable |
| `mode` | `Mode` | — | audit store | immutable |
| `actor` | `{ type: operator \| risk_engine \| system \| scheduler \| sentinel \| cli, id: string, display: string }` (`sentinel`, `cli` added by UC-06) | — | audit store | immutable |
| `action` | string (e.g. `halt`, `resume`, `set_mode`, `update_limit`, `apply_config`, `close_position`, `flatten_all`, `write_off_position`, `close_unsolicited`, `ack_alert`, `login`, `step_up`) | — | command service | immutable |
| `action_class` | `ActionClass` | — | command service | immutable |
| `target` | `{ type: string, id: string }` \| null | — | command service | immutable |
| `before`, `after` | object \| null (big integers as strings) | — | command service | immutable |
| `reason_text` | string \| null | — | operator input | immutable |
| `command_id` | `Id` \| null | — | command service | immutable |
| `result` | `accepted` \| `scheduled` \| `executed` \| `rejected` \| `failed` \| `cancelled` | — | command service | immutable |
| `dialog_version`, `dialog_text_hash` | string \| null | — | UI (sent with the command) | immutable |
| `session_ref` | string (salted hash of the session ID; never the session ID itself) | — | auth service | immutable |
| `prev_hash`, `hash` | string (hex) | — | audit store (hash chain, PROPOSED) | immutable |

### VM-18 — Mode readiness (go-live gates)

REST `GET /api/v1/mode/readiness?target_mode=live_small|live` (poll 30s while S-13 is open).

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `current_mode`, `target_mode` | `Mode` | — | mode controller | 30s |
| `strategy_id` | string | — | M13 stage machine (UC-09) | 30s |
| `strategy_stage` | `research` \| `coarse_screened` \| `backtest_passed` \| `replay_passed` \| `paper_passed` \| `live_small` \| `live` \| `failed` \| `archived` (UC-09; ARCH 5.0a `StrategyStage`) | — | M13 stage machine | 30s |
| `stage_entered_at` | string | `_at` (every gate's `window` starts after it; UC-09) | M13 | 30s |
| `trial_key` | string (UC-09) | — | M13 trial registry | 30s |
| `gates[].gate_id`, `label`, `metric` | string (gate IDs per ARCH 3.4, including CS-1, P-2b, P-9, LS-3b, LS-7, R-6 from UC-09) | — | risk policy | 30s |
| `gates[].unit` | VM-07 check units plus `ratio` (DecimalStr value; dimensionless gates such as DSR, PBO, t-statistic, rank stability; UC-09) | — | risk policy | 30s |
| `gates[].comparator` | as VM-07 | — | risk policy | 30s |
| `gates[].required_value`, `actual_value` | string \| null | per `unit` | risk policy / analytics | 30s |
| `gates[].window` | `{ from: string, to: string }` \| null | `_at` | analytics | 30s |
| `gates[].sample_size` | integer \| null | count | analytics | 30s |
| `gates[].pass` | boolean | — | risk policy (authoritative) | 30s |
| `gates[].as_of` | string | `_at` | analytics | 30s |
| `gates[].evidence_route` | string (in-app route, e.g. `/performance?mode=paper&window=30d`) | — | API | 30s |
| `all_pass` | boolean | — | risk policy | 30s |
| `blocking_reasons[]` | `{ code, message }` | — | risk policy | 30s |
| `cooldown_until` | string \| null | `_at` | risk policy (e.g. after a demotion or auto-halt) | 30s |
| `min_dwell_until` | string \| null | `_at` | risk policy | 30s |
| `caps_after_promotion` | `{ max_trade_lamports: U64Str, max_open_positions: integer, max_daily_loss_lamports: U64Str }` | lamports / count | risk policy | 30s |
| `checklist[]` | `{ item_id, text }` (texts the operator must tick) | — | risk policy | 30s |
| `required_phrase` | string (e.g. `LIVE-SMALL 0.25`; the number is illustrative: the ARCH 8.1 live-small `MAXPOS` is min(1.0% E, 66,666,667 lamports) ≈ 0.0667 SOL) | — | command service | 30s |

### VM-19 — Command contract

REST `POST /api/v1/commands/preview`, `POST /api/v1/commands`, `GET /api/v1/commands/{command_id}`, `POST /api/v1/commands/{command_id}/cancel` (all PROPOSED). Topic `commands` pushes `command.updated`. Headers: the session cookie plus `X-CSRF-Token` (UI-F39) and `Idempotency-Key: <command_id>`.

**Request**

| Field | Type | Unit | Notes |
|---|---|---|---|
| `command_id` | `Id` | — | Generated by the UI when the dialog opens; reused on retry |
| `type` | `halt` \| `resume` \| `flatten_all` \| `close_position` \| `set_mode` \| `update_limit` \| `reset_breaker` \| `apply_config` \| `ack_alert` \| `snooze_alert` \| `cancel_scheduled` \| `write_off_position` \| `close_unsolicited` (last two added by UC-14) | — | — |
| `params` | object (per type, below) | — | Big integers as strings |
| `expected_state_version` | `U64Str` | — | From VM-03 at preview time; mismatch → 409 |
| `reason_text` | string \| null | — | Required for A2/A3 (≥ 10 characters) |
| `typed_confirmation` | string \| null | — | Required for A3; must equal the preview's `required_phrase` |
| `checklist_ack[]` | string[] \| null | — | Item IDs ticked (A3 mode changes) |
| `step_up_assertion` | object \| null | — | WebAuthn assertion (opaque to the UI) when elevation is required |
| `dialog_version`, `dialog_text_hash` | string | — | For the audit trail |
| `client_sent_at` | string | `_at` | — |

Params per type: `halt {}` · `resume {}` · `flatten_all { max_slippage_bps: integer }` · `close_position { position_id: Id, max_slippage_bps: integer }` · `set_mode { target_mode: Mode, open_positions_policy: keep_managing \| flatten }` · `update_limit { limit_id: string, new_value: string }` · `reset_breaker { breaker_id: string }` · `apply_config { config_version: string, changes: { key: string, new: JSON }[] }` · `ack_alert { alert_id: Id }` · `snooze_alert { alert_id: Id, until: string }` · `cancel_scheduled { target_command_id: Id }` · `write_off_position { position_id: Id }` (A2, UC-14) · `close_unsolicited { mint: Pubkey }` (A1, UC-14).

**Preview response** (`commands/preview`): `action_class`, `requires_step_up` (boolean), `required_phrase` (string \| null), `summary` (string), `consequences[]` (`{ label, value, unit }`, e.g. estimated proceeds in lamports), `delay_s` (integer; 60 for A3, 0 otherwise), `state_version`, `blocking_reasons[]`. For `update_limit`, `consequences[]` shows both the typed value and the exact stored value with units (for example "0.30 SOL = 300000000 lamports", UC-05). `apply_config` and `update_limit` previews may return blocking reason `book_not_flat` (a restart-requiring change while positions or intents are open, UC-14). A RESUME preview returns blocking reason `latch_requires_host_cli` while VM-03 `kill.latch_clear_requires = host_cli` (UC-08).

**Command status** (response and `command.updated` push)

| Field | Type | Unit | Notes |
|---|---|---|---|
| `command_id` | `Id` | — | — |
| `status` | `accepted` \| `scheduled` \| `executing` \| `executed` \| `rejected` \| `failed` \| `cancelled` | — | `accepted` = validated, not yet applied |
| `action_class` | `ActionClass` | — | Server-derived (authoritative) |
| `reason_code`, `message` | string \| null | — | Shown verbatim on reject or fail |
| `effective_at` | string \| null | `_at` | For `scheduled` |
| `executed_at` | string \| null | `_at` | — |
| `new_state_version` | `U64Str` \| null | — | — |
| `audit_event_id` | `Id` | — | Link to VM-17 |

HTTP semantics: `200` with status; `409 state_changed` (re-preview); `401` (re-login); `403` (`step_up_required` \| `role` \| `mobile_forbidden` \| `csrf` \| `class_changed`; `class_changed` = the server-derived action class at submit differs from the preview's, so the UI re-previews; ARCH 14.1 as amended at integration); `422` (validation, with field errors); `429` (rate limit). A repeated `command_id` returns the original result (idempotent).

### VM-20 — Mobile digest

Topic `digest` (one event every 2s). Mobile sessions subscribe only to `digest`, `alerts`, `positions` (compact) and `system`.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `mode`, `simulated`, `trading_state` | `Mode`, boolean, as VM-03 | — | system-state service | 2s |
| `equity_lamports` | `U64Str` | lamports | position service | 2s |
| `today_net_pnl_lamports` | `I64Str` | lamports | analytics | 2s |
| `open_positions_count` | integer | count | position service | 2s |
| `open_unrealized_net_lamports` | `I64Str` | lamports | position service | 2s |
| `worst_position` | `{ position_id: Id, symbol: Untrusted<string>, unrealized_pnl_net_bps: integer }` \| null | bps | position service | 2s |
| `limits_near_count`, `limits_breached_count`, `breakers_tripped_count` | integer | count | risk engine | 2s |
| `open_alerts.critical`, `open_alerts.warning` | integer | count | alert service | 2s |
| `health_status` | `ok` \| `degraded` \| `down` | — | health monitor | 2s |
| `landing_rate_bps` | integer \| null | bps | execution engine | 2s |
| `as_of` | string | `_at` | — | 2s |

### VM-21 — Imported runs (added by ARCH UC-12)

REST `GET /api/v1/runs`, `GET /api/v1/runs/{run_id}`; topic `runs` (push `upsert` on import). Read-only: backtests, replays and coarse screens run off-host (ARCH D29) and are imported with `botctl import-run`; the dashboard never launches a run.

| Field | Type | Unit | Source of truth | Update |
|---|---|---|---|---|
| `items[].run_id` | `Id` | — | M13 run import (A-M13-08) | immutable |
| `items[].mode` | `backtest` \| `replay` \| `coarse_screen` | — | run bundle | immutable |
| `items[].strategy_id` | string | — | run bundle | immutable |
| `items[].trial_key` | string | — | M13 trial registry | immutable |
| `items[].from`, `items[].to` | string | `_at` (data window of the run) | run bundle | immutable |
| `items[].imported_at` | string | `_at` | M13 / M29 `botctl import-run` | immutable |
| `items[].bundle_signature_ok` | boolean | — | M13 bundle verification | immutable |
| `items[].trades_count` | integer | count | run bundle | immutable |
| `items[].low_coverage` | boolean | — | run bundle (coverage report) | immutable |
| `items[].gate_ids_evaluated[]` | string[] | — | M13 | immutable |
| `as_of` | string | `_at` (freshness row: the time of the latest import) | M13 | on import |
| `schema_version` | integer | — | API gateway | — |

## Front-end stack

### Verified current facts (npm registry `latest` dist-tag and licence field, read 2026-10-06, UI-F32, unless noted)

| Package / item | Version today | Licence | Notes |
|---|---|---|---|
| React / React DOM | 19.3.0 | MIT | react.dev lists v19.3.0 released September 9, 2026 (UI-F33) |
| Vite | 8.3.3 | MIT | Vite docs: regular patches for `vite@8.3`; important fixes backported to 7.3 and 8.2; security patches to 6.4 and 8.1 (UI-F34). Engines `node ^20.19.0 \|\| >=22.12.0` |
| @vitejs/plugin-react | 6.1.2 | MIT | Peer `vite ^8.0.0` |
| TypeScript | `latest` 7.0.2; 6.0.3 is the newest 6.0.x | Apache-2.0 | **typescript-eslint 8.71.1 declares peer `typescript >=4.8.4 <6.1.0`**, so TS 7 is not yet supported by the linter. **Pin TypeScript 6.0.x** until typescript-eslint widens its range |
| typescript-eslint / ESLint | 8.71.1 / 10.12.0 | MIT / MIT (checked 2026-10-07, VF-16) | Peer `eslint ^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` |
| Next.js | 16.3.8 (16.4.0 on 2026-10-07) | MIT (VF-16) | Considered and not chosen (D-UI-04) |
| @tanstack/react-router | 1.170.41 | MIT | Typed URL search params (docs page exists) |
| @tanstack/react-query | 5.104.1 | MIT | Peer `react ^18 \|\| ^19` |
| @tanstack/react-table | 9.2.6 | MIT | Peer `react >=18`; engines `node >=20` |
| @tanstack/react-virtual | 3.14.13 | MIT | — |
| radix-ui | 1.7.0 | MIT | Unstyled accessible primitives (dialog, popover, tabs, tooltip) |
| cmdk | 1.1.1 | MIT | Command palette primitive; published 2025-03-14 (2025-08-27 is the registry's modified time; corrected 2026-10-07, VF-16) |
| zod | 4.6.5 | MIT | Runtime schema validation of every VM payload |
| uPlot | 1.6.32 | MIT | Last published 2025-03-14. The README claims ~50 KB min and benchmarks against Chart.js and ECharts; these are the author's own claims (UI-F36) |
| lightweight-charts | 5.2.1 | Apache-2.0 | **Licence requires attribution**: "This license requires specifying TradingView as the product creator … add the 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/ to the page"; the `attributionLogo` chart option satisfies the link requirement (README, UI-F35). Built-in series: Area, Bar, Baseline, Candlestick, Histogram, Line; custom series via plugins (UI-F35) |
| echarts | 6.1.0 | Apache-2.0 | Considered (D-UI-05) |
| recharts | 3.10.1 | MIT | Considered; not evaluated in depth here |
| lucide-react | 1.52.0 (built: 1.47.0, U-04) | ISC | Icons |
| @fontsource-variable/inter, …/jetbrains-mono | 5.3.0 | OFL-1.1 | Self-hosted fonts |
| tailwindcss | 4.3.3 | MIT | Alternative for D-UI-06 |
| motion | 14.0.0 | MIT | **Not needed**; CSS transitions cover the motion spec |
| Vitest | 5.0.3 | MIT (VF-16) | Unit and component tests |
| @playwright/test | 1.63.0 | Apache-2.0 (VF-16) | End-to-end and screenshot tests |
| axe-core / @axe-core/playwright | 4.14.0 / 4.13.0 | MPL-2.0 / MPL-2.0 (VF-16) | Automated accessibility checks. Allowed for dev and test only, never at runtime (Meme-snipe `docs/DECISIONS.md`, 2026-10-07) |
| Storybook | 10.6.1 | MIT (VF-16) | Component state catalogue + visual regression source |

Licence fields not listed ("—") were not checked in this session; check them before adoption (open question Q-12). On 2026-10-07 every remaining "—" licence above was checked against the npm registry (VF-16), and every listed version was still `latest` except Next.js.

### Recommendation

**DECISION D-UI-04 — application framework.**
- Option A (**recommended**): React 19 + TypeScript 6.0 + Vite 8, built to **static files** served by the bot's own API process on the same origin. There is no Node server in production. A private single-operator console gains nothing from server-side rendering, and every extra server is attack surface on a machine that can move funds.
- Option B: Next.js 16 (SSR or app router). Brings a server runtime, server actions and more configuration surface with no user-facing benefit here.
- Option C: Svelte or Solid. Smaller runtime, but a thinner ecosystem for accessible primitives, tables and the specific libraries above. Not justified for a one-person operator console.

**DECISION D-UI-05 — charts.**
- Option A (**recommended**): **uPlot** for all metric time series (equity, drawdown, latency, landing rate, costs). Canvas, small, fast, MIT. Plus **Lightweight Charts** only for the token price candle chart, with the required TradingView attribution shown on that chart (UI-F35). Lazy-load Lightweight Charts with the inspector's Price tab.
- Option B: Lightweight Charts for everything. One library and a Baseline series fits PnL well, but the attribution requirement then applies across the app, and it is aimed at price charts rather than multi-series operational metrics.
- Option C: ECharts for everything. Very capable, but a much larger bundle (its own benchmark table lists ~1000 KB for ECharts 5 vs ~48 KB for uPlot, UI-F36, author-reported).
- Accessibility applies to every option: canvas charts need the table view and an `aria-label` summary (UI-T15).

**DECISION D-UI-06 — styling.**
- Option A (**recommended**): plain CSS custom properties (tokens) + CSS Modules for components. Zero runtime, works with the token tables directly, easy theming via `[data-theme]`.
- Option B: Tailwind 4 with the tokens mapped into its theme. Fast to write, but the class soup obscures the component state matrix that this spec relies on, and theme tokens must be duplicated.
- Option C: vanilla-extract. Type-safe tokens, but an extra build plugin for little gain.

Other choices:
- **State:** server state via TanStack Query (REST snapshots, paging) + a small custom stream store per VM (subscribe through React's `useSyncExternalStore`, UI-F44). No global client-state library. URL search params through TanStack Router hold all filters.
- **Multi-tab:** leader election with the Web Locks API; the leader tab owns the SSE connection and rebroadcasts envelopes on a `BroadcastChannel` (both are MDN-documented browser APIs, UI-F44). This keeps the app at one stream per browser, well under the 6-connection HTTP/1.1 limit (UI-F37).
- **Validation:** zod schemas generated from (or hand-mirrored to) the backend's contract. A CI contract test compares fixtures from the backend against the schemas.
- **Number handling:** a single `money` module with BigInt-based parse and format functions (UI-T03). The coding standard forbids `parseFloat` and `Number()` on any `*_lamports`, `*_base`, `*_usd_e6` or `*_slot` field.
- **Performance budgets (PROPOSED):** initial JS ≤ 200 KB gzip (excluding lazily loaded charts); route chunks ≤ 80 KB gzip; Lightweight Charts lazy. Table scroll at 60fps with 5,000 rows (virtualised). Time from stream event to DOM update ≤ 100 ms at p95 under 50 events/s.

### Dashboard authentication and network exposure

The dashboard can halt, resume and reconfigure trading and move the bot between paper and live. It must **never** be reachable from the public internet.

**DECISION D-UI-09 — network exposure.**
- Option A (**recommended for cost**): bind the API and dashboard to `127.0.0.1` on the bot host and reach it through a **Tailscale** tailnet. The Personal plan is "$0 Free forever", "Up to 6 users", "Unlimited user devices" per the vendor pricing page (vendor claim, UI-F41). Use tailnet ACLs so only the operator's devices can reach the port.
- Option B: self-managed **WireGuard** to the host. No third-party coordination service, more setup.
- Option C: **SSH local port-forward** (`ssh -L`) for desktop-only use. Zero extra services; no mobile access.
- Option D: a cloud identity-aware proxy (for example Cloudflare Access). Free-tier limits could not be read in this session (**UNVERIFIED**); it also exposes a public hostname, even if gated.
- **Never:** binding to `0.0.0.0` on a public interface, port-forwarding on a router, or a public URL protected only by a password.

Controls that apply whichever option is chosen:

| Control | Specification | Basis |
|---|---|---|
| Transport | HTTPS on the tailnet or WireGuard address. For SSH-forwarded `http://localhost`, the browser treats `localhost` and `127.0.0.0/8` as potentially trustworthy origins (secure context) | MDN Secure Contexts (UI-F43) |
| Passkeys | WebAuthn login. The API is available only in secure contexts | MDN Web Authentication API (UI-F43); W3C WebAuthn Level 3 Recommendation, 2026-08-25 (UI-F40) |
| Session cookie | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`. Rotate the session ID on login and on step-up | OWASP Session Management Cheat Sheet (UI-F38). Whether `Secure` cookies are accepted on plain `http://localhost` in every browser is **UNVERIFIED**; prefer HTTPS |
| Timeouts | View idle 30 min; absolute 8 h; elevation 5 min (A2) and ≤ 60s fresh assertion (A3) | OWASP ranges (UI-F38) |
| CSRF | Synchronizer token (`X-CSRF-Token` header) + reject requests whose `Sec-Fetch-Site` is not `same-origin` + `SameSite=Strict` | OWASP CSRF Cheat Sheet (UI-F39) |
| DNS-rebinding defence | Server rejects any request whose `Host` header is not on an allowlist (tailnet name, `localhost:<port>`) | Design requirement (PROPOSED) |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` | Design requirement. Whether Lightweight Charts' attribution logo loads any external resource, and whether any chosen library injects `<style>` elements (which would need a hash or nonce), is **UNVERIFIED**; check in UI-T15 and UI-T32 and keep `img-src` closed |
| No third parties at runtime | No analytics, no CDN fonts, no remote token images, no error-reporting SaaS. External explorer links open only on explicit click, with `noreferrer` | Privacy and attack-surface rule (brief hard rule 6) |
| Roles | `viewer` (read-only) and `operator`. Viewer sessions never receive `csrf_token` for command endpoints | — |
| Rate limits | Login: 5 attempts / 15 min / IP + exponential backoff. Commands: 30 / min | PROPOSED |
| Keys | The browser never sees private keys, seed phrases or RPC credentials. All signing happens server-side. The UI has no "sign" or "export key" feature | Brief hard rule 5 |
| Audit | Logins, step-ups, failed logins and every command go to VM-17 | — |
| Supply chain | Lockfile committed; exact versions; `npm audit` (or equivalent) in CI; dependency updates reviewed; production build has no source maps exposed on the network | PROPOSED |

## UI build tickets

### Conventions for all tickets

- **Dependencies** name design-system sections (DS), other tickets (UI-Tnn) and view models (VM-nn).
- **Fixtures:** every ticket ships JSON fixtures for the VMs it consumes, covering the happy path, empty, null fields, maximum-length untrusted strings, u64 maximum values (`"18446744073709551615"`), negative PnL, simulated and live. Fixture public keys and signatures are randomly generated for tests and never belong to real wallets. No secrets in fixtures.
- **Common Definition of Done (applies to every ticket in addition to its own):**
  1. TypeScript strict mode; no `any` in VM-facing code; ESLint clean.
  2. Unit tests pass; line coverage ≥ 90% for `money`, `stream` and `commands` modules and ≥ 80% elsewhere (PROPOSED thresholds).
  3. A Storybook story exists for **every** state listed for the component or screen in this spec. Playwright screenshot baselines exist for dark and light themes, Standard density, at 1440×900 (and 390×844 for mobile-relevant views), with reduced motion on (deterministic).
  4. Automated accessibility: `@axe-core/playwright` reports zero violations for WCAG 2.0/2.1/2.2 A and AA rule tags on every story and page touched. A manual keyboard-only walkthrough is recorded in the pull request.
  5. No new runtime third-party origins; CSP unchanged or stricter.
  6. No private keys, seed phrases, API keys, RPC URLs or personal data in code, fixtures, logs, screenshots or error messages.
  7. Behaviour matches this spec; any deviation is written back into this document in the same pull request.

### UI-T01 — Project scaffold, tooling and CI

- **Goal:** a reproducible React 19 + TypeScript 6.0 + Vite 8 single-page app that builds to static files and is served by the bot API on the same origin, with the test harness in place.
- **Depends on:** none (stack per Front-end stack).
- **Behaviour:** Vite project with `@vitejs/plugin-react`; TypeScript pinned to the 6.0.x line (typescript-eslint peer range, UI-F32; versions and licences rechecked 2026-10-07, VF-16); ESLint + typescript-eslint; Vitest; Playwright with `@axe-core/playwright`; Storybook 10; CSS Modules. Scripts: `dev`, `build`, `test`, `test:e2e`, `test:visual`, `storybook`, `lint`, `typecheck`. A mock API server (fixture-driven REST + SSE) for development and tests, so the UI can be built before the backend exists. The build emits hashed assets and an `index.html`; there is no Node runtime in production. The development server binds to `127.0.0.1` only. A lint rule bans `parseFloat`/`Number(` on identifiers matching `/_(lamports|base|usd_e6|slot|micro_lamports_per_cu)$/`.
- **States:** n/a.
- **Edge cases:** Node version below Vite 8's engines (`^20.19.0 || >=22.12.0`, UI-F32) → the setup script fails with a clear message.
- **Acceptance criteria:**
  1. Given a clean checkout, when `npm ci && npm run build` runs, then `dist/` contains only static files and no source maps referenced from `index.html`.
  2. Given the mock server, when `npm run dev` runs, then the app loads on `127.0.0.1` and is unreachable on other interfaces.
  3. Given code that calls `parseFloat(x.net_pnl_lamports)`, when lint runs, then it fails with the money-rule message.
  4. Given CI, when a pull request is opened, then typecheck, lint, unit, e2e, visual and accessibility jobs all run and gate the merge.
- **Tests:** unit (sample test plus the lint-rule test); visual (a blank-shell baseline); accessibility (axe on the blank shell).
- **DoD:** CI green on an empty feature; README section "Running the dashboard locally against fixtures".

### UI-T02 — Design tokens and themes

- **Goal:** implement every DS token (colour, type, spacing, radius, elevation, z-index, motion) as CSS custom properties, with dark (default) and light themes and System/Dark/Light switching.
- **Depends on:** UI-T01; DS Colour, Typography, Spacing, Radius, Elevation, Motion.
- **Behaviour:** `tokens.css` defines `:root` (dark), `[data-theme="light"]`, and `@media (prefers-color-scheme: light)` applied only when the preference is System. `<html>` gets `color-scheme` to match (Vercel guideline, UI-F16). The polarity setting swaps `--c-pos*`/`--c-neg*` to the blue/orange set via `[data-polarity="blue-orange"]`. Density sets `--row-h` (28/32/40px). Reduced motion sets every `--d-*` to 0ms except opacity fades (`--d-fast`). A machine-readable `tokens.json` is generated from the same source for tests.
- **States:** theme dark / light / system-dark / system-light; polarity default / alt; density compact / standard / comfortable; motion normal / reduced.
- **Edge cases:** OS theme changes while the app is open → follows when set to System; `forced-colors: active` → borders and focus use system colours.
- **Acceptance criteria:**
  1. Given `tokens.json`, when the contrast test runs, then every text-token/surface pair listed in DS meets ≥ 4.5:1 and every non-text pair meets ≥ 3:1, using the WCAG 2.2 relative-luminance formula, and the computed values match the DS tables to ±0.01.
  2. Given the polarity alt setting, when an element uses `--c-pos-mark`, then it renders `#3987e5` in dark.
  3. Given reduced motion, when a drawer opens, then no transform animation runs.
  4. Given theme System and an OS switch to light, when the media query changes, then the light tokens apply without reload.
- **Tests:** unit (contrast calculator against known pairs, e.g. `#ffffff` on `#000000` = 21.00); visual (a token swatch page in four theme/polarity combinations); accessibility (axe on the swatch page).
- **DoD:** the swatch page in Storybook; contrast test in CI fails the build on any regression.

### UI-T03 — Fonts and the money / unit formatting library

- **Goal:** self-hosted Inter and JetBrains Mono, and one exact formatting library for every quantity in the Number, unit and identifier formatting table.
- **Depends on:** UI-T01, UI-T02; DS Typography and Formatting; VM conventions.
- **Behaviour:**
  - Fonts from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (OFL-1.1, UI-F32), `font-display: swap`, preloading the Latin subset; an `Inter Fallback` face from `local("Arial")` with measured `size-adjust`, `ascent-override` and `descent-override` so text width shifts by less than 1% on swap. OFL texts copied into `/licenses/`.
  - `money` module (pure functions, BigInt only): `parseU64Str`, `parseI64Str`, `formatSol(lamports, {dp, signed, compact})`, `formatLamports`, `formatTokenAmount(base, decimals, opts)`, `formatPrice(decimalStr, {sig: 4})` with zero-compressed notation and an accessible label, `formatUsdE6`, `formatBps(bps, {as: "bps" | "pct"})`, `formatDuration(ms)`, `formatAge(fromIso, nowMs, offsetMs)`, `truncateMiddle(base58, 4, 4)`, `sanitizeUntrusted(str, maxChars)` (strips Unicode bidi controls U+202A–U+202E and U+2066–U+2069, zero-width U+200B–U+200D and U+FEFF; collapses whitespace; flags mixed scripts).
  - Signed output uses U+2212 for minus; zero is `±0`; a non-zero value that rounds to zero renders `<0.0001 SOL` (or the equivalent for its precision).
- **States:** n/a (library).
- **Edge cases:** `"18446744073709551615"` lamports; `"-9223372036854775808"`; `decimals = 0` and `decimals = 18`; a price of `"0.000000000123"`; an empty string or `"01"` → throws a typed `ContractError`; `null` → returns the unknown marker `—`.
- **Acceptance criteria:**
  1. Given `"1"` lamport, when `formatSol` is called with 4 dp, then it returns `<0.0001 SOL`, and the exact tooltip text is `0.000000001 SOL (1 lamport)`.
  2. Given `"-4500000"` lamports signed, then it returns `−0.0045 SOL` with U+2212.
  3. Given base `"123456789"` and decimals `6`, then `formatTokenAmount` returns `123.4568` (standard rounding to 4 dp in tables) and the exact text `123.456789`.
  4. Given price `"0.000004321"`, then the visible text is `0.0₅4321` and the accessible label is `0.000004321`.
  5. Given `formatBps(3500, {as: "pct"})`, then `35.00%`; given `formatBps(35, {as: "bps"})`, then `35 bps`.
  6. Given a symbol containing U+202E, when sanitised, then the control character is removed and `mixedScript` is reported where applicable.
  7. Given any value above `Number.MAX_SAFE_INTEGER`, when formatted, then no precision is lost (property test against string arithmetic).
- **Tests:** unit (table-driven, ≥ 200 cases, plus property-based round-trip tests); visual (a typography specimen and number gallery in both themes); accessibility (screen-reader labels on the number gallery checked with axe and a manual NVDA/VoiceOver pass for the U+2212 minus).
- **DoD:** the library is the only place numbers are formatted (enforced by a lint rule banning `toFixed` and `toLocaleString` in components).

### UI-T04 — Core primitives

- **Goal:** C01, C02, C07–C14, C19–C22, C43 (Button, IconButton, TextInput, AmountInput, Select/Combobox, Switch, Checkbox/Radio/SegmentedControl, Tabs, Tooltip, Popover/Menu, Toast, Banner, Badge/StatusPill, Kbd, NavItem) with every state in the inventory.
- **Depends on:** UI-T02, UI-T03; DS Component inventory; Radix primitives.
- **Behaviour:** built on Radix where a primitive exists (dialog, popover, tooltip, tabs, select), styled with tokens. Buttons keep their label while loading (spinner at left, width locked). AmountInput parses user text into an exact string in the target unit (SOL → lamports with at most 9 decimals; bps as an integer) and reports `invalid`, `out-of-range` or `exceeds-limit` with the min/max/limit shown. Tooltips open after 400ms on hover and immediately on focus. Toasts: polite by default, `role="alert"` for danger. Lucide icons verified to exist in the installed version (`lucide-react` 1.52.0, VF-16); any missing name gets a replacement recorded in this spec.
- **States:** exactly those in C01–C22 and C43.
- **Edge cases:** AmountInput receiving `0.1234567891` SOL (10 decimals) → invalid, never rounded; pasting `1,000.5` → accepted as `1000.5` with the thousands separator stripped; locales that use a comma decimal separator → the UI is English-only (open question Q-09), and the input accepts `.` only.
- **Acceptance criteria:**
  1. Given a Button in `loading`, when rendered, then its width equals its idle width and its accessible name is unchanged, with `aria-busy="true"`.
  2. Given AmountInput (SOL) with `0.25`, when read, then the value is `"250000000"` lamports.
  3. Given a Select with a disabled option, when it is hovered or focused, then the reason tooltip is shown and announced.
  4. Given keyboard only, when tabbing through the primitives story, then every control shows the 2px focus ring and no focus is obscured.
- **Tests:** unit (input parsing, state reducers); visual (all states × 2 themes × 3 densities); accessibility (axe per story; keyboard e2e for Select, Menu and Tabs per WAI-ARIA patterns, UI-F42).
- **DoD:** the Storybook "Primitives" section is complete; the icon-name audit is recorded.

### UI-T05 — Universal states, freshness and skeletons

- **Goal:** one StateView (C32), Skeleton (C33), FreshnessIndicator (C29) and ConnectionStatus (C30) implementing the Universal states table.
- **Depends on:** UI-T04; Screens → Universal states, Data freshness model.
- **Behaviour:** StateView takes `{kind: loading | empty | filtered-empty | error | stale | disconnected | unauthorised | forbidden | not-found, reason, context, action}`. Loading shows after 200ms and stays at least 400ms. Error keeps the last good data visible at full contrast, labelled "as of" and offers Retry and Copy diagnostics (VM ID, field path, HTTP status, `seq`; never cookies or tokens). FreshnessIndicator takes `{as_of, expected_ms, delayed_ms, stale_ms, clock: wall | sim, paused}` and renders live / delayed / stale / disconnected / paused, re-evaluating every 1s.
- **States:** all StateView kinds; Freshness `live`, `delayed`, `stale`, `disconnected`, `paused`; Connection `connected`, `reconnecting`, `disconnected`, `auth-expired`.
- **Edge cases:** a negative age (server clock ahead by more than skew) → treat as 0 and log a clock-skew diagnostic; `as_of` missing → `stale` with reason "no timestamp".
- **Acceptance criteria:**
  1. Given a request that resolves in 150ms, when a panel loads, then no skeleton flashes.
  2. Given a request that resolves in 250ms, then the skeleton shows from 200ms to at least 600ms.
  3. Given VM-12 data older than 5s, then the panel shows `Stale · 6s`, and raise-limit actions are disabled with the reason "Risk status is stale".
  4. Given replay mode (`clock: sim`), when the simulation is paused, then data freshness uses `sim_clock.sim_time` while ConnectionStatus still uses the wall clock.
- **Tests:** unit (freshness state machine with fake timers); visual (every state); accessibility (status changes announced politely; the disconnected banner via `role="alert"` once, not every second).
- **DoD:** every screen ticket uses these components; no ad-hoc spinners anywhere.

### UI-T06 — DataTable

- **Goal:** the C23 table used by Positions, Journal, Signals, Health, Audit and Config diff.
- **Depends on:** UI-T03, UI-T04, UI-T05; TanStack Table and Virtual.
- **Behaviour:** column definitions with `format` (from UI-T03), alignment (numbers right-aligned, tabular figures), min/max width, sort (client-side for streamed sets, server-side for paged sets), pinning, resizing (mouse and keyboard), and a per-table column-visibility menu persisted in preferences. Virtualised above 200 rows. Keyboard: `J`/`K`/arrows move the focused row (roving `tabindex`), `Enter` opens, `Space` selects, `Home`/`End`. Row states `new` (2s marker) and `updated` (cell tint `--d-value-flash`, at most once per second per cell). Streamed inserts do not move the focused row: if the user has scrolled or focused a row, new rows above increment a "n new" pill instead of shifting content. "Copy row as JSON" copies the raw VM entity (big integers as strings).
- **States:** as C23.
- **Edge cases:** 10,000 rows; a cell value changing 20 times per second (flash throttled, text always current); untrusted strings at maximum length (ellipsis + full text in tooltip); RTL-override attempts (sanitised).
- **Acceptance criteria:**
  1. Given 5,000 rows, when scrolled, then the frame rate stays ≥ 55fps on the reference machine (PROPOSED: a 4-core laptop, Chrome stable) and DOM rows ≤ 60.
  2. Given focus on row 10 and 3 streamed inserts at the top, then focus stays on the same entity and the "3 new" pill appears.
  3. Given a numeric column, then all digits align (tabular figures) in a screenshot diff.
  4. Given keyboard only, then sort, resize and column visibility are operable.
- **Tests:** unit (sorting with BigInt strings, throttle logic); visual (all table states, both densities); accessibility (grid semantics: `role="grid"` only if cell navigation is implemented, otherwise a native `table`; axe clean).
- **DoD:** used by at least the Positions fixture page; the performance benchmark is recorded in CI as a non-gating trend.

### UI-T07 — Dialog family and safety components

- **Goal:** C03 HoldButton, C15 Dialog/AlertDialog, C16 TypedConfirmDialog, C17 StepUpAuth (presentation only), C44 Countdown, C38 DiffView — presentational and accessible. Wiring to commands happens in UI-T13.
- **Depends on:** UI-T04, UI-T05; DS Motion (`--hold-to-confirm`); Safety UX.
- **Behaviour:** AlertDialog uses `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` and `aria-describedby` (UI-F42), traps focus, sets initial focus on the least destructive action (except HALT, where "Halt now" receives focus by design because halting reduces risk), and returns focus on close. Mode-aware: the title prefix ("LIVE:", "Paper:", "Replay:") and the orchid top border in live come from VM-03. TypedConfirmDialog compares the trimmed input to `required_phrase` exactly (case-sensitive) and shows a character-by-character match hint; the confirm button is disabled until it matches (a deliberate exception to "don't pre-disable submit", because the typed phrase *is* the confirmation). HoldButton: pointer down starts a 1000ms progress ring; release before completion rewinds in 160ms; completion emits `onConfirm`; keyboard `Enter`/`Space` does **not** hold but opens the HALT dialog. Countdown renders server time minus clock offset and never ticks below 0.
- **States:** as C03, C15, C16, C17, C38, C44.
- **Edge cases:** the dialog opens while the stream is disconnected (non-HALT dialogs show "Disconnected · cannot confirm current state" and disable submit); a mode change while the dialog is open → the dialog closes and shows "Mode changed to X — review again"; touch-cancel during hold → rewind.
- **Acceptance criteria:**
  1. Given an A3 dialog with phrase `LIVE-SMALL 0.25`, when the user types `live-small 0.25`, then confirm stays disabled and the hint shows the case mismatch.
  2. Given a HoldButton, when released at 700ms, then no confirm event fires.
  3. Given mode `live`, when any money-affecting dialog opens, then its title starts with "LIVE:" and the screen reader announces it.
  4. Given the dialog is closed with Esc, then focus returns to the triggering control.
- **Tests:** unit (phrase matcher, hold timer with fake timers); visual (each state in paper and live); accessibility (focus trap, labelled dialog, no focus obscured; axe).
- **DoD:** stories for every state × {paper, live}.

### Built in Z05 (UI-T01..UI-T07, card notes)

Deviations written back (common Definition of Done 7). Rulings: `docs/reviews/Z05.md`; decisions: `docs/DECISIONS.md` "Z05 UI system".

- **Build and tests (UI-T01).** Vite 8.3.2's build API (`packages/dashboard/test/tooling/build.ts`), Vitest with happy-dom, an in-repository catalogue in place of Storybook, `createElement` in place of JSX (only `.ts` modules under `packages/`). Line coverage is not measured for now: the repository has no Vitest coverage provider (supervisor, 2026-10-08).
- **Security headers (UI-T32).** The production CSP and the other headers in the security table are sent only by the development and test server (`test/tooling/serve.ts`) today. The production server must send the same headers. That is tested in the card that builds that server, not here.
- **Freshness (UI-T05).** Data ahead of the server clock by more than `CLOCK_SKEW_TOLERANCE_MS` (1 s) is stale, with the reason "clock skew", and blocks risk-increasing actions. Paused and disconnected keep the age state. Paused always blocks risk-increasing actions, and so does stale data under paused or disconnected.
- **AmountInput (UI-T04 edge case).** SOL and token amounts refuse commas outright, so `0,250` and `1,500` are invalid. This replaces "pasting `1,000.5` → accepted as `1000.5`". bps and percent keep thousands groups, and a group may not start with 0. Their values are read back from the bigint, never through `Number`. The field always shows the parsed value back ("Reads as 0.25 SOL"). The stored value is handed on only when it is valid, never when it is out of range or over a limit.
- **Dialogs (UI-T07).** A money-affecting confirm is disabled, with its reason, while the connection is not `connected` (disconnected, reconnecting or unknown) or the mode is unknown. HALT is exempt, because it reduces risk. The exemption belongs to `HaltDialog` alone, which owns its title ("Halt trading") and its confirm ("Halt now", sending the halt command); the generic `Dialog` never exempts any action, whatever props it is given. A dialog's secondary action always gets the same gate, HALT's included: "Halt and flatten all…" is the A2 flatten flow and sells. No action can be marked risk-reducing. HaltDialog's confirm takes only a `HaltCommand`, a branded function that only `src/lib/halt-command.ts` makes and that sends `{ type: 'halt', params: {} }`. A change to or from an unknown mode is a mode change, and in the render where the mode changed, every action is already disabled except HALT's confirm. Every dialog closes on a mode change (the UI-T07 edge case), HALT's included: the notice says the mode changed, and the operator reopens HALT from the header (hold, `Enter` or `⇧H`), which is never blocked. Both offline modes use the title prefix "Replay:".
- **HoldButton (UI-T07).** A hold is cancelled by touch cancel, lost capture, leaving the button or a move of more than 10 px (a finger resting on HALT while the page scrolls). Only a press that starts a hold claims the click that follows its pointer up, and that claim expires after 1 s. A press cancelled by a move or by leaving the button keeps its claim for as long as the pointer is down, so releasing it on the button opens nothing, however long the drag. The 1 s expiry starts from the pointer up, on the button or anywhere on the page (a window listener catches it when there is no pointer capture); touch cancel (on the button, or anywhere on the page for the same pointer) and lost capture before the pointer up end the claim at once.
- **Copy guard.** The dashboard's no-AI-wording guard reads text as a reader sees it: NFKC, no format characters or other default-ignorable code points, and look-alike letters mapped to Latin: every single-letter skeleton in Unicode's confusables.txt 18.0.0, plus Cherokee small letters and Latin small capitals from UnicodeData.txt 18.0.0. The table is generated by `test/copy/generate-lookalikes.ts` from both files, kept in the repository with their sha256, and a test checks that the committed table equals its output. Apostrophe look-alikes (every confusables.txt source whose skeleton is `'`) read as `'`, dashes (`\p{Pd}`) as `-`, runs of white space as one space; enclosing marks are dropped, and spacing marks between Latin letters. text is read as written and with ASCII `l`, `I` and `|` read both as `l` and as `I` (not `1`: the action class A1 is copy), and the letter pairs `rn`, `vv` and `cl` are read as `m`, `w` and `d`, in the text and in each banned word. The guard covers accidental wording in our own copy; deliberate look-alike hunting is out of its scope. Combining marks are removed, and text is read twice, with l-like letters as `l` and as `I`. It matches AI in any case, catches phrases split over two strings, and scans the built bundle and the rendered pages (`packages/dashboard/test/copy/`, `test/e2e/copy.e2e.ts`).

### UI-T08 — Data client: REST, SSE stream, schemas, clock and multi-tab

- **Goal:** the single source of live data: snapshot fetching, the SSE envelope stream (VM-01), patch application, gap recovery, clock offset, freshness metadata, zod validation for VM-01…VM-21 (schemas imported from the shared `@bot/contract` package owned by backend ticket B-M28-01; the UI never redefines a VM schema), and multi-tab sharing.
- **Depends on:** UI-T01; VM-01 to VM-21 (all), View-model conventions. Backend: B-M28-01 (`@bot/contract`), B-M28-04 (stream), B-M28-05 (REST).
- **Behaviour:**
  - On start: fetch snapshots for the subscribed VMs (TanStack Query), then open `EventSource` on the stream with the topic list. Apply `snapshot` / `upsert` / `remove` / `replace` per VM store. Each store exposes `{data, as_of, emitted_at, seq, status}` via `useSyncExternalStore`.
  - `seq` gap within one connection → refetch snapshots for all subscribed VMs, then resume. `reset` event → the same. `incompatible` → a blocking "Dashboard update required" StateView.
  - Clock offset from heartbeats (median of the last 10). Heartbeat missing for 4s → `delayed`; for 10s → `disconnected` and close/reopen the EventSource with jittered backoff (1, 2, 4, 8, max 15s).
  - Every payload is validated with zod. A failure marks that VM `error`, keeps the last good data, and posts a diagnostic (VM ID, path, issue code; no values longer than 64 chars, no secrets).
  - Multi-tab: the Web Locks API elects one leader tab per browser that owns the EventSource and rebroadcasts envelopes on a `BroadcastChannel`; followers fail over within 3s when the leader closes.
  - 401 on any request → stop the stream, route to `/login?next=…`.
- **States:** per VM: `idle`, `loading`, `live`, `delayed`, `stale`, `error`, `disconnected`, `incompatible`.
- **Edge cases:** a burst of 1,000 events in one second (batch with `requestAnimationFrame`; no dropped events); an out-of-order `seq` after reconnect (discard events with `seq` ≤ the last applied); a tab sleeping for 10 minutes (on wake: full resync); a laptop clock 5 minutes off (ages still correct via offset).
- **Acceptance criteria:**
  1. Given the stream sends seq 10, 11, 13, then the client refetches snapshots and the final state equals the server fixture state.
  2. Given no heartbeat for 10s, then every VM reports `disconnected` and the global banner appears within 1s.
  3. Given a payload with `net_pnl_lamports: 123` (a number, not a string), then validation fails, the VM shows `error`, and the value is not rendered.
  4. Given three open tabs, then the server sees exactly one stream connection from the browser.
  5. Given the local clock is 300s fast, then the age of an event emitted 2s ago displays as 2s (±1s).
- **Tests:** unit (patch reducer, gap detection, offset estimator, backoff); integration with the mock SSE server (disconnects, resets, bursts); e2e multi-tab test in Playwright (two pages, one context).
- **DoD:** zod schemas for all 21 VMs (from `@bot/contract`) with fixture round-trip tests; the contract fixture suite can run against the real backend in a staging environment (backend-owned).

### UI-T09 — Authentication, session and step-up

- **Goal:** passkey sign-in (S-00), session lifecycle, CSRF header, roles, and the step-up flow used by A2/A3 commands.
- **Depends on:** UI-T04, UI-T07, UI-T08; VM-02; Front-end stack → authentication controls.
- **Behaviour:** `/login` calls the backend's WebAuthn ceremony endpoints (PROPOSED; the backend owns them) and uses `navigator.credentials.get()` (WebAuthn, secure context only, UI-F43). On success the server sets the `__Host-` session cookie (UI-F38); the UI never reads or stores it. `csrf_token` from VM-02 is kept in memory only (not `localStorage`) and sent as `X-CSRF-Token` on every non-GET request. Idle warning dialog 60s before `idle_timeout_s` elapses ("Stay signed in"). Step-up: when a preview says `requires_step_up`, StepUpAuth runs a fresh assertion and passes it with the command. Role `viewer` hides all A1–A3 controls and shows a read-only badge. `client_kind = mobile` sessions route to `/m`.
- **States:** S-00 states; StepUpAuth states (C17); session `active`, `idle-warning`, `expired`.
- **Edge cases:** browser without WebAuthn → "This browser cannot use passkeys" with the CLI recovery-code path; the user cancels the passkey prompt → back to idle, no error toast; the system clock is wrong → no effect, because expiry is computed with the server offset; a session that expires mid-dialog → the dialog shows "Session expired — sign in again", and the command is not sent.
- **Acceptance criteria:**
  1. Given no session, when `/positions?inspect=X` is opened, then the app redirects to `/login?next=%2Fpositions%3Finspect%3DX` and returns there after sign-in.
  2. Given an operator whose elevation expired, when RESUME is confirmed, then the step-up prompt appears before the command is sent, and the command carries the assertion.
  3. Given a viewer, then no HALT, close, edit or mode buttons are rendered, and direct command URLs return 403 with a read-only message.
  4. Given 29 idle minutes, then the warning dialog appears; with no response at 30 minutes, the stream closes and the login page shows "Signed out after 30 minutes of inactivity".
- **Tests:** unit (session timers with an offset clock); e2e with a virtual WebAuthn authenticator if Playwright 1.63 offers one (**UNVERIFIED**), otherwise with a mocked `navigator.credentials`; visual (S-00 states); accessibility (login form and step-up dialog axe-clean; no cognitive test, WCAG 3.3.8).
- **DoD:** no auth token is persisted in web storage (verified by an e2e storage dump).

### UI-T10 — App shell, routing and navigation

- **Goal:** the global frame: sidebar, header, status bar, banner stack, routes from the IA, URL-synced filters, the inspector drawer host, preferences application.
- **Depends on:** UI-T04, UI-T05, UI-T08, UI-T09; VM-01, VM-03, VM-13, VM-16 (alert counts).
- **Behaviour:** TanStack Router with typed search params for every filter in the IA. Sidebar groups and counts (positions count from VM-05, alert dot from VM-16). Header: title, page filters slot, global FreshnessIndicator (worst of the page's VMs), ⌘K hint, HALT slot (filled by UI-T14). Status bar items from VM-13 and VM-01 link to `/health`. Banner stack with the priority order and the "+n" collapse rule. The drawer is URL-driven (`?inspect=<mint>`). Responsive breakpoints per DS Layout; below 768px redirect to `/m` unless `?desktop=1`.
- **States:** sidebar expanded/collapsed; banners 0/1/2/+n; drawer open/closed; route not found.
- **Edge cases:** deep link to a removed position → not-found StateView with a link to the journal; browser Back closes the drawer before leaving the page.
- **Acceptance criteria:**
  1. Given `/journal?mode=paper&outcome=loss`, when loaded, then the filters show those values, and changing a filter updates the URL without a full reload.
  2. Given the disconnected state and a stale-risk state together, then the banner stack shows "Disconnected" first and "Risk status unknown" second.
  3. Given 1280px width, then the sidebar is expanded; at 1024px it is collapsed to icons with tooltips.
  4. Given keyboard only, then a "Skip to content" link is the first focusable element.
- **Tests:** unit (search-param schemas); visual (frame at 1440, 1024, 768); accessibility (landmarks `nav`, `main`, `header`, `footer`; axe).
- **DoD:** every IA route renders a placeholder with the correct title and document title prefix (UI-T11).

### UI-T11 — Mode treatment (ModeBar, frame, title, favicon, announcements)

- **Goal:** make paper versus live unmistakable through every channel in "Mode treatment".
- **Depends on:** UI-T02, UI-T10; VM-03 (`mode`, `simulated`, `mode_since`, `live_caps`, `scheduled_change`, `sim_clock`), VM-01 (`mode` on every envelope).
- **Behaviour:** ModeBar (C05) renders per mode, including `transition-pending`, `scheduled` with Countdown and Cancel (A1, wired in UI-T13), and `unknown` when disconnected (last known mode retained with a warning stripe). The 2px viewport frame is rendered in a fixed layer at `--z-mode-frame`, above dialogs, with `pointer-events: none`: dashed paper, solid live, none offline. `document.title` prefix `[LIVE]`, `[PAPER]`, `[REPLAY]`, `[BACKTEST]`; favicon swapped among four SVG data-URI variants. Live regions: polite for offline and paper, assertive for live, announced on load and on change only. Every money value component reads `simulated` from its own VM (not from VM-03) to show the `SIM` badge. **Consistency check:** if any VM envelope's `mode` differs from VM-03 `mode` for more than 2s, show a danger banner "Mode mismatch between data sources" and disable money-affecting actions except HALT.
- **States:** C05 states × 5 modes.
- **Edge cases:** a replay at 100× speed (the sim clock updates at most 1 Hz in the bar); a mode switch while a dialog is open (the dialog closes, UI-T07); light theme (live fill `#a21caf` with white text).
- **Acceptance criteria:**
  1. Given mode `paper`, then the mode bar shows the hatch and the text `PAPER · simulated fills · no real funds`, the frame is dashed cyan, and the title starts with `[PAPER]`.
  2. Given mode `live_small`, then the bar is the solid live fill with `LIVE-SMALL · REAL FUNDS · max <cap> SOL per trade`, where the cap comes from `live_caps.max_trade_lamports`, formatted by UI-T03.
  3. Given a greyscale screenshot (CSS `filter: grayscale(1)` in a test), then paper and live remain distinguishable by text, pattern and frame style (visual test).
  4. Given a simulated deuteranopia filter, then the same holds.
  5. Given a mismatch (VM-05 envelope says `live`, VM-03 says `paper`), then the mismatch banner appears within 3s.
- **Tests:** unit (title/favicon selection); visual (5 modes × 2 themes × normal/greyscale); accessibility (live-region announcements via Playwright accessibility snapshots; axe).
- **DoD:** reviewed by someone who did not build it: shown 10 random screenshots, they identify the mode correctly 10/10 (recorded in the PR).

### UI-T12 — Command palette, keyboard shortcuts and help

- **Goal:** C34 palette, the global shortcut map and C35 help overlay.
- **Depends on:** UI-T07, UI-T10; cmdk; all routes; command flows from UI-T13 (palette actions open those flows).
- **Behaviour:** `⌘K`/`Ctrl K` opens the palette (platform-detected labels). Root groups: Navigate, Search, Actions, Preferences. Search for a mint/prefix (exact base58 first), a symbol (lists every mint; never auto-picks), position, trade or signature IDs (searches the loaded stores first, then the backend search endpoint, PROPOSED `GET /api/v1/search?q=`). Actions show their class badge and a disabled reason. Nested pages (e.g. "Close position…" → pick a position); Backspace on an empty input pops the page. G-sequences have a 1s window; shortcuts are ignored in text inputs; the S-15 setting turns off or remaps character shortcuts (WCAG 2.1.4, UI-F28). `?` opens the help overlay, generated from the same shortcut registry so the docs cannot drift.
- **States:** C34 and C35 states.
- **Edge cases:** pressing `G` then waiting 2s → no navigation; IME composition active → shortcuts ignored; a palette action becomes disabled while the palette is open (state change) → the item updates in place.
- **Acceptance criteria:**
  1. Given focus anywhere outside a text input, when `G` then `R` is pressed, then the app navigates to `/risk`.
  2. Given the palette with "Promote to live-small…" while gates fail, then the item is disabled and shows "2 gates failing".
  3. Given a symbol search matching three mints, then all three are listed with truncated mints, and none is pre-selected for an action.
  4. Given the S-15 setting "character shortcuts off", then `G R` does nothing and `⌘K` still works.
- **Tests:** unit (sequence parser, registry); e2e (keyboard flows); visual (palette states); accessibility (combobox/listbox semantics, `aria-activedescendant`, UI-F42; axe).
- **DoD:** every action in Safety UX is reachable from the palette.

### UI-T13 — Command framework (preview → confirm → submit → status)

- **Goal:** one implementation of the command lifecycle used by every money-affecting action.
- **Depends on:** UI-T07, UI-T08, UI-T09; VM-19, VM-17, VM-03 (`state_version`).
- **Behaviour:** `useCommand(type)` returns `open(params)`: generates `command_id` (ULID) → calls preview → renders the right dialog for `action_class` (A1 AlertDialog; A2 dialog + reason + step-up if needed; A3 TypedConfirm + checklist + reason + fresh step-up) → submits with `expected_state_version`, `Idempotency-Key`, `X-CSRF-Token`, `dialog_version` and `dialog_text_hash` (SHA-256 of the rendered dialog text via Web Crypto) → shows `pending` → resolves on the response or on the `command.updated` push. `409` → re-preview and show what changed. Timeout (10s) or network error → `unknown-outcome`, then poll `GET /commands/{id}` every 2s up to 60s, then the "Outcome unknown — check the audit log" state with a link. Never retries with a new `command_id`. `scheduled` → registers a Countdown on the ModeBar or the Risk page and a Cancel (A1 `cancel_scheduled`). There are no optimistic UI changes.
- **States:** C16 states + `unknown-outcome` + `conflict` (409).
- **Edge cases:** a double-click on confirm (one request; the button goes `pending` on the first click); the tab closes during `pending` (the server proceeds; on reopen, the audit log and VM state show the result); the server derives a higher class than the preview showed (submit returns 403 `class_changed` → re-preview); disconnected during submit (HALT uses direct retries per UI-T14; others fail with a clear message).
- **Acceptance criteria:**
  1. Given an A3 limit raise, when confirmed, then exactly one POST is sent, with the typed phrase, the reason, the step-up assertion and the dialog hash, and the UI shows `scheduled` with the server's `effective_at`.
  2. Given the POST times out, then the UI shows "Outcome unknown", polls the status, and shows `executed` once the server reports it, without sending a second command.
  3. Given a 409, then the dialog re-opens with a "State changed since you opened this" diff and requires confirmation again.
  4. Given any command result, then an audit link (`audit_event_id`) is shown.
- **Tests:** unit (lifecycle state machine with every response code); integration with the mock server; visual (each state); accessibility (status changes announced; focus management on errors).
- **DoD:** no component submits a command except through this framework (lint rule on `fetch('/api/v1/commands'`).

### UI-T14 — Kill switch: HALT, RESUME, FLATTEN ALL

- **Goal:** C03/C04 and the HALT, RESUME and FLATTEN ALL flows per Safety UX and D-UI-07.
- **Depends on:** UI-T07, UI-T11, UI-T13; VM-03 (`trading_state`, `kill.*`, `signer.*`), VM-05, VM-12 (`breakers`), VM-19. Backend: B-M26-01, B-M26-02, B-M17-08 (latch setter and lease holder), B-M29-04 (`botctl halt`, `botctl resume-latch`).
- **Behaviour:** header HoldButton + `⇧H` dialog. HALT is A1: no step-up, no reason required (optional note). While disconnected, HALT sends a direct POST with 3 attempts (1s, 2s, 4s) reusing the `command_id`; failure → "HALT NOT CONFIRMED" danger state with the out-of-band instructions: `ssh <host> botctl halt --reason "<text>"` (ARCH 12.6, U-14 resolved). Header states follow VM-03 `trading_state`, including `halt_partial` with the list of unacknowledged components, and `auto-halted` with breaker details. RESUME is A2 (reason + step-up), and is blocked while any breaker with `requires_manual_reset` is tripped (the UI offers "Reset breaker…" first). FLATTEN ALL is A2: the preview lists every position with estimated proceeds, price impact and the `max_slippage_bps` that will be applied; totals; the mode is in the title.
- **States:** C04 states (including `exits-only` and `sentinel-managing`, UC-07); HALT dialog `idle`, `pending`, `acked`, `partial`, `failed`, `unconfirmed`. RESUME dialog `latch-requires-host-cli` (UC-08): when VM-03 `kill.latch_clear_requires = host_cli` the dialog explains `botctl resume-latch --reason "<text>"` and RESUME stays disabled until the field becomes `null`.
- **Edge cases:** HALT pressed twice (the second press shows "Already halting"); HALT while a scheduled live promotion is pending (the dialog offers "Also cancel the scheduled promotion" checked by default); flatten with zero positions (dialog says "Nothing to flatten"); flatten with a stale mark (warning line per position).
- **Acceptance criteria:**
  1. Given trading `running`, when the HALT button is held for 1000ms, then a `halt` command is sent once and the header shows `Halting…` until VM-03 reports `halted`.
  2. Given keyboard focus on the HALT button, when `Enter` is pressed, then the HALT dialog opens with focus on "Halt now", and a second `Enter` sends the command.
  3. Given the stream is disconnected and the server is reachable over HTTP, when HALT is confirmed, then the POST is sent and success is shown from the POST response alone.
  4. Given the server is unreachable, then after 3 attempts the UI shows "HALT NOT CONFIRMED" and never displays "Halted".
  5. Given an auto-halt from the weekly-loss limit or a breaker with `requires_manual_reset`, then the danger banner names the limit or breaker, the reason and the time, and RESUME is disabled until it is reset (the daily loss stop only blocks entries, ARCH 8.2).
  6. Given VM-03 `kill.latch_set_by = sentinel` and `kill.latch_clear_requires = host_cli`, then the RESUME button is disabled with the `botctl resume-latch` instruction, and becomes enabled only after VM-03 reports `kill.latch_clear_requires = null` (UC-08).
- **Tests:** unit (state mapping); e2e against the mock server (normal, partial, unreachable); visual (all states, paper and live); accessibility (hold alternative via keyboard; `role="alert"` on the result; axe).
- **DoD:** a "kill switch drill" e2e scenario (halt → verify → resume) runs in CI and its last pass time is exportable for the readiness gate (VM-18, backend-owned).

### UI-T15 — Charts foundation

- **Goal:** themed, accessible chart components on uPlot (metrics) and Lightweight Charts (price candles), with the table view.
- **Depends on:** UI-T02, UI-T03, UI-T05; DS Data-visualisation palette; VM-10.
- **Behaviour:** `<TimeSeriesChart>` wraps uPlot: one y-axis; 2px lines; hairline grid; crosshair with one tooltip listing all series (values lead, labels follow); gaps from `gaps[]` drawn as breaks; zoom via buttons and keyboard (`+`, `-`, `0` reset; no drag-only); threshold lines with labels; theming from tokens (re-render on theme change); "View as table" (`T`) renders the same data in a DataTable. `<CandleChart>` lazily loads Lightweight Charts with `attributionLogo` enabled and the NOTICE text included in `/licenses`, per the licence (UI-F35); entry/stop/target price lines; fill markers. Categorical colours are assigned by a stable hash of the entity ID to a slot and persisted; never by rank. An `aria-label` summary generator ("Equity, 7 days, from X to Y, max drawdown Z").
- **States:** C26 states.
- **Edge cases:** a single data point; all-zero series; a huge outlier (log-scale toggle only on charts that allow it; PnL charts stay linear around zero); more than 8 categories (fold into "Other"); the theme switching while a tooltip is open.
- **Acceptance criteria:**
  1. Given equity and drawdown series, then they render as two vertically stacked charts with a shared x-axis, never one dual-axis chart.
  2. Given a gap from 10:00 to 10:20, then the line breaks across it, and the table view lists the gap.
  3. Given the CSP from the security table, when the candle chart loads, then there are no CSP violations (this verifies whether the attribution logo needs any external resource; if it does, record that and find a compliant option).
  4. Given keyboard focus on a chart, then arrow keys move the crosshair point by point, and the tooltip content is exposed to assistive technology.
  5. Given the sequential and diverging ramps generated from tokens, then an automated check confirms monotonic OKLCH lightness per arm.
- **Tests:** unit (colour slot hashing, ramp monotonicity, summary text); visual (each chart type and state in both themes); accessibility (table view axe-clean; chart `aria-label` present).
- **DoD:** the licence/attribution page lists TradingView per the README requirement.

### UI-T16 — Overview screen (S-01)

- **Goal:** S-01 as specified.
- **Depends on:** UI-T05, UI-T06, UI-T10, UI-T14, UI-T15; VM-04, VM-05, VM-07, VM-10, VM-11, VM-12, VM-13, VM-14, VM-16.
- **Behaviour:** the period selector scopes every tile; tiles per the S-01 table; the equity hero uses `--t-hero` with proportional figures; delta signed with ▲/▼; USD shown with `≈` and the price as-of in the tooltip; panels link to their full pages.
- **States:** every panel has loading, empty, error and stale states; the page as a whole shows the `SIM` badges in paper.
- **Edge cases:** no SOL/USD price (USD hidden, with "USD price unavailable" in the tooltip); equity of zero (the "unknown" state is distinct from zero); a fresh install with no trades.
- **Acceptance criteria:**
  1. Given paper mode, then every money tile shows the `SIM` badge, sourced from each VM's `simulated` flag.
  2. Given VM-11 `today_utc.net_pnl_lamports = "-4500000"`, then the tile shows `▼ −0.0045 SOL` in the loss colour with an accessible label "minus 0.0045 SOL".
  3. Given VM-13 stale beyond 6s, then only the Health panel shows stale; other panels are unaffected.
- **Tests:** unit (view-model selectors); visual (fixtures: fresh install, paper active, live with losses, disconnected); accessibility (axe; heading order).
- **DoD:** page performance: under 50 stream events/s, p95 event-to-DOM ≤ 100ms (measured in the e2e performance test).

### UI-T17 — Positions screen and close-position flow (S-02)

- **Goal:** S-02 with C23 columns and the close and close-all entry points.
- **Depends on:** UI-T06, UI-T13, UI-T14 (close-all = FLATTEN ALL), UI-T20 (inspector, can stub first); VM-05, VM-03.
- **Behaviour:** columns and formats per the S-02 table; sort default by absolute unrealised net PnL; `C` opens close for the focused row (A1 dialog with estimated proceeds, impact, mark age, mode prefix; `max_slippage_bps` defaulted from config and editable within the server's bounds); `closing` and `close_failed` row states (plus the `orphan` flag); the Stop and Target cells show the nearest item of `stops[]` / `targets[]` with a "+n" tooltip (UC-02) and outline in danger when any stop has `armed = false`; an `opening` row shows armed stops and the `entry_unconfirmed` flag (UC-03); the "Other tokens in the wallet" list with A1 "Close account…" (`close_unsolicited`) and the A2 "Write off…" action (`write_off_position`) per S-02 (UC-13, UC-14). Backend: B-M20-02, B-M20-05, B-M22-04, B-M26-02.
- **States:** C23 states + position states.
- **Edge cases:** `decimals` null (amount `—`, and close still allowed because the server knows the decimals); mark null (PnL `—`; the close dialog warns "No current quote"); a position closes while its dialog is open (the dialog shows "Position already closed").
- **Acceptance criteria:**
  1. Given a position with `mark_method = mid`, then the mark tooltip says "mid price — may overstate exit value" (D-UI-08).
  2. Given close confirmed, then the row shows `closing` until VM-05 reports `closed` (the row then animates out) or `close_failed` (danger pill + Retry).
  3. Given the unrealised PnL fixture `unrealized_pnl_net_lamports = exit_value_est − entry_cost + realized_partial`, then the UI displays the server's value and never recomputes it (a contract test asserts the identity on fixtures).
- **Tests:** unit (column formatters); e2e (close, fail, retry); visual (row states); accessibility (axe; row actions reachable by keyboard).
- **DoD:** no manual "open/buy" control exists anywhere (scope check in review).

### UI-T18 — Closed-trade journal (S-03)

- **Goal:** S-03 with filters, totals, cursor pagination, row expansion and CSV export.
- **Depends on:** UI-T06, UI-T10; VM-06. Backend: B-M23-02, B-M23-04 (journal), B-M28-05 (`/journal.csv`).
- **Behaviour:** the exit-reason filter lists the full UC-01 enum; rows show `source` and `shadow` badges; filters in the URL; totals for the whole filter from `totals.*`; rows expand to the cost breakdown and transaction signatures; new closes arrive by push and show a "n new trades" pill when the user is not at the top; CSV via the server endpoint.
- **States:** C23 states + `end of history`.
- **Edge cases:** paper and live mixed under "All modes" (a mode column is always visible, plus a per-row badge); negative `implicit_slippage_lamports` (price improvement) shown with the tooltip "price improvement; already included in gross"; a page boundary splitting a day (no client-side aggregation across pages; totals come from the server).
- **Acceptance criteria:**
  1. Given any fixture row, then `net_pnl_lamports = gross_pnl_lamports − total_costs_lamports` exactly (contract test; a mismatch fails CI and the UI flags the row "inconsistent data").
  2. Given filter `outcome=loss`, then the totals strip shows the server totals for that filter, not the sum of the visible page.
  3. Given "Download CSV", then the request carries the current filters and the file uses integer lamport columns.
- **Tests:** unit (filter ↔ URL mapping); e2e (pagination, push insert); visual; accessibility.
- **DoD:** journal rows are read-only (no edit affordances).

### UI-T19 — Candidate and signal feed (S-04)

- **Goal:** S-04 with the streaming table, pause, filters and the full RiskCheckList detail.
- **Depends on:** UI-T06, UI-T08; VM-07; C27.
- **Behaviour:** ring buffer of 500 in memory; batched inserts per animation frame; pause freezes the list (FreshnessIndicator `paused`, "n new" pill); detail pane renders `rejection_reasons[]` and every `risk_checks[]` row with the comparator glyph, observed and threshold formatted by `unit`; `error` checks render as blocking; "Show all candidates failing this check" sets `?check=<id>&decision=rejected` and loads history from REST.
- **States:** C23 + C27 states; feed `live`, `paused`, `catching-up`.
- **Edge cases:** 1,000 events in 10s (no jank; counts correct); a candidate updated from `pending` to `accepted` (upsert in place, no duplicate row); a check with `unit = bool` (shows `true`/`false` with ✓/✗ against the expected value).
- **Acceptance criteria:**
  1. Given a rejected candidate, then the "First failing check" column shows the first `fail` or `error` check in server order, with observed vs threshold and units.
  2. Given pause, then no row moves for 60s while events keep arriving, and the pill count equals the number of events received.
  3. Given a check with `status = skipped`, then the detail shows its `skipped_reason`.
- **Tests:** unit (first-failing selector, comparator rendering); e2e (burst, pause/resume); visual; accessibility (the feed is not a live region; the paused summary is announced on resume).
- **DoD:** the feed sustains 50 events/s for 60s in the performance test without dropped frames above the PROPOSED budget (p95 frame time ≤ 20ms).

### UI-T20 — Token inspector (S-05)

- **Goal:** S-05 as a drawer and as a full page.
- **Depends on:** UI-T10 (drawer host), UI-T15 (candle chart), UI-T06; VM-08, VM-10 (`price_ohlc`).
- **Behaviour:** opens from any mint chip or row `Enter`; subscribes to `token:<mint>` while open and unsubscribes on close; tabs Overview, Price, Our history, Checks; identicon from the mint; the symbol-collision warning when `symbol_collision_count > 0`; no remote images.
- **States:** drawer `open`, `loading`, `error`, `not-found`, `pinned`; each tab's universal states.
- **Edge cases:** `token_program = unknown`; authorities null (shown as "none", not `—`, because null means "no authority" for these two fields; documented in VM-08); a holders list absent (section hidden with "Not provided by backend").
- **Acceptance criteria:**
  1. Given two tokens with symbol "PEPE", then each inspector shows "Symbol shared by 1 other mint" and the full mint is always visible in the header.
  2. Given the drawer closes, then the stream unsubscribes `token:<mint>` (verified on the mock server).
  3. Given an open position in this token, then the price chart shows entry, stop and target lines with labels.
- **Tests:** unit (sanitisation, identicon determinism); visual; accessibility (drawer focus trap and return).
- **DoD:** network inspector shows zero requests to non-same-origin hosts while the inspector is open.

### UI-T21 — Strategy performance (S-06)

- **Goal:** S-06 with after-cost metrics, confidence intervals and the edge-status banner.
- **Depends on:** UI-T15, UI-T06, UI-T05; VM-09, VM-10, VM-18 (P-2b / LS-3b values for the after-fixed-cost line, UC-19); C41 IntervalBar. Backend: A-M13-04 (PerfStats, series), B-M28-03 (projection).
- **Behaviour:** strategy / mode / window selectors in the URL; metric tiles per the S-06 table; IntervalBar per strategy with a zero line; equity, drawdown, PnL-per-trade (± bars from the zero baseline) and stacked daily cost charts; a strategy × mode table; the banner from `edge_status` (amber "unproven", danger "negative"; none for "positive"); "All modes" shows separate series per mode and never sums paper with live.
- **States:** universal states per panel; IntervalBar states (C41); insufficient sample (`sample_sufficient = false`): the interval is drawn at 40% opacity (never dashed; the DS forbids dashed chart rules) with the text "n = 64 of 100 required" (numbers from `trade_count` and `min_trades_required`).
- **Edge cases:** `expectancy_ci = null` (show "CI not available" and treat as unproven); `profit_factor = null` ("n/a (no losses)"); a single trade.
- **Acceptance criteria:**
  1. Given `edge_status = unproven`, then the banner reads "No proven after-cost edge — 95% CI includes zero (n = 64)", taking the level from `level_bps` and n from `trade_count`.
  2. Given a positive point estimate with a CI crossing zero, then no element labels the strategy "profitable".
  3. Given gross and net PnL, then net is primary and gross is secondary text labelled "gross".
- **Tests:** unit (banner text builder); visual (unproven, positive, negative, insufficient); accessibility (IntervalBar has a text equivalent "Expectancy +0.0033 SOL, 95% CI −0.0011 to +0.0078").
- **DoD:** reviewed against brief rule 3 (no implied guaranteed profit): a copy review of every string on the page is recorded in the PR.

### UI-T22 — Risk limits and breakers (S-07)

- **Goal:** S-07: the kill-switch panel (from UI-T14), the breakers list, the limits table, and the lower/raise flows.
- **Depends on:** UI-T13, UI-T14, UI-T06, UI-T04 (AmountInput); VM-12, VM-19. Backend: B-M21-01 (limits, states), B-M25-02 (display units, ceilings), B-M26-02/03 (A3 scheduling).
- **Behaviour:** LimitMeter per limit; inline edit with AmountInput in the limit's `display_unit` (UC-05), prefilled from `limit_value_display`; direction detection by comparing old vs new (the server's preview is authoritative); lowering → A1 immediate; raising or disabling → A3 with phrase `RAISE <short_code> <new_value>`, magnitude guard above 2×, `hard_ceiling` client check (the server enforces it too), 60s scheduled delay with a Countdown row and Cancel; breaker reset → A2.
- **States:** C28 meter states; row `editing`, `pending_change`, `breached`; breaker `armed`, `tripped`, `auto-reset scheduled`.
- **Edge cases:** an edit started while the limit is breached (the dialog notes "Raising a breached limit resumes entries immediately after the delay"); a concurrent change from another session (409 handling from UI-T13); a value with too many decimals for lamports (rejected by AmountInput).
- **Acceptance criteria:**
  1. (Restated per UC-05.) Given `MAXPOS` with `display_unit = sol`, `limit_value_display = "0.066666667"` (66,666,667 lamports, the ARCH 8.1 live-small value) and `hard_ceiling = "350000000"`, when the operator enters 0.30, then the A3 dialog shows "4.5× the current value", the phrase `RAISE MAXPOS 0.30`, and the preview's `consequences[]` line "0.30 SOL = 300000000 lamports"; when the operator enters 3.0, the value is rejected as above the 0.35 SOL ceiling and no phrase is offered.
  2. Given lowering from 0.25 to 0.20, then a single confirmation applies it, and VM-12 shows the new value within 2s with no countdown.
  3. Given a scheduled raise, when Cancel is clicked, then a `cancel_scheduled` command is sent and the countdown row disappears after the server confirms.
- **Tests:** unit (direction, magnitude guard, phrase builder); e2e (raise, cancel, lower, 409); visual; accessibility.
- **DoD:** every raise path requires step-up (verified by an e2e test with an expired elevation).

### UI-T23 — Mode control and go-live readiness (S-13)

- **Goal:** S-13 with gates, promotion (A3) and demotion (A1) flows, the strategy-stage header and the read-only imported-runs list (VM-21). The backtest/replay launcher is removed (UC-12, ARCH D29).
- **Depends on:** UI-T11, UI-T13, UI-T06; VM-03, VM-18, VM-19, VM-21. Backend: B-M26-03, B-M26-04 (promotion and demotion), A-M13-06 (gate values via B-M28-03), A-M13-08 (imported runs).
- **Behaviour:** gate table from VM-18 with evidence links; the promote button is disabled unless `all_pass` and there is no cooldown or dwell remaining (the server also rejects). Promotion dialog: live-styled; caps after promotion; the server checklist; phrase `required_phrase`; reason; fresh step-up; scheduled 60s; Countdown in the ModeBar with Cancel. Demotion: A1 with the open-positions policy choice (`keep_managing` default, `flatten` → escalates to A2). Imported runs: a read-only table from VM-21 with links to the journal filtered by `run_id`; no form posts a run request (UC-12). Gate units include `ratio` (UC-09).
- **States:** gates `pass`, `fail`, `pending-data`; page `eligible`, `blocked`, `cooldown`, `scheduled`, `switching`.
- **Edge cases:** gates flip from pass to fail during the countdown (the server cancels; the UI shows the server's cancellation reason); a promotion while halted (the dialog warns "Trading is halted; promotion will not resume trading"); the operator closes the browser during the countdown (the server proceeds; on return the audit log shows it).
- **Acceptance criteria:**
  1. Given any gate failing, then the promote control is disabled and lists the failing gates, and a forced POST (test harness) is rejected by the mock server and rendered as `rejected`.
  2. Given all gates passing, when the operator completes the A3 flow, then the ModeBar shows "LIVE-SMALL in 0:60 · Cancel", and at expiry the bar changes only after VM-03 reports `live_small`.
  3. Given demotion from live to paper with `keep_managing`, then the confirmation states that existing live positions will continue to be managed with real funds until closed.
- **Tests:** unit (eligibility logic mirrors the server flags only); e2e (promote, cancel, demote); visual (blocked, eligible, scheduled); accessibility (the assertive announcement on entering live).
- **DoD:** the UI contains no hard-coded gate thresholds (grep check in CI for numeric literals in this module's copy).

### UI-T24 — System health (S-08)

- **Goal:** S-08 tables and charts.
- **Depends on:** UI-T06, UI-T15; VM-13 (including `safety[]` and `rpc[].projected_month_end_bps`, UC-17), VM-10 (`rpc_latency`, `landing_rate`, `stream_lag`). Backend: A-M14-05, B-M27-02, B-M26-01 (safety net).
- **Behaviour:** status summary; RPC table (labels only); streams; transactions with the landing definition tooltip; errors (sanitised messages); the "Safety net" panel from `safety[]` and projected month-end use per metered provider (UC-17); charts. Status colours come from the server `status` fields only.
- **States:** universal + per-row `ok`, `degraded`, `down`.
- **Edge cases:** an RPC with `latency_ms_p99 = null` (no samples) → `—`; error messages containing what looks like a URL with a query string → rendered as text, never as a link.
- **Acceptance criteria:**
  1. Given VM-13, then no element renders an RPC URL (test fixture includes a URL-like label to confirm it is treated as text, not linked).
  2. Given `tx.landing_rate_bps = 9620`, then it shows `96.20%`, with the definition text on hover/focus.
- **Tests:** unit; visual (ok, degraded, down); accessibility.
- **DoD:** the status bar items (UI-T10) and this page agree on every value (same store).

### UI-T25 — Cost tracker (S-09)

- **Goal:** S-09 including the fixed-cost burden against the bankroll.
- **Depends on:** UI-T06, UI-T15; VM-14, VM-10 (`cost_daily` with `v_by_category`).
- **Behaviour:** period selector; tiles; stacked daily bars with the categorical slots (network, priority, tips, venue, failed) and slippage as a separate line chart (it can be negative); fixed items list with a link to Config; the fixed-cost burden tile turns amber at ≥ 200 bps of equity per month (PROPOSED, configurable); rent deposits shown separately and excluded from totals.
- **States:** universal.
- **Edge cases:** equity zero or null (burden `—`, not infinity); negative slippage total.
- **Acceptance criteria:**
  1. Given `fixed_cost_bps_of_equity_per_month = 410`, then the tile reads "Fixed costs = 4.10% of equity per month" in amber.
  2. Given rent deposits, then they never appear in "Total costs".
- **Tests:** unit; visual; accessibility (stacked bars have a legend and table view).
- **DoD:** cost category colours are stable across periods (hash assignment).

### UI-T26 — Configuration editor (S-10)

- **Goal:** S-10: schema-driven form, validation, diff review and apply.
- **Depends on:** UI-T04, UI-T07, UI-T13; VM-15, VM-19.
- **Behaviour:** fields generated from `sections[].fields[]`; client validation (type, min, max, step) on blur and submit, never blocking typing; server validation before review; DiffView with risk direction; apply through UI-T13 with `derived_action_class`; conflict (version changed) → 3-way view; secrets show "set / not set" only; `requires_restart` warning with the UC-15 copy, and the `book_not_flat` blocking reason rendered from the preview (UC-14). Backend: B-M25-01..03, B-M26-02.
- **States:** C37 and C38 states; page `pristine`, `dirty`, `validating`, `invalid`, `reviewing`, `applying`, `applied`, `conflict`.
- **Edge cases:** navigating away with unsaved changes (confirm discard); an enum value removed by a new schema version (field shows `invalid: value no longer allowed`); a list field with 1,000 items (virtualised editor).
- **Acceptance criteria:**
  1. Given a diff containing one raise and two lowerings, then the apply dialog is A3 (server-derived) and lists all three lines with directions.
  2. Given `config_version` changed after load, when applying, then the conflict view appears and nothing is sent until re-reviewed.
  3. Given a secret field, then its value is never present in the DOM, the network response or any client-side store (e2e DOM and network check).
- **Tests:** unit (schema-to-form mapping, validators); e2e (validate, apply, conflict); visual; accessibility (labels, error association `aria-describedby`, error summary on submit).
- **DoD:** every field type in VM-15 has a story.

### UI-T27 — Alerts centre and notifications (S-11)

- **Goal:** S-11, toasts and the title badge.
- **Depends on:** UI-T04, UI-T08, UI-T13 (ack/snooze are A0 commands); VM-16, VM-19, VM-13 `safety[]` (out-of-band line, UC-20). Backend: B-M27-02.
- **Behaviour:** tabs Open / Acknowledged / Resolved; grouped by severity; detail with an entity link; Acknowledge and Snooze (critical not snoozable); toasts for warning and critical (deduplicated by `dedupe_key`, at most 3 visible); document title `(n)` for open critical; optional sound (off by default) and optional browser notifications (opt-in, permission requested only from a user gesture in S-15).
- **States:** alert `open`, `acknowledged`, `snoozed`, `resolved`; toast states (C19).
- **Edge cases:** an alert storm (100 alerts in 10s → one summary toast "100 new alerts"; no screen-reader flood); acknowledging an alert that has just resolved (idempotent).
- **Acceptance criteria:**
  1. Given a critical alert, then a `role="alert"` toast appears once, and the title shows `(1)`.
  2. Given 100 warnings in 10s, then at most 3 toasts are visible and one summary announcement is made.
- **Tests:** unit (dedupe, rate limiter); e2e; visual; accessibility (announcement rate limit verified).
- **DoD:** money-affecting command results always appear in Alerts or Audit, not only as toasts.

### UI-T28 — Audit log (S-12)

- **Goal:** S-12 read-only log with filters and chain verification.
- **Depends on:** UI-T06; VM-17.
- **Behaviour:** filters in the URL; append via push; expand to the before/after JSON (big integers stay strings; keys sorted); a "Verify chain" button calls the server and shows the result; deep links from command results (`?event=<id>`).
- **States:** universal + verify `idle`, `verifying`, `valid`, `broken (at event X)`.
- **Edge cases:** very large before/after objects (collapsed beyond 200 lines); actor `risk_engine` or `system` (distinct icons).
- **Acceptance criteria:**
  1. Given a command result link, then the log opens scrolled to and focusing that event.
  2. Given the server reports a broken chain, then a danger banner names the first bad event, and the log stays readable.
- **Tests:** unit; visual; accessibility.
- **DoD:** no edit or delete controls exist.

### UI-T29 — Mobile monitor (S-14)

- **Goal:** S-14 read-only monitor with HALT, alert acknowledgement and single-position close.
- **Depends on:** UI-T08, UI-T09, UI-T11, UI-T14, UI-T05; VM-20, VM-16, VM-05 (compact), VM-03.
- **Behaviour:** layout per the wireframe; sticky mode bar (40px) and a sticky bottom HALT (56px, hold 1000ms, or double-tap for the dialog with a screen reader); a 24-point equity sparkline; alerts with Ack buttons; positions with Close (A1). No A2/A3 controls rendered; the server also rejects them for mobile sessions.
- **States:** universal states, compact; HALT states.
- **Edge cases:** the phone locks and resumes (full resync); landscape orientation; 320px width; poor network (stale indicators prominent).
- **Acceptance criteria:**
  1. Given 390×844, then the mode bar, equity, today's PnL and HALT are visible without scrolling.
  2. Given 320px width, then there is no horizontal scrolling (WCAG 1.4.10).
  3. Given a mobile session, then no Resume, Promote, Raise or Config control exists in the DOM.
- **Tests:** visual (390×844, 320×640, both themes, paper and live); e2e (halt hold on touch emulation); accessibility (44px targets; axe).
- **DoD:** a real-device check on one iOS and one Android browser is recorded (**UNVERIFIED** availability of devices; otherwise document the gap).

### UI-T30 — Operator preferences (S-15)

- **Goal:** S-15 settings applied app-wide.
- **Depends on:** UI-T02, UI-T09, UI-T12; VM-02 `preferences`.
- **Behaviour:** theme, density, polarity, time-zone display, reduced motion, sound, character shortcuts (on / off / remap), default landing page; saved server-side (PROPOSED endpoint), cached in `localStorage` (wrapped in try/catch; failure falls back to defaults).
- **States:** `loading`, `saved`, `saving`, `error`.
- **Edge cases:** remapping a shortcut to a conflicting key (rejected with a message); storage unavailable (private mode).
- **Acceptance criteria:**
  1. Given polarity "blue-orange", then every PnL surface (tiles, tables, charts) switches without reload.
  2. Given character shortcuts off, then no single-character shortcut fires.
- **Tests:** unit; visual (settings page); accessibility.
- **DoD:** preferences round-trip through the server fixture.

### UI-T31 — Accessibility audit and hardening

- **Goal:** verify WCAG 2.2 AA across the whole app and fix the gaps.
- **Depends on:** UI-T10 to UI-T30.
- **Behaviour:** automated axe sweep of every route and state fixture; a manual audit with keyboard only, NVDA + Firefox, VoiceOver + Safari (macOS and iOS), 200% text zoom, 400% zoom (reflow at 320px), forced colours, reduced motion, greyscale and simulated CVD screenshots; review of announcement rates on busy streams; the U+2212 minus and zero-compressed prices read correctly (fix with `aria-label` where not).
- **States:** n/a.
- **Edge cases:** dialogs over the mode frame; focus inside virtualised tables after data refresh.
- **Acceptance criteria:**
  1. Given every route fixture, then axe reports zero violations for A and AA tags.
  2. Given the manual audit checklist (one row per WCAG 2.2 A/AA success criterion), then every row is pass or not-applicable, with notes.
- **Tests:** the audit itself; regression tests added for every fixed issue.
- **DoD:** an accessibility conformance note (what was tested, with which assistive technology and browser versions, and known limitations) is added to the repository.

### UI-T32 — Security and privacy hardening review

- **Goal:** verify the front-end controls in "Dashboard authentication and network exposure".
- **Depends on:** UI-T01, UI-T08, UI-T09, UI-T13, UI-T15; backend deployment of headers and cookies.
- **Behaviour:** check the response headers (CSP exactly as specified, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (PROPOSED), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on API responses); cookie attributes; the CSRF token and `Sec-Fetch-Site` enforcement (attempt a cross-origin POST from a test page → rejected); `Host` allowlist (a request with a foreign Host → rejected); no secrets in the bundle (scan `dist/` for key-like strings and RPC URLs); no third-party requests (e2e network log); dependency audit; viewer role cannot call commands; the dashboard port is not bound on public interfaces (a deployment check script run on the host).
- **States:** n/a.
- **Edge cases:** an SSH-tunnel deployment on `http://localhost` (verify secure context and cookie behaviour in Chrome, Firefox and Safari; record the results, since `Secure` cookies on plain localhost are **UNVERIFIED**).
- **Acceptance criteria:**
  1. Given a cross-site form POST to `/api/v1/commands`, then the server returns 403 and no command is created.
  2. Given the built bundle, then a secret scan finds no keys, seeds or RPC URLs.
  3. Given an e2e session through every route, then the network log contains only same-origin requests.
- **Tests:** automated security e2e suite; a deployment checklist script.
- **DoD:** the findings report is filed and every high finding is fixed before any live-mode use.

### Ticket dependency summary

Backend ticket IDs were added at integration (`INTEGRATION.md`); a UI ticket can be built against fixtures from `@bot/contract` before its backend tickets merge, but its contract and e2e tests against the real server wait for them.

| Ticket | Depends on (UI tickets) | Depends on (VMs) | Backend tickets (integration) |
|---|---|---|---|
| UI-T01 | — | — | B-M30-01 (monorepo CI) |
| UI-T02 | T01 | — | — |
| UI-T03 | T01, T02 | conventions | — |
| UI-T04 | T02, T03 | — | — |
| UI-T05 | T04 | — | — |
| UI-T06 | T03, T04, T05 | — | — |
| UI-T07 | T04, T05 | VM-03 | — |
| UI-T08 | T01 | VM-01…VM-21 | B-M28-01, B-M28-04, B-M28-05 |
| UI-T09 | T04, T07, T08 | VM-02 | B-M28-02 |
| UI-T10 | T04, T05, T08, T09 | VM-01, VM-03, VM-05, VM-13, VM-16 | B-M28-04 |
| UI-T11 | T02, T10 | VM-01, VM-03 | B-M26-01 |
| UI-T12 | T07, T10, (T13 for actions) | all routes | B-M28-05 (`/search`) |
| UI-T13 | T07, T08, T09 | VM-03, VM-17, VM-19 | B-M26-02, B-M26-03, B-M28-05 |
| UI-T14 | T07, T11, T13 | VM-03, VM-05, VM-12, VM-19 | B-M26-01, B-M26-02; live acceptance only: B-M17-08, B-M29-04 |
| UI-T15 | T02, T03, T05 | VM-10 | A-M08-03, A-M13-04, B-M28-03 |
| UI-T16 | T05, T06, T10, T14, T15 | VM-04, VM-05, VM-07, VM-10, VM-11, VM-12, VM-13, VM-14, VM-16 | B-M28-03 |
| UI-T17 | T06, T13, T14, (T20) | VM-03, VM-05 | B-M20-02, B-M20-05, B-M26-02; live acceptance only: B-M22-04 |
| UI-T18 | T06, T10 | VM-06 | B-M23-02, B-M23-04, B-M28-05 |
| UI-T19 | T06, T08 | VM-07 | B-M21-02, A-M06-01, B-M28-03 |
| UI-T20 | T06, T10, T15 | VM-08, VM-10 | A-M06-02, A-M06-03, A-M08-03, B-M28-03 |
| UI-T21 | T05, T06, T15 | VM-09, VM-10 | A-M13-04, B-M28-03 |
| UI-T22 | T04, T06, T13, T14 | VM-12, VM-19 | B-M21-01, B-M25-02, B-M26-03 |
| UI-T23 | T06, T11, T13 | VM-03, VM-18, VM-19, VM-21 | B-M26-03, B-M26-04, A-M13-06, A-M13-08, B-M28-03 |
| UI-T24 | T06, T15 | VM-10, VM-13 | A-M14-05, B-M27-02, B-M26-01 |
| UI-T25 | T06, T15 | VM-10, VM-14 | B-M23-03, B-M23-04 |
| UI-T26 | T04, T07, T13 | VM-15, VM-19 | B-M25-01, B-M25-02, B-M25-03, B-M26-02 |
| UI-T27 | T04, T08, T13 | VM-16, VM-19 | B-M27-02 |
| UI-T28 | T06 | VM-17 | B-M24-03, B-M28-05 |
| UI-T29 | T05, T08, T09, T11, T14 | VM-03, VM-05, VM-16, VM-20 | B-M28-03, B-M28-04 |
| UI-T30 | T02, T09, T12 | VM-02 | B-M28-02 |
| UI-T31 | T10–T30 | — | — |
| UI-T32 | T01, T08, T09, T13, T15 | — | B-M28-02, B-M30-02 |

Suggested order: T01 → T02 → T03 → T04 → T05 → T08 → T06 → T07 → T09 → T10 → T11 → T13 → T14 → T12 → T15 → T16–T28 (parallelisable) → T29 → T30 → T31 → T32. The safety-critical path (T08, T11, T13, T14, T22, T23, T32) must be complete and tested before any live-mode use.

## Unverified and open questions

### Unverified (do not rely on these without checking)

| ID | Item | Why unverified | How to resolve |
|---|---|---|---|
| U-01 | Any Height design trait (typography, colour, motion, keyboard model) | height.app is down (TLS reset / HTTP 503). Archive snapshots exist (2025-03-08, 2025-10-08) but `web.archive.org` and `archive.ph` connections were reset from this environment, and WebFetch refuses the archive | Fetch `https://web.archive.org/web/20250308141946/https://height.app/` and its CSS from an unrestricted network |
| U-02 | Height shutdown date (24 Sep 2025) and March 2025 announcement | Only secondary sources: a competitor's blog (Shortcut) and a search summary of AlternativeTo (page itself returned 403) | Find a first-party Height announcement in an archive |
| U-03 | Licence terms of Berkeley Mono, Domaine, Arcadia | Vendor page 403 or not checked | Not needed: these fonts are not used |
| U-04 | That each named Lucide icon exists in `lucide-react` 1.52.0 | Checked in Z05 against `lucide-react` 1.47.0, the version installed and audited (1.52.0 was under 14 days old): all eleven reserved state icons exist under their DS names (`packages/dashboard/test/primitives-logic.test.ts`) | UI-T04 icon audit |
| U-05 | Whether the Lightweight Charts `attributionLogo` loads any external resource (CSP impact) | Not tested | UI-T15 acceptance criterion 3 |
| U-06 | Whether `Secure` / `__Host-` cookies work on plain `http://localhost` in every browser | MDN confirms `localhost` is a secure context (UI-F43), but cookie behaviour was not checked | UI-T32 edge case; prefer HTTPS |
| U-07 | Playwright 1.63 virtual-authenticator support for WebAuthn tests | Not checked | UI-T09; fall back to mocking `navigator.credentials` |
| U-08 | How NVDA, JAWS and VoiceOver read U+2212 and the subscript-zero price notation | Not tested | UI-T31; `aria-label` fallbacks are specified |
| U-09 | Browser Notification API delivery when the tab is in the background | Not tested | UI-T27; notifications are opt-in only |
| U-10 | Cloudflare Zero Trust free-plan limits | The plans page did not state them; no fact in the verified register either (checked at integration) | Read Cloudflare's pricing docs if Option D is considered (Option D is not the default; ARCH D19 uses the tailnet) |
| U-11 | Licences of Next.js, Vitest, Playwright, axe-core, Storybook, ESLint, typescript-eslint | Licence field not read in this session | Read each package's `license` field before adoption |
| U-12 | Maintenance pace of uPlot (last npm publish 2025-03-14) and cmdk (2025-08-27) | Publish dates verified; whether that indicates risk is a judgement | Re-check before UI-T12 / UI-T15; both are small enough to vendor if abandoned |
| U-13 | Tailscale Personal plan terms | Vendor pricing page (UI-F41); can change | Re-read before deployment |
| U-14 | ~~An out-of-band (host CLI) kill command exists~~ **Resolved** | ARCH 12.6 / 14.5: `botctl halt --reason "<text>"` on the host (B-M29-04); resuming after a sentinel or CLI halt needs `botctl resume-latch` then dashboard RESUME (D28, UC-08) | UI-T14 shows `ssh <host> botctl halt --reason "<text>"` |
| U-15 | ~~"Open positions stay protected by server-side stops during a restart"~~ **Resolved: false** | ARCH 14.5 and UC-16 | Copy replaced (S-10, Safety UX "Apply configuration"): restart-requiring changes are refused while positions or orders are open (UC-15). Wherever restart protection is described, use: "Stops resume when the engine restarts. While the engine is down, the sentinel can close positions after 2 minutes; if the whole server is down or the signer is locked, open positions are unmanaged until you act." (UC-16) |
| U-16 | Solana fee figures (5,000 lamports per signature; priority-fee formula) remain current | Read from Solana docs today (UI-F30); protocol parameters can change | The UI never hard-codes them; the cost ledger reports actual fees |
| U-17 | All performance budgets, freshness thresholds, rate limits, timeouts and warning thresholds marked PROPOSED | Design proposals, not measurements | Tune with real data in paper mode |
| U-18 | Reference-site counts (durations, radii, fonts) represent each brand's *product* UI | Only marketing sites were inspected; logged-in apps were not | Treat them as brand design language only |

### Open questions (owners: backend architect, risk owner, project owner)

| ID | Question | Default assumed in this spec | Resolution (ARCH 14.5, applied at integration) |
|---|---|---|---|
| Q-01 | Final HALT semantics (D-UI-07): do exits stay armed when halted? | Yes (Option A) | Option A (ARCH D24) |
| Q-02 | Can the backend produce an **exit-quote mark** for every open position at ≤ 1 Hz without exceeding RPC/quote budgets (D-UI-08)? | Yes; else `mark_method = mid` with the warning tooltip | Yes, computed locally from polled reserves (ARCH 14.5) |
| Q-03 | Readiness gates and thresholds for paper → live-small → live (VM-18) | Backend/risk-owned; the UI shows whatever is sent | ARCH 3.4 gates; VM-18 carries them |
| Q-04 | CI method for expectancy and win rate (bootstrap vs t-distribution; level) | `bootstrap`, 95% (`level_bps = 9500`) | Bootstrap 95% (expectancy), Wilson 95% (win rate) (ARCH 14.5) |
| Q-05 | Fixed-cost burden warning threshold | 200 bps of equity per month | 200 bps/month warning; 3% hard ceiling (ARCH 1.4, 8.2) |
| Q-06 | Exit price-impact warning threshold in the positions table | 300 bps | 300 bps (ladder rung 2) |
| Q-07 | SOL/USD price source and whether USD is shown at all (a paid feed would add fixed cost) | Show USD only if a free or already-paid source exists; otherwise SOL only | Jupiter Price V3 keyless, fallback CoinGecko Demo (ARCH D20) |
| Q-08 | How alerts reach the operator's phone without sending personal data to third parties (self-hosted push, or none) | In-app only; mobile monitor polled manually | ARCH D27 operator-side watcher by default |
| Q-09 | Locale: English only, `.` decimal separator? | Yes | Not answered by ARCH; default stands |
| Q-10 | One operator or several? Is the viewer role needed? | One operator + optional viewer | One operator + optional viewer |
| Q-11 | A3 delay length | 60 seconds | 60 s (ARCH 5.0a `PreviewResponse.delayS`; D-UI-13) |
| Q-12 | Licence review for the remaining dev dependencies (U-11) | Must be done before UI-T01 merges | Not answered by ARCH; still required before UI-T01 merges (U-11) |
| Q-13 | Should the console ever allow manual discretionary entries? | No (out of scope by design) | No |
| Q-14 | API for launching backtest/replay runs and reporting their progress | Backend-owned; UI-T23 consumes it | Runs are off-host and imported (D29); read-only VM-21; launcher removed (UC-12) |
| Q-15 | Hash-chained audit log (`prev_hash`/`hash`) feasibility | Proposed; UI-T28 degrades gracefully if absent | Yes (M24, B-M24-03) |
| Q-16 | Does the dashboard run on the same host as the bot? (resource contention vs a second paid machine) | Same host, static files only, to avoid extra fixed cost | Yes, static files served by M28 |
| Q-17 | Which token properties (authorities, extensions, holder concentration) the risk engine uses | Risk-owned; the UI displays the fields provided | ARCH 8.4 |

