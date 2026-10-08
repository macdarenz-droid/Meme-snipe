import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { canonicalJson } from '@bot/types';
import { openDb } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { bootstrapConfig, M25_LOG_CODES, REPAIR_ACTOR, SYSTEM_ACTOR, type BootstrapOptions } from '../../src/m25/bootstrap.ts';
import { CEILING_KEYS, parseCeilings } from '../../src/m25/ceilings.ts';
import { ALL_MODES, type ConfigFieldDef } from '../../src/m25/fields.ts';
import { lstatOrNull, trustProblem, type FileStat } from '../../src/m25/files.ts';
import { CONFIG_FIELDS } from '../../src/m25/registry.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes } from '../../src/m27/log.ts';
import { MetricsRegistry } from '../../src/m27/metrics.ts';
import { fakeClock, tempDir } from '../helpers.ts';

const dir = tempDir('m25');
const repos = createRepos();
const BOT_UID = 1000;
const CEILINGS = { per_trade_notional_lamports: '66666667', open_positions: 5, daily_loss_lamports: '200000000', hot_wallet_cap_lamports: '2000000000',
  slippage_bps: 2500, signer_day_cap_lamports: '1000000000', tip_cap_lamports: '1000000', exit_fee_cap_lamports: '5000000' };

const rootFile: FileStat = { uid: 0, mode: 0o100644, isFile: true, isSymbolicLink: false, isDirectory: false };
const rootDir: FileStat = { uid: 0, mode: 0o40755, isFile: false, isSymbolicLink: false, isDirectory: true };

/** A fake /etc/bot: every path is root-owned 0644 (files) or 0755 (directories) unless overridden. */
function fakeStat(over: Record<string, FileStat | null> = {}) {
  return (p: string): FileStat | null => (Object.hasOwn(over, p) ? over[p] as FileStat | null : p.endsWith('.json') ? rootFile : rootDir);
}

