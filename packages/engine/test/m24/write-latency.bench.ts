// Write-latency benchmark for the CA-33 spike (B-M24-01 logic 1): p50, p95 and p99 of a 10-row transaction (one
// state row plus outbox-sized rows) with the production PRAGMAs (WAL, synchronous=FULL). Run it on the target host:
//   node packages/engine/test/m24/write-latency.bench.ts <data dir>/bench.db 2000
// It prints one JSON line and deletes its database. The D06 switch trigger is a write p99 above 20 ms (ARCH 6).
import { rmSync } from 'node:fs';
import { openDb } from '../../src/m24/db.ts';
import { schemaTx } from '../../src/m24/schema-tx.ts';

export interface LatencyResult { transactions: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }

function at(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

/** Runs `n` transactions of 10 inserts each against a fresh database at `path`; returns the latency quantiles. */
export function measureWriteLatency(path: string, n: number): LatencyResult {
  let tick = 0;
  const db = openDb({ create: true, path, clock: { kind: 'sim', nowMs: () => tick++ } });
  schemaTx(db, (tx) => tx.run('CREATE TABLE bench (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL)'));
  const samples: number[] = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    const started = process.hrtime.bigint();
    db.withTx((tx) => {
      for (let r = 0; r < 10; r++) tx.run('INSERT INTO bench (id, a, b, c) VALUES (?, ?, ?, ?)', ++id, 1_000_000_000n + BigInt(id), 'x'.repeat(64), '{"k":"v"}');
    });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  db.close();
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return { transactions: n, p50Ms: round(at(sorted, 0.5)), p95Ms: round(at(sorted, 0.95)), p99Ms: round(at(sorted, 0.99)), maxMs: round(sorted[sorted.length - 1] as number) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path = 'bench.db', n = '2000'] = process.argv.slice(2);
  console.log(JSON.stringify({ node: process.version, ...measureWriteLatency(path, Number(n)) }));
}
