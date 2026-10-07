# STRATEGY-INTAKE (PR #293) review log

## Round 1: researcher's open questions (head `edfb1cda`)

### Supervisor rulings (8 Oct 2026, about 9:23 AM)

1. **A paper switch needs a PREREG.** Accepted. Validation refuses `paper` for a strategy unless a PREREG exists for its (id, version, paramsHash). This is the owner's own rule (CLAUDE.md "Strategy slots": "switchable in paper once its rules are written down in advance"). Name the lookup M25 needs from A-M13-02.
2. **Action classes for `strategy.<id>.enabled_modes`.** Accepted. Adding `live_small` or `live` is A3; adding `paper` is A2; removing any mode is A1, since it lowers risk.
3. **Same version, changed code.** Accepted. A CI check pins `id@version` to a hash of the plugin source, so any code change needs a new version.
4. **Template modes.** Accepted. The known-answer template runs in backtest and replay only, never in paper or live ("No knowingly losing trades").
5. **Where the validator is wired.** Accepted. B-M25-02's cross-key rules; Z-STRAT ships it as a pure validator.
6. **Two strategies, one pool.** Accepted. M21's per-token rule rejects the second, and Z-STRAT adds nothing.
7. **New inputs (holders, wallets, social).** Not now. When the owner brings a strategy that needs them, the supervisor puts a features card to the owner then ("Focused queue": a new task needs the owner's OK). Say this in the doc's checklist.
8. **A dedicated switch.** Required. The owner asked for exactly this ("Like a switch button where this logic turns on strat 1 Then strat 2 turns on"), so it is not a new task. Add a UI ticket to Z-STRAT's scope, or as a named follow-up UI card after Z05: a strategies screen listing each strategy (VM-03 `strategies[]`), with a switch per mode. It writes `strategy.<id>.enabled_modes` through the S-10 config path, under the classes in ruling 2. A strategy with no PREREG shows its paper switch disabled, with the reason.

Next: the researcher applies 1–8 and takes the PR out of draft. Then a fresh reviewer and a red team.

## Round 1 red team (head `a889f73b`): 3 BLOCKER, 6 MAJOR, 4 MINOR

Red team `session_01HECcHHGsHibzJQLqXnMmYz`, about 9:26 AM. Full report in its transcript. In short:
- B1: a new version inherits the old version's switch and stage, including live.
- B2: a failed strategy still paper-trades.
- B3: a params change in config alters a live strategy without a new version, at A2.
- M1: the source pin can be edited in place, and a version reused. M2: the pin misses features and shared code. M3: plugins can reach `fetch`, `process.env` and other globals. M4: the config bootstrap and engine start skip the validator. M5: the A3 class is proven on a pure function only. M6: no mechanism enforces the 31 Dec stop for agent-started strategies.
- m1: two sources for the switch. m2: the selected configKey is not enforced after backtest_passed. m3: the system mode versus paper strategies. m4: negative evidence, and plugin state carried across runs.

### Supervisor rulings for round 2 (8 Oct 2026, about 9:35 AM)

All fixes are accepted, as follows.
1. **B1.** Keep SPEC's key `strategy.<id>.enabled_modes`. The host emits in paper or live only when the running (version, paramsHash) equals the stage record's frozen version and configKey. Otherwise the strategy is disabled with `E_VERSION_NOT_STAGED` and a critical alert. The validator refuses paper and live on the same mismatch. A new version starts its own stage at `registered` and needs its own PREREG. Add ACs for an upgrade (X@2 while X@1 is live_small) and for a rollback.
2. **B2.** The host emits nothing in any mode at stage `failed` or `archived`. The validator refuses every mode at those stages. The move to `failed` removes every mode as an audited A1 action. Add ACs for all three.
3. **B3.** Params belong to the version and cannot change in config. The validator refuses any change to `strategy.<id>.params.*` of a registered version (`E_PARAMS_CHANGED` at validate time). The host re-checks paramsHash against the registry on every config swap and disables the strategy on a mismatch. Add an AC.
4. **M1.** The pin file is append-only. CI compares it with the base branch: an existing `id@version` entry may never change or disappear. Add ACs: same version with a new hash fails, and a removed pin fails.
5. **M2.** Add a features-implementation hash (the features package and the host and shared helpers a plugin calls) to configKey. A change in the middle of a window resets that window through `E_TRIAL_MISMATCH`, and the reset is recorded.
6. **M3.** An allow-list lint that bans every global named in the report, plus dynamic `import()` and computed `globalThis` access. Give AC-12 one failing fixture per name. A vm context is optional and is not a security boundary.
7. **M4.** Bootstrap and every start run the full cross-key validator, with the PREREG snapshot and the stage. A violation gives `start_refused` or `exits_only`. Bootstrap refuses `live_small` and `live` in any `enabled_modes`, which only an A3 action can add. Add an AC.
8. **M5.** The class is max(M25-derived, validator-derived). Add an integration AC on B-M25-02 and B-M26-02: adding live_small previews A3 with delayS 60, and a mobile attempt gets 403 `mobile_forbidden`. The A3 phrase is `ENABLE <id>@<version> LIVE-SMALL` (and `LIVE`).
9. **M6.** The PREREG and the strategy row carry `origin: owner | agent`. `owner` is set only with a cited owner message, and the reviewer checks it. For `origin=agent`, the host stops emission at 2026-12-31T23:59:59 Australia/Melbourne, and the validator refuses enabling it after that. Starting an agent strategy is itself a new task that needs the owner's OK ("Focused queue"); say so in §1 and §8. Add ACs.
10. **m1.** Config is authoritative. The `strategy` table is a projection rebuilt from config at start.
11. **m2.** From `backtest_passed` on, only the selected configKey may run in paper and live.
12. **m3.** State what SPEC (B-M26-04, A-M09-01) says about paper strategies while the system mode is live_small. If SPEC is silent, propose that they keep running as a paper shadow (no real orders), so their W_P continues, and mark it PROPOSED.
13. **m4.** The handover evidence must show a positive after-cost expectancy; the reviewer refuses a PREREG whose own evidence is negative (§2 and checklist step 7). A fresh plugin instance per run.

Next: the researcher applies 1–13. The reviewer's round 1 report is still collected. Then a delta review and red team at the new head.
