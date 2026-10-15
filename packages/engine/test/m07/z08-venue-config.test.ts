// Card Z08: the PumpSwap GlobalConfig and the FeeConfigs recorded at start and every 10 minutes (supervisor,
// 2026-10-07), from the Z07 cache's own reads (no extra read), on the never-dropped `venue_config` stream. Uses the
// 2026-10-06 mainnet config fixtures of card Z07.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { UnixMs } from '@bot/types';
import { readFileSync } from 'node:fs';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { Pubkey, Slot } from '@bot/types';
import { createVenueConfigCache } from '@bot/venue';
import { ACCOUNTS, PROGRAMS } from '@bot/venue/constants';
import { recordVenueConfig, SNAPSHOT_EVERY_MS, type VenueConfigRecord } from '../../src/m07/venue-config.ts';
import { PROTECTED_STREAMS } from '../../src/recorder/streams.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';

// The 2026-10-06 mainnet config accounts (fixtures/mainnet/config, card Z07), read as files.
const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
type Fixture = { accounts: Array<{ owner: string; data_base64: string; context_slot: number }> };
const raw = (name: string) => {
  const a = (JSON.parse(readFileSync(new URL(`../../../../fixtures/mainnet/config/${name}.json`, import.meta.url), 'utf8')) as Fixture).accounts[0] as Fixture['accounts'][number];
  return { owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')), slot: a.context_slot };
};
const ORDER = ['fee_config_curve', 'fee_config_pumpswap', 'pumpswap_global_config', 'pump_global'].map(raw);
const CONFIG_ACCOUNTS: Pubkey[] = [ACCOUNTS.feeConfigCurve, ACCOUNTS.feeConfigPumpSwap, ACCOUNTS.pumpSwapGlobalConfig, ACCOUNTS.pumpGlobal];
function fakeReader() {
  const r = {
    fail: false, reads: 0, accounts: ORDER.map((a) => ({ owner: a.owner, data: a.data }) as { owner: string; data: Uint8Array } | null),
    async read(keys: readonly Pubkey[]) {
      r.reads += 1;
      assert.deepEqual(keys, CONFIG_ACCOUNTS);
      if (r.fail) return { ok: false as const, error: { code: 'E_TIMEOUT' } };
      return { ok: true as const, value: { contextSlot: BigInt((ORDER[1] as { slot: number }).slot) as Slot, accounts: r.accounts } };
    },
  };
  return r;
}
const fakeClock = () => { const c = { t: 1_790_000_000_000, kind: 'sim' as const, nowMs: () => c.t as UnixMs }; return c; };
const log = { event: () => undefined };

describe('card Z08 venue config recording', () => {
  it('a snapshot of all four config accounts after the first good refresh and every 10 min; a change and a decode failure are recorded; no extra read', async () => {
    const reader = fakeReader();
    const clock = fakeClock();
    const cache = createVenueConfigCache({ reader, decoder: decoders, clock, log });
    const out: VenueConfigRecord[] = [];
    const q = new RecorderQueue();
    const rec = recordVenueConfig({ cache, accounts: CONFIG_ACCOUNTS, nowMs: () => clock.t as UnixMs, append: (r) => { out.push(r); assert.equal(q.append(r), 'queued'); } });
    rec.tick(clock.t as UnixMs);                                         // nothing cached yet: nothing written
    assert.equal(out.length, 0);
    reader.fail = true;
    await cache.refresh();
    assert.equal(out.length, 0);
    reader.fail = false;
    await cache.refresh();
    const first = out.filter((r) => (r.payload as { kind: string }).kind === 'snapshot');
    assert.deepEqual(first.map((r) => (r.payload as { name: string }).name).sort(), ['feeConfigCurve', 'feeConfigPumpSwap', 'pumpGlobal', 'pumpSwapGlobalConfig']);
    assert.ok(first.every((r) => r.stream === 'venue_config' && r.slot !== null && typeof (r.payload as { configHash: string }).configHash === 'string'));
    assert.ok(PROTECTED_STREAMS.has('venue_config'));
    const n = out.length;
    rec.tick((clock.t + SNAPSHOT_EVERY_MS - 1) as UnixMs);
    assert.equal(out.length, n);
    rec.tick((clock.t + SNAPSHOT_EVERY_MS) as UnixMs);
    assert.equal(out.length, n + 4);
    // A change of the PumpSwap FeeConfig's bytes is recorded with the previous hash.
    const changed = reader.accounts.slice();
    const fc = changed[1] as { owner: string; data: Uint8Array };
    const data = new Uint8Array(fc.data);
    data[data.length - 1] = (data[data.length - 1] as number) ^ 1;
    reader.accounts[1] = { owner: fc.owner, data } as never;
    await cache.refresh();
    const c = out.filter((r) => (r.payload as { kind: string }).kind === 'changed' && (r.payload as { previousHash: string | null }).previousHash !== null);
    assert.ok(c.some((r) => (r.payload as { name: string }).name === 'feeConfigPumpSwap'));
    // An undecodable GlobalConfig is recorded as a decode failure.
    reader.accounts[2] = { owner: (reader.accounts[2] as { owner: string }).owner, data: new Uint8Array(3) } as never;
    await cache.refresh();
    assert.ok(out.some((r) => (r.payload as { kind: string; name?: string }).kind === 'decode_failed'));
    assert.equal(reader.reads, 4);                                       // only the cache's own refreshes read the chain
    const before = out.length;
    rec.tick((clock.t - 1) as UnixMs);                                   // a clock step back writes a fresh snapshot
    assert.ok(out.length > before);
    rec.stop();
    await cache.refresh();
    const after = out.length;
    reader.accounts[1] = { owner: fc.owner, data: fc.data } as never;
    await cache.refresh();
    assert.equal(out.length, after);                                      // stopped: no more records
    assert.equal(q.take(10_000, 's').length, out.length);                // every record serialised and queued
  });
});
