// Rule tests for the bot ESLint rule package (B-M19-01 logic 3). Each invalid case is code the rule must reject.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import plugin from '../plugin.ts';
import noAmbientClockOrRandom from '../rules/no-ambient-clock-or-random.ts';
import noAwaitInWithTx from '../rules/no-await-in-withtx.ts';
import noNumberOnUnits from '../rules/no-number-on-units.ts';
import noSharedTypeRedefinition, { exportedTypeNames } from '../rules/no-shared-type-redefinition.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' } });
const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('plugin', () => {
  it('exports the four rules under the bot namespace', () => {
    assert.equal(plugin.meta?.name, 'bot');
    assert.deepEqual(Object.keys(plugin.rules ?? {}).sort(), ['no-ambient-clock-or-random', 'no-await-in-withtx', 'no-number-on-units', 'no-shared-type-redefinition']);
  });
});

tester.run('no-number-on-units', noNumberOnUnits, {
  valid: [
    'Number(count)',
    'Number(x.lamportsFloor)',
    'parseFloat(priceText)',
    'BigInt(feeLamports)',
    'String(feeLamports)',
    'foo(feeLamports)',
    'Math.floor(1)',
    'Number.isInteger(baseSlot)',
    'x[0](feeLamports)',
    'Number[k](feeLamports)',
    'globalThis.foo(feeLamports)',
    'other.Number(feeLamports)',
    'Number(database)',
    'Number(timeslot)',
    'Number(x.uiAmount)',
    'Number(x[k])',
    'Number(x[0])',
    'Number(x[`a${b}`])',
    'parseInt(text, radix)',
  ],
  invalid: [
    { code: 'Number(feeLamports)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'feeLamports' } }] },
    { code: 'parseFloat(amountBase)', errors: [{ messageId: 'unitToNumber', data: { fn: 'parseFloat', name: 'amountBase' } }] },
    { code: 'parseInt(String(openedSlot), 10)', errors: [{ messageId: 'unitToNumber', data: { fn: 'parseInt', name: 'openedSlot' } }] },
    { code: 'Number(p.lastValidBlockHeight)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'lastValidBlockHeight' } }] },
    { code: 'Number.parseFloat(x.sizeBase)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number.parseFloat', name: 'sizeBase' } }] },
    { code: "Number['parseInt'](heightSlot)", errors: [{ messageId: 'unitToNumber', data: { fn: 'Number.parseInt', name: 'heightSlot' } }] },
    { code: 'globalThis.Number(aLamports + bLamports)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'aLamports' } }] },
    { code: 'new Number(tipLamports)', errors: [{ messageId: 'unitToNumber' }] },
    { code: 'Number(x as Lamports)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'Lamports' } }] },
    { code: 'Number(info.lamports)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'lamports' } }] },
    { code: 'Number(info.slot)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'slot' } }] },
    { code: 'Number(info.amount)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'amount' } }] },
    { code: "Number(info['lamports'])", errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'lamports' } }] },
    { code: 'Number(info[`blockHeight`])', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'blockHeight' } }] },
    { code: 'Number(LAMPORTS)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'LAMPORTS' } }] },
    { code: 'Number(fee_lamports)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'fee_lamports' } }] },
    { code: 'parseInt(block$height)', errors: [{ messageId: 'unitToNumber', data: { fn: 'parseInt', name: 'block$height' } }] },
    { code: 'Number(amount)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'amount' } }] },
    { code: 'window.Number(slot)', errors: [{ messageId: 'unitToNumber', data: { fn: 'Number', name: 'slot' } }] },
  ],
});

tester.run('no-ambient-clock-or-random', noAmbientClockOrRandom, {
  valid: [
    'clock.nowMs()',
    'rng.nextU32()',
    'new Date(0)',
    'new Date(ms)',
    'Date.parse(s)',
    'Math.floor(1)',
    'x.now()',
    'other.Date.now()',
    'Date[key]',
    'Math.random2()',
    'new Foo()',
    'foo()',
    'const { parse } = Date;',
    'const { floor } = Math;',
    'const { now } = clock;',
    'const { now } = other.Date;',
    'const { [key]: v } = Date;',
    'const { 1: v } = Math;',
    'const { ...rest } = Math;',
    'function f({ now }) { return now; }',
    'for (const { now } of xs) use(now);',
    '({ now: x.y } = clock);',
    'performance.mark()',
    'other.performance.now()',
    'make().now()',
    'global.foo()',
    'Date[`parse`](s)',
    'const { now } = other;',
    'const { Date: { now } } = other;',
    'const { Date: { now } } = make();',
    'const { Date: { parse } } = globalThis;',
    'const { [k]: { now } } = globalThis;',
    'const [{ now }] = [Date];',
  ],
  invalid: [
    { code: 'Date.now()', errors: [{ messageId: 'clock', data: { what: 'Date.now' } }] },
    { code: 'const { now } = Date; now();', errors: [{ messageId: 'clock', data: { what: 'Date.now' } }] },
    { code: 'const { now: n, parse } = globalThis.Date;', errors: [{ messageId: 'clock' }] },
    { code: "const { 'now': n } = Date;", errors: [{ messageId: 'clock' }] },
    { code: "const { ['random']: r } = Math;", errors: [{ messageId: 'random' }] },
    { code: 'const { random } = Math;', errors: [{ messageId: 'random' }] },
    { code: 'let n; ({ now: n } = Date);', errors: [{ messageId: 'clock' }] },
    { code: 'function f({ now } = Date) { return now(); }', errors: [{ messageId: 'clock' }] },
    { code: 'const { now }: DateConstructor = Date;', errors: [{ messageId: 'clock' }] },
    { code: 'const f = Date.now;', errors: [{ messageId: 'clock' }] },
    { code: "Date['now']()", errors: [{ messageId: 'clock' }] },
    { code: 'globalThis.Date.now()', errors: [{ messageId: 'clock' }] },
    { code: 'Math.random()', errors: [{ messageId: 'random' }] },
    { code: 'globalThis.Math.random()', errors: [{ messageId: 'random' }] },
    { code: 'new Date()', errors: [{ messageId: 'clock', data: { what: 'new Date()' } }] },
    { code: 'Date()', errors: [{ messageId: 'clock', data: { what: 'Date()' } }] },
    { code: 'global.Date.now()', errors: [{ messageId: 'clock', data: { what: 'Date.now' } }] },
    { code: 'window.Date.now()', errors: [{ messageId: 'clock' }] },
    { code: 'self.Math.random()', errors: [{ messageId: 'random' }] },
    { code: "globalThis['Date'].now()", errors: [{ messageId: 'clock' }] },
    { code: 'globalThis.globalThis.Date.now()', errors: [{ messageId: 'clock' }] },
    { code: 'Date[`now`]()', errors: [{ messageId: 'clock' }] },
    { code: 'performance.now()', errors: [{ messageId: 'clock', data: { what: 'performance.now' } }] },
    { code: 'globalThis.performance.now()', errors: [{ messageId: 'clock', data: { what: 'performance.now' } }] },
    { code: 'const { now } = performance;', errors: [{ messageId: 'clock', data: { what: 'performance.now' } }] },
    { code: 'const { now } = global.Date;', errors: [{ messageId: 'clock' }] },
    { code: 'const { Date: { now } } = globalThis; now();', errors: [{ messageId: 'clock', data: { what: 'Date.now' } }] },
    { code: "const { 'Math': { random } } = window;", errors: [{ messageId: 'random' }] },
    { code: 'const { globalThis: { Date: { now } } } = global;', errors: [{ messageId: 'clock' }] },
    { code: 'new global.Date()', errors: [{ messageId: 'clock', data: { what: 'new Date()' } }] },
    { code: 'window.Date()', errors: [{ messageId: 'clock', data: { what: 'Date()' } }] },
  ],
});

tester.run('no-shared-type-redefinition', noSharedTypeRedefinition, {
  valid: [
    { code: 'type LocalThing = number;', filename: join(root, 'packages/engine/src/a.ts') },
    { code: "import type { Lamports } from '@bot/types'; export type X = Lamports;", filename: join(root, 'packages/engine/src/a.ts') },
    { code: 'export type Lamports = bigint;', filename: join(root, 'packages/types/src/types.ts') },
    { code: 'const Lamports = 1;', filename: join(root, 'packages/engine/src/a.ts') },
    { code: 'export default class {}', filename: join(root, 'packages/engine/src/a.ts') },
  ],
  invalid: [
    { code: 'type Lamports = bigint;', filename: join(root, 'packages/engine/src/a.ts'), errors: [{ messageId: 'redefined', data: { name: 'Lamports' } }] },
    { code: 'export interface OrderIntent { a: 1 }', filename: join(root, 'packages/signer/src/a.ts'), errors: [{ messageId: 'redefined' }] },
    { code: 'type VenueId = string;', filename: join(root, 'packages/venue/src/a.ts'), errors: [{ messageId: 'redefined', data: { name: 'VenueId' } }] },
    { code: 'class ExecutionPort {}', filename: join(root, 'tools/x.ts'), errors: [{ messageId: 'redefined' }] },
    { code: "enum Mode { A = 'a' }", filename: join(root, 'packages/types-extra/src/a.ts'), errors: [{ messageId: 'redefined' }] },
    { code: 'type Result = 1;', filename: join(root, 'packages/types/x.ts'), errors: [{ messageId: 'redefined' }] },
  ],
});

describe('exportedTypeNames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-types-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('collects exported type aliases and interfaces only', () => {
    writeFileSync(join(dir, 'a.ts'), 'export type A = 1;\nexport interface B { x: 1 }\nexport const C = 1;\ntype D = 1;\nexport { };\nexport * from "./b.ts";\n');
    writeFileSync(join(dir, 'b.js'), 'export type Ignored = 1;\n');
    assert.deepEqual([...exportedTypeNames(dir)].sort(), ['A', 'B']);
  });
  it('covers every type exported by @bot/types', () => {
    const names = exportedTypeNames(join(root, 'packages/types/src'));
    for (const n of ['Lamports', 'Result', 'OrderState', 'StrategyContext', 'VenueId', 'UnsignedTx', 'ExecutionPort', 'AttemptState', 'RungParams', 'U64Str']) {
      assert.ok(names.has(n), n);
    }
  });
});

