import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Config } from '@bot/types';
import { m24Settings } from '../../src/m24/settings.ts';
import { resolveConfig } from '../../src/m25/bootstrap.ts';
import { ALL_MODES, fieldProblem, scaled, valueProblem, type ConfigFieldDef } from '../../src/m25/fields.ts';
import { CONFIG_FIELDS, configValue, mergeFields, schema } from '../../src/m25/registry.ts';
import { m27Settings } from '../../src/m27/settings.ts';

const field = (over: Partial<ConfigFieldDef>): ConfigFieldDef => ({
  key: 'x.k', section: 'x', type: 'int', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: false, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES, label: 'k', description: 'd', default: 1, ...over,
});
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

describe('config schema registry (B-M25-01 logic 1)', () => {
  it('merges the module field lists, sorted, with every ConfigFieldSchema property', () => {
    assert.deepEqual(CONFIG_FIELDS.map((f) => f.key), [...CONFIG_FIELDS.map((f) => f.key)].sort());
    assert.ok(CONFIG_FIELDS.some((f) => f.key === 'm24.db_path') && CONFIG_FIELDS.some((f) => f.key === 'm27.series_cap'));
    const s = schema();
    assert.equal(s.length, CONFIG_FIELDS.length);
    for (const f of s) {
      assert.deepEqual(Object.keys(f).sort(), ['affectsReturns', 'displayUnit', 'enumValues', 'key', 'max', 'min', 'modeScope', 'requiresRestart',
        'riskDirectionOnIncrease', 'secret', 'step', 'type', 'unit']);
    }
  });

  it('fails on a duplicate key and on an invalid field (so the build fails)', () => {
    assert.throws(() => mergeFields([field({})], [field({})]), /defined twice/);
    assert.throws(() => mergeFields([field({ key: 'Bad' })]), /dotted snake_case/);
    assert.throws(() => mergeFields([field({ key: 'y.k' })]), /outside its section/);
    assert.throws(() => mergeFields([field({ default: null })]), /needs a default/);
    assert.throws(() => mergeFields([field({ max: '0' })]), /default fails E_RANGE/);
    assert.throws(() => mergeFields([field({ secret: true })]), /must have no default/);
    assert.equal(fieldProblem(field({ secret: true, default: null })), null);
  });

  it('CA-24: the keys that do not affect returns are listed here for review', () => {
    assert.deepEqual(CONFIG_FIELDS.filter((f) => !f.affectsReturns).map((f) => f.key), [
      'm24.db_path', 'm24.synchronous', 'm27.log_dir', 'm27.log_max_bytes_per_day', 'm27.log_queue_bytes', 'm27.log_retention_days', 'm27.metrics_port',
      'm27.ring_budget_bytes', 'm27.rollup_max_bytes', 'm27.series_cap',
    ]);
  });

  it('acceptance: every key referenced in code exists in the schema (static check of every configValue call)', () => {
    const keys = new Set(CONFIG_FIELDS.map((f) => f.key));
    const files = readdirSync(join(ROOT, 'packages')).flatMap((p) => sources(join(ROOT, 'packages', p, 'src')));
    let calls = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith(join('m25', 'registry.ts'))) continue;
      for (const m of text.matchAll(/configValue\(([^,()]+),\s*([^)]*)\)/g)) {
        calls++;
        const arg = (m[2] as string).trim();
        assert.match(arg, /^'[a-z0-9_.]+'$/, `${file}: configValue needs a literal key, found ${arg}`);
        assert.ok(keys.has(arg.slice(1, -1)), `${file}: ${arg} is not a registered config key`);
      }
      assert.doesNotMatch(text, /config\[\s*['"`]/, `${file}: read config values with configValue()`);
    }
    assert.ok(calls >= 9);
  });

  it('module settings read every one of their keys from a resolved config', () => {
    const resolved = resolveConfig({ 'm24.db_path': '/x/bot.db' }, CONFIG_FIELDS);
    assert.equal(resolved.ok, true);
    const config = { ...(resolved.ok ? resolved.value : {}), version: 'v' } as Config;
    assert.deepEqual(m24Settings(config), { dbPath: '/x/bot.db', synchronous: 'FULL' });
    assert.deepEqual(m27Settings(config), { seriesCap: 5_000, logRetentionDays: 14, ringBudgetBytes: 67_108_864, logMaxBytesPerDay: 268_435_456,
      logQueueBytes: 8_388_608, logDir: '/var/lib/bot/log', metricsPort: 9_464, rollupMaxBytes: 4_294_967_296 });
    assert.throws(() => configValue({ version: 'v' } as Config, 'm24.db_path'), /no value/);
  });
});

