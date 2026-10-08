# SOL/USD for the tape days (Binance public archive)

SOLUSDT spot klines, 1-hour and 1-minute, one file per day for 2026-09-02..2026-09-11 only. Downloaded 2026-10-08 from `https://data.binance.vision/data/spot/daily/klines/SOLUSDT/<1h|1m>/SOLUSDT-<1h|1m>-2026-09-DD.zip`. Each file was checked against Binance's `.CHECKSUM` (20 of 20 matched). `SHA256SUMS` lists every file.

No day from U1-B's holdout (09-12..09-21) or the sealed window was downloaded. These are public market data: no keys and no personal data. The partner did not open the files. They are inputs for the H8 stratum (D1, H1-CGO, count rows) and the count rows' round-USD check.
