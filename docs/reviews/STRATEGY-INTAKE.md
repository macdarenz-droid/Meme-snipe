# STRATEGY-INTAKE (PR #293) review log

## Round 1: researcher's open questions (head `edfb1cda`)

### Supervisor rulings (8 Oct 2026, 9:21 AM)

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

### Supervisor rulings for round 2 (8 Oct 2026, 9:27 AM)

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

### Supervisor rulings (8 Oct 2026, 9:27 AM), added to round 2

14. **M1:** covered by ruling 2 (B2). Also add the disabled reason to Z-STRAT-UI.
15. **M2:** limit AC-11 to the hand-computed fixture. Hand the after-cost and look-ahead checks to A-M11-02 with its citation, and list it under Dependencies.
16. **M3:** add AC-17 (B1, pool updates dated from measured slot time) and AC-18 (B5, no config key can inject an edge), each with a fail-before test against the old `strategy.ts` and `engine.ts` behaviour.
17. **M4:** no C10. Use a control that shows on or off and opens the UI-T13 dialog.
18. **m1–m5, m8, m11:** fix as the reviewer says. The round 1 ruling time is 9:21 AM (the researcher's first stamp was right).
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

### Supervisor rulings for round 3 (8 Oct 2026, 9:34 AM)

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

**Time correction (9:39 AM).** The ruling times above were first written as estimates (9:23, 9:35, 9:38 and 9:52), and some were later than the real time. They are now the commit times of this file, from `git log` in Melbourne time.

## Round 3 (head `d5a43d18`): reviewer FAIL on 1 MAJOR and 3 MINOR; red team 0 BLOCKER, 4 MAJOR, 5 MINOR

- Reviewer M1: AC-22 and AC-33 test B-M25-03's start outcome, which is out of scope. m1: :47 still hashes host helpers. m2: the claim that M14 runs in the plugin process is an inference. m3: two amendments are missing (A-M11-01; B-M26-02 and B-M26-04 readiness).
- Red team:
  - P1: the pin hash includes the features package, so any features fix breaks every pin.
  - P2: owner limit raises and cost or fill model changes send a strategy back to `research`, and a live drop skips the demotion path.
  - P3: the stage-machine interfaces are still keyed by id only.
  - P4: a live-only sandbox breaks parity with backtest.
  - p1–p5: lint gaps (literal and destructured `constructor`, locale built-ins); where the `owner` check runs; the PREREG-file pin check is vacuous; piled-up changes; an upgrade of a live strategy.

### Supervisor rulings for round 4 (8 Oct 2026, 9:40 AM)

40. **Reviewer M1.** Z-STRAT tests only its own side: the validator classifies each violation as global or strategy-scoped, and the host disables only the scoped strategy, against a fake B-M25-03 that records the start outcome. Add the Dependencies row "Global start outcome (`start_refused` / `exits_only`) | B-M25-03 | fake start coordinator".
41. **Reviewer m1–m3.** As written: align :47 with :77; write "may run in the same process" unless the ARCH process model says it does; add A-M11-01 and B-M26-02/B-M26-04 readiness to open point 6.
42. **P1.** Two separate hashes. The pin hash covers only the plugin's own import closure, without the features package, and stays immutable per version. `featuresImplHash()` enters configKey separately and is what "Changes after freezing" can re-freeze. Add an AC: a features change under existing pins passes CI and puts each strategy into mismatch, then into the B-9 decision.
43. **P2.** configKey has two groups.
    - Group P changes proposals: features implementation, universe, and the registered configuration. Ruling 26 applies:
      - B-9 byte-identical and A1: re-freeze, and the stage stands;
      - proposals differ and A1: drop one stage and restart that window;
      - A2 or A3: back to `research`.
    - Group S scales or costs proposals: sizing, caps, and the cost and fill model.
      - A config change in group S is re-frozen by an audited action of its own class. An owner A3 raise also re-runs the current gate's stress and size table ($5 to $10,000, with price impact). The stage stands ("Capital and trade size scale").
      - A cost- or fill-model code deploy re-runs the current gate's statistics on the window's data with the new model. If the gate still passes, it is re-frozen by an audited A2 action. If not, the strategy is demoted one stage.
    - Every stage drop of a live strategy goes through B-M26-04 as a demotion: signer setMode lowered first, cancelAllPendingA3, and the cooldown.
    - On a mismatch, the host disables the strategy and raises a critical alert, and the research runner starts the B-9 decision on its own. With no decision within 24 h, a second critical alert goes to the owner.
44. **P3.** Every stage-machine interface is keyed by (id, version) or the stage record id: A-M13-05's `stage`, `onModeCommand`, `onDemotion`, `archive`, `cooldownUntil` and `minDwellUntil`; A-M13-06's `evaluateGates`; B-M26-04 step 8; and VM-18 (add `strategy_version`). Add them to open point 6. Add an AC: a demotion while X@2 exists changes only X@1.
45. **P4.** PLUGIN-SANDBOX applies in every mode, the research host included, so the gates run the same path that trades. Its card carries a parity AC: the same bars and seed in-process and sandboxed give byte-identical proposals and featuresHash, in CI. The A3 refusal checks a runtime attestation in the host's `status()` (empty env, network denied), not a config flag.
46. **p1.** Ban `constructor` and `__proto__` in every property position (member, literal computed, destructuring, `in`), and the locale built-ins (`toLocaleString`, `localeCompare`, `toLocaleUpperCase`, `toLocaleLowerCase`), with one fixture each.
47. **p2.** A CI check binds a PREREG's `origin: owner` to a supervisor DECISIONS line on main. preRegister copies that reference into the append-only registry row the validator reads. After the agent stop, preRegister refuses new `agent` registrations.
48. **p3.** State the order: PREREG pushed → plugin built and pinned on main → preRegister records the source hash → W_B. The CI check uses the registry export, and the doc says where CI gets a fresh export.
49. **p4.** The class of piled-up changes is the server-derived maximum over every change since the frozen configKey, recorded in the re-freeze audit.
50. **p5.** One line: with X@1 live, upgrading means demoting to paper first and running X@2's full gates, so live trading pauses.

## Round 4 (head `5d1ec4c4`): reviewer PASS (1 optional MINOR); red team 0 BLOCKER, 4 MAJOR, 5 MINOR

- Reviewer n1: split the ruling 50 paragraph from the "Live only after the gates" sentences.
- Red team:
  - Q1: @bot/types runtime code (canonicalJson) is in every pin closure.
  - Q2: group S lets admission keys and losing raises keep the stage.
  - Q3: code deploys have no class, and "current gate" fails mid-window.
  - Q4: owner PREREGs in the public repo publish the owner's edge.
  - q1–q5: the A3 enable bound to a version; an atomic group S re-freeze; sandbox notes; registry export lag; after the 24 h alert.

### Supervisor rulings for round 5 (8 Oct 2026, 9:45 AM)

51. **Q1.** The pin hash covers only files inside the plugin's own package directory. Every runtime dependency outside it (the features package and the @bot/types runtime modules the plugin imports, as the build computes them) goes into one group P hash in configKey: `runtimeDepsHash()`, which replaces `featuresImplHash()` and is re-frozen through B-9. AC-35 also covers "a @bot/types change under existing pins passes CI".
52. **Q2.**
    - (a) Every affectsReturns key in the B-M25-01 schema carries a group tag. A CI test fails any key without one, and until it is tagged the key is treated as group P.
    - (b) Group S holds only keys that change a trade's size or cost and never which trades happen. Admission keys (ladder, cooldown, entry rate, regime, dump window, max open positions, the per-token rule) are group P.
    - (c) A group S raise is applied only if the re-run gate statistics, and the size table at the new size, still pass with the CI lower bound above 0. Otherwise the server refuses the A3, at preview or at effective_at, with the blocking reason.
    - Add the AC: "A3 MAXPOS raise where the size table shows a negative mean at the new size → refused, stage and limit unchanged."
53. **Q3.** Code deploys get their own rule.
    - If B-9 is byte-identical and the model outputs are not more favourable, the change is re-frozen by an audited A2 with actor `system`.
    - Otherwise, every gate already passed is re-run on its own recorded window with the new code. If all still pass, it is re-frozen by an audited A2; if not, the strategy is demoted through B-M26-04 to the last stage whose gate still passes.
    - An open window continues under the new key from the deploy time, and the reset is recorded.
    - Add ACs: byte-identical; differing but still passing; differing and failing.
54. **Q4.** Owner-origin strategies are never published.
    - An owner PREREG, its evidence and its plugin source live only in a private location. The public repo holds only a commitment: the sha256 of the PREREG and of the plugin closure, plus the private commit sha. `git ls-remote` on the private repo proves the pre-registration time, and CI checks the hashes.
    - Agent-origin strategies may stay public.
    - Where the private copy lives, and how the server gets the plugin, is the owner's choice (a new kind of stored data, and a deploy path); it was put to the owner at 9:45 AM.
    - Until the owner answers, the doc names both options, and no owner strategy is merged anywhere public.
55. **q1.** The scheduled A3 command is bound to id@version and cancelled at effective_at if the running version differs (B-M26-03 re-validation). Add `version` to VM-03 `strategies[]` in Z-STRAT-UI's contract gap.
56. **q2.** A group S A1 lowering carries its own re-freeze in the same apply_config, at the same class, so a live strategy never goes dark waiting for a second action.
57. **q3.** Add the sandbox notes to the card:
    - features are passed with the bar, or through a synchronous proxy, with the same featuresHash;
    - before the first A3, B-9 runs on the strategy's own W_B data through the sandbox;
    - a timing criterion: per-bar IPC against `onbar_warn_ms`.
58. **q4.** The runner refuses a second preRegister, or a registration, of the same id@version until its export entry is on main.
59. **q5.** After the 24 h alert, the alert repeats daily, and the supervisor records a decision in DECISIONS within 2 days.
60. **Reviewer n1.** Split the paragraph.

## Round 5 (head `79aba2c1`): reviewer PASS (2 optional MINOR); red team 0 BLOCKER, 4 MAJOR, 3 MINOR

- Reviewer n1 and n2: PREREG paths and the pin check for owner strategies (wording).
- Red team:
  - R1: any push, review note or DECISIONS quote publishes an owner strategy.
  - R2: an A1 size lowering can make a strategy lose to fixed costs.
  - R3: code-deploy re-runs reuse seen windows, the holdout included, and P cannot be re-run on recorded data.
  - R4: admission keys in group P send owner raises back to `research`, and B-9 cannot see admission changes.
  - m1–m3: "not more favourable" is undefined; the private pin CI; the B re-run failure target.

### Supervisor rulings for round 6 (8 Oct 2026, 9:49 AM)

61. **R1.** Owner-strategy work (building, review and red team) happens only in the private location, and nothing about it is pushed to any branch of this repo. The public repo, PR text, review logs and DECISIONS refer to an owner strategy only by an opaque id (`o-<n>`) and hashes. The DECISIONS citation points to where the owner's message is and does not quote it. Until the owner chooses the location, no owner-strategy work starts at all.
62. **R2.** An A1 change always applies. The same apply checks the size table at the new size. If the CI lower bound is ≤ 0 there, the strategy stays enabled, but entries are blocked with reason `size_not_profitable` until the size is raised back or the gate passes. Exits are kept, and a critical alert goes out. Add an AC with a fixed-cost fixture.
63. **R3.**
    - Every code-deploy re-run is a registered trial (A-M13-02 `registerTrial`, kind `gate`), counted in the DSR and B-5. Re-runs on W_B and W_R are allowed only within the trial budget. When the budget is used up, the strategy needs a fresh forward window.
    - For P and LS: if the differing proposals change any trade in W_P, P is not re-run. The strategy drops to `replay_passed` through B-M26-04 and starts a fresh W_P, with no cooldown, since this is not a demotion for cause.
    - Add ACs: a re-run is registered as a trial; a differing deploy that touches W_P trades starts a fresh W_P.
64. **R4.** Admission keys are compared on trades: the recorded proposals are replayed through M21 with the old and the new setting.
    - A1: identical trades → re-freeze. Otherwise the passed gates' statistics are re-run on the new trade set, registered as trials under ruling 63, and the strategy keeps its stage or is demoted one.
    - An A3 raise follows the group S rule: it is applied only if the gate re-run and the size table pass, with the CI lower bound above 0, and is refused otherwise. The stage stands.
    - `research` remains only for plugin, universe and configuration changes.
    - Add an AC: an A3 MAXOPEN raise that passes keeps the stage, and one that fails is refused.
65. **m1.** "Not more favourable" means that on the window's trades, every modelled cost is ≥ and every modelled fill is ≤ the old model's, per trade.
66. **m2 and reviewer n2.** The private location runs the same pin CI. Public CI compares only the commitment hash with the pin entry (AC-46).
67. **m3.** Add a test row for gate B failing on a re-run. A failure with sufficient data is `failed` (A-M13-05 step 3); with insufficient data, the strategy goes to `research`.
68. **Reviewer n1.** In §2 "Document" and "Order", say that the in-repo path is for agent-origin strategies only; owner-origin ones use the private location, with only the commitment here.

## Round 6 (head `fdbaf99c`): reviewer PASS (1 optional MINOR); red team 0 BLOCKER, 3 MAJOR, 4 MINOR

- Reviewer n1: Dependencies rows for the M21 side (size_not_profitable, admission replay) and for the registerTrial budget.
- Red team:
  - S1: the re-run trial budget is zero at the default W_B, and "fresh forward window" is undefined.
  - S2: admission changes and group S raises do not inherit the re-run safeguards (trials, no P on simulated trades).
  - S3: "not more favourable" is backwards for buy fills.
  - s1–s4: wording on the public commitments; a no-cooldown drop needs SPEC and must not shorten an existing cooldown; the W_LS gap; owner results in public text.

### Supervisor rulings for round 7 (8 Oct 2026, 3:06 PM)

69. **S1.**
    - (a) The PREREG reserves k = 2 re-run trials. MinBTL is computed on configurations + k, and preRegister refuses a W_B too short for that.
    - (b) "Fresh forward window" means the strategy drops to `backtest_passed`, through B-M26-04 when live. It is disabled in paper and live with exits kept, then records a new W_R and after it a new W_P. W_B is re-run only inside the budget.
    - (c) AC: a 30-day W_B with 2 configurations and k = 2 is accepted; a re-run inside k proceeds; the (k+1)-th goes to the fresh-window state.
70. **S2.** One shared re-run rule for code deploys, admission changes and group S raises:
    - every re-run is a registered trial inside the budget;
    - B and R are re-run on their own windows;
    - P and LS are never re-run on simulated trades. If a change adds or removes any W_P or W_LS trade, a raise applies only as "W_P restarts under the new setting from `replay_passed`" (a stage drop through B-M26-04, with no cooldown for cause), or it is refused until the owner accepts that restart in the A3 preview.
    - AC: an A3 MAXOPEN raise that admits a new W_P trade is never judged by P on simulated trades.
71. **S3.** "Not more favourable" is measured in SOL outcome, per trade and side:
    - buy: tokens received ≤ old;
    - sell: SOL received ≤ old;
    - modelled costs in lamports ≥ old;
    - net SOL P&L per trade ≤ old.
    The AC covers a buy and a sell separately.
72. **s1.** "Nothing except the opaque id, the hashes and the export row."
73. **s2.** Add the no-cooldown drop to the open point 6 amendments (B-M26-04, A-M13-05). It never shortens an existing `cooldown_until` (max of existing and none).
74. **s3.** When a deploy changes W_LS trades but no W_P trades, W_LS restarts at `live_small`.
75. **s4.** Owner-strategy results stay in the private location as well. Public text uses only the opaque id and stage names.
76. **Reviewer n1.** Add the Dependencies rows "B-M21-02 / B-M25-02 | fake M21" and "A-M13-02 registerTrial and budget | fake registry".

**Ruling 69(c) amended (8 Oct 2026, 3:10 PM).** The example "a 30-day W_B with 2 configurations and k = 2 is accepted" is withdrawn. It conflicts with ARCH 3.4's MinBTL table (Sharpe 2: N = 2 at 30 days, N = 3 at 91 days). k is a PREREG field (k ≥ 0), fitted so that configurations + k fits the table for the planned W_B. With k = 0 there are no re-runs, and a proposal-changing deploy goes straight to the fresh-window state. AC-50: 1 configuration + k = 2 on 91 days is accepted; 2 configurations + k = 2 on 30 days is refused with E_BUDGET.

## Round 7 (head `5be4b143`)

Reviewer: PASS (1 optional MINOR: record this withdrawal here, now done). Red team round 7 pending.

Red team round 7: 0 BLOCKER, 2 MAJOR, 3 MINOR.
- T1: the shared re-run rule lets a raise or an A1 admission tightening fail or sideline a proven strategy, always so at k = 0.
- T2: the byte-identical path compares only the old window's trades, so a fill model that adds fills gets through.
- t1–t3: safety fixes ship at once; the source of n_80 in the fresh-window state; AC-50's common case.

### Supervisor rulings for round 8 (8 Oct 2026, 3:11 PM)

77. **T1: what-if checks are not re-validations.**
    - Raises (group S and admission A3) are what-if checks on the recorded proposals of W_B and W_R plus the size table.
    - A failed what-if only refuses the raise. It never demotes, never sets `failed`, and never enters the fresh-window state.
    - Each submitted raise (not a preview) is registered as a trial of kind `whatif`, counted in a separate raise budget that limits holdout probing without using k.
    - An A1 admission tightening applies at once. If the new trade set's CI lower bound is ≤ 0 on W_B and W_R, entries are blocked with `admission_not_profitable` until it is reverted; otherwise the stage stands.
    - k and the fresh-window state stay only for code deploys that change proposals.
    - ACs: a failing MAXPOS raise is refused with the stage unchanged; at k = 0 a passing raise applies and the stage stands; at k = 0 an A1 regime tightening applies with no fresh-window state.
78. **T2.** The byte-identical path also needs the filled-trade set and the rejection set (with reasons) to be identical under both models. Any difference goes to the re-run rule, or to the fresh-window state at k = 0. AC: a model that turns one rejected proposal into a fill is not re-frozen by the byte-identical rule.
79. **t1.** A bug fix that touches trading safety (wrong data, wrong side, wrong size) ships at once and accepts the fresh-window state; it is never held back to protect a stage. A PREREG that wants room for deploys plans a longer W_B.
80. **t2.** In the fresh-window state, R-1's `n_80` stays computed from the old W_B (the conservative choice).
81. **t3.** Add the AC: 2 configurations + k = 0 on 30 days is accepted, and the first proposal-changing deploy goes straight to the fresh-window state.
82. **Open point 9 (8 Oct 2026, 3:14 PM).** The raise budget r is a required PREREG field (r ≥ 0), stated like k. preRegister refuses a PREREG without it (E_BUDGET). The template suggests r = 2. Once r is used up, raises are refused. Every `whatif` trial is listed in the gate report beside the k trials. Ruling 77 replaces ruling 70's W_P path for raises: an approved raise keeps its stage, bounded by r and by the what-if on W_B and W_R with the size table (the owner raises limits after proof, "Capital and trade size scale").

## Round 8 (head `94d24c06`)

Reviewer: PASS (1 optional MINOR: record ruling 82 here, now done). Red team round 8 pending.

Red team round 8: 0 BLOCKER, 2 MAJOR, 2 MINOR.
- U1: r does not limit holdout probing (previews are free), blocks normal stepwise scaling, and can trap a block forever (a revert is itself a raise).
- U2: the fresh-window state has no re-freeze to the new code, so W_P can never emit.
- u1: a null CI on a small trade set. u2: a fill-only change counts as "changes trades".

### Supervisor rulings for round 9 (8 Oct 2026, 3:15 PM)

83. **U1.**
    - A preview shows only the blocking reasons that need no holdout data (ceilings, stage, budget). The holdout what-if is computed and shown only at submit, where it registers the trial.
    - Every `whatif` trial counts in the DSR (B-3).
    - r refills when a fresh forward window (W_P, or W_LS for a live strategy) passes at the current setting.
    - A return to the stage's last frozen setting (reverting a tightening, or raising the size back to the frozen value) uses no r and needs no what-if.
    - ACs: a preview registers no trial and shows no holdout result; at r = 0 a revert to the frozen setting applies; r refills after a passing W_P.
84. **U2.** On entering the fresh-window state, the stage record is re-frozen to the new configKey by an audited A2 with actor `system`, recording the old key, the deploy, and "fresh window". Gates R and P then run on the new key. AC: after a fresh-window entry and a passing W_R, paper emission resumes under the new configKey.
85. **u1.** A null CI (fewer than 30 trades, A-M13-04) counts as ≤ 0: entries are blocked, or the raise is refused.
86. **u2.** A difference in the fill or rejection sets counts as "changes trades", so AC-61's path runs end to end through the re-run rule.

## Round 9 (head `6c8a730c`): reviewer PASS (no findings); red team 0 BLOCKER, 3 MAJOR, 1 MINOR

- V1: the free revert never applies, because an A1 change re-freezes first.
- V2: r never refills at paper_passed, live_small or live.
- V3: any fill-value change counts as "changes trades", so a more conservative model demotes live strategies.
- v1: a cancelled A3 raise as a probe.

### Supervisor rulings for round 10 (8 Oct 2026, 3:18 PM)

87. **V1.** The "evidence-backed setting" is the setting frozen at the last gate pass or the last passing what-if raise; an A1 re-freeze never moves it. A return to the evidence-backed setting, or to any value between it and the current one, uses no r and needs no what-if. AC: lower MAXPOS (A1 re-freeze, `size_not_profitable`), then at r = 0 raise it back to the gate-pass value; it applies with no trial.
88. **V2.** At paper_passed, live_small and live, a rolling forward block refills r: each block of ≥ 100 closed trades and ≥ 14 days at the current setting, counting only real paper or live fills, net in SOL after costs. When the block's CI lower bound is above 0, r refills. AC: at `live`, a passing block refills r, and a failing one does not.
89. **V3.** "Changes trades" means a trade is added or removed, or a proposal's fill or reject outcome flips; only that restarts W_P. When membership is identical and only values change:
    - if the change is "not more favourable" (the SOL test), it re-freezes by an audited A2 with no restart;
    - if it is more favourable, the B, R and P statistics are recomputed on the same real trades with the new model, as registered trials inside k, and the strategy is demoted only if a gate fails.
    - AC: a more conservative model that changes every W_P fill value, with no flips, re-freezes with no restart.
90. **v1.** A cancelled A3 raise keeps its `whatif` trial and its r use, so cancelling is never a free probe.

## Round 10 (head `0d5b01e2`): reviewer PASS (1 optional MINOR); red team 0 BLOCKER, 2 MAJOR, 2 MINOR

- W1: a value between the current one and the evidence-backed one skips the size check.
- W2: a more conservative model re-freezes without recomputing the gates.
- w1: rolling refill blocks can reuse trades. w2: the evidence-backed setting must be the whole configuration.
- Reviewer n1: AC-71 should say "what-if or replay trades are not counted".

### Supervisor rulings for round 11 (8 Oct 2026, 3:20 PM)

91. **W1.** Only a return to exactly the evidence-backed setting is free. An intermediate value uses no r and no holdout what-if, but runs the same apply-time checks as an A1 change: the size table, or the admission trade set on W_B and W_R. If the CI lower bound is ≤ 0 or null, the block stays or is raised. Non-numeric keys have no "between". AC: from 0.05 (blocked), a raise to 0.10 where the size table fails keeps `size_not_profitable`; a raise to 0.50 clears it with no trial.
92. **W2.** A not-more-favourable value change still recomputes B, R and P (and LS, and the size table at the current size) on the same real trades with the new model. It uses no k and no r, and is recorded as a `recost` trial listed in the gate report. If every gate passes, it is re-frozen by an audited A2 and the stage stands. If any fails, the strategy is demoted through B-M26-04 to the last stage whose gate still passes. AC: a conservative model that turns P-2's CI lower bound negative on the same W_P trades demotes the strategy, with no k used.
93. **w1.** Refill blocks are disjoint and consecutive, and each trade is in one block only. A block lies wholly at one setting and starts after the last raise or A1 change. r refills to its PREREG value at most.
94. **w2.** The evidence-backed setting is the whole configuration (all group S and admission keys) as frozen at the last gate pass or passing raise.
95. **Reviewer n1.** AC-71: "what-if or replay trades are not counted" (real paper fills count at paper_passed).

## Round 11 (head `ed4cb0d3`): reviewer PASS (2 optional MINOR); red team 0 BLOCKER, 1 MAJOR, 3 MINOR

- X1: a neutral (A2) change to an admission or group S key (exit ladder shape, regime enum, per-token rule mode, dump window kind) falls in none of the paths, so it re-freezes with the stage standing and nothing checked.
- x1: intermediate-value and A1 apply-time checks read W_R with no trial, so stepping through values leaks the holdout verdict.
- x2: "not more favourable" must cover every window the recomputed gates use.
- x3: a refill block should restart after any configKey change.
- Reviewer n1: AC-76 leaves its setup implicit. n2: no AC for an intermediate value that raises a new block.

### Supervisor rulings for round 12 (8 Oct 2026, 3:26 PM)

96. **X1.** A neutral (A2) change to a group S or admission key is handled as a raise: a what-if on W_B and W_R plus the size table, one `whatif` trial, one use of r; refused if it fails (never demotes), and a pass moves the evidence-backed setting. A return to exactly the evidence-backed setting stays free. Add the sentence under "Raises". AC: an A2 change to the exit ladder or the regime enum on a live strategy registers a `whatif` trial and uses r; at r = 0 it is refused.
97. **x1.** Keep the W_R check (it is what makes a tightening safe), but every apply-time check that reads W_R (an intermediate value or an A1 change) is a listed trial: kind `applycheck`, PROPOSED, no k and no r, listed in the gate report and counted in the DSR trial count. Add it to the A-M13-02 amendment line beside `whatif` and `recost`. Why not W_B only: dropping W_R would let a tightening that loses on the holdout go live unchecked.
98. **x2.** "Not more favourable" holds only if it holds on the trades of every window the recomputed gates use (W_B, W_R, W_P, W_LS). Otherwise the change is a trial inside k.
99. **x3.** A refill block starts after the last change to configKey (a raise, an A1 or A2 change, a code-deploy re-freeze or a `recost`).
100. **Reviewer n1 and n2.** AC-76 states its setup (the key was tightened by A1 before the passing MAXPOS raise, so its old value is not in the new evidence-backed configuration). Add an AC row: an intermediate admission value whose CI lower bound is ≤ 0 raises `admission_not_profitable` where there was no block.

## Round 12 (head `23905ddd`): reviewer PASS (1 optional MINOR); red team 0 BLOCKER, 1 MAJOR, 1 MINOR

- Y1: cost- and fill-model inputs set through config (assumed priority fee, slippage coefficients, sandwich probability, fixed-cost line) take the limit paths A1/A2/A3 from a human-set riskDirection tag, so an optimistic model can freeze through A1 with no k trial, and a more conservative one can be refused at r = 0.
- y1: `applycheck` trials are unlimited and count in the DSR, so system-initiated A1 changes (breakers, demotions) could fail B-3 through housekeeping.
- Reviewer n1: AC-78 should say "that reads W_R".

### Supervisor rulings for round 13 (8 Oct 2026, 3:28 PM)

101. **Y1.** Cost- and fill-model config inputs get their own tag, group M, set in B-M25-01 and enforced by the CI tag test. Their changes never take the limit paths, whatever the key's riskDirection: they follow the "Code deploys" value rule (the four-window SOL test). Not more favourable → `recost` (no k, no r; demote through B-M26-04 if a gate fails). More favourable → a trial inside k, or the fresh-window state at k = 0. A flipped fill or reject outcome → the re-run rule. The operator sees A2 (it changes money state); the server picks the path from the SOL test, never from the class. ACs: (a) lowering an assumed fee in config is more favourable, a k trial, never an A1 re-freeze; (b) raising it at r = 0 is a `recost`, not refused.
102. **y1.** Only operator or owner changes create `applycheck` trials. System-initiated tightenings (breakers, demotions) are not searches and create none. The DSR counts trials by distinct configKey evaluated, so the same value checked twice counts once.
103. **Reviewer n1.** AC-78: "an intermediate value and an A1 change each register one `applycheck` trial when the check reads W_R".

## Round 13 (head `f342b664`): reviewer PASS (2 optional MINOR); red team 0 BLOCKER, 1 MAJOR, 2 MINOR

- Z1: one apply that mixes a group M key with an S or admission key takes the other key's path (A1 re-freeze, or a what-if under the optimistic model), so the M change skips the SOL test.
- z1: a hand-set tag can be wrong, and some keys sit in two groups (a slippage cap is a cap and can flip fills). Reviewer n2 is the same point.
- z2: L125 does not say the A1 apply-time check still runs for system tightenings.
- Reviewer n1: :260 and :682 still say "the group S gate re-run after a model deploy".

### Supervisor rulings for round 14 (8 Oct 2026, 3:30 PM)

104. **Z1.** A diff with a group M key and any other key is refused (`E_MIXED_GROUP_M`); the UI splits it into two submits, the M part first. AC: a diff with MAXPOS (A1) and an assumed fee (M) is refused.
105. **z1 and reviewer n2.** The tag is derived from which modules read the key, using B-M25-01's static key-usage check (if B-M25-01 has none, add it, PROPOSED): read by the cost or fill model → M; read by M21 admission → P (admission); read only by sizing → S. A key read by more than one takes the strictest path (admission > M > S). CI fails when a hand tag disagrees with the derived one. A key that can flip a fill or reject outcome is never S; the slippage caps are named explicitly.
106. **z2.** For a system-initiated tightening the apply-time check still runs and blocks as usual; only the `applycheck` trial is not registered. "System" means the M21 or M26 actor as SPEC-A names it (**VERIFY** the actor names), never an agent or operator session.
107. **Reviewer n1.** :260 and :682 read "the recost or k-trial recomputation after a model change (group M or a model deploy)".

## Round 14 (head `4bf69714`): reviewer PASS (1 optional MINOR); red team 0 BLOCKER, 1 MAJOR, 2 MINOR

- A1: while a group M decision (recost, k trial, B-9) is pending, a second submit (the split-off raise) or a second M change is judged against the unvalidated model, so Z1 returns in two submits, and a chain A→B→C can skip k.
- a1: derived tags miss shared helpers, computed values and dynamic access.
- a2 and reviewer n1: actor types `scheduler`, `cli` and `sentinel` are not placed.
- Verified by both: B-M25-01's static check only checks keys exist; ARCH 5.0a's Actor type includes `risk_engine` and `system`.

### Supervisor rulings for round 15 (8 Oct 2026, 3:34 PM)

108. **A1.** While any `recost`, k or B-9 decision for a strategy is pending, the validator refuses any other change that touches that strategy's configKey (`E_DECISION_PENDING`, PROPOSED). Only A1 tightenings (they apply at once) and a cancel of the pending change are accepted. The SOL test, every what-if and every apply-time check use the last frozen configKey's model, never a pending value. ACs: a raise submitted while a group M k decision is pending is refused with `E_DECISION_PENDING`; an M change C after a pending B is compared with the frozen A.
109. **a1.** Readers are derived by import and call-graph closure (a key belongs to every module that reaches its read site). A lint rule allows config reads only through typed literal accessors, so no computed key names exist. A key whose readers cannot be resolved statically takes P (admission). AC: a key read only through a shared helper called by M21 is derived P.
110. **a2 and reviewer n1.** `scheduler` acts for the submitting actor and is attributed to it; `cli` is an operator or owner change; `sentinel`, `risk_engine` and `system` are system. AC: an A3 raise applied by `scheduler` registers its `whatif` trial against the submitting operator. The actor VERIFY is cleared (ARCH 5.0a, A-M13-07 step 5, B-M26-04 step 5).

## Round 15 (head `664f75e2`): reviewer PASS (no findings); red team 0 BLOCKER, 1 MAJOR, 2 MINOR

- B1: an A1 tightening accepted during a pending decision re-freezes the whole configKey, including the pending, unvalidated group M value.
- b1: a cancel does not say what happens to the value or the trial; a late-registered trial makes cancel a free holdout read.
- b2: a pending decision with no end blocks raises indefinitely.

### Supervisor rulings for round 16 (8 Oct 2026, 3:36 PM)

111. **B1.** During a pending decision, an A1 change applies but does not re-freeze. Its apply-time check runs against the last frozen model with the A1 value. The host stays mismatched (no new emissions, exits kept) until the decision resolves; the outcome then freezes the result with the A1 keys, or reverts the pending value and freezes the last frozen model plus the A1 keys. AC: with a pending M change B, an A1 MAXPOS lowering applies, the frozen configKey still holds A, and a later what-if uses A.
112. **b1.** A cancel reverts the pending value to the last frozen value (the free exact return). The k, `recost` or B-9 trial is registered when the decision starts, before it reads any window, and a cancel keeps it. AC: a cancelled pending M change restores A, and its trial stays in the registry and the DSR count.
113. **b2.** A pending decision older than 24 h raises the same alert chain as a mismatch (24 h, then daily, then a DECISIONS line within 2 days). That DECISIONS entry may only cancel the decision (ruling 112) or complete it, never apply the pending value.

## Round 16 (head `e57e9394`): reviewer PASS (no findings); red team 0 BLOCKER, 0 MAJOR, 2 MINOR

- c1: the configuration frozen when a decision resolves (B with the A1 keys) is never checked as a whole; a conservative B at a lowered size can be net negative.
- c2: with several A1 changes during one decision, each check sees only its own value.
- Nothing at MAJOR remains. After these two, #293 merges on green CI.

### Supervisor rulings for round 17 (8 Oct 2026, 3:38 PM)

114. **c1.** When a decision resolves, re-run the A1 apply-time checks (size table, admission trade set) on the configuration about to be frozen, before emission resumes. If the CI lower bound is ≤ 0 or null, freeze it but raise `size_not_profitable` or `admission_not_profitable` ("No knowingly losing trades"). This is an `applycheck` trial (no k, no r). AC: B a conservative recost plus an A1 MAXPOS lowering during the decision; if B fails at the lowered size, the strategy resumes entry-blocked.
115. **c2.** Each A1 check during a pending decision runs against the last frozen model with every A1 value applied since the decision started. AC: two A1 changes during one decision; the second check sees both.

## Round 17 (head `a6b33d16`): reviewer PASS (no findings); red team 0 BLOCKER, 0 MAJOR, 1 MINOR

- d1: state the way out of a block raised at resolution: the evidence-backed setting is re-confirmed by the decision that freezes a new model, so the free exact return clears the block.

### Supervisor ruling (8 Oct 2026, 3:40 PM)

116. **Done.** No MAJOR remains after 17 rounds. #293 merges on green CI at `a6b33d16`. d1 is carried into card Z-STRAT's acceptance (one clause and one AC: after a B resolution with an entry block, the free return to the evidence-backed MAXPOS clears the block), so no further CI cycle is spent on a one-line clarification.
