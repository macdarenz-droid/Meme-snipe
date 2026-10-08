// B-M28-01 contract tests: every fixture parses; the ARCH section 19 changes are in force (old VM-05 shape fails);
// the backend ExitReason union equals VM-06 exit_reason; BigInt round trips; the scalar rules of UI.md.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { EXIT_REASONS, fromU64Str, toU64Str, U64_MAX } from '@bot/types';
import {
  At, Bps, DecimalStr, ExitReason, I128Str, I64Str, Id, Pubkey, SCHEMA_VERSIONS, SeriesNumber, Signature, U64Str, UntrustedName, UntrustedString,
  UntrustedSymbol, VM_IDS, VM_SCHEMAS, VM01Envelope, VM05Position, VM05Positions, VM06Trade, VM07Signal, VM10Series, VM15Config, VM16Alert, VM17AuditEvent,
  VM19CommandRequest, VM19PreviewResponse, VM21Run, type VmId,
} from '@bot/contract';
import { COMMAND_FIXTURES, ENTITY_FIXTURES, FIXTURES, MAX_NAME, MAX_SYMBOL, U64_MAX as U64_MAX_TEXT, type Variant } from '@bot/contract/fixtures';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const happy = (vm: VmId): Record<string, unknown> => structuredClone(FIXTURES[vm].happy) as Record<string, unknown>;
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => schema.safeParse(v).success;

describe('fixtures (B-M28-01 logic 4, logic 5: every fixture parses)', () => {
  it('every VM has happy, empty and nulls fixtures, and the other variants where the VM has such fields; all parse', () => {
    const expected: Record<string, Variant[]> = {
      'VM-01': ['u64_max', 'simulated', 'live'], 'VM-03': ['u64_max', 'simulated', 'live'], 'VM-04': ['max_untrusted', 'u64_max', 'simulated'],
      'VM-05': ['max_untrusted', 'u64_max', 'negative_pnl', 'simulated', 'live'], 'VM-06': ['max_untrusted', 'u64_max', 'negative_pnl', 'simulated', 'live'],
      'VM-07': ['max_untrusted', 'live'], 'VM-08': ['max_untrusted', 'u64_max', 'negative_pnl'], 'VM-09': ['negative_pnl', 'live'], 'VM-10': ['simulated'],
      'VM-11': ['negative_pnl', 'simulated', 'live'], 'VM-12': ['u64_max'], 'VM-13': ['u64_max'], 'VM-14': ['u64_max', 'simulated'], 'VM-19': ['u64_max'],
      'VM-20': ['max_untrusted', 'u64_max', 'negative_pnl', 'simulated', 'live'],
    };
    for (const vm of VM_IDS) {
      const variants = Object.keys(FIXTURES[vm]).sort();
      assert.deepEqual(variants, ['empty', 'happy', 'nulls', ...(expected[vm] ?? [])].sort(), vm);
      for (const [variant, fixture] of Object.entries(FIXTURES[vm])) {
        const r = VM_SCHEMAS[vm].safeParse(fixture);
        assert.ok(r.success, `${vm} ${variant}: ${r.success ? '' : JSON.stringify(r.error.issues)}`);
      }
    }
  });

  it('entity, command request and preview fixtures parse; the nulls fixtures really hold nulls and the empty ones empty lists', () => {
    const entity = { 'VM-05': VM05Position, 'VM-06': VM06Trade, 'VM-07': VM07Signal, 'VM-16': VM16Alert, 'VM-17': VM17AuditEvent, 'VM-21': VM21Run } as const;
    for (const [vm, schema] of Object.entries(entity)) assert.ok(ok(schema, ENTITY_FIXTURES[vm as keyof typeof entity]), vm);
    assert.ok(ok(VM19CommandRequest, COMMAND_FIXTURES.request));
    assert.ok(ok(VM19PreviewResponse, COMMAND_FIXTURES.preview));
    const nulls = FIXTURES['VM-05'].nulls as { items: Array<Record<string, unknown>> };
    assert.equal(nulls.items[0]?.mark_price_sol_per_token, null);
    assert.equal(nulls.items[0]?.pending_close, null);
    assert.deepEqual((FIXTURES['VM-05'].empty as { items: unknown[] }).items, []);
    assert.equal(new TextEncoder().encode(MAX_SYMBOL).length, 32);
    assert.equal(new TextEncoder().encode(MAX_NAME).length, 64);
  });
});

