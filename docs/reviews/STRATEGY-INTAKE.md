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

## Round 1 reviewer (head `a889f73b`): FAIL on 4 MAJOR, plus 11 MINOR

Reviewer `session_011iA9FMWTMikWUyoerDHrq2`, about 9:27 AM. Rulings 1–8 were applied as written. Every SPEC citation it checked is correct, apart from those listed.
- M1: a failed strategy still paper-trades (the same as red team B2).
- M2: AC-11 cites A-M09-01, but the after-cost and look-ahead checks are A-M11-02's criteria (SPEC-A:1829-1830).
- M3: MIGRATION's A-M09-01 B1 and B5 probes are not in the AC or test tables ("No bugs migrate").
- M4: C10 misquoted. UI.md:556 says C10 is never used for money-affecting toggles that need confirmation.
- m1–m11: the L-3 wording; the edgeEstimate object shape; PROPOSED marks (step-up 5 min, `config/validate`); the VM-03 `name` source; a class for backtest and replay; no AC for live switches below paper_passed; varianceBps2 ≤ 0; "practice only" wording; the full live checklist; the ruling time.

### Supervisor rulings (8 Oct 2026, about 9:38 AM), added to round 2

14. **M1:** covered by ruling 2 (B2). Also add the disabled reason to Z-STRAT-UI.
15. **M2:** limit AC-11 to the hand-computed fixture. Hand the after-cost and look-ahead checks to A-M11-02 with its citation, and list it under Dependencies.
16. **M3:** add AC-17 (B1, pool updates dated from measured slot time) and AC-18 (B5, no config key can inject an edge), each with a fail-before test against the old `strategy.ts` and `engine.ts` behaviour.
17. **M4:** no C10. Use a control that shows on or off and opens the UI-T13 dialog.
18. **m1–m5, m8, m11:** fix as the reviewer says. The ruling time is about 9:23 AM.
19. **m6:** refuse `backtest` and `replay` on the live host (UC-12), with a test row.
20. **m7:** add the AC. The validator also refuses live modes below `paper_passed`.
21. **m9:** use "They are marked shadow and do not count for any gate yet."
22. **m10:** add one plain line on what live also needs: the go-live checklist and kill drill (P-7, P-8), the signer's max_mode raised on the host, one strategy live at a time, and funding the wallet (owner only).

## Round 2 delta review (head `e69fc5c6`): FAIL on 1 MAJOR, plus 6 MINOR

