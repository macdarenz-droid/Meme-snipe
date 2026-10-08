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
import noNumberFormatting from '../rules/no-number-formatting.ts';
import noNumberOnMoney, { MONEY_FIELD } from '../rules/no-number-on-money.ts';
import noNumberOnUnits from '../rules/no-number-on-units.ts';
import noProgramIdLiteral, { base58Runs, CONSTANTS_FILE, isAddressLiteral, knownProgramIds } from '../rules/no-program-id-literal.ts';
import noSharedTypeRedefinition, { exportedTypeNames } from '../rules/no-shared-type-redefinition.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' } });
const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('plugin', () => {
  it('exports the eight rules under the bot namespace', () => {
    assert.equal(plugin.meta?.name, 'bot');
    assert.deepEqual(Object.keys(plugin.rules ?? {}).sort(),
      ['no-ambient-clock-or-random', 'no-await-in-withtx', 'no-fixtures-import', 'no-number-formatting', 'no-number-on-money', 'no-number-on-units', 'no-program-id-literal', 'no-shared-type-redefinition']);
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

describe('no-number-on-money: field names (UI-T01)', () => {
  it('matches exactly the UI-T01 suffixes after an underscore', () => {
    for (const n of ['net_pnl_lamports', 'size_base', 'pnl_usd_e6', 'opened_slot', 'cu_price_micro_lamports_per_cu']) assert.ok(MONEY_FIELD.test(n), n);
    for (const n of ['lamports', 'database', 'usd_e6_x', 'slots', 'netPnlLamports', 'price_sol_per_token']) assert.ok(!MONEY_FIELD.test(n), n);
  });
});

tester.run('no-number-on-money', noNumberOnMoney, {
  valid: [
    'Number(count)',
    'parseFloat(price_sol_per_token)',
    'BigInt(x.net_pnl_lamports)',
    'parseU64Str(x.size_base)',
    'Number(x.decimals)',
    'Number(x[k])',
    'foo(x.net_pnl_lamports)',
    'Number.isInteger(x.opened_slot)',
  ],
  invalid: [
    { code: 'parseFloat(x.net_pnl_lamports)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'parseFloat', name: 'net_pnl_lamports' } }] },
    { code: 'Number(row.size_base)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'size_base' } }] },
    { code: "Number(v['pnl_usd_e6'])", errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'pnl_usd_e6' } }] },
    { code: 'parseInt(mark_slot, 10)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'parseInt', name: 'mark_slot' } }] },
    { code: 'Number.parseFloat(fee.cu_price_micro_lamports_per_cu)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number.parseFloat', name: 'cu_price_micro_lamports_per_cu' } }] },
    { code: 'new Number(a.tip_lamports)', errors: [{ messageId: 'moneyToNumber' }] },
  ],
});

// Review m8: unary +, Math.* and money fields reached through a renamed destructure or an alias.
tester.run('no-number-on-money: unary +, Math.* and bound variables (review m8)', noNumberOnMoney, {
  valid: [
    '-count',
    '!x.net_pnl_lamports',
    '+count',
    '+x.decimals',
    'Math.max(a, b)',
    'Math.round(x.decimals)',
    'foo.round(x.net_pnl_lamports)',
    'const { decimals: d } = vm; Number(d)',
    'const { [k]: v } = vm; Number(v)',
    'const { 1: v } = vm; Number(v)',
    'const { ...rest } = vm; Number(rest)',
    'const pnl = vm.decimals; Number(pnl)',
    'let pnl; Number(pnl)',
    'function f(pnl = 1) { return Number(pnl); }',
    'function f(pnl) { return Number(pnl); }',
    'const [pnl] = vm.rows; Number(pnl)',
    'var a = b; var b = a; Number(a)',
    'Number(undeclared)',
    'const pnl = 1; Number(x.pnl)',
    'const pnl = vm.net_pnl_lamports; Number({ pnl: 1 }.size)',
    'const pnl = vm.net_pnl_lamports; Number(x[k])',
  ],
  invalid: [
    { code: '+x.net_pnl_lamports', errors: [{ messageId: 'unary', data: { op: '+', name: 'net_pnl_lamports' } }] },
    { code: "+row['size_base']", errors: [{ messageId: 'unary', data: { op: '+', name: 'size_base' } }] },
    { code: 'Math.round(x.pnl_usd_e6)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.round', name: 'pnl_usd_e6' } }] },
    { code: 'Math.max(a, opened_slot)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.max', name: 'opened_slot' } }] },
    { code: "globalThis.Math['floor'](x.tip_lamports)", errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.floor', name: 'tip_lamports' } }] },
    { code: 'Math[k](x.tip_lamports)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.[…]', name: 'tip_lamports' } }] },
    { code: 'const { net_pnl_lamports: pnl } = vm; Number(pnl)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'net_pnl_lamports' } }] },
    { code: "const { 'size_base': s = '0' } = vm; parseFloat(s)", errors: [{ messageId: 'moneyToNumber', data: { fn: 'parseFloat', name: 'size_base' } }] },
    { code: "const { ['pnl_usd_e6']: u } = vm; +u", errors: [{ messageId: 'unary', data: { op: '+', name: 'pnl_usd_e6' } }] },
    { code: 'const pnl = vm.net_pnl_lamports; const p2 = pnl; Math.abs(p2)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.abs', name: 'net_pnl_lamports' } }] },
    { code: 'function f({ net_pnl_lamports: pnl }) { return Number(pnl) + Number(pnl.length); }', errors: [{ messageId: 'moneyToNumber' }, { messageId: 'moneyToNumber' }] },
    { code: 'const { net_pnl_lamports: pnl } = vm; function g() { return Number(pnl); }', errors: [{ messageId: 'moneyToNumber' }] },
  ],
});