describe('value checks by field type', () => {
  it('validates every type, its bounds and enums, and refuses a value for a secret', () => {
    const cases: Array<[Partial<ConfigFieldDef>, unknown, string | null]> = [
      [{ type: 'bool' }, true, null], [{ type: 'bool' }, 'true', 'E_TYPE'],
      [{ type: 'enum', enumValues: ['a', 'b'] }, 'b', null], [{ type: 'enum', enumValues: ['a'] }, 'c', 'E_ENUM'], [{ type: 'enum', enumValues: null }, 'a', 'E_ENUM'], [{ type: 'enum' }, 1, 'E_TYPE'],
      [{ type: 'string' }, 'x', null], [{ type: 'string' }, 'x'.repeat(4_097), 'E_TYPE'], [{ type: 'string' }, 1, 'E_TYPE'],
      [{ type: 'list' }, ['a'], null], [{ type: 'list' }, [1], 'E_TYPE'], [{ type: 'list' }, 'a', 'E_TYPE'], [{ type: 'list' }, Array.from({ length: 257 }, () => 'a'), 'E_TYPE'],
      [{ type: 'int', min: '1', max: '5' }, 5, null], [{ type: 'int', min: '1', max: '5' }, 0, 'E_RANGE'], [{ type: 'int', min: '1', max: '5' }, 6, 'E_RANGE'],
      [{ type: 'int' }, 1.5, 'E_TYPE'], [{ type: 'bps', min: '-100' }, -100, null], [{ type: 'duration_ms' }, -1, 'E_TYPE'], [{ type: 'duration_ms' }, 0, null],
      [{ type: 'lamports', max: '1000000000' }, '1000000000', null], [{ type: 'lamports', max: '1000000000' }, '1000000001', 'E_RANGE'],
      [{ type: 'lamports' }, 5, 'E_TYPE'], [{ type: 'lamports' }, '01', 'E_TYPE'], [{ type: 'base_units' }, '18446744073709551616', 'E_TYPE'],
      [{ type: 'base_units' }, '18446744073709551615', null],
      [{ type: 'decimal', min: '-0.5', max: '2.25' }, '2.25', null], [{ type: 'decimal', min: '-0.5', max: '2.25' }, '-0.6', 'E_RANGE'],
      [{ type: 'decimal' }, '1e3', 'E_TYPE'], [{ type: 'decimal' }, 1, 'E_TYPE'],
      [{ type: 'string', secret: true }, 'x', 'E_SECRET'],
    ];
    for (const [over, value, expected] of cases) assert.equal(valueProblem(field(over), value), expected, `${JSON.stringify(over)} ${JSON.stringify(value)}`);
    assert.equal(scaled('-1.5'), -1_500_000_000_000_000_000_000_000_000_000n);
  });

  it('resolves a flat config object: defaults fill missing keys; unknown keys, secrets and bad values are errors', () => {
    const fields = [field({ key: 'x.a', default: 1 }), field({ key: 'x.s', type: 'string', secret: true, default: null }), field({ key: 'x.b', type: 'bool', default: false })];
    assert.deepEqual(resolveConfig({ 'x.b': true }, fields), { ok: true, value: { 'x.a': 1, 'x.b': true } });
    assert.deepEqual(resolveConfig({ 'x.z': 1, 'x.s': 'key', 'x.a': 'one' }, fields),
      { ok: false, error: { code: 'E_CONFIG_INVALID', errors: [{ key: 'x.z', code: 'E_UNKNOWN_KEY' }, { key: 'x.a', code: 'E_TYPE' }, { key: 'x.s', code: 'E_SECRET' }] } });
    for (const bad of [null, [], 'x', undefined]) {
      assert.deepEqual(resolveConfig(bad, fields), { ok: false, error: { code: 'E_CONFIG_INVALID', errors: [{ key: '', code: 'E_NOT_OBJECT' }] } });
    }
  });
});