// B-M24-01 acceptance: a withTx containing an await fails lint.
tester.run('no-await-in-withtx', noAwaitInWithTx, {
  valid: [
    'db.withTx((tx) => { tx.run(sql); })',
    'withTx(function (tx) { return tx.get(sql); })',
    'db.withTx(handler)',
    'async function f() { await x; db.withTx((tx) => tx.run(sql)); }',
    'db.withTx((tx) => { const later = async () => { await x; }; return later; })',
    'other(async () => { await x; })',
    '(async () => { await x; })()',
    'db.other(async (tx) => { await tx; })',
    'await x;',
    'for await (const r of rows) use(r);',
  ],
  invalid: [
    { code: 'db.withTx(async (tx) => { await send(tx); })', errors: [{ messageId: 'asyncCallback' }, { messageId: 'awaitInTx' }] },
    { code: "db['withTx'](async function (tx) { for await (const r of rows) tx.run(r); })", errors: [{ messageId: 'asyncCallback' }, { messageId: 'awaitInTx' }] },
    { code: 'withTx(async (tx) => tx.run(sql))', errors: [{ messageId: 'asyncCallback' }] },
    { code: 'this.db.withTx(function* (tx) { yield tx; })', errors: [{ messageId: 'asyncCallback' }] },
    { code: 'db.withTx((tx) => { if (a) { await b; } })', errors: [{ messageId: 'awaitInTx' }] },
  ],
});
