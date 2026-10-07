<!-- Draft from the advisor-four-hypotheses workflow (2026-10-08). Scouted, designed and adversarially reviewed; every blocking or major issue was fixed in this text. run_now=False. The builder commits the final PREREG.md before any data pull. -->

# Theme-leader collector (H2): forward design, fixed before the first event

File: `research/theme-collector/PREREG.md`. This tests the outside reviewer's H2 (2026-10-08), forward only. Nothing here trades; outcomes are paper scores computed later, in a separate stage. An adversarial review on 2026-10-08 checked this text before commit; its fixes are folded in.

## Why forward only
A historical test cannot be done without look-ahead:
- Any theme, keyword or account list written today encodes which themes boomed in 2024–26.
- The free Musk archive (Zenodo 14836471) has damaged tweet ids (46,058 of 60,567 are in scientific notation) and ends 2025-01-24.
- Full X history is paid.
- Buyer share needs swap-level data.

The cited paper (Li, Shin, Sun & Wang, preliminary draft of 12 Jul 2023, SSRN 4228920; full PDF read) shows only three things:
- same-day co-movement inside keyword styles, with R² under 1%;
- more new tokens issued after a style's prices rise;
- day-1 relative jumps in doge-named tokens after 27 Musk tweets.

That evidence is BSC data from 2020–21, daily, with no costs. The paper has no leader-versus-clone test.

## Hypothesis
When a theme suddenly gets public attention outside crypto, a predetermined, established Solana token of that theme gains share of the theme's buying in the first 15 minutes. Buying it at that point and holding 6 hours makes money in SOL after costs, and beats the same token at ordinary times.

## Frozen before the first event
Each item below is committed with its SHA-256 before it takes effect.

**Themes and keyword rules**
- Themes are CoinGecko's meme theme categories, from the list fetched on the freeze date.
- Each theme gets a whole-word keyword list of ordinary words and names (for example: goat, goats; hippo; Moo Deng), used for catalyst text and for token names.

**Crypto-context exclusion**
An item is not a catalyst if its text contains any of:
- a cashtag ($ followed by letters);
- a Solana mint address (base58, 32–44 characters);
- a frozen crypto term as a whole word: crypto, cryptocurrency, coin, token, memecoin, bitcoin, solana, airdrop, pump.fun, pumpfun, dex.

Bare ticker words are never excluded, so a news item about goats still counts while GOAT is on the roster, and so does the bare word "pump".

**Roster per theme**
- **Leader:** the Solana token in the category with the highest 30-day SOL volume that meets all of these:
  - aged at least 90 days;
  - has a constant-product SOL pool (Raydium AMM v4, CPMM or PumpSwap);
  - that pool's reserve is at least $250,000 at freeze.
  - **Volume:** GeckoTerminal daily OHLCV of the token's SOL pools over the 30 completed days before freeze. Each day's USD volume is divided by that day's SOL/USD close. The raw responses' SHA-256 is committed.
- **Peers:** every other Solana token in the category with a SOL pool of at least $50,000.
- **New tokens:** tokens created after the freeze whose name or symbol matches the theme keywords count in the theme's buy total.
- Themes with no qualifying leader are recorded and skipped.

**Re-freeze**
- The roster is re-frozen monthly.
- A new roster applies only to events after its commit time.

**Source accounts**
- None at the start.
- X posts are added only if the owner approves the pay-per-use X API ($0.005 per post read, docs.x.com pricing, read 2026-10-07). The account list is frozen before its first read.

## Catalyst feed and timestamps
**Feed**
- Google Trends "Trending now" RSS: `https://trends.google.com/trending/rss?geo=US`. Checked 2026-10-07: HTTP 200, with pubDate and approx_traffic.
- Polled every 2 minutes.
- Only geo=US is used. Other geos would be a later, separate trial.

**Catalyst**
- The first item in a 24-hour period, per theme, that passes the exclusion and whose title or attached news titles match the theme keywords.

**Recorded for each catalyst**
- the source pubDate;
- our receipt time R, from an NTP-synced clock;
- the raw item;
- the matched rule.

**New-token names**
- Source: PumpPortal `subscribeNewToken` (free; PumpPortal is a third party, not pump.fun). The worker's stored copy is used if it exists; otherwise the collector subscribes itself.
- Recorded as (mint, name, symbol, receipt time).
- Used to count clones and to monitor confounds, never as a trigger.

