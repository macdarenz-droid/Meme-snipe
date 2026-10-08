# Rent rate boundary on 2026-09-03 (D1, G1, H1-CGO, W1)

Design owner's ruling (brainstorm partner), 2026-10-09 00:53 Melbourne, answering the code red team's Q-R2-b.

- **The rate 6,333 lamports a byte starts at the first slot of epoch 1028: slot 444,096,000, block time 2026-09-03 23:24:41 UTC.**
  - Checked by one public RPC call, `getBlockTime(444096000)` = 1788477881.
  - Epoch 1029 starts at slot 444,528,000, block time 2026-09-05 13:13:41 UTC.
- Why:
  - Solana activates features at epoch boundaries.
  - `docs/research/execution.md` dates the change to 2026-09-03, and epoch 1028 is the epoch that starts that day.
  - It is also the conservative reading: it keeps the higher 6,960 rate about 23 hours longer than a 00:00 UTC switch.
- Which epoch the feature activated in was not read from the chain; the date and the boundary rule fix it. The rate 5,080 starts at epoch 1033 (slot 446,256,000), as before.
- D1 and W1 switch at this slot, like G1 and H1-CGO.