let n = 0;
async function setup(files: { ceilings?: string | null; config?: string | null } = {}) {
  const base = join(dir, `etc${n++}`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(base);
  const ceilingsPath = join(base, 'ceilings.json');
  const configPath = join(base, 'config.json');
  if (files.ceilings !== null) writeFileSync(ceilingsPath, files.ceilings ?? JSON.stringify(CEILINGS));
  if (files.config !== null) writeFileSync(configPath, files.config ?? JSON.stringify({ 'm24.db_path': '/var/lib/bot/bot.db', 'm27.series_cap': 2_000 }));
  const path = join(base, 'bot.db');
  const clock = fakeClock();
  const db = openDb({ create: true, path, clock });
  assert.equal((await prepareDatabase(db, { clock, backupPath: `${path}.bak` })).ok, true);
  const lines: string[] = [];
  const log = createLogger({ clock, codes: mergeLogCodes(M27_LOG_CODES, M25_LOG_CODES), runId: 'R', mode: 'paper', sink: { write: (l) => { lines.push(l); return 'written'; } } });
  const metrics = new MetricsRegistry({ clock, seriesCap: 50, ringBudgetBytes: 0, sink: { append() {} } });
  const opts: BootstrapOptions = { db, repo: repos.config_version, clock, euid: BOT_UID, ceilingsPath, configPath, stat: fakeStat(), log,
    versionInfo: (version) => metrics.gauge('config_version_info', { version }) };
  return { db, opts, lines, metrics, ceilingsPath, configPath, codes: () => lines.map((l) => JSON.parse(l).code as string) };
}

describe('config bootstrap (B-M25-01 logic 4)', () => {
  it('first start: config.json becomes config_version 1, the sha256 of its canonical JSON with defaults filled', async () => {
    const { db, opts, codes, metrics } = await setup();
    const r = bootstrapConfig(opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const config = r.value.current();
    assert.equal(config['m24.db_path'], '/var/lib/bot/bot.db');
    assert.equal(config['m27.series_cap'], 2_000);
    assert.equal(config['m27.log_retention_days'], 14);
    const values = Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'version'));
    assert.equal(config.version, createHash('sha256').update(canonicalJson(values)).digest('hex'));
    assert.equal(r.value.versionNo, 1);
    assert.ok(Object.isFrozen(config));
    assert.equal(r.value.schema().length, CONFIG_FIELDS.length);
    assert.equal(r.value.ceilings().openPositions, 5);
    assert.equal(r.value.ceilings().perTradeNotionalLamports, 66_666_667n);
    const row = db.withTx((tx) => repos.config_version.find(tx));
    assert.deepEqual(row.map((v) => [v.configVersion, v.versionNo, v.json, v.appliedBy]), [[config.version, 1, canonicalJson(values), canonicalJson(SYSTEM_ACTOR)]]);
    assert.deepEqual(codes(), ['m25.bootstrap']);
    assert.match(metrics.render(), new RegExp(`^config_version_info\\{version="${config.version}"\\} 1$`, 'm'));
    db.close();
  });

  it('later starts use the newest stored version; a changed config file is ignored and logged', async () => {
    const { db, opts, lines, codes, configPath } = await setup();
    const first = bootstrapConfig(opts);
    const second = bootstrapConfig(opts);
    assert.deepEqual(second.ok && first.ok ? second.value.current() : null, first.ok ? first.value.current() : 'x');
    assert.deepEqual(codes(), ['m25.bootstrap', 'm25.loaded']);
    writeFileSync(configPath, JSON.stringify({ 'm27.series_cap': 3_000 }));
    const third = bootstrapConfig(opts);
    assert.equal(third.ok && third.value.current()['m27.series_cap'], 2_000);
    assert.equal(JSON.parse(lines.at(-2) as string).code, 'm25.config_file_ignored');
    writeFileSync(configPath, 'not json');
    bootstrapConfig(opts);
    assert.equal(JSON.parse(lines.at(-2) as string).code, 'm25.config_file_ignored');
    const { rmSync } = await import('node:fs');
    rmSync(configPath);
    bootstrapConfig({ ...opts, log: undefined as never, versionInfo: undefined as never });
    db.withTx((tx) => repos.config_version.insert(tx, { configVersion: 'b'.repeat(64), versionNo: 2, json: '{"m24.removed":1}', appliedAt: Date.UTC(2026, 9, 8), appliedBy: '{}', createdAt: Date.UTC(2026, 9, 8) }));
    const stale = bootstrapConfig(opts);                                      // ruling 3: exits_only, never refused
    assert.deepEqual(stale.ok ? [stale.value.exitsOnly, stale.value.versionNo, stale.value.current()['m27.series_cap']] : stale.error, [true, 1, 2_000]);
    assert.deepEqual(JSON.parse(lines.findLast((l) => l.includes('m25.stored_invalid')) as string).keys, 'm24.removed:E_UNKNOWN_KEY');
    db.close();
  });

  it('acceptance: /etc/bot/ceilings.json writable by bot fails the start-up permission check', async () => {
    const { db, opts, ceilingsPath, codes } = await setup();
    const owned = bootstrapConfig({ ...opts, stat: fakeStat({ [ceilingsPath]: { ...rootFile, uid: BOT_UID } }) });
    assert.deepEqual(owned.ok ? null : [owned.error.reason, owned.error.code], ['ceilings_untrusted', 'E_NOT_ROOT_OWNED']);
    for (const mode of [0o100664, 0o100646, 0o100666]) {
      const writable = bootstrapConfig({ ...opts, stat: fakeStat({ [ceilingsPath]: { ...rootFile, mode } }) });
      assert.deepEqual(writable.ok ? null : [writable.error.reason, writable.error.code], ['ceilings_untrusted', 'E_WRITABLE']);
    }
    const dirWritable = bootstrapConfig({ ...opts, stat: fakeStat({ [join(ceilingsPath, '..')]: { ...rootDir, mode: 0o40777 } }) });
    assert.deepEqual(dirWritable.ok ? null : dirWritable.error.code, 'E_WRITABLE');
    const asRoot = bootstrapConfig({ ...opts, euid: 0 });
    assert.deepEqual(asRoot.ok ? null : asRoot.error.code, 'E_RUN_AS_ROOT');
    assert.ok(codes().every((c) => c === 'm25.start_refused'));
    assert.equal(db.withTx((tx) => repos.config_version.find(tx)).length, 0);
    db.close();
  });

  it('edge case: an invalid config file at first start refuses the start (config_invalid)', async () => {
    const invalid = await setup({ config: JSON.stringify({ 'm27.series_cap': 99, 'm99.unknown': 1 }) });
    const r = bootstrapConfig(invalid.opts);
    assert.deepEqual(r.ok ? null : [r.error.reason, r.error.code, r.error.errors],
      ['config_invalid', 'E_CONFIG_INVALID', [{ key: 'm99.unknown', code: 'E_UNKNOWN_KEY' }, { key: 'm27.series_cap', code: 'E_RANGE' }]]);
    invalid.db.close();
    const garbage = await setup({ config: '{' });
    const g = bootstrapConfig(garbage.opts);
    assert.deepEqual(g.ok ? null : [g.error.reason, g.error.errors], ['config_invalid', [{ key: '', code: 'E_NOT_OBJECT' }]]);
    garbage.db.close();
    const missing = await setup({ config: null });
    const m = bootstrapConfig({ ...missing.opts, stat: fakeStat() });
    assert.deepEqual(m.ok ? null : [m.error.reason, m.error.code], ['config_invalid', 'E_CONFIG_UNREADABLE']);
    const untrusted = bootstrapConfig({ ...missing.opts, stat: fakeStat({ [missing.configPath]: null }) });
    assert.deepEqual(untrusted.ok ? null : [untrusted.error.reason, untrusted.error.code], ['config_untrusted', 'E_MISSING']);
    missing.db.close();
  });

  it('defaults to /etc/bot/ceilings.json and /etc/bot/config.json, checked on the real file system', async () => {
    const { db, opts } = await setup();
    const { ceilingsPath: _c, configPath: _f, stat: _s, ...defaults } = opts;
    const r = bootstrapConfig(defaults);
    assert.deepEqual(r.ok ? null : [r.error.reason, r.error.code, r.error.message], ['ceilings_untrusted', 'E_MISSING', '/etc/bot/ceilings.json does not exist']);
    db.close();
  });

  it('refuses unreadable or invalid ceilings', async () => {
    const none = await setup({ ceilings: null });
    const r = bootstrapConfig(none.opts);
    assert.deepEqual(r.ok ? null : [r.error.reason, r.error.code], ['ceilings_invalid', 'E_CEILINGS_UNREADABLE']);
    none.db.close();
    const bad = await setup({ ceilings: JSON.stringify({ ...CEILINGS, open_positions: 0 }) });
    const b = bootstrapConfig(bad.opts);
    assert.deepEqual(b.ok ? null : [b.error.reason, b.error.code], ['ceilings_invalid', 'E_CEILINGS_INVALID']);
    bad.db.close();
  });

  it('refuses a value for a secret field and never stores one', async () => {
    const { db, opts } = await setup({ config: JSON.stringify({ 'x.api_key': 'abc' }) });
    const fields: ConfigFieldDef[] = [{ key: 'x.api_key', section: 'x', type: 'string', unit: null, displayUnit: null, min: null, max: null, step: null,
      enumValues: null, secret: true, requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES,
      label: 'key', description: 'from the secret store', default: null }];
    const r = bootstrapConfig({ ...opts, fields });
    assert.deepEqual(r.ok ? null : r.error.errors, [{ key: 'x.api_key', code: 'E_SECRET' }]);
    writeFileSync(opts.configPath as string, '{}');
    const ok = bootstrapConfig({ ...opts, fields });
    assert.deepEqual(ok.ok ? { ...ok.value.current() } : null, { version: createHash('sha256').update('{}').digest('hex') });
    db.close();
  });
});

