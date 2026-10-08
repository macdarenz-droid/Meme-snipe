# Step A count rows, amendment 5: MIG-SEAT and MAYHEM-SNAP rows (counts only)

Brainstorm partner, 2026-10-08, before any Step A row is read. From sweep 5 (`SWEEP_5.md`). These rows read counts, flows, timing and auction prices only: no price path after an entry slot and no wallet P&L. An idea earns a PREREG only if all its rows pass. Chances are judgement.

## MIG-SEAT: a mid-speed seat at pool open (about 0.5%)
- s0 = the slot of the transaction that emits `CreatePoolEvent` for a standard SOL graduation. Windows are counted in slots and also reported in seconds per day; slot time is never assumed.
- "Non-linked" = signer and user outside the creator group (LAUNCHER-ID set plus W links of 2 hops or fewer), and the row is not BOOST, buyback or mayhem.
- The primary group is gradual launches (create to complete in more than 5 s). Instant launches are reported as a separate arm.
- Rows, with thresholds:
  - **G1 seat open:** at least 50% of graduations have at least 1 non-linked buy in s0..s0+2, and the median number of distinct non-linked buyers there is at least 2.
  - **G2 seat toll:** the median of (`jito_tip` + `tx_fee`) on those buys is at most 0.005 SOL. `tx_fee` is the transaction's whole fee, already including the priority fee, so `cu_price × cu` is not added. Run on v2 and later units only, with coverage reported.
  - **G3 racers:** the median number of failed pool transactions (slippage and state classes) in s0..s0+3 is at most 10 per graduation.
  - **G4 seller timing:** creator-group sells reach 5% of supply before s0 + 2 + 60 s in at most 50% of graduations.
  - **G5 payer mass:** the median of BOOST quote used plus non-linked buy SOL in (s0+2, s0+2+60 s] is at least 2X*, with X* = Q(√(1+c) − 1), about 1.47 SOL at Q = 85 and c = 3.5%. Its day-clustered 95% lower bound must be at least X*.
  - **G6 BOOST realisation:** the median BOOST used ÷ requested within 300 s is at least 0.8.
  - **G7 count:** at least 100 eligible graduations a day.
  - **G8 regime:** no `PostCompleteBuyEvent` on tape days. Running it needs the v3 IDL items in the decoder first; until then it reads "not checkable".
  - **Kill row:** if at least 2/3 of first-minute non-linked buy SOL lands in s0..s0+1 (ahead of any seat we could buy), MIG-SEAT closes.
- Reported with no threshold: rank against tip within s0..s0+2; the share of migrate transactions bundled with a non-creator buy; the instant/gradual split.
- What live use would need from the owner: H8, H10 and the first-block rule lifted for it; a seat of about US$509 a month (proposer's reading of Helius pricing, not re-checked); a tip route in the signer; about 20 trades a day at $100 or more; Australian legality (UNVERIFIED).

## MAYHEM-SNAP: back-run the mayhem program's synthetic re-prices (about 0.2%)
- Step j = (new vSOL ÷ new vToken) ÷ (old vSOL ÷ old vToken) − 1, from `UpdateMayhemVirtualParamsEvent` rows.
- Rows, with thresholds:
  - **(a) attribution:** at least 95% of re-price rows come from transactions that invoke the mayhem program;
  - **(b) mechanism:** among down steps with j ≤ −6.2%, at least 60% are followed within 120 s by an up step of at least |j|/2 on the same mint, with a mint-clustered 95% lower bound above 50%. Up steps are the placebo, and down steps caused by non-agent sells of similar size are a second placebo;
  - **(c) seat need:** median time from a qualifying down step to that up step, and the share with a non-agent buy in the same slot;
  - **(d) exit depth:** at the up step, real SOL is at least twice a $100 position's proceeds in at least 90% of cases;
  - **(e) count:** at least 100 qualifying down steps a day on SOL mayhem curves with at least 5 real SOL.
- First, write down the re-price rule from the events. If it is deterministic, any later test is of that mechanical rule, not a statistical bounce.
- Before any primary day is named, the owner and a legal check must rule on whether trading on a protocol's re-price is fair or exploits a fault.