## Decision rule
This is scored later from on-chain history. Nothing is sent.

**Buyer share s**
- s = the leader's SOL buy volume ÷ the theme's SOL buy volume over [R, R + 15 min].
- The theme's buy volume covers the leader, the peers and post-freeze matching tokens, across all decoded venues.
- Measured from Helius history.

**Entry and exit**
- **Baseline:** the median of s over the same clock window on each of the previous 7 days.
- **Enter if** s is above the baseline.
- **Entry:** the leader pool's state at or before R + 15 min + 7 s.
- **Exit:** at or before entry + 6 h.

**Size and costs**
- Size: 0.4193 SOL ($50 at 119.26 $/SOL).
- Fees read from the pool, plus a fixed 414,009 lamports per round trip.
- Stress line: −1 point.
- A trade counts only if its round trip at entry is at most 1.5%.

## Controls
1. **The leader at ordinary times (decisive):** the same clock time on 5 seeded days between −14 and −1, with no catalyst for that theme within ±24 h.
2. **Theme peers** at the same entry time: each executable peer as its own $50 trade, then the mean.
3. **Catalysts that failed the share filter,** scored the same way.
4. **Placebo:** trending items that match no theme, each assigned to a seeded random leader.

## Phases and verdict
**Phase A: 4 weeks, counts only**
- Counted:
  - catalysts per theme;
  - receipt delay (R − pubDate);
  - clone launches per catalyst;
  - the share filter's pass rate, on a seeded sample of at most 10 catalysts.
- No return is computed.
- **Stop rule:** if catalysts per month × pass rate is below 12.5, the number needed for 300 entries in 24 months, H2 closes as **untestable in useful time**.

**Phase B: keep collecting and score in a separate stage**
- **Kill-only look at 100 eligible entries:** H2 is killed if either of these holds:
  - mean leader net ≤ 0;
  - mean (leader − leader at ordinary times) ≤ 0.
- **Final test** at 300 entries or 24 months, whichever comes first.
  - **Promising** requires the 95% day-block lower bounds of both measures above to be greater than 0, and leader − peers above 0.
  - Fewer than 100 entries at 24 months: **unresolved**.

**Reviewer's kill conditions, reported:**
- the advantage disappears once the map is frozen in advance;
- the move is over before an executable entry. This is reported as the leader's move from R to entry, against its move after entry.

Nothing here counts toward the pre-funding gate unless it is later replayed through the engine.

## Live parity (owner decision before any live use)
- A live share filter would need real-time buys across all theme tokens, including bonding-curve clones.
- PumpPortal trade streams cost 0.01 SOL per 10,000 events: a paid service that needs the owner's approval.
- Until then, scoring is from history only.

## Caveats
- **Timing:** Google Trends RSS times may lag the real onset (unverified).
- **Single-token themes:** the peers are mostly new clones.
- **Wash buying** can fake buyer share (Mongardini & Mei, arXiv 2507.01963, as reported).
- **Reversal:** the attention literature predicts reversal after intense buying.
- **Event rate:** unknown. Phase A measures it.


## Executor notes

Not run now as a test.

**Host.** It needs an always-on host.
- Run it as a separate process with fixed memory and disk caps, or on another machine. Never run it inside the worker process: the bot staying up is the owner's first core stream.
- The supervisor assigns the host.

**Phase A build.** About 0.5–1 day. Model: claude-sonnet-5-5 at medium for the poller, Opus for the roster freeze rules. Parts:
- an RSS poller, every 2 minutes;
- a whole-word matcher with the cashtag, address and term exclusion (no bare tickers);
- a roster freeze job that writes a committed JSON plus its SHA-256;
- a new-token logger reusing PumpPortal subscribeNewToken.

**Running cost.** $0. Public data only.

**Roster freeze, monthly.**
- About 40 keyless CoinGecko category calls.
- At most about 100 GeckoTerminal calls (pool lookups plus 30-day daily OHLCV), 7 s apart, queued behind the other client.

**Helius.**
- Phase A share-filter sample: at most 30k credits.
- Phase B: about 1–3k credits per entry, measured on the first 5 entries before any further spend.

**Owner decisions.** The X API, and paid trade streams for any live version, both need the owner's approval.

**Next step.** Start Phase A when a host is assigned. It does not compete with H1's or H3's credits.
