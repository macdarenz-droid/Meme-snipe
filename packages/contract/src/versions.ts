// View-model IDs and schema versions (B-M28-01 logic 2-3; UI convention 9; INTEGRATION.md: "the version numbers are
// not enumerated in either spec", so they are set here). A VM changed by ARCH section 19 (UC-01..UC-21) is at version
// 2; an unchanged VM stays at 1; VM-21 is new (UC-12) at 1. The UI declares the versions it supports in VM-01
// `ui_supported`; the server sends `incompatible` on a mismatch.
export const VM_IDS = ['VM-01', 'VM-02', 'VM-03', 'VM-04', 'VM-05', 'VM-06', 'VM-07', 'VM-08', 'VM-09', 'VM-10', 'VM-11', 'VM-12', 'VM-13', 'VM-14',
  'VM-15', 'VM-16', 'VM-17', 'VM-18', 'VM-19', 'VM-20', 'VM-21'] as const;
export type VmId = (typeof VM_IDS)[number];

export const SCHEMA_VERSIONS = {
  'VM-01': 2, // logic 3: `vm` extends to VM-21
  'VM-02': 1,
  'VM-03': 2, // UC-06 actor types; UC-07 exits_only, kill.latch_set_by, kill.latch_clear_requires, signer.*; UC-12 sim_clock null on the live host
  'VM-04': 2, // UC-13 tokens[].token_class, role = reserve wallets
  'VM-05': 2, // UC-02 stops[] and targets[] replace stop and target; UC-03 risk flag entry_unconfirmed
  'VM-06': 2, // UC-01 exit_reason enum, source, shadow
  'VM-07': 1, // UC-10: no change
  'VM-08': 1,
  'VM-09': 1, // UC-19: no field change
  'VM-10': 1, // UC-18: no field change
  'VM-11': 1,
  'VM-12': 2, // UC-04 action_on_breach; UC-05 display_unit, limit_value_display
  'VM-13': 2, // UC-17 safety[], rpc[].projected_month_end_bps
  'VM-14': 1,
  'VM-15': 1, // UC-15: copy only
  'VM-16': 1,
  'VM-17': 2, // UC-06 actor types sentinel and cli
  'VM-18': 2, // UC-09 unit ratio, strategy_id, strategy_stage, stage_entered_at, trial_key
  'VM-19': 2, // UC-14 write_off_position, close_unsolicited; blocking reason book_not_flat
  'VM-20': 1,
  'VM-21': 1, // UC-12: new
} as const satisfies Record<VmId, number>;