describe('ceilings file (B-M25-01 logic 3)', () => {
  it('parses exactly the eight maxima; lamports as positive u64 strings, counts 1-1000, bps 1-10000', () => {
    assert.deepEqual(CEILING_KEYS.sort(), Object.keys(CEILINGS).sort());
    const ok = parseCeilings(JSON.stringify(CEILINGS));
    assert.deepEqual(ok.ok ? ok.value : null, { perTradeNotionalLamports: 66_666_667n, openPositions: 5, dailyLossLamports: 200_000_000n,
      hotWalletCapLamports: 2_000_000_000n, slippageBps: 2_500, signerDayCapLamports: 1_000_000_000n, tipCapLamports: 1_000_000n, exitFeeCapLamports: 5_000_000n });
    const bad = (text: string, re: RegExp) => { const r = parseCeilings(text); assert.match(r.ok ? '' : r.error.message, re); };
    bad('[', /not valid JSON/);
    bad('[]', /not a JSON object/);
    bad('null', /not a JSON object/);
    bad(JSON.stringify({ ...CEILINGS, extra: 1, also: 2 }), /unknown keys: also, extra/);
    bad(JSON.stringify({ ...CEILINGS, tip_cap_lamports: 1_000_000 }), /tip_cap_lamports must be a positive u64/);
    bad(JSON.stringify({ ...CEILINGS, tip_cap_lamports: '0' }), /tip_cap_lamports/);
    bad(JSON.stringify({ ...CEILINGS, tip_cap_lamports: '18446744073709551616' }), /tip_cap_lamports/);
    bad(JSON.stringify({ ...CEILINGS, slippage_bps: 10_001 }), /slippage_bps must be an integer from 1 to 10000/);
    bad(JSON.stringify({ ...CEILINGS, open_positions: 1_001 }), /open_positions must be an integer from 1 to 1000/);
    const { open_positions: _omit, ...missing } = CEILINGS;
    bad(JSON.stringify(missing), /open_positions/);
  });
});

