// Benchmark guard (B-M24-01 tests): 10-row transactions with the production PRAGMAs. The D06 trigger (p99 > 20 ms for
// 24 h, ARCH 6) is watched in production by db_write_latency_ms; this test only catches a gross regression (for
// example a commit per row) on any CI machine, and prints the measured quantiles into the test log.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { tempDir } from '../helpers.ts';
import { measureWriteLatency } from './write-latency.bench.ts';

describe('write latency of a 10-row transaction (CA-33 spike)', () => {
  it('stays far below a gross-regression bound and reports its quantiles', () => {
    const r = measureWriteLatency(join(tempDir('bench'), 'bench.db'), 500);
    console.log(JSON.stringify(r));
    assert.equal(r.transactions, 500);
    assert.ok(r.p50Ms <= r.p95Ms && r.p95Ms <= r.p99Ms && r.p99Ms <= r.maxMs);
    assert.ok(r.p99Ms < 250, `p99 ${r.p99Ms} ms`);
  });
});
