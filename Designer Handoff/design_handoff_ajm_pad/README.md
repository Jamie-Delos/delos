# Handoff: AJM Pad — Token Launchpad UI

## Overview
AJM Pad is a memecoin launchpad in the style of pump.fun v1, built on **Base** with a **single-sided Uniswap V3** liquidity model. Users browse a live catalogue of coins, create their own token in seconds, trade on a bonding curve, track graduation to a full DEX pool, and collect creator swap fees. This package contains eight screens: four **desktop** and four **mobile** (iPhone) versions of Home, Create, Coin, and Profile.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. They are authored as "Design Components" (`.dc.html`) that run in a bespoke preview runtime (`support.js`), so the markup uses a custom template dialect (`<sc-for>`, `<sc-if>`, `{{ }}` holes, `<x-import>`). **Do not try to run or port that runtime.** Read the files to extract layout, structure, exact colors, typography, spacing, copy, and interaction logic, then **recreate the designs in the target codebase's existing environment** (React, Vue, SwiftUI, native, etc.) using its established patterns, component library, and router. If no frontend exists yet, React + a CSS solution (CSS Modules, Tailwind, or styled-components) is a natural fit for this UI.

## Fidelity
**High-fidelity.** These are pixel-level mockups with final colors, typography, spacing, and interactions. Recreate the UI faithfully using the codebase's own primitives. The visual language is deliberately **flat and sharp**: no gradients (one accent fill only), no drop shadows/glows, **zero border-radius on all rectangular elements** (square corners everywhere) — the ONLY rounded elements are circular avatars/dots (`border-radius:50%`). Keep it that way.

## Brand / Visual Language
- **Aesthetic:** dark, flat, sharp-cornered, minimal. No gradients on fills, no box-shadows, no hover-lift transforms. Deliberately un-glossy.
- **Wordmark:** lowercase `launchpad` placeholder next to a small teal square containing a rotated (45°) dark diamond. This is a **placeholder brand** — swap for the real AJM Pad mark when available.
- **Tone of copy:** lowercase, direct, crypto-native ("mcap", "aped 0.3 ETH", "wen graduation ser", "LFG"). No explainer paragraphs, no tooltips, no hand-holding fine print.
- **Emoji** are used only as coin icons (🐮 🐈 🍉 🤖 etc.) — part of the memecoin content, not decorative UI.

## Design Tokens

### Colors
| Token | Hex | Usage |
|---|---|---|
| Page background | `#090b0f` | App canvas |
| Surface / card | `#0d1017` | Coin cards, panels |
| Surface alt | `#0e1219` | Inputs, inset wells |
| Surface alt 2 | `#0a0d12` | Deepest wells (segmented control track) |
| Nav/topbar tint | `rgba(9,11,15,0.92)` | Sticky bars (with backdrop-blur) |
| Border default | `#171c25` | Card borders |
| Border input | `#232a37` | Input borders |
| Border subtle | `#12161e` | Topbar bottom border |
| **Accent (teal)** | `#2dd4bf` | Primary CTA fill, progress bars, active tab fill |
| Accent light | `#5eead4` | Links, active text, mcap values, focus ring |
| Accent hover | `#99f6e4` | Link hover |
| Accent border | `#2f6b5e` | Secondary teal-outline buttons |
| CTA text (on teal) | `#05130c` / `#06110e` | Text on accent fills |
| Text primary | `#e9edf3` | Headings, body |
| Text secondary | `#aab2c0` | Sub-labels |
| Text muted | `#9aa3b2` | Descriptions |
| Text dim | `#7b8494` | Meta ("by", timestamps) |
| Text dimmer | `#6b7482` / `#5b6472` / `#4b535f` | Inactive tab icons, fine print |
| Positive (green) | `#6ee7b0` text / `rgba(52,211,153,0.14)` bg / `rgba(52,211,153,0.35)` ring | Buys, +% gains |
| Negative (red) | `#f9a8b8` text / `rgba(244,114,140,0.13)` bg / `rgba(244,114,140,0.35)` ring | Sells, -% losses |
| Warning / KOTH (gold) | `#f4d47a`/`#f2c14c` text / `rgba(242,201,76,0.12)` bg / `rgba(242,201,76,0.3)` ring | Trending/created badges |
| Creator-fee panel | bg `rgba(94,234,212,0.06)`, border `rgba(94,234,212,0.25)` | Fee callout |

### Typography
- **Font stack:** system UI — `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif`.
- **Monospace** (addresses): `ui-monospace, monospace`.
- **Scale (mobile):** page title 21px/700; section h2 15px/700; card head 13–13.5px/700; body 12.5–14px; meta 11–12px; tab-bar label 10.5px/600; stat value 16–19px/700.
- **Scale (desktop):** larger — headings up to ~28px; verify against desktop files.
- Letter-spacing: wordmark `2px`; page titles slightly negative (`-0.2` to `-0.4px`).