Reviewer, about 9:33 AM. Rulings 1–22 are applied as written, and nothing weakens an owner rule or a gate.
- M1: AC-21 (configKey, E_TRIAL_MISMATCH, the window reset) and AC-19's audited A1 removal test behaviour of A-M13-02/05/06 and B-M26-04, which Z-STRAT's scope excludes.
- m1: the 5-min A2 step-up is in SPEC-B B-M26-02 step 2, so it is not PROPOSED.
- m2: the A3 phrase `ENABLE <id>@<version> …` is not in SPEC. Mark it as the ruling's addition and list B-M26-02 step 2 among the amendments.
- m3: the positive-evidence rule is missing from §2 (the reviewer's refusal).
- m4: the order of the Rulings list.
- m5: AC-28 should read "the PREREG sizing result, capped by M21".
- m6: operator demotion is not automatic.
Held until red team round 2 reports, so both go in one push.

## Round 2 red team (head `e69fc5c6`): 0 BLOCKER, 6 MAJOR, 5 MINOR

Red team, about 9:32 AM. All three round 1 blockers are closed. New or remaining:
- N1: stages are stored per id, so X@2's `research` record replaces X@1's `live_small` record.
- N2: two registered configurations per version clash with "params belong to the version".
- N2b: `origin` can be flipped through config, which defeats the 31 Dec stop.
- N3: making configKey equality a trading condition turns any affectsReturns or host change into a permanent stop.
- N4: the globals lint is a deny-list with a one-line bypass (the constructor chain), and names are missing.
- N5: a version can be reused if it never reached main.
- N6: a strategy-scoped violation at start stops the whole engine, with an outage scheduled for 1 Jan 2027.
- n1–n5: the live switch shows "on" before set_mode; the meaning of "live" for MAXSTRAT; "calls" cannot be computed; the order of the Rulings list; AC-28 sizing.

### Supervisor rulings for round 3 (8 Oct 2026, about 9:52 AM)

23. **N1.** Stage records are keyed by (id, version). Registering X@2 never changes X@1's stage. Add a step to AC-17 that checks X@1's stage is unchanged. Add A-M13-05 and ARCH 15 to the open point 6 amendments.
24. **N2.** paramsHash and the staging check are per configKey within the version's registered set. Each configuration's params are fixed in the PREREG. Config may only pick one of the registered configurations, never set free params. At `research`, the L89 check accepts any configKey in the registered set; from `backtest_passed` on, only the selected one (AC-24). Add an AC: configuration 2 is selected, then paper-traded.
25. **N2b.** `origin` comes only from the immutable PREREG or the append-only registry row, never from config. The validator refuses any key that sets it. `owner` needs a supervisor-recorded DECISIONS line that names id@version and cites the owner's message. Origin is fixed for the life of the version. For agent strategies, the stop uses wall-clock time, covers backtest and replay too, and runs the audited A1 removal of every mode at that moment. Open positions keep their exits. Add ACs.
26. **N3.**
    - (a) The code hash is the build-computed import closure of the plugin plus the features package. A host change outside that closure does not change configKey.
    - (b) When a change alters configKey for a strategy in paper or live, a B-9 replay on its W_B data decides.
    - (c) If the proposals are byte-identical and the change only lowers risk (class A1), configKey is re-frozen by an audited A1 action and the stage stands.
    - (d) If the proposals differ, or the change is A2 or A3, the strategy drops to the stage before its open window, and that window restarts. Any change other than a risk-lowering one sends it back to `research`.
    - Add an AC: "A1 limit lowered while live".
27. **N4.**
    - A real allow-list of global identifiers.
    - Ban member access to `.constructor` and `__proto__`, computed member access with non-literal keys on non-local objects, `import.meta`, `with` and `Intl`.
    - Add a failing fixture for each bypass the red team listed, the constructor chain included.
    - State that lint is not a boundary.
    - Add a named follow-up card, PLUGIN-SANDBOX: plugins run in a process with no provider secrets and no network. It is a precondition of live: the A3 enable refuses live for a plugin that does not run that way.
28. **N5.** CI refuses an id@version that appears with another hash in `research/<id>/PREREG.md` or in the trial registry export. The runner, the research host included, refuses to register an id@version whose source hash is not in main's pin file. The pinned source hash goes into the stage record, so the staging check binds the code.
29. **N6.**
    - A strategy-scoped violation (a staging mismatch, failed or archived, the origin stop, a missing PREREG) disables only that strategy at start, with a critical alert and the audited A1 removal. Its open positions keep their exits.
    - Only a global violation (schema, ceilings, live modes in the bootstrap config) gives `start_refused` or `exits_only`.
    - Add an AC: an upgrade restart leaves the other strategies running.
30. **n1.** The control shows "on, waiting for live mode" with its reason until set_mode. Checklist item 11 says two A3 steps are needed.
31. **n2.** "Live" for MAXSTRAT means stage live_small or live while the system mode is live, not a stale entry in enabled_modes.
32. **n3.** Covered by 26(a).
33. **n4 and the reviewer's m4.** Put the Rulings list in order.
34. **n5 and the reviewer's m5.** AC-28 reads "never above the size the PREREG's sizing rule gives at edge 0, capped by M21".
35. **Reviewer M1.**
    - Z-STRAT ships `featuresImplHash()` with a stability and change test.
    - The configKey, mismatch and window-reset criteria go to A-M13-02 and A-M13-05/06 under Dependencies.
    - For AC-19, Z-STRAT tests the host and validator and its handling of a removal event from a fake M26. The audited A1 removal goes to B-M26-04 under Dependencies.
    - The same split applies to rulings 25, 26 and 29: Z-STRAT tests its own side against fakes, and the rest is listed as dependencies.
36. **Reviewer m1.** The 5-min step-up is in SPEC-B B-M26-02 step 2. Cite it and drop PROPOSED.
37. **Reviewer m2.** The A3 phrase is the supervisor's addition. Mark it so, and add B-M26-02 step 2 (requiredPhrase) to the amendments.
38. **Reviewer m3.** Add the reviewer's refusal of a negative-evidence PREREG to §2, and say why the checklist puts it at step 3.
39. **Reviewer m6.** "L-1, L-2 and L-4 demote it automatically; the operator can demote it (A1)."
