# Kill-and-resume proof

Run on 2026-10-03 with scanner revision 7fa3d65 plus the `-slots` test filter (committed after it). Three units of epoch 1047 were scanned with `-parallel 2` into an empty directory. The run was sent SIGTERM as soon as the first unit finished: at that moment one unit was mid-scan (left as `.tmp`) and one had just started. The same command was then run again. The resumed run skipped the finished unit and redid the other two from scratch.

Every data file of the three units was then compared, decompressed, with the same units from the main scan. Those were scanned without interruption by the earlier index-based build (revision e9fddcb). All 18 files are identical (sha256 of the decompressed content).

## Log

```
== start 13:56:39
2026/10/03 13:56:44 plan: 3 units, 0 already done, 3 to scan
2026/10/03 13:59:11 unit 1047 452704500-452708999 ok: blocks=4500/4500 curve=27347 amm=61936 other=2998 decodeFail=0 147s | 1/3 done, eta 5m0s
2026/10/03 13:59:11 unit 1047 452700000-452704499 FAILED: context canceled
2026/10/03 13:59:12 unit 1047 452709000-452713499 FAILED: context canceled
2026/10/03 13:59:12 run finished: 1 done, 2 failed, interrupted=true
== killed 13:59:12 exit=0; state:
452704500-452708999
452709000-452713499.tmp
== resume 13:59:12
2026/10/03 13:59:16 plan: 3 units, 1 already done, 2 to scan
2026/10/03 14:01:28 unit 1047 452700000-452704499 ok: blocks=4493/4493 curve=25098 amm=59847 other=3176 decodeFail=0 132s | 1/2 done, eta 2m0s
2026/10/03 14:01:43 unit 1047 452709000-452713499 ok: blocks=4496/4496 curve=17138 amm=64009 other=3543 decodeFail=0 147s | 2/2 done, eta 0s
2026/10/03 14:01:43 run finished: 2 done, 0 failed, interrupted=false
== resumed run exit=0 14:01:43
```

## Comparison (unit, file, first 16 hex of sha256, result)

```
452700000-452704499 curve_trades ddb8b6ef03080dda identical
452700000-452704499 amm_trades 21e3419a58e97a98 identical
452700000-452704499 events af4ca517318374a6 identical
452700000-452704499 failed 1bc603bff8135ca9 identical
452700000-452704499 agg_hourly 1a5e46e9f14a33fc identical
452700000-452704499 blocks 74880a28cc516150 identical
452704500-452708999 curve_trades 036884d239911fc3 identical
452704500-452708999 amm_trades 2b2ed50841319ede identical
452704500-452708999 events 29ae36eea5025b93 identical
452704500-452708999 failed 5f0516e0506cc5d2 identical
452704500-452708999 agg_hourly ee1ae63eca3888d6 identical
452704500-452708999 blocks 2c49235ad9f4cf9e identical
452709000-452713499 curve_trades b3be29dc3fb066e5 identical
452709000-452713499 amm_trades 23fbfc043ba7ae6f identical
452709000-452713499 events 057aca41f96f80df identical
452709000-452713499 failed 24367824d3935c4e identical
452709000-452713499 agg_hourly 9eb479d17b4e1ef3 identical
452709000-452713499 blocks 07aafd47f8b04932 identical
```