describe('ARCH section 19 changes (B-M28-01 logic 2-3)', () => {
  it('acceptance: a VM-05 fixture with a single stop object (old shape) fails validation at the new version', () => {
    const position = structuredClone(ENTITY_FIXTURES['VM-05']) as Record<string, unknown>;
    const { stops, targets, ...rest } = position;
    const old = { ...rest, stop: (stops as unknown[])[0], target: (targets as unknown[])[0] };
    assert.equal(ok(VM05Position, old), false);
    assert.equal(ok(VM05Positions, { schema_version: 1, items: [position] }), false);
    assert.equal(ok(VM05Positions, { schema_version: 2, items: [position] }), true);
  });

  it('CB-11: the backend ExitReason union equals the VM-06 exit_reason enum', () => {
    assert.deepEqual([...ExitReason.options].sort(), [...EXIT_REASONS].sort());
  });

  it('schema versions: VMs changed by UC-01..UC-21 are at 2, the others at 1; VM-01 vm covers VM-21', () => {
    assert.deepEqual(Object.entries(SCHEMA_VERSIONS).filter(([, v]) => v === 2).map(([k]) => k),
      ['VM-01', 'VM-03', 'VM-04', 'VM-05', 'VM-06', 'VM-12', 'VM-13', 'VM-17', 'VM-18', 'VM-19']);
    assert.deepEqual(Object.values(SCHEMA_VERSIONS).filter((v) => v !== 1 && v !== 2), []);
    assert.equal(VM_IDS.at(-1), 'VM-21');
    const env = { ...happy('VM-01'), vm: 'VM-21', schema_version: SCHEMA_VERSIONS['VM-21'] };
    assert.ok(ok(VM01Envelope, env));
    assert.equal(ok(VM01Envelope, { ...env, vm: 'VM-22' }), false);
  });

  it('UC-01, UC-04, UC-06, UC-07, UC-09, UC-13, UC-14, UC-17 values are accepted', () => {
    assert.ok(ok(VM_SCHEMAS['VM-03'], { ...happy('VM-03'), trading_state: 'exits_only' }));
    const audit = { ...happy('VM-17') };
    assert.ok(ok(VM_SCHEMAS['VM-17'], audit));
    assert.ok(ok(VM19CommandRequest, { ...COMMAND_FIXTURES.request, type: 'close_unsolicited', params: { mint: ENTITY_FIXTURES['VM-05'].mint } }));
    assert.ok(ok(VM19CommandRequest, { ...COMMAND_FIXTURES.request, type: 'write_off_position', params: { position_id: ENTITY_FIXTURES['VM-05'].position_id } }));
  });
});