describe('root-owned file check', () => {
  it('requires a root-owned regular file, not group or other writable, in such a directory, and an engine not running as root', () => {
    const p = '/etc/bot/ceilings.json';
    const check = (over: Record<string, FileStat | null>, euid = BOT_UID) => trustProblem(p, euid, fakeStat(over))?.code ?? null;
    assert.equal(check({}), null);
    assert.equal(check({}, 0), 'E_RUN_AS_ROOT');
    assert.equal(check({ [p]: null }), 'E_MISSING');
    assert.equal(check({ [p]: { ...rootFile, isSymbolicLink: true } }), 'E_NOT_REGULAR');
    assert.equal(check({ [p]: rootDir }), 'E_NOT_REGULAR');
    assert.equal(check({ [p]: { ...rootFile, uid: BOT_UID } }), 'E_NOT_ROOT_OWNED');
    assert.equal(check({ [p]: { ...rootFile, mode: 0o100620 } }), 'E_WRITABLE');
    assert.equal(check({ '/etc/bot': null }), 'E_MISSING');
    assert.equal(check({ '/etc/bot': rootFile }), 'E_NOT_REGULAR');
    assert.equal(check({ '/etc/bot': { ...rootDir, uid: BOT_UID } }), 'E_NOT_ROOT_OWNED');
    assert.equal(check({ '/etc/bot': { ...rootDir, mode: 0o40775 } }), 'E_WRITABLE');
  });

  it('lstatOrNull reads the real file system without following a link', () => {
    const file = join(dir, 'real.json');
    writeFileSync(file, '{}');
    symlinkSync(file, join(dir, 'link.json'));
    assert.deepEqual({ ...lstatOrNull(file), uid: 0, mode: 0 }, { uid: 0, mode: 0, isFile: true, isSymbolicLink: false, isDirectory: false });
    assert.equal(lstatOrNull(join(dir, 'link.json'))?.isSymbolicLink, true);
    assert.equal(lstatOrNull(join(dir, 'nope.json')), null);
    assert.throws(() => lstatOrNull(join(file, 'child')), /ENOTDIR/);
  });
});