### Spacing & Geometry
- **Border radius: 0 everywhere** except circles (`border-radius:50%` for avatars, status dots).
- Card padding: 12–18px. Screen gutters (mobile): 16px. Gaps between cards: 10–16px.
- Inputs: `box-sizing:border-box; width:100%`, padding ~12–14px, `outline:none`, focus → `border-color:#5eead4`.
- Sticky bars: top bar `padding:52px 16px 12px` (52px clears the iOS status bar); bottom tab bar `padding:10px 8px 26px` (26px clears the home indicator).

### Effects (allowed)
- `backdrop-filter: blur(10–12px)` on sticky bars only.
- Button active/hover: `filter:brightness(1.06)` on accent CTAs; border→teal on secondary buttons. **No translateY lift, no shadows.**

### Animations
- `@keyframes popin` — tape items enter: `translateY(-4px)` + opacity 0 → 0, `.4s ease`.
- `@keyframes kothbounce` — the top KOTH/trending card bobs: `translateY(0 → -3px → 0)`, `1.5s ease-in-out infinite`.

## Screens / Views

> Exact copy, per-element colors, and SVG icons are in the HTML files — reference them directly. Below is the structural + behavioral spec.

### 1. Home (`AJM Pad Home.dc.html` / `AJM Pad Home Mobile.dc.html`)
- **Purpose:** discover coins; entry point.
- **Desktop layout:** left sidebar nav (home / token / profile), main column with search, "now trending" / King-of-the-Hill carousel, and a coin grid; a live transaction tape.
- **Mobile layout:** sticky top bar (wordmark + "log in") → horizontal **live tape ticker** (auto-scrolling chips) → search input → "now trending" horizontal snap-scroll rail (4 cards, last one bounces) → "all coins" single-column list → sticky bottom tab bar.
- **Components:**
  - **Live tape chip:** flex row, 6px colored dot + text; bg/fg/ring tinted by event type (buy=green, sell=red, create=gold); `popin` animation on entry.
  - **Trending card:** 236px wide (mobile), coin emoji tile (48px, colored bg) + title + mcap + one-line description; top card has teal border + `kothbounce`.
  - **Coin list row:** 72px square coin tile (emoji + ticker), then "by {addr}" + round avatar + age, mcap (teal) + reply count, then bold head + muted description. Whole row links to Coin page.
  - **Search button (desktop):** secondary style — `#12161e` bg, `#232a37` border, teal text/border on hover. NOT a solid accent fill.
- **Behavior:** tape prepends a new random event every **2100ms**, capped at 4 items (mobile) — see `makeEvent()` in the logic class for the address/token/amount generation. Trending rail and tape use `overflow-x:auto` with hidden scrollbars.

### 2. Create (`AJM Pad Create.dc.html` / `AJM Pad Create Mobile.dc.html`)
- **Purpose:** launch a new coin.
- **Layout:** single centered column (desktop 520px). Sticky top bar with back arrow + "create a new coin". Form card, then a **live preview** card below.
- **Form fields (in order):** name (text) → ticker (text, uppercased, `$` prefix, maxlength 11) → image url (optional) → **"show more options"** disclosure toggling X/Twitter, Telegram, Website fields → divider → "buy a little of your own coin" (optional, ETH-suffixed amount) → **launch coin** primary CTA (full-width teal, no rocket emoji).
- **Live preview:** mirrors a Home coin row using typed name/ticker/image; shows uploaded image if `image` url is non-empty, else a dashed-border image placeholder; static "by you · just now · mcap $1.2K · 0 replies".
- **State:** `{ name, symbol, image, devBuy, showMore }`. Ticker forced uppercase on display. `showMore` toggles the socials block; chevron flips ▾/▴.
- **Inputs:** all `width:100%; box-sizing:border-box` so they stay flush regardless of container padding.

### 3. Coin (`AJM Pad Coin.dc.html` / `AJM Pad Coin Mobile.dc.html`)
- **Purpose:** trade a coin and track its curve. Example coin: **Bullko (🐮)**.
- **Mobile layout (top→bottom):** top bar (back + coin emoji + name/ticker) → meta row (trending badge, "created by" + avatar + addr link + age) → contract address chip (copy icon) + share/social icons → **2×2 stats grid** (market cap, price, 24h, holders) → **trade panel** → chart → graduation → holders → creator fees → thread.
- **Trade panel:** buy/sell **segmented control** (active segment = teal fill, dark text; inactive = transparent, dim text) → amount input (18px, unit suffix flips ETH↔coin name based on buy/sell) → quick-amount buttons (0.01 / 0.1 / 0.5 / 1) → **place trade** CTA → "1% fee" caption.
- **Chart:** inline SVG area chart, `viewBox="0 0 640 200"`, teal stroke (2.5px) with a teal→transparent `<linearGradient>` fill (this gradient is on the *chart data viz*, which is fine — the flat-fill rule is about UI chrome). Timeframe pills 1m/5m/1h/1d (1h active).
- **Graduation:** label + "%" + progress bar (teal fill on dark track) + "X ETH of ~Y ETH bought · graduates at ~$60k mcap".
- **Holders:** legend rows (square swatch + label + right-aligned %). Locked pool (bonding) is the largest; dev wallet flagged.
- **Creator fees:** tinted teal panel, "you've earned {N} ETH in swap fees" + "collect fees" secondary button.
- **Thread:** reply input + "post" button, then comment list (round avatar + name + optional "dev" badge + age + body). Dev badge = teal bg, dark text.
- **State:** `{ buy: bool, amount: string }`. Segmented control and quick-amount buttons set these.

