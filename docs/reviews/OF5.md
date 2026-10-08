# OF-5 completion from zeroed-data: review log

Card: `docs/MIGRATION.md` Card Z-H, OF-5 bullet. Builder: data builder `session_01SP5ftusK23iJPxYXEMY9y7`. PR #316 (draft, stacked on #315), branch `claude/of5-completion`. Reviewer `session_01DK9TU4gHh9V1Accrv4yuPY` and red team `session_01Uoe1pFxvHNzq9yCieDicqQ`.

## Round 1 (head `5478dd5b`, diffed against `93140d9d`)

- Builder: test-ci 272/0; three new blocks fail on `93140d9d`; label `deps-reviewed:bc841e4826f1629ae9e4f116b7b0d717`.
- Red team: PASS, 0 BLOCKER, 0 MAJOR, 2 MINOR. No day is read twice; D+1 waits for D; the prior list is checked by name and sha256; the store token stays in the clean prior step.

### Supervisor rulings for round 2 (9 Oct about 10:05 AM; the reviewer's verdict is folded in when it arrives)

1. **Red team m1, required.** "Done" is judged from tag and asset names only, so a release whose content read-back failed still counts as done. After read-back passes, the store writes a final `readback-ok` marker asset (listed after SHA256SUMS, itself read back), and `--check`, `ag_read_done` and `ag_b10_done` count only releases that carry it. A release without it stops the chain for review and is never re-read automatically. Test: a release with complete names and one wrong byte is not done.
2. **Red team m2, required.** `ag_b10_done` judges B-10 done from the release's recorded retention (every `units-D.log` line K3 with the list sha256), not from the tag name. Test: 07-22 stored at K3 under the plain tag counts as B-10 done.