describe('stored config versions and newer builds (Z02 round 2 rulings 3 and 4)', () => {
  it('ruling 3: a stored version this build rejects runs exits_only on the newest version it accepts, never a refused start', async () => {
    const { db, opts, lines } = await setup();
    assert.equal(bootstrapConfig(opts).ok, true);                                      // version 1 from config.json
    const at = Date.UTC(2026, 9, 8);
    db.withTx((tx) => repos.config_version.insert(tx, { configVersion: 'c'.repeat(64), versionNo: 2, json: '{"m27.series_cap":-5}', appliedAt: at, appliedBy: '{}', createdAt: at }));
    const r = bootstrapConfig(opts);
    assert.deepEqual(r.ok ? [r.value.exitsOnly, r.value.versionNo, r.value.current()['m27.series_cap']] : r.error, [true, 1, 2_000]);
    const log = JSON.parse(lines.findLast((l) => l.includes('m25.stored_invalid')) as string);
    assert.deepEqual([log.level, log.version_no, log.used_version_no], ['critical', 2, 1]);
    db.close();
  });

  it('ruling 3 and 16: with no stored version accepted, the newest one runs exits_only with each rejected key at its default, in its own row', async () => {
    const { db, opts, lines } = await setup();
    const at = Date.UTC(2026, 9, 8);
    db.withTx((tx) => repos.config_version.insert(tx, { configVersion: 'd'.repeat(64), versionNo: 1, json: '{"m24.removed":1,"m27.series_cap":3000,"m27.log_retention_days":0}',
      appliedAt: at, appliedBy: '{}', createdAt: at }));
    const r = bootstrapConfig(opts);
    assert.deepEqual(r.ok ? [r.value.exitsOnly, r.value.versionNo, r.value.current()['m27.series_cap'], r.value.current()['m27.log_retention_days']] : r.error,
      [true, 2, 3_000, 14]);
    if (!r.ok) return;
    const row = repos.config_version.find(db.reader(), { versionNo: 2 })[0];
    assert.equal(row?.configVersion, r.value.current().version);                         // the id names the values in use
    assert.equal(row?.configVersion, createHash('sha256').update(row?.json ?? '').digest('hex'));
    assert.deepEqual(JSON.parse(row?.appliedBy ?? '{}'), JSON.parse(canonicalJson(REPAIR_ACTOR)));
    const alert = JSON.parse(lines.findLast((l) => l.includes('m25.stored_invalid')) as string);
    assert.equal(alert.level, 'critical');
    assert.equal(alert.rejected, 'm27.log_retention_days');                              // m24.removed is unknown: dropped, listed in keys
    const defaults = (alert.defaults as string).split(',');
    assert.ok(defaults.includes('m27.log_retention_days') && defaults.includes('m24.db_path') && !defaults.includes('m27.series_cap'), alert.defaults);
    const again = bootstrapConfig(opts);                                                  // the repaired row is newest: still exits_only
    assert.deepEqual(again.ok ? [again.value.exitsOnly, again.value.versionNo] : again.error, [true, 2]);
    assert.ok(lines.some((l) => l.includes('m25.exits_only_kept')));
    assert.equal(repos.config_version.find(db.reader()).length, 2);
    db.close();
  });

  it('ruling 4: a build that adds a key stores the values in use as version + 1 (system actor) and logs it; the next start adds nothing', async () => {
    const { db, opts, codes } = await setup();
    const older = CONFIG_FIELDS.filter((f) => f.key !== 'm27.rollup_max_bytes');        // the build before the key existed
    const first = bootstrapConfig({ ...opts, fields: older });
    assert.equal(first.ok && first.value.versionNo, 1);
    const second = bootstrapConfig(opts);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const rows = repos.config_version.find(db.reader(), {}, { orderBy: 'versionNo' });
    assert.deepEqual(rows.map((v) => v.versionNo), [1, 2]);
    const v2 = rows[1] as (typeof rows)[number];
    assert.equal(JSON.parse(v2.json)['m27.rollup_max_bytes'], 4_294_967_296);
    assert.equal(v2.configVersion, createHash('sha256').update(v2.json).digest('hex'));
    assert.deepEqual(JSON.parse(v2.appliedBy), JSON.parse(canonicalJson(SYSTEM_ACTOR)));
    assert.deepEqual([second.value.versionNo, second.value.current().version, second.value.exitsOnly], [2, v2.configVersion, false]);
    assert.ok(codes().includes('m25.defaults_added'));
    const third = bootstrapConfig(opts);
    assert.equal(third.ok && third.value.versionNo, 2);
    assert.equal(repos.config_version.find(db.reader()).length, 2);
    db.close();
  });
});