### 4. Profile (`AJM Pad Profile.dc.html` / `AJM Pad Profile Mobile.dc.html`)
- **Purpose:** wallet identity + activity. Example user: **bullrunner (🐮)**.
- **Layout:** top bar → identity block (72px avatar tile + name + copyable truncated address + "joined … · on Base") → edit profile / share buttons → **2×2 stats grid** (coins created, wallet balance, fees earned, best coin) → **tabs: created / held / replies** → tab content list.
- **Tabs:**
  - **created** — coin rows (56px tile, name, mcap + age, "fees earned {N} ETH"). Links to Coin page.
  - **held** — holdings rows (44px tile, name, amount held, right-aligned value + colored PnL %).
  - **replies** — cards ("on {coin link} · {age}" + reply body).
- **State:** `{ tab: 'created' | 'held' | 'replies' }`. Active tab = white text, 700, 2px teal bottom-border; inactive = dim, 500.

## Navigation Flow
- **Bottom tab bar (mobile, all 4 screens):** home / search / **create** (center, teal-filled + icon) / profile. Active tab icon+label are teal; others dim. The bar is `position:sticky; bottom:0`.
- **Search tab:** on Create/Coin/Profile it navigates to Home (where the search field lives); on Home it focuses the search input (`#mobileSearch`) via an `onClick` handler — replicate as focus-on-tap or an in-page search route.
- **Back arrows** (Create/Coin/Profile top bars) → Home.
- **Coin cards / rows** everywhere → Coin page. Creator/user addresses → Profile.
- Desktop and mobile files link within their own set; in the real app these collapse into one responsive route per screen (Home, Create, Coin/:id, Profile/:addr) with a breakpoint switch, not separate pages.

## Interactions & Behavior Summary
- Live tape: `setInterval` 2100ms, prepend random event, cap list length, `popin` animation. Clear interval on unmount.
- KOTH/top-trending card: infinite `kothbounce`.
- Buy/sell toggle drives amount unit label and (in a real impl) quote math.
- Create form: controlled inputs, ticker uppercased, optional socials disclosure, live preview binding.
- Profile tabs: client-side tab switch, no fetch in mock.
- Focus states: inputs → teal border. Button press → `brightness(1.06)` (accent) or teal border (secondary).
- **Responsive:** desktop uses multi-column (sidebar + grid); mobile is single-column with sticky top/bottom bars inside a 402×874 iPhone frame. Collapse to one responsive implementation.

## State Management
Minimal, all client-local in the mocks:
- Home: `tape[]` (live-generated), timer id.
- Create: `{ name, symbol, image, devBuy, showMore }`.
- Coin: `{ buy, amount }`.
- Profile: `{ tab }`.

Real implementation will need: coin catalogue fetch + realtime tx stream (websocket) for the tape, coin detail + price/curve data, wallet connection (Base), buy/sell tx submission, graduation progress, holder distribution, comment thread CRUD, creator-fee balance + claim tx.

## Assets
- **No external image files** — all coin icons are **emoji**, all UI icons are **inline SVG** (search, plus, home, profile, back chevron, copy, X/Twitter, Telegram, chart). Lift the SVG paths directly from the HTML. Replace emoji coin icons with real uploaded token images in production (the Create form already has an image-url field + preview).
- **Wordmark** is CSS-drawn (teal square + rotated diamond) — placeholder; swap for the real brand mark.
- The iPhone bezel (`ios-frame.jsx`) is a **presentation frame only** — do not ship it; it's the mockup device chrome.

## Files
Design references included in this bundle (`screens/`):
- `AJM Pad Home.dc.html`, `AJM Pad Home Mobile.dc.html`
- `AJM Pad Create.dc.html`, `AJM Pad Create Mobile.dc.html`
- `AJM Pad Coin.dc.html`, `AJM Pad Coin Mobile.dc.html`
- `AJM Pad Profile.dc.html`, `AJM Pad Profile Mobile.dc.html`
- `ios-frame.jsx` — device frame used by the mobile mocks (presentation only, not for production)

`support.js` (the preview runtime) is intentionally **not** included — it is not part of the design and should not be ported.
