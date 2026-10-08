# Brainstorm tests (exploration only)

Owner brainstorm, 2026-10-07. These are **exploration** results on the runner probe's exploration sample (`../lottery-probe/sample.json`: 900 graduates created 2026-07-22..08-20, 492 usable after the dust, start-missing and no-entry filters). None of them is pre-registered; the 900-coin validation sample (created 2026-08-21..09-06) was not used. Many cuts were tried, so a good-looking line here is a candidate at most, never evidence.

Sim: `$10` bets, costs as in `../lottery-probe/lottery.py`. Entry at the close of hour 1, stop −30%, trail arms at 2×. `pess` = stop at min(level, close), trail at the close. `opt` = fills at the level (trail fill only with ≥ 20 SOL hourly volume). `capped20x` caps any coin's net return at +1900%, to show how much of a mean comes from one coin.

## Exit ideas (`brainstorm1.py`)

| Idea | pess mean | opt mean | pess without best coin | capped 20× |
|---|---|---|---|---|
| Base R2 (trail 60%) | −18.9% | +56.5% | −10.9% (opt) | negative |
| Sell half at 2× | −20.1% | +24.9% | | negative |
| Sell if < 1.2× at hour 6 | −19.3% | −8.2% | | negative |
| Leash: trail 60% below 10×, 40% to 50×, 30% above | +2.4% | +31.0% | | negative |
| All three | −19.2% | −8.9% | | negative |
| Only after a SOL up day (n=273) | −17.4% | +111.0% | | negative |
| Entry hour 16–24 UTC | −10.5% | +164.8% | | negative |

Every positive mean comes from one coin (about 330× peak). The "sell half" and "sleepy" rules cut that coin early. The timing filters look good only because that coin fell in their bucket.

## Socials, creator, graduation speed (`brainstorm2.py`)

Features (creation-time fields from pump.fun `coins/search-unrestricted`): Twitter link kind (account, tweet link, community), website, Telegram, number of links, the creator's earlier graduates, graduation in under or over one hour. **I am not certain** these link fields are frozen at creation; if creators can edit them later, they carry look-ahead. `reply_count`, `ath_market_cap` and `boost_mode` were not used as features.

Result: no group has a positive capped-20× mean at pess prices. Every positive mean is again the one big coin, which had a tweet link, a website, 2+ links, a repeat creator and a fast graduation. Lines worth noting only as candidates:
- No links at all (n=73): pess −32.7% vs −16.0% for 2+ links. Rejecting coins without links may remove the worst losers.
- Twitter community link (n=9): positive, but the sample is too small to mean anything.
- Slow graduation over 1 hour (n=48): no better.

## Data facts found on the way

- pump.fun `ath_market_cap` matches the GeckoTerminal maximum hourly high (checked on all 492 coins). That high includes the opening spike right after migration and the fake high prints. So it is **not** a usable outcome for "a coin that really ran". The median graduate's ATH sits at the opening spike (about 2.3× the migration price) and closes far below it.
- Of 29,170 graduates created 2026-07-22..08-20, 9,663 (33%) have dust pools (LP supply < 1e12, read on chain). Their ATH median is 0.14× the migration price: they never traded at the graduation price.

## Next

The leash exit is the only idea to carry forward, and it still lives on one coin. It will be judged by whether jackpots recur in the validation sample (R1–R4, pre-registered in `../runner-probe/PREREG.md`), not by this table.
