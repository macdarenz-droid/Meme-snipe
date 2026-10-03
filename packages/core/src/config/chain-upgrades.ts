// Chain facts the gates compare against (not limits). UPG-1, docs/research/venues.md §2.7: the unannounced
// 2026-10-02 upgrade appends 8 undocumented bytes to pump TradeEvent and PumpSwap BuyEvent/SellEvent from these slots
// (the upgrade transactions' own slots).
export const EVENT_TAIL_UPGRADE_SLOT = { pump_amm: 452_654_882n, pump: 452_654_932n } as const;
/** Bytes appended after the boundary. */
export const EVENT_TAIL_BYTES = 8;
