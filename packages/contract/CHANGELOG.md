# Changelog

`@bot/contract` follows semantic versioning and is frozen (B-M28-01: "frozen before UI and backend tickets start"; ARCH 18). Any change to `package.json` or `src/` needs a higher version, a section here with both leads' sign-off lines (the UI lead and the backend lead; the policy check reads them as group A and group B), and a re-recorded `FREEZE.json` (`node tools/policy/bin/freeze.ts packages/contract`). `pnpm lint` enforces this against the base branch.

## 1.0.0 — 2026-10-07

Initial freeze (B-M28-01, card C02 in macdarenz-droid/snipe-solana, ported here as card Z02).

- zod 4.6.5 schemas of VM-01..VM-21 as `UI.md` "View-model contract" defines them, with ARCH section 19 applied: UC-01 (VM-06 `exit_reason`, `source`, `shadow`), UC-02 (VM-05 `stops[]`, `targets[]`), UC-03 (risk flag `entry_unconfirmed`), UC-04 (VM-12 `action_on_breach`), UC-05 (`display_unit`, `limit_value_display`), UC-06 (`sentinel`, `cli` actors), UC-07 (VM-03 `exits_only`, `kill.latch_set_by`, `kill.latch_clear_requires`, `signer.lock`, `signer.exit_lease_holder`), UC-09 (VM-18 `ratio`, `strategy_id`, `strategy_stage`, `stage_entered_at`, `trial_key`), UC-12 (VM-21; `sim_clock` null on the live host), UC-13 (VM-04 `token_class`, `reserve` wallets), UC-14 (VM-19 `write_off_position`, `close_unsolicited`, `book_not_flat`), UC-17 (VM-13 `safety[]`, `rpc[].projected_month_end_bps`), UC-18 (no 15 s resolution).
- `SCHEMA_VERSIONS`: VM-01, VM-03, VM-04, VM-05, VM-06, VM-12, VM-13, VM-17, VM-18 and VM-19 at 2; the others at 1 (VM-21 new at 1).
- Shared scalars (`U64Str`, `I64Str`, `LamportsStr`, `I128Str`, `DecimalStr`, `Pubkey`, `Signature`, `Id`, `Mode`, `Commitment`, `Severity`, `ActionClass`, `UntrustedString(maxBytes)` and the unit types of UI convention 4); big-integer strings use the `@bot/types` codecs.
- Fixtures for every VM (`@bot/contract/fixtures`): happy, empty, nulls, and where the VM has such fields maximum-length untrusted strings, u64 maximum values, negative PnL, simulated and live.
- Envelope checks (Z02 round 2 ruling 5, before the first tag, so the version stays 1.0.0 and the sign-offs below cover this content): `VM01Envelope` requires `schema_version` to equal `SCHEMA_VERSIONS[vm]` except on `incompatible`; `parseEnvelope` checks `data` against the VM's payload (`snapshot`, `replace`), the collection VM's entity in `VM_ENTITY_SCHEMAS` (`upsert`, with its `key`), or an empty object (`remove`, `heartbeat`, `reset`, `incompatible`). A malformed amount in a VM-06 trade is reported as an issue of its field instead of throwing from the cost invariant.
- Decisions where `UI.md` leaves a choice (see the C02 pull request, snipe-solana #5, and the Z02 pull request): `schema_version` in every top-level payload; collection snapshots of VM-05 and VM-07 as `{ items }`, of VM-16 and VM-17 as `{ items, next_cursor }`; VM-02 `preferences.shortcuts` as `{ mode, remap }` and `default_route` from ARCH 15; VM-13 `clock.ntp_offset_ms` signed; VM-12 `limits[].limit_value`, `usage_value` and `hard_ceiling` accept a `U64Str` or an `I64Str` (UI.md "`U64Str` or integer as string"; `limit_def.value` is a signed i64).

Sign-off (group A lead): pending (the UI lead's sign-off is the owner's to record)
Sign-off (group B lead): pending (the backend lead's sign-off is the owner's to record)