describe('cross-field rules', () => {
  it('VM-06: net = gross - total costs and total = the sum of costs.* (UI-T18 invariant)', () => {
    const t = structuredClone(ENTITY_FIXTURES['VM-06']) as Record<string, unknown>;
    assert.ok(ok(VM06Trade, t));
    assert.equal(ok(VM06Trade, { ...t, net_pnl_lamports: '1' }), false);
    assert.equal(ok(VM06Trade, { ...t, total_costs_lamports: '1' }), false);
  });

  it('VM-16: a critical alert is not snoozable; VM-15: a secret never carries a value', () => {
    assert.equal(ok(VM16Alert, { ...ENTITY_FIXTURES['VM-16'], severity: 'critical', snoozable: true }), false);
    assert.ok(ok(VM16Alert, { ...ENTITY_FIXTURES['VM-16'], severity: 'critical', snoozable: false }));
    const config = happy('VM-15') as { sections: Array<{ fields: Array<Record<string, unknown>> }> };
    (config.sections[0]?.fields[1] as Record<string, unknown>).current = 'leaked';
    assert.equal(ok(VM15Config, config), false);
  });

  it('VM-10: price_ohlc needs o/h/l/c and no v; other series need v; every column is as long as t', () => {
    const s = happy('VM-10');
    assert.equal(ok(VM10Series, { ...s, v: [1] }), false);
    const { v: _v, ...noV } = s;
    assert.equal(ok(VM10Series, noV), false);
    const ohlc = { ...noV, series: 'price_ohlc', unit: 'sol_per_token', o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2] };
    assert.ok(ok(VM10Series, ohlc));
    assert.equal(ok(VM10Series, { ...ohlc, v: [1, 2] }), false);
    assert.equal(ok(VM10Series, { ...s, v: [2 ** 53, 0] }), false);
  });

  it('VM-01: heartbeat fields only and always on a heartbeat', () => {
    const hb = happy('VM-01');
    const { server_time: _s, state_version: _v, topics: _t, ui_supported: _u, ...plain } = hb;
    assert.equal(ok(VM01Envelope, { ...plain, kind: 'heartbeat' }), false);
    assert.ok(ok(VM01Envelope, { ...plain, kind: 'upsert', key: 'k' }));
    assert.equal(ok(VM01Envelope, { ...plain, kind: 'upsert', key: 'k', topics: [] }), false);
    assert.equal(ok(VM01Envelope, { ...plain, kind: 'upsert', key: 'k', ui_supported: {} }), false);
  });

  it('VM-19: params must match the command type; delay_s is 60 exactly for A3', () => {
    assert.equal(ok(VM19CommandRequest, { ...COMMAND_FIXTURES.request, type: 'halt' }), false);
    assert.ok(ok(VM19CommandRequest, { ...COMMAND_FIXTURES.request, type: 'halt', params: {} }));
    assert.equal(ok(VM19PreviewResponse, { ...COMMAND_FIXTURES.preview, delay_s: 0 }), false);
    assert.equal(ok(VM19PreviewResponse, { ...COMMAND_FIXTURES.preview, action_class: 'A1' }), false);
    assert.equal(ok(VM19PreviewResponse, { ...COMMAND_FIXTURES.preview, delay_s: 30 }), false);
  });

  it('VM-12: limit_value, usage_value and hard_ceiling take a U64Str or a signed integer string (UI.md VM-12; limit_def.value is i64)', () => {
    const risk = happy('VM-12') as { limits: Array<Record<string, unknown>> };
    const limit = (field: string, value: string) => ({ ...risk, limits: [{ ...risk.limits[0], [field]: value }] });
    for (const field of ['limit_value', 'usage_value', 'hard_ceiling']) {
      for (const good of ['-1', '-9223372036854775808', '0', U64_MAX_TEXT]) assert.ok(ok(VM_SCHEMAS['VM-12'], limit(field, good)), `${field} ${good}`);
      for (const bad of ['-0', '01', '1.5', '18446744073709551616', '-9223372036854775809', '']) {
        assert.equal(ok(VM_SCHEMAS['VM-12'], limit(field, bad)), false, `${field} ${bad}`);
      }
    }
  });

  it('objects are strict: an unknown field fails', () => {
    for (const vm of VM_IDS) assert.equal(ok(VM_SCHEMAS[vm], { ...happy(vm), unexpected_field: 1 }), false, vm);
  });
});

