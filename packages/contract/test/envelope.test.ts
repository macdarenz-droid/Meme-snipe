// VM-01 envelope checks (Z02 round 2 ruling 5): `schema_version` is the VM's current version, and `parseEnvelope`
// checks `data` against the VM's payload or entity schema for the event's kind.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { parseEnvelope, SCHEMA_VERSIONS, VM01Envelope, type VmId } from '@bot/contract';
import { ENTITY_FIXTURES, FIXTURES } from '@bot/contract/fixtures';

const clone = <T>(v: T): T => structuredClone(v);
const heartbeat = (): Record<string, unknown> => clone(FIXTURES['VM-01'].happy) as Record<string, unknown>;
/** A non-heartbeat envelope of `vm` around `data`. */
function event(vm: VmId, kind: string, data: unknown, key: string | null = null): Record<string, unknown> {
  const { server_time: _s, state_version: _v, topics: _t, ui_supported: _u, ...base } = heartbeat();
  return { ...base, vm, schema_version: SCHEMA_VERSIONS[vm], kind, key, data };
}
const issues = (raw: unknown): string[] => { const r = parseEnvelope(raw); return r.ok ? [] : r.issues; };

describe('VM-01 envelope (ruling 5)', () => {
  it('accepts every VM snapshot fixture, an entity upsert, a remove with its key, a heartbeat, a reset and an incompatible', () => {
    for (const vm of Object.keys(SCHEMA_VERSIONS) as VmId[]) {
      if (vm === 'VM-01') continue;
      assert.deepEqual(issues(event(vm, 'snapshot', FIXTURES[vm].happy)), [], vm);
    }
    for (const [vm, entity] of Object.entries(ENTITY_FIXTURES) as Array<[VmId, unknown]>) assert.deepEqual(issues(event(vm, 'upsert', entity, 'k1')), [], vm);
    assert.deepEqual(issues(event('VM-05', 'remove', {}, 'k1')), []);
    assert.deepEqual(issues(heartbeat()), []);
    assert.deepEqual(issues(event('VM-03', 'reset', {})), []);
    assert.deepEqual(issues({ ...event('VM-05', 'incompatible', {}), schema_version: 1 }), []);   // the one kind that reports a mismatch
  });

  it('refuses a wrong schema_version for the VM, also in VM01Envelope itself', () => {
    const wrong = { ...event('VM-05', 'snapshot', FIXTURES['VM-05'].happy), schema_version: 1 };
    assert.equal(VM01Envelope.safeParse(wrong).success, false);
    assert.match(issues(wrong).join(), /schema_version: VM-05 is at version 2/);
    assert.match(issues({ ...heartbeat(), schema_version: 1 }).join(), /schema_version/);
  });

  it('refuses malformed money and unknown fields in the payload and in an upserted entity', () => {
    const journal = clone(FIXTURES['VM-06'].happy) as { items: Array<Record<string, unknown>> };
    (journal.items[0] as Record<string, unknown>).gross_pnl_lamports = '1.5';
    assert.match(issues(event('VM-06', 'snapshot', journal)).join(), /^data\.items\.0\.gross_pnl_lamports/);
    assert.match(issues(event('VM-06', 'upsert', { ...(clone(ENTITY_FIXTURES['VM-06']) as Record<string, unknown>), gross_pnl_lamports: 12 }, 'k')).join(), /^data\.gross_pnl_lamports/);
    const positions = clone(FIXTURES['VM-05'].happy) as { items: Array<Record<string, unknown>> };
    (positions.items[0] as Record<string, unknown>).size_base = '18446744073709551616';     // one past u64
    assert.match(issues(event('VM-05', 'snapshot', positions)).join(), /size_base/);
    assert.match(issues(event('VM-03', 'replace', { ...(clone(FIXTURES['VM-03'].happy) as Record<string, unknown>), extra: 1 })).join(), /^data/);
  });

  it('refuses data that does not fit the kind', () => {
    assert.match(issues(event('VM-03', 'upsert', FIXTURES['VM-03'].happy, 'k')).join(), /needs a collection VM/);
    assert.match(issues(event('VM-05', 'upsert', ENTITY_FIXTURES['VM-05'])).join(), /key: required/);
    assert.match(issues(event('VM-05', 'remove', { position_id: 'x' }, 'k')).join(), /^data/);
    assert.match(issues(event('VM-01', 'snapshot', {})).join(), /no payload of its own/);
    assert.match(issues(event('VM-03', 'heartbeat', {})).join(), /heartbeat|only on a heartbeat|required on a heartbeat/);
    assert.match(issues(event('VM-03', 'reset', { a: 1 })).join(), /^data/);
    assert.match(issues('not an object').join(), /.+/);
  });
});
