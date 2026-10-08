# D1 amendment 4: H13 on the tape, and the universe-exit secondary

Design owner's rulings (brainstorm partner), 2026-10-09, before D1 reads any Step A row for scoring. They answer items 37 and 38 of `research/d1-discovery-funnel/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co.

## 37: H13 by a tape proxy, labelled
- D1 has a 0-credit cap, so the bot's funder reads (each wallet's first-ever funding) are not supplied.
- H13 is computed by a tape proxy, only for coins whose CreateEvent is on the tape. The bot's thresholds apply: insider supply above 15% of circulating, or the dev's linked cluster above 5%. Insiders are:
  - the dev (CreateEvent `creator` and `user`);
  - creation-slot curve buyers, keyed on the curve `user` as the bot does, with `user_token_owner` as the fallback;
  - wallets linked to the dev by a W or T transfer on the tape on or before the decision slot (hub cap 50, the same rule as elsewhere).
- Coins created before the tape stay "H13 unknown" and out of the tradable subset (conservative).
- The proxy can only miss links made before the tape, so it can pass coins the live H13 would reject. Every tradable result is labelled "H8-tradable by tape proxy for H13". The forward confirmation, run by the recorder with real funder reads, decides tradability.
- `unknown_share` is still reported.

## 38: the universe-exit secondary is dropped
- D1's rules define no structure stop, so building the universe exits would invent one.
- That secondary is removed. D1's frozen exits (15- and 60-minute holds) are the only ones. No judgement changes.