describe('shared scalars (UI.md conventions 2, 4, 5)', () => {
  it('big integers are canonical decimal strings in range, and round-trip through BigInt', () => {
    assert.ok(ok(U64Str, U64_MAX_TEXT));
    assert.equal(fromU64Str(U64_MAX_TEXT).ok && toU64Str(U64_MAX) === U64_MAX_TEXT, true);
    for (const bad of ['18446744073709551616', '01', '-1', '1e3', '', ' 1', 1]) assert.equal(ok(U64Str, bad), false, String(bad));
    for (const good of ['-9223372036854775808', '9223372036854775807', '0']) assert.ok(ok(I64Str, good));
    for (const bad of ['-9223372036854775809', '-0']) assert.equal(ok(I64Str, bad), false);
    assert.ok(ok(I128Str, `-${2n ** 127n}`));
    assert.equal(ok(I128Str, `${2n ** 127n}`), false);
  });

  it('decimals, keys, signatures, IDs, times and basis points follow their rules', () => {
    for (const good of ['0', '-0.5', '12.000000000000000000000000000001']) assert.ok(ok(DecimalStr, good), good);
    for (const bad of ['1e5', '01', '.5', '1.', '1.0000000000000000000000000000001']) assert.equal(ok(DecimalStr, bad), false, bad);
    assert.ok(ok(Pubkey, ENTITY_FIXTURES['VM-05'].mint));
    assert.equal(ok(Pubkey, `0${'1'.repeat(43)}`), false);
    assert.ok(ok(Signature, (ENTITY_FIXTURES['VM-05'].entry_signatures as string[])[0]));
    assert.equal(ok(Signature, '1'.repeat(63)), false);
    assert.ok(ok(Id, ENTITY_FIXTURES['VM-05'].position_id));
    assert.equal(ok(Id, '01kt46zegegqgh3kevaaemznbm'), false);
    assert.ok(ok(At, '2026-10-06T14:02:11.123Z'));
    for (const bad of ['2026-02-30T00:00:00.000Z', '2026-10-06T14:02:11Z', '2026-10-06 14:02:11.123Z', '2026-10-06T14:02:11.123+00:00']) assert.equal(ok(At, bad), false, bad);
    assert.ok(ok(Bps, -2_147_483_648) && ok(Bps, 2_147_483_647));
    assert.equal(ok(Bps, 2_147_483_648) || ok(Bps, 1.5), false);
    assert.ok(ok(SeriesNumber, 2 ** 53 - 1) && !ok(SeriesNumber, -(2 ** 53)));
  });

  it('untrusted strings are limited in UTF-8 bytes (symbol 32, name 64)', () => {
    assert.ok(ok(UntrustedSymbol, MAX_SYMBOL) && ok(UntrustedName, MAX_NAME));
    assert.equal(ok(UntrustedSymbol, `${MAX_SYMBOL}a`), false);
    assert.equal(ok(UntrustedName, `${MAX_NAME}\u00e9`), false);
    assert.ok(ok(UntrustedString(3), '\u20ac') && !ok(UntrustedString(2), '\u20ac'));
  });
});

describe('one package version for every consumer (acceptance: the SPA and the backend import the same version)', () => {
  // pnpm links `workspace:*` to the one copy in packages/contract and never falls back to the registry (the policy
  // check, E_INTERNAL_NOT_LINKED, refuses any other spec for an internal package), so every consumer gets the frozen version.
  it('every workspace package that depends on @bot/contract uses workspace:* and the lockfile links it to packages/contract', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'packages/contract/package.json'), 'utf8')) as { version: string }).version;
    assert.equal(version, '1.0.0');
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    for (const parent of ['packages', 'apps']) {
      for (const dir of readdirSync(join(ROOT, parent))) {
        let text: string;
        try { text = readFileSync(join(ROOT, parent, dir, 'package.json'), 'utf8'); } catch { continue; }
        const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const spec = pkg[field]?.['@bot/contract'];
          if (spec === undefined) continue;
          assert.equal(spec, 'workspace:*', `${parent}/${dir} ${field}`);
          const importer = lock.split(/\n(?=  \S)/).find((block) => block.startsWith(`  ${parent}/${dir}:`));
          assert.ok(importer?.includes("'@bot/contract':") === true, `${parent}/${dir} is in the lockfile`);
          assert.match(importer ?? '', /'@bot\/contract':\n\s+specifier: workspace:\*\n\s+version: link:\.\.\/(\.\.\/packages\/)?contract\n/);
        }
      }
    }
  });
});