// Review n1: coercions that passed both lint and typecheck: unary - and ~ (TypeScript accepts both on a string),
// converters passed as values or called through .call/.apply, assignment aliases, and computed keys held in a variable.
tester.run('no-number-on-money: unary - and ~, converter values, .call/.apply, assigned aliases, held keys (review n1)', noNumberOnMoney, {
  valid: [
    'Number.isInteger(x)', 'Number.MAX_SAFE_INTEGER', 'Number[k]', 'const { isFinite } = Number', "const { 'MAX_SAFE_INTEGER': m, isNaN } = Number", 'globalThis.foo', 'globalThis.foo.bar', 'foo(globalThis)',
    'Number.call(null, count)', 'parseFloat.apply(null, [x.decimals])', 'Math.round.call(null, x.decimals)',
    'type T = typeof Number', 'let n: Number', 'xs.map((s) => BigInt(s))',
    'function f(Number) { return xs.map(Number); }', 'import { parseInt } from "m"; xs.map(parseInt)',
    'let p; p = vm.decimals; Number(p)', 'let p; p += 1; Number(p)', '({ decimals: p } = vm); Number(p)',
    "const k = 'decimals'; Number(vm[k])", 'const k = f(); Number(vm[k])', 'Number(vm[k])', 'Number(vm[k + 1])', 'let k; Number(vm[k])',
  ],
  invalid: [
    { code: '-x.net_pnl_lamports', errors: [{ messageId: 'unary', data: { op: '-', name: 'net_pnl_lamports' } }] },
    { code: '~x.size_base', errors: [{ messageId: 'unary', data: { op: '~', name: 'size_base' } }] },
    { code: '[vm.x_lamports].map(Number)', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'xs.map(parseFloat)', errors: [{ messageId: 'converterValue', data: { fn: 'parseFloat' } }] },
    { code: 'xs.map(Number.parseInt)', errors: [{ messageId: 'converterValue', data: { fn: 'Number.parseInt' } }] },
    { code: "xs.map(globalThis['parseInt'])", errors: [{ messageId: 'converterValue', data: { fn: 'parseInt' } }] },
    { code: 'xs.map(window.Number.parseFloat)', errors: [{ messageId: 'converterValue', data: { fn: 'Number.parseFloat' } }] },
    { code: 'const f = Number; f(x.tip_lamports)', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const { parseFloat: pf } = Number', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const { ...all } = Number', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const { [k]: f } = Number', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const [f] = Number', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const o = { Number }', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'Reflect.apply(Number, null, [x.tip_lamports])', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'const g = parseInt.bind(null); g(s)', errors: [{ messageId: 'converterValue', data: { fn: 'parseInt' } }] },
    { code: 'const c = parseFloat.call', errors: [{ messageId: 'converterValue', data: { fn: 'parseFloat' } }] },
    { code: '(Number as any)(x)', errors: [{ messageId: 'converterValue', data: { fn: 'Number' } }] },
    { code: 'parseFloat.call(null, vm.x_lamports)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'parseFloat.call', name: 'x_lamports' } }] },
    { code: 'Number.apply(null, [vm.size_base])', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number.apply', name: 'size_base' } }] },
    { code: 'Number.parseInt.call(null, opened_slot, 10)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number.parseInt.call', name: 'opened_slot' } }] },
    { code: 'Math.round.call(null, x.pnl_usd_e6)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Math.round.call', name: 'pnl_usd_e6' } }] },
    { code: 'let p; p = vm.x_lamports; Number(p)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'x_lamports' } }] },
    { code: "let p = '0'; p = vm.size_base; -p", errors: [{ messageId: 'unary', data: { op: '-', name: 'size_base' } }] },
    { code: "let p = ''; p += vm.size_base; Number(p)", errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'size_base' } }] },
    { code: 'let p; ({ net_pnl_lamports: p } = vm); Number(p)', errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'net_pnl_lamports' } }] },
    { code: "const k = 'net_pnl_lamports'; Number(vm[k])", errors: [{ messageId: 'moneyToNumber', data: { fn: 'Number', name: 'net_pnl_lamports' } }] },
    { code: "let k; k = `size_base`; parseFloat(vm[k])", errors: [{ messageId: 'moneyToNumber', data: { fn: 'parseFloat', name: 'size_base' } }] },
  ],
});

