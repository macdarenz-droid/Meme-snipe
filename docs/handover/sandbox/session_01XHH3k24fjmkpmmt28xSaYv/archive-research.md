Archive research (03:10 UTC, for the 05:15 report)

1. Documented limits
- docs.old-faithful.net (OF1 page, sourcing-data page, root) and the rpcpool/yellowstone-faithful README state no rate, bandwidth or concurrency limit and no fair-use policy.
- Facts they do state:
  - files.old-faithful.net is "a full copy" hosted by Triton, with servers in Amsterdam;
  - "download using servers nearby for best throughput";
  - the only access requirement is HTTP range support;
  - each CAR and its indexes are delivered "within 4 epochs of the epoch closing".
- Contacts:
  - GitHub issues on rpcpool/yellowstone-faithful;
  - the Triton One Telegram group https://t.me/+K0ONdq7fE4s0Mjdl;
  - lk@triton.one (README: for warehouse node operators).
- Our reader against the docs:
  - range GETs (archive.go:200);
  - User-Agent zeroed-historical-scanner/2 with a repo URL (archive.go:84);
  - HTTP/1.1 keep-alive reuse, with idle connections up to 256 per host and one connection per parallel chunk.
  - None of this conflicts with any documented rule. The run-1 429 hit the first request after each 1 h pause, so the request pattern cannot be the cause there.
2. Alternatives
- The CAR-REPORT (gha-report branch) lists only files.old-faithful.net URLs. It has no Filecoin column, so whether epochs 1025-1047 are on Filecoin is unverified.
- The Filecoin docs page describes uploading only and gives no availability status.
- The README says Triton "can provide you with access to a storage bucket" for bulk transfer (on request).
- The docs list no public hosted Old Faithful RPC or gRPC endpoint.
- Public mainnet RPC (getBlock, free). Documented limits (solana.com/docs/references/clusters):
  - 100 requests per 10 s per IP, and 40 per 10 s for a single method;
  - 40 connections per IP, and 100 MB per 30 s (~3.3 MB/s).
  - At 4 getBlock calls a second, ~216k blocks a day take ~15 h per day of data, so 64 days take ~40 days. Not viable as the main path. It is the documented free fallback.
