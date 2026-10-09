# OF-5 completion from zeroed-data: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-5 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`. PR #316 (draft, stacked on #315), branch `claude/of5-completion`. Reviewer `session_01DK9TU4gHh9V1Accrv4yuPY` and red team `session_01Uoe1pFxvHNzq9yCieDicqQ`.

## Round 1 (head `5478dd5b`, diffed against `93140d9d`)

- Builder: test-ci 272/0; three new blocks fail on `93140d9d`; label `deps-reviewed:bc841e4826f1629ae9e4f116b7b0d717`.
- Red team: PASS, 0 BLOCKER, 0 MAJOR, 2 MINOR. No day is read twice; D+1 waits for D; the prior list is checked by name and sha256; the store token stays in the clean prior step.

### Supervisor rulings for round 2 (9 Oct about 10:05 AM; the reviewer's verdict is folded in when it arrives)

1. **Red team m1, required.** "Done" is judged from tag and asset names only, so a release whose content read-back failed still counts as done. After read-back passes, the store writes a final `readback-ok` marker asset (listed after SHA256SUMS, itself read back), and `--check`, `ag_read_done` and `ag_b10_done` count only releases that carry it. A release without it stops the chain for review and is never re-read automatically. Test: a release with complete names and one wrong byte is not done.
2. **Red team m2, required.** `ag_b10_done` judges B-10 done from the release's recorded retention (every `units-D.log` line K3 with the list sha256), not from the tag name. Test: 07-22 stored at K3 under the plain tag counts as B-10 done.
- Reviewer (round 1, `5478dd5b`): PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR. The card points are met; test-ci 272/0; the three new blocks fail on `93140d9d`; label matches.
3. **Reviewer MINOR (9 Oct about 10:33 AM), folded into ruling 1.** `ag_read_done` and `ag_b10_done` count a tag without a complete release. Under ruling 1 all three predicates require `release_state` complete and the `readback-ok` marker. Test: a tagged release with one asset not uploaded is not done.

## Round 2 (head `1af47fd6`, contains OF-4 `ab2c9b87`)

- Builder: rulings 1–3 built; test-ci 275/0; the new tests fail on `5478dd5b`; label unchanged.
4. **Builder's note, ruled (9 Oct about 10:55 AM), required.** `assemble.sh --download` reads `data-day-D` without the `readback-ok` check. It uses the shared `release-state.sh` and accepts only "done" releases (complete and marked); anything else stops for review. Test: a complete but unmarked day is refused before any download.
5. **From OF4.md 14, required here.** The storage check runs whenever the day was stored, also when a later step failed (`!cancelled()` and the stored output). Test it.
- Round 2 delta red team (`5c6f1ff2`): PASS, 0 BLOCKER, 0 MAJOR, 1 MINOR; test-ci 277/0. m1 and m2 closed; markers cannot be forged or reused across days or SUMS; b10-done and assemble hold; the storage check covers a failed store and a failed volume step. MINOR m1 goes to OF-6 (OF6.md ruling 5).
- Round 2 delta review (`5c6f1ff2`): PASS, 0/0/0. Rulings 1–5 met; with the round 2 files set back, 8 rows fail; label matches. The changed lead-in test still checks what matters (lead-in days fetch only `events-D.tar`, window days their parts, the manifest is built).
- **#316 approved at `5c6f1ff2`** (9 Oct about 11:53 AM). Next: merge base `f3ac2a35`, read the guarded diff, label after the head, CI, merge.