// Red-team 3 RT3-2: a parameter whose value flows from a money field (callbacks, named callbacks, direct calls, for…of),
// destructured or not, and arrays of fields built by literals and array methods.
const money = (fn: string, name = 'size_base'): { messageId: string; data: { fn: string; name: string } } => ({ messageId: 'moneyToNumber', data: { fn, name } });
const unary = (op: string, name = 'size_base'): { messageId: string; data: { op: string; name: string } } => ({ messageId: 'unary', data: { op, name } });
tester.run('no-number-on-money: callback parameters and arrays of fields (red-team 3 RT3-2)', noNumberOnMoney, {
  valid: [
    'rows.map((r) => r.count).map((s) => Number(s))',
    'rows.map((r) => r.size_base).forEach((s, i) => Number(i))',
    'rows.map((r) => [r.count, r.size_base]).map(([n]) => Number(n))',
    'const [a] = [, vm.size_base]; Number(a)',
    'rows.map((r) => [r.size_base]).map(({ length }) => Number(length))',
    'const n = rows.map((r) => r.size_base).length; Number(n)',
    'const o = { p: vm.size_base }; Number(o.q)',
    'const o = { p: vm.size_base }; Number(o[i])',
    'const o = { p: vm.size_base, ...rest }; Number(o.q)',
    'rows.map().map((s) => Number(s))',
    'rows.map(f.g).map((s) => Number(s))',
    'rows.map(pick).map((s) => Number(s))',
    'const pick = 1; rows.map(pick).map((s) => Number(s))',
    'let pick; rows.map(pick).map((s) => Number(s))',
    'function wrap(fn) { rows.map(fn).map((s) => Number(s)); return vm.size_base; }',
    'import { pick } from "m"; rows.map(pick).map((s) => Number(s))',
    'rows.map(function (r) { const f = () => r.size_base; if (!r) return; return r.count; }).map((s) => Number(s))',
    'foo((s) => Number(s), vm.size_base)',
    'rows.map((r) => r.size_base).map(1, (s) => Number(s))',
    'rows.map((r) => r.size_base).map(1, 2, (s) => Number(s))',
    'Array.from([vm.size_base], (s, i) => Number(i))',
    '[vm.size_base].then((s) => Number(s))',
    '[vm.size_base][m]((s) => Number(s))',
    'const f = (a, s) => Number(s); f(vm.size_base)',
    'const f = (a, s) => Number(s); f(...xs, vm.size_base)',
    'function toNum(s) { return Number(s); } const g = toNum',
    'export default function (s) { return Number(s); }',
    'const o = { f(s) { return Number(s); } }; o.f(vm.size_base)',
    'function f() { return 1; } Number(f)',
    'for (const k in vm) Number(k)',
    'let o = vm; o = o.next; Number(o)',
    'const [...xs] = [vm.size_base]; Number(xs)',
    'const xs = make(); xs.map((s) => Number(s))',
    'const xs = rows.keys(); xs.map((s) => Number(s))',
    'Foo.from([vm.size_base]).map((s) => Number(s))',
    'rows[m]((r) => r.size_base).map((s) => Number(s))',
    'const o = [vm.size_base]; Number(o.p)',
  ],
  invalid: [
    { code: 'rows.map((r) => r.net_pnl_lamports).map((s) => Number(s))', errors: [money('Number', 'net_pnl_lamports')] },
    { code: 'rows.map((r) => r.net_pnl_lamports).reduce((a, s) => a + Number(s), 0)', errors: [money('Number', 'net_pnl_lamports')] },
    { code: 'rows.map((r) => r.size_base).reduceRight((a, b) => Math.max(a, 1))', errors: [money('Math.max')] },
    { code: 'rows.reduce((acc) => +acc, vm.size_base)', errors: [unary('+')] },
    { code: 'rows.map((r) => [r.count, r.size_base]).map(([n, s]) => Number(s))', errors: [money('Number')] },
    { code: 'rows.map((r) => [...r.extra, r.size_base]).map(([n]) => Number(n))', errors: [money('Number')] },
    { code: 'const [, s] = [, vm.size_base]; Number(s)', errors: [money('Number')] },
    { code: 'rows.map((r) => ({ s: r.net_pnl_lamports })).map(({ s }) => Number(s))', errors: [money('Number', 'net_pnl_lamports')] },
    { code: 'rows.map((r) => ({ s: r.net_pnl_lamports })).map((o) => parseFloat(o.s))', errors: [money('parseFloat', 'net_pnl_lamports')] },
    { code: 'rows.map(({ net_pnl_lamports: p }) => Number(p))', errors: [money('Number', 'net_pnl_lamports')] },
    { code: 'rows.map(({ s = vm.size_base }) => Number(s))', errors: [money('Number')] },
    { code: 'rows.map((r) => r.size_base).map((s = x) => Number(s))', errors: [money('Number')] },
    { code: 'const xs = rows.map((r) => r.net_pnl_lamports); xs.forEach((s) => { total += Number(s); })', errors: [money('Number', 'net_pnl_lamports')] },
    { code: '[vm.a_lamports, vm.b_lamports].map((s) => +s)', errors: [unary('+', 'a_lamports')] },
    { code: '[...rows.map((r) => r.size_base)].map((s) => -s)', errors: [unary('-')] },
    { code: 'rows.map(function (r) { if (r.x) return r.count; return r.size_base; }).some(function (s) { return Number(s) > 0; })', errors: [money('Number')] },
    { code: 'rows.flatMap((r) => [r.size_base]).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'rows.map((r) => r.size_base).filter(Boolean).sort((a, b) => Number(a) - Number(b))', errors: [money('Number'), money('Number')] },
    { code: 'const last = rows.map((r) => r.size_base).at(-1); Number(last)', errors: [money('Number')] },
    { code: 'const [head] = rows.map((r) => r.size_base); Number(head)', errors: [money('Number')] },
    { code: 'const xs = [vm.size_base]; Number(xs[i])', errors: [money('Number')] },
    { code: 'Array.from(rows, (r) => r.size_base).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'Array.from([vm.size_base]).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'Array.from([vm.size_base], (s) => Number(s))', errors: [money('Number')] },
    { code: 'function toNum(s) { return Number(s); } rows.map((r) => r.size_base).map(toNum)', errors: [money('Number')] },
    { code: 'const toNum = (s) => Number(s); toNum(vm.size_base)', errors: [money('Number')] },
    { code: '((s) => Number(s))(vm.size_base)', errors: [money('Number')] },
    { code: 'for (const s of rows.map((r) => r.size_base)) Number(s)', errors: [money('Number')] },
    { code: 'const pick = (r) => r.size_base; rows.map(pick).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'function pick(r) { return r.size_base; } rows.map(pick).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'const o = { ...{ p: vm.size_base } }; Number(o.p)', errors: [money('Number')] },
    { code: '(rows.map((r) => r.size_base) as string[]).map((s: string) => Number(s))', errors: [money('Number')] },
    { code: 'const xs = vm.rows?.map((r) => r.size_base); xs.map((s) => Number(s))', errors: [money('Number')] },
    { code: 'rows.map((r) => r.size_base).concat(more).map((s) => Number(s))', errors: [money('Number')] },
    { code: '[].concat(vm.size_base).map((s) => Number(s))', errors: [money('Number')] },
    { code: 'const o = { s: vm.size_base }; const t = [o.n, o.s]; t.map((v) => ~v)', errors: [unary('~')] },
  ],
});

tester.run('no-number-formatting', noNumberFormatting, {
  valid: ['formatSol(x)', 'x.toString()', 'toFixed(2)', 'x[k](2)', 'x.fixed(2)', "x['format'](2)"],
  invalid: [
    { code: 'x.toFixed(2)', errors: [{ messageId: 'adHoc', data: { name: 'toFixed' } }] },
    { code: 'n.toLocaleString()', errors: [{ messageId: 'adHoc', data: { name: 'toLocaleString' } }] },
    { code: 'n.toPrecision(3)', errors: [{ messageId: 'adHoc', data: { name: 'toPrecision' } }] },
    { code: "n['toFixed'](1)", errors: [{ messageId: 'adHoc', data: { name: 'toFixed' } }] },
    { code: 'a?.b.toFixed?.(1)', errors: [{ messageId: 'adHoc', data: { name: 'toFixed' } }] },
  ],
});

tester.run('no-number-formatting: Intl.NumberFormat (review m8)', noNumberFormatting, {
  valid: [
    'Intl.DateTimeFormat', 'x.NumberFormat', 'Intl[k]', 'const { DateTimeFormat } = Intl', 'const { NumberFormat } = other',
    'let x', 'const { [k]: F } = Intl', 'const { 1: F } = Intl',
    'type O = Intl.NumberFormatOptions', 'type T = typeof Intl', 'function f(Intl) { return Intl; }', 'globalThis.Intl.DateTimeFormat', 'foo(globalThis.x)',
  ],
  invalid: [
    { code: 'new Intl.NumberFormat().format(n)', errors: [{ messageId: 'intl' }] },
    { code: "Intl.NumberFormat('en-GB').format(n)", errors: [{ messageId: 'intl' }] },
    { code: "globalThis.Intl['NumberFormat']", errors: [{ messageId: 'intl' }] },
    { code: 'const F = window.Intl.NumberFormat', errors: [{ messageId: 'intl' }] },
    { code: 'const { NumberFormat } = Intl', errors: [{ messageId: 'intl' }] },
    { code: "const { 'NumberFormat': F } = Intl", errors: [{ messageId: 'intl' }] },
    { code: "const { ['NumberFormat']: F } = globalThis.Intl", errors: [{ messageId: 'intl' }] },
    // Review n1: Intl as a whole value reaches NumberFormat out of sight.
    { code: 'const I = Intl; new I.NumberFormat()', errors: [{ messageId: 'intlValue' }] },
    { code: 'let I; I = window.Intl', errors: [{ messageId: 'intlValue' }] },
    { code: 'use(globalThis.Intl)', errors: [{ messageId: 'intlValue' }] },
    { code: 'const { ...rest } = Intl', errors: [{ messageId: 'intlValue' }] },
    { code: 'const [a] = Intl', errors: [{ messageId: 'intlValue' }] },
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

// A-M01-01 logic 1 (ported from Snipe-solana card C03 #6 @ 6ae4d62). The IDs come from the registry itself, so this
// test file holds none.
const ids = [...knownProgramIds()];
const pump = ids[0] as string;
tester.run('no-program-id-literal', noProgramIdLiteral, {
  valid: [
    "const a = 'not a program id';",
    `const a = \`\${x}${pump}\`;`,
    'const n = 7;',
    "import { PROGRAMS } from '@bot/venue/constants'; const p = PROGRAMS.pumpCurve;",
    'const r = String.raw`\\unicode`;',                       // a tagged template with no cooked value
  ],
  invalid: [
    { code: `const p = '${pump}';`, errors: [{ messageId: 'literal' }] },
    { code: `const p = "${ids[12] as string}";`, errors: [{ messageId: 'literal' }] },
    { code: `const p = \`${ids[13] as string}\`;`, errors: [{ messageId: 'literal' }] },
    { code: `f({ program: '${ids[3] as string}' });`, errors: [{ messageId: 'literal' }] },
    // Z03 ruling 16: an ID inside a longer string (a log line) is reported too; it was valid before round 3.
    { code: `const a = 'Program ${pump} invoke [1]';`, errors: [{ messageId: 'literal' }] },
  ],
});

describe('knownProgramIds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-constants-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('reads the 14 program IDs of the constants registry (A-M01-01), base58 of 32-44 characters', () => {
    assert.equal(CONSTANTS_FILE, join(root, 'packages/venue/src/constants.ts'));
    assert.equal(ids.length, 14);
    for (const id of ids) assert.match(id, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it('reads only the PROGRAMS object, and nothing from a file without one', () => {
    writeFileSync(join(dir, 'a.ts'), "export const MINTS = { a: 'x' };\nexport const PROGRAMS = Object.freeze({ a: 'P1', b: 'P2' } as const);\n");
    assert.deepEqual([...knownProgramIds(join(dir, 'a.ts'))].sort(), ['P1', 'P2']);
    writeFileSync(join(dir, 'b.ts'), "export const MINTS = { a: 'x' };\n");
    assert.deepEqual([...knownProgramIds(join(dir, 'b.ts'))], []);
  });
});

// Z03 round 2, ruling m7: any base58 literal that decodes to 32 bytes is an address. Built at run time here, so this
// file holds none.
const WSOL = `So${'1'.repeat(40)}2`;                                   // the wrapped SOL mint
const DEFAULT = '1'.repeat(32);                                        // Pubkey::default()
tester.run('no-program-id-literal (addresses)', noProgramIdLiteral, {
  valid: [
    `const a = '${'1'.repeat(31)}';`,                                  // 31 zero bytes
    `const a = '${'1'.repeat(33)}';`,                                  // 33 zero bytes
    `const sig = '${'2'.repeat(88)}';`,                                // a signature is 64 bytes
    `const s = 'solana:${'1'.repeat(31)} pay';`,                       // a 31-byte token in a longer string
    "const c = 'So' + 'x';",                                           // concatenation: out of scope (Z03-9)
  ],
  invalid: [
    { code: `const m = '${WSOL}';`, errors: [{ messageId: 'address' }] },
    { code: `const d = \`${DEFAULT}\`;`, errors: [{ messageId: 'address' }] },
    // Z03 ruling 16: an address inside a longer string literal.
    { code: `const u = 'solana:${WSOL}';`, errors: [{ messageId: 'address' }] },
    { code: `const v = '${WSOL}0';`, errors: [{ messageId: 'address' }] },   // '0' is not base58: the address is a token of its own
    { code: `const p = '  ${WSOL}  ';`, errors: [{ messageId: 'address' }] },
    { code: `const q = 'https://x.example/${WSOL}?a=1';`, errors: [{ messageId: 'address' }] },
  ],
});

describe('isAddressLiteral', () => {
  it('is true exactly for base58 text that decodes to 32 bytes', () => {
    assert.equal(isAddressLiteral(WSOL), true);
    assert.equal(isAddressLiteral(DEFAULT), true);
    for (const id of ids) assert.equal(isAddressLiteral(id), true, id);
    for (const no of ['1'.repeat(31), '1'.repeat(33), `${WSOL}x`, 'I'.repeat(32), '2'.repeat(88), '']) assert.equal(isAddressLiteral(no), false, no);
  });
});

describe('base58Runs (Z03 ruling 16)', () => {
  it('splits a string at every character outside the base58 alphabet', () => {
    assert.deepEqual(base58Runs(`pay:${WSOL}?x=1`), ['pay', WSOL, 'x', '1']);
    assert.deepEqual(base58Runs('solana'), ['so', 'ana']);                 // 'l' is not in the base58 alphabet
    assert.deepEqual(base58Runs('  '), []);
  });
});
