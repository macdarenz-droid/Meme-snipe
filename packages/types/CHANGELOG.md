# Changelog

`@bot/types` follows semantic versioning and is frozen (ARCH 18; B-M19-01 logic 2). Any change to `package.json`, `src/` or the tsconfig files it compiles with (`tsconfig.json` and the shared `tsconfig.bot.json` it extends) needs a higher version, a section here with both group leads' sign-off lines, and a re-recorded `FREEZE.json` (`node tools/policy/bin/freeze.ts packages/types`). `pnpm lint` enforces this against the base branch.

## 1.0.0 — 2026-10-06

Initial freeze (B-M19-01, card C01).

- ARCH 5.0 shared types and ARCH 5.0a contract types.
- Execution contract: M18 `AttemptStatus`, `AttemptResult`; M19 `OrderIntent`, `AttemptRequest`, `AttemptHandle`, `FillRecord`; M20 `ExitReason` with `EXIT_REASONS`.
- Clarifications: CL-04 (`LandingPath` gains `jupiter_execute`), CL-27 and C-29 (`AttemptState`; one `ExecutionPort` with `onResult` and `onNotLanded`), CL-28 (`RungParams`, `ExitLadder`).
- Types the contract references, owned by other modules and copied verbatim: `VenueId`, `FeeSchedule`, `Quote` (M01), `DecodedEvent` (M02), `Features` with `dumpFlagState` (M08, ARCH 5.0b I-26), `UnsignedTx` (M16).
- `canonicalJson` and `priorityFeeLamports` (ARCH 5.0b I-19); unit guards; `U64Str`, `I64Str` and `I128Str` codecs.
- Unit types carry a compile-time unit tag (recorded in ARCH 5.0b I-29): a `Slot` is not accepted as `Lamports`; plain `bigint` and `number` values still are.
- `canonicalJson` throws on symbol keys, accessor (getter or setter) properties, non-enumerable properties, array properties that are not indexes, and Array subclasses, instead of dropping them or calling getters (C01 red-team finding m6, before the first tag; 1.0.0 is not yet tagged, so the version stays 1.0.0 and the sign-offs below cover this content).
- `canonicalJson` reads each property through its own descriptor instead of copying every descriptor at once, reads a plain array index by index, and spells out a path only when it is needed: same output and errors, about 3.7 times faster on a 1M-element array and 1.8 times on 200k small objects (Node 22.23.2) (C01 review finding R7, before the first tag).

Sign-off (group A lead): owner, approved 2026-10-06 after the spec review and red-team pass on 9f5bc89; acknowledges CL-04, CL-27 and CL-28
Sign-off (group B lead): owner, approved 2026-10-06 after the spec review and red-team pass on 9f5bc89
