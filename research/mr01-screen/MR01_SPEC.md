# MR-01 as specified by the Blueprint (verbatim extract, read 2026-10-07)

Source: Solana Meme Bot Blueprint, Architecture §3.3, artifact claude.ai/artifact/SWxLJXAncuoyZvq2vXcbMK (version 1791304452-8a1f). Copied as data for a research screen. The Blueprint is the design authority.

> **MR-01 (first test).** The ticket is written only after the A-24 count and the A-24b move-size study (Phase 0) show that the universe is non-trivial and that typical 5–60 minute moves exceed the cost hurdle.
>
> **Universe:** pools on allowlisted venues with per-side fee ≤ 30 bps; effective quote depth ≥ 300 SOL; pool age ≥ 24 h; all token-safety checks pass (section 8.4); pool normalised so that quote = wSOL (M01). Venues by stage (D18): PumpSwap canonical pools in tiers ≤ 30 bps (market cap ≥ 98,240 SOL [EX-07]) in every stage. Raydium AMM v4 [EX-22] and Raydium CPMM with total trade + creator fee ≤ 30 bps [EX-22] in research, replay and paper only after the Raydium venue spec (M01/M02, A-13) is accepted, and in live only after direct Raydium sell adapters pass gate P-6. Universe membership on each day is written to a manifest (M05, section 3.4) from information recorded at that time.
>
> **Data:** 1 Hz pool snapshots at confirmed commitment, aggregated into 15 s bars (M04, M08).
>
> **Signal:** robust z-score of the log return over lookback L, with scale = MAD / 0.67449 of the 15 s returns over the previous 6 h (the same robust scale as the dump detector in [ST-V08]). Entry when z ≤ −z_entry, depth has not fallen by more than 10% over L, no authority or fee-config change is pending, the market-regime filter is clear (section 8.1 REGIME) and the MR entry-rate limit allows it (section 8.1 ENTRYRATE).
>
> **Exit:** two targets, whichever fires first: reversion to the 6 h rolling median price, or +6% (POLICY); stop at −a; time stop T; plus every universal exit in section 8.6.
>
> **Pre-registered configurations:** at most 2 configurations for the first evaluation window. (L, z_entry, a, T) ∈ {(5 min, 3.0, 4%, 30 min), (15 min, 3.0, 5%, 60 min)}. Every other value that can change returns (universe filters, exits, cost-model and fill-model versions) is part of the trial identity (section 3.4), so changing it counts as a new trial.

Earlier proxy: `../deep-pool-probe` (MR-A/MR-B) used 5-minute bars, a 3-day standard deviation, fixed targets (+6% and +8%) and a main group with 0.33–0.55% pools. That proxy was not supported. In the 0.30% tier its validation CIs crossed zero (`../deep-pool-probe/RESULTS.md`).
