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
